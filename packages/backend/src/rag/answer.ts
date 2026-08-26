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
import { buildSystemPrompt, formatContext, buildUserMessage, type HistoryTurn } from "./prompt.js";
import { numericSearch } from "./numeric.js";
import { matchManualFaq } from "./faq.js";

// Cosine-Distanz in [0,2]. Kleiner = ähnlicher.
// Empirisch kalibriert für multilingual-e5-small (relevant ~0.15, irrelevant ~0.21+).
// Bewusst etwas großzügig: Haiku ist im Prompt angewiesen, bei unzureichendem
// Kontext selbst "weiß ich nicht" zu sagen — falsche Ablehnungen sind schlechter.
const RELEVANCE_DISTANCE = 0.24; // bester Treffer schlechter -> "weiß ich nicht" (ohne LLM)
const CONTEXT_DISTANCE = 0.3; // Chunks darüber nicht in den Kontext
const TOP_K = 8;
const DEFAULT_ANSWER_TOKENS = 250; // Fallback, falls Bot keinen Wert gesetzt hat

// Manuelle FAQ (Prompt 14 #5): Passt die Besucherfrage sehr stark zu einer
// redaktionellen FAQ, wird deren Antwort wörtlich ausgegeben. Konservativ
// kalibriert für multilingual-e5-small: direkte Paraphrasen liegen < 0.10,
// themenverwandte Fremdfragen erst ab ~0.12 — 0.11 trennt sauber und vermeidet
// Fehlauslösungen (lieber eine FAQ verpassen als eine falsche wörtlich ausgeben).
const FAQ_MATCH_DISTANCE = 0.11;

// Kanonische Kontakt-Query für die Standort-Erweiterung (matcht Adress-/Impressum-Chunks).
const LOCATION_QUERY =
  "Adresse Anschrift Standort Anfahrt wo befindet sich das Unternehmen Kontakt Telefon Öffnungszeiten";

/** Erkennt Standort-/Kontakt-Fragen (bewusst breit, damit die Adresse zuverlässig kommt). */
function isLocationIntent(q: string): boolean {
  return /\b(wo|adresse|anschrift|standort|anfahrt|hinkommen|findet man|finde ich|sitz|ansässig|erreiche|erreichen|kontakt|telefon|öffnungszeit|geöffnet|maps|karte|weg)\b/i.test(
    q,
  );
}

// Kanonische Preis-Query für die Preis-Erweiterung. Preis-/Tarif-Chunks sind oft
// terse Tabellen ("B € 2.166,– B 17 € 2.197,– …") mit wenig Fließtext und matchen
// eine knappe Frage ("Preis B17") semantisch schlecht. Diese Query zieht solche
// Chunks zuverlässig heran (Prompt-15-Folge: Preisfragen OHNE Zahl in der Frage).
const PRICE_QUERY =
  "Preis Preise Kosten Kurskosten Ausbildungskosten Gebühr Gebühren Tarif Preisliste was kostet wie viel kostet Euro €";

/** Erkennt Preis-/Kostenfragen (auch ohne konkrete Zahl in der Frage). */
function isPriceIntent(q: string): boolean {
  return /(\bpreis|\bpreise|\bpreislist|kostet|\bkosten\b|\bgebühr|\btarif|teuer|wie\s?viel|was\s?kostet|betrag|€|\beuro\b)/i.test(
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

// Rückfrage statt pauschaler Absage (Prompt 15 #3b): kurze/mehrdeutige Folgefrage,
// zu der auch mit Gesprächskontext nichts Passendes gefunden wurde.
const CLARIFY_ANSWER =
  "Das habe ich noch nicht ganz verstanden. Magst du kurz genauer sagen, worauf sich " +
  "deine Frage bezieht? Dann helfe ich dir direkt weiter.";

/** Kurze/mehrdeutige Nachricht (typisch für Folgefragen wie "nein größer"). */
function isShortQuery(q: string): boolean {
  const words = q.trim().split(/\s+/).filter(Boolean);
  return words.length <= 4;
}

/** Letzte Nutzernachricht aus dem Verlauf (für die Retrieval-Anreicherung). */
function lastUserTurn(history: HistoryTurn[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].content;
  }
  return undefined;
}

/**
 * Erkennt, ob eine bereits generierte LLM-Antwort inhaltlich eine ABSAGE ist
 * ("kann ich anhand der Website nicht beantworten", "wende dich ans Team" …).
 *
 * Hintergrund (Prompt 14 #4): Der Retrieval-Treffer kann über der Relevanz-
 * Schwelle liegen (also wird das LLM aufgerufen), aber das Modell erkennt selbst,
 * dass die konkrete Antwort nicht im Kontext steht, und gibt einen Absage-/
 * Verweis-Text aus. Ohne diese Prüfung würde so eine Antwort fälschlich als
 * "beantwortet" gezählt und taucht nicht bei den "unbeantworteten Fragen" auf.
 *
 * Bewusst eher inklusiv: ein Fehlalarm (echte Antwort wird als unbeantwortet
 * markiert) ist hier weniger schlimm als ein verpasster Content-Gap — der
 * Betreiber will diese Lücken ja gerade sehen. Deutsch + gängiges Englisch.
 */
const NON_ANSWER_PATTERNS: RegExp[] = [
  /\bnicht beantworten\b/i,
  /\bkann ich (dir |ihnen |euch |das |dazu |hierzu |diese frage )*(leider )?nicht\b/i,
  /\bwei(?:ß|ss) ich (leider )?nicht\b/i,
  /\bkeine (näheren |genaueren |weiteren |genauen )?(informationen|angaben|angabe|details|infos?|daten)\b/i,
  /\bliegen (mir|uns)\b[^.]*\bkeine\b/i,
  /\b(dazu|hierzu|darüber)\b[^.]*\bkein(e|en)?\b[^.]*\b(informationen|angaben|details|infos?)\b/i,
  /\bgeht\b[^.]*\bnicht hervor\b/i,
  /\bnicht ersichtlich\b/i,
  /\bsteht (leider )?nicht\b[^.]*\b(website|seite|kontext|hier)\b/i,
  /\bfinde ich (dazu |hierzu )?(leider )?(nichts|keine)\b/i,
  /\bwende dich\b[^.]*\b(team|unternehmen|direkt)\b/i,
  /\bwenden sie sich\b[^.]*\b(team|unternehmen|direkt)\b/i,
  // Englisch
  /\bcan(?:'|no|)?t (help|answer|find|provide)\b/i,
  /\bdon'?t have (enough |any |the )?(information|details|data)\b/i,
  /\bno (information|details) (available|about|on)\b/i,
  /\b(unable|not able) to (help|answer|find|provide)\b/i,
  /\bnot (mentioned|available|specified|listed|provided)\b[^.]*\b(website|page|context)\b/i,
];

/** True, wenn die generierte Antwort wie eine inhaltliche Absage aussieht. */
export function looksLikeNonAnswer(answer: string): boolean {
  const t = answer.trim();
  if (!t) return false; // leer = technischer Abbruch, kein Content-Gap
  return NON_ANSWER_PATTERNS.some((re) => re.test(t));
}

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
  /**
   * Bisheriger Gesprächsverlauf (Prompt 15 #3) — chronologisch, OHNE die aktuelle
   * Frage. Wird genutzt, um kurze Folgefragen ("nein größer") zu verstehen: fürs
   * Retrieval (vorige Nutzerfrage anreichern) und als Kontext im LLM-Prompt.
   */
  history?: HistoryTurn[];
}

export async function* answerQuestion(
  bot: BotRow,
  question: string,
  onMeta?: (meta: AnswerMeta) => void,
  opts?: AnswerOptions,
): AsyncGenerator<string> {
  const storeContent = opts?.storeContent !== false; // Default: loggen (Cron/Tests)
  const ipHash = opts?.ipHash ?? null;
  const history = opts?.history ?? [];
  const started = Date.now();
  const branding = safeParseBranding(bot.branding);
  // Trial-Kontingent nur belasten, wenn tatsächlich der Trial-Key genutzt wird.
  const trialUsed = isTrialActive(bot);

  // Gesprächskontext fürs Retrieval (Prompt 15 #3a): Bei kurzen Folgefragen
  // ("nein größer", "und günstiger?") fehlt der Suchbegriff. Dann die vorige
  // Nutzernachricht voranstellen, damit Vektor- UND Zahlensuche das gemeinte Thema
  // treffen. Bei ausreichend langen Fragen unverändert (retrievalText == question).
  const prevUser = lastUserTurn(history);
  const retrievalText =
    isShortQuery(question) && prevUser ? `${prevUser}\n${question}` : question;

  // 1) + 2) Query lokal embedden (kein Chat-Key nötig). kind="query" für e5.
  const [qEmb] = await embed([retrievalText], "query");

  // 2a) Manuelle FAQ mit Vorrang (Prompt 14 #5): Bei sehr starker Übereinstimmung
  // die redaktionelle Antwort WÖRTLICH ausgeben — garantiert die gewünschte
  // Formulierung und kostet keinen LLM-Token. Recrawl-fest, da manual_faqs eine
  // eigene Tabelle ist, die der Crawler nicht anfasst.
  const faqMatch = await matchManualFaq(bot.id, qEmb);
  if (faqMatch && faqMatch.distance <= FAQ_MATCH_DISTANCE) {
    const answerText = faqMatch.faq.answer;
    onMeta?.({ answered: true, sources: [], topScore: faqMatch.distance, provider: "faq" });
    if (storeContent) {
      insertChatLog({
        botId: bot.id,
        question,
        answer: answerText,
        answered: true,
        topScore: faqMatch.distance,
        provider: "faq",
        latencyMs: Date.now() - started,
        ipHash,
      });
    }
    yield answerText;
    return;
  }

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

  // Preis-/Kostenfragen: Preistabellen sind terse und matchen knappe Fragen
  // ("Preis B17", "wie viel kostet das") semantisch schlecht. Zusätzlich mit einer
  // kanonischen Preis-Query suchen und zusammenführen — auch wenn KEINE Zahl in der
  // Frage steht (die numerische Suche aus Prompt 14 greift dann nicht).
  if (isPriceIntent(question)) {
    const [augEmb] = await embed([PRICE_QUERY], "query");
    hits = mergeHits(hits, searchChunks(bot.id, augEmb, TOP_K), TOP_K);
  }

  // Numerische Zusatzsuche (Prompt 14 #2): Enthält die Frage Zahlen-Filter
  // (m²/qm, €, PLZ), matchen diese semantisch oft schlecht. Dann zusätzlich nach
  // Chunks mit passenden Zahlenwerten (in Toleranz) suchen und als hochrelevante
  // Treffer einmischen — so wird z. B. ein Immobilienobjekt mit ~320 m² gefunden,
  // auch wenn die reine Vektorsuche es verfehlt.
  const numHits = numericSearch(bot.id, retrievalText);
  if (numHits.length) hits = mergeHits(hits, numHits, TOP_K);

  const topScore = hits.length ? hits[0].distance : null;

  // 3) Nichts Relevantes gefunden -> ehrliche Absage OHNE LLM (kein Chat-Provider nötig).
  if (!hits.length || hits[0].distance > RELEVANCE_DISTANCE) {
    // Bei einer kurzen/mehrdeutigen Folgefrage (Verlauf vorhanden, aber trotz
    // Anreicherung nichts gefunden) aktiv nachfragen statt pauschal abzusagen
    // (Prompt 15 #3b). Sonst die normale ehrliche Absage.
    const ambiguous = history.length > 0 && isShortQuery(question);
    const reply = ambiguous ? CLARIFY_ANSWER : FALLBACK_ANSWER;
    onMeta?.({ answered: false, sources: [], topScore, provider: "none" });
    if (storeContent) {
      insertChatLog({
        botId: bot.id,
        question,
        answer: reply,
        answered: false,
        topScore,
        provider: "none",
        latencyMs: Date.now() - started,
        ipHash,
      });
    }
    yield reply;
    return;
  }

  // 4) Kontext bauen und Chat-Provider (Haiku 4.5 / Kunden-Key) jetzt erzeugen.
  const provider = getProviderForBot(bot);
  const contextHits = hits.filter((h) => h.distance <= CONTEXT_DISTANCE);
  const sources = dedupeSources(contextHits);
  onMeta?.({ answered: true, sources, topScore, provider: provider.id });

  const system = buildSystemPrompt({
    botName: branding.botName,
    styleSample: bot.style_sample ?? undefined,
  });
  // Nur die letzten 2 Turns mitgeben — genug fürs Verständnis kurzer Folgefragen,
  // ohne den Prompt (und die Tokens) aufzublähen.
  const userMessage = buildUserMessage(
    formatContext(contextHits),
    question,
    history.slice(-2),
  );

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
    // answered hängt NICHT nur an der Retrieval-Schwelle, sondern auch am tatsächlichen
    // Antwortinhalt: sagt das LLM trotz gefundenem Kontext inhaltlich ab ("kann ich anhand
    // der Website nicht beantworten", "wende dich ans Team"), zählt das als unbeantwortet
    // (Prompt 14 #4 — sonst fehlen diese Content-Lücken in der Analytics).
    if (storeContent) {
      insertChatLog({
        botId: bot.id,
        question,
        answer: full || null,
        answered: !looksLikeNonAnswer(full),
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
