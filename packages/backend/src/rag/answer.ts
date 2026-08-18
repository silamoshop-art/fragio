/**
 * RAG-Kernpipeline: Frage -> relevante Chunks -> geerdete Antwort (Streaming).
 *
 * Ablauf:
 *   1. Frage lokal embedden.
 *   2. Top-K Chunks des Bots holen (tenant-isoliert, Cosine-Distanz).
 *   3. Relevanz prüfen: liegt der beste Treffer über der Distanz-Schwelle,
 *      wird ohne LLM-Aufruf ehrlich "weiß ich nicht" geantwortet (spart Tokens).
 *   4. Sonst Kontext bauen und Antwort streamen.
 *   5. Chat-Log für Analytics schreiben (beantwortet / unbeantwortet).
 */
import type { BotRow, ChunkHit } from "../db/repo.js";
import { searchChunks, insertChatLog, incrementTrialCount } from "../db/repo.js";
import { getProviderForBot } from "../llm/index.js";
import { embed } from "../llm/embedder.js";
import { isTrialActive } from "../trial/state.js";
import { buildSystemPrompt, formatContext, buildUserMessage } from "./prompt.js";

// Cosine-Distanz in [0,2]. Kleiner = ähnlicher.
// Empirisch kalibriert für multilingual-e5-small (relevant ~0.15, irrelevant ~0.21+).
// Bewusst etwas großzügig: Haiku ist im Prompt angewiesen, bei unzureichendem
// Kontext selbst "weiß ich nicht" zu sagen — falsche Ablehnungen sind schlechter.
const RELEVANCE_DISTANCE = 0.24; // bester Treffer schlechter -> "weiß ich nicht" (ohne LLM)
const CONTEXT_DISTANCE = 0.3; // Chunks darüber nicht in den Kontext
const TOP_K = 8;
const DEFAULT_ANSWER_TOKENS = 250; // Fallback, falls Bot keinen Wert gesetzt hat

// Kanonische Kontakt-Query für die Standort-Erweiterung (matcht Adress-/Impressum-Chunks).
const LOCATION_QUERY =
  "Adresse Anschrift Standort Anfahrt wo befindet sich das Unternehmen Kontakt Telefon Öffnungszeiten";

/** Erkennt Standort-/Kontakt-Fragen (bewusst breit, damit die Adresse zuverlässig kommt). */
function isLocationIntent(q: string): boolean {
  return /\b(wo|adresse|anschrift|standort|anfahrt|hinkommen|findet man|finde ich|sitz|ansässig|erreiche|erreichen|kontakt|telefon|öffnungszeit|geöffnet|maps|karte|weg)\b/i.test(
    q,
  );
}

/** Zwei Trefferlisten vereinen: pro Chunk kleinste Distanz behalten, aufsteigend sortiert. */
function mergeHits(a: ChunkHit[], b: ChunkHit[], cap: number): ChunkHit[] {
  const best = new Map<number, ChunkHit>();
  for (const h of [...a, ...b]) {
    const cur = best.get(h.chunk_id);
    if (!cur || h.distance < cur.distance) best.set(h.chunk_id, h);
  }
  return [...best.values()].sort((x, y) => x.distance - y.distance).slice(0, cap);
}

export interface AnswerSource {
  title: string | null;
  url: string | null;
}

export interface AnswerMeta {
  answered: boolean;
  sources: AnswerSource[];
  topScore: number | null;
  provider: string;
}

const FALLBACK_ANSWER =
  "Das kann ich anhand der Inhalte dieser Website leider nicht beantworten. " +
  "Formuliere deine Frage gern anders oder wende dich direkt an das Team.";

/**
 * Streamt die Antwort. Ruft `onMeta` einmal auf, sobald Quellen/Relevanz
 * feststehen (vor dem ersten Token), und liefert die Text-Token als AsyncIterable.
 */
export interface AnswerOptions {
  /**
   * Gesprächsinhalt (Frage + Antwort) in chat_logs für Analytics speichern?
   * false = "Nur notwendige Verarbeitung": Anfrage wird beantwortet (Weiterleitung an
   * Anthropic ist zur Diensterbringung nötig), aber KEIN chat_logs-Eintrag mit Inhalt.
   * Kontingent/Rate-Limit laufen unabhängig davon (im Chat-Endpoint).
   */
  storeContent?: boolean;
  /** Gehashte IP (SHA-256+Salt) für die gezielte Löschfunktion; keine Klartext-IP. */
  ipHash?: string | null;
}

export async function* answerQuestion(
  bot: BotRow,
  question: string,
  onMeta?: (meta: AnswerMeta) => void,
  opts?: AnswerOptions,
): AsyncGenerator<string> {
  const storeContent = opts?.storeContent !== false; // Default: loggen (Cron/Tests)
  const ipHash = opts?.ipHash ?? null;
  const started = Date.now();
  const branding = safeParseBranding(bot.branding);
  // Trial-Kontingent nur belasten, wenn tatsächlich der Trial-Key genutzt wird.
  const trialUsed = isTrialActive(bot);

  // 1) + 2) Query lokal embedden (kein Chat-Key nötig). kind="query" für e5.
  const [qEmb] = await embed([question], "query");
  let hits = searchChunks(bot.id, qEmb, TOP_K);

  // Standort-/Kontaktfragen ("wo seid ihr?", "wie erreiche ich euch?") matchen den
  // Adress-Chunk (oft nur im Footer/Impressum, ohne Überschrift) semantisch mal gut,
  // mal schlecht. Für solche Fragen zusätzlich mit einer kanonischen Kontakt-Query
  // suchen und die Treffer zusammenführen — so landet die echte Adresse zuverlässig
  // im Kontext, statt dass mal nur Telefon/E-Mail gezogen wird.
  if (isLocationIntent(question)) {
    const [augEmb] = await embed([LOCATION_QUERY], "query");
    hits = mergeHits(hits, searchChunks(bot.id, augEmb, TOP_K), TOP_K);
  }
  const topScore = hits.length ? hits[0].distance : null;

  // 3) Nichts Relevantes gefunden -> ehrliche Absage OHNE LLM (kein Chat-Provider nötig).
  if (!hits.length || hits[0].distance > RELEVANCE_DISTANCE) {
    onMeta?.({ answered: false, sources: [], topScore, provider: "none" });
    if (storeContent) {
      insertChatLog({
        botId: bot.id,
        question,
        answer: FALLBACK_ANSWER,
        answered: false,
        topScore,
        provider: "none",
        latencyMs: Date.now() - started,
        ipHash,
      });
    }
    yield FALLBACK_ANSWER;
    return;
  }

  // 4) Kontext bauen und Chat-Provider (Haiku 4.5 / Kunden-Key) jetzt erzeugen.
  const provider = getProviderForBot(bot);
  const contextHits = hits.filter((h) => h.distance <= CONTEXT_DISTANCE);
  const sources = dedupeSources(contextHits);
  onMeta?.({ answered: true, sources, topScore, provider: provider.id });

  const system = buildSystemPrompt({ botName: branding.botName });
  const userMessage = buildUserMessage(formatContext(contextHits), question);

  let full = "";
  try {
    for await (const piece of provider.streamAnswer({
      system,
      messages: [{ role: "user", content: userMessage }],
      maxTokens: bot.max_answer_tokens || DEFAULT_ANSWER_TOKENS,
    })) {
      full += piece;
      yield piece;
    }
  } finally {
    // Trial-Kontingent erhöhen (nur wenn der Trial-Key wirklich verwendet wurde).
    if (trialUsed) incrementTrialCount(bot.id);
    // 5) Loggen (auch bei Abbruch, was bereits generiert wurde) — nur mit Einwilligung.
    if (storeContent) {
      insertChatLog({
        botId: bot.id,
        question,
        answer: full || null,
        answered: true,
        topScore,
        provider: provider.id,
        latencyMs: Date.now() - started,
        ipHash,
      });
    }
  }
}

function dedupeSources(hits: ChunkHit[]): AnswerSource[] {
  const seen = new Set<string>();
  const out: AnswerSource[] = [];
  for (const h of hits) {
    const key = h.page_url || h.page_title || "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ title: h.page_title, url: h.page_url });
  }
  return out;
}

function safeParseBranding(json: string): { botName?: string } {
  try {
    return JSON.parse(json) as { botName?: string };
  } catch {
    return {};
  }
}
