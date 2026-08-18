/**
 * Crawl-&-Index-Orchestrierung: URL rein -> Wissensbasis in der DB raus.
 *
 * Ablauf pro Bot:
 *   crawl() -> extractContent() -> chunkText() -> provider.embed() -> repo.insertChunk()
 *
 * Embeddings laufen über den lokalen Provider (siehe llm/types.ts). Vor dem
 * (Re-)Crawl wird die bestehende Wissensbasis des Bots gelöscht.
 */
import { crawl, type CrawlProgress } from "./crawl.js";
import { extractContent, estimateTokens } from "./extract.js";
import { chunkText } from "./chunk.js";
import { embed } from "../llm/embedder.js";
import type { BotRow } from "../db/repo.js";
import {
  clearBotKnowledge,
  upsertPage,
  insertChunk,
  setLastCrawledAt,
} from "../db/repo.js";
import { sha256 } from "../util/id.js";

// Obergrenze Chunks pro Seite (Balance in der Wissensbasis, s. u.).
const MAX_CHUNKS_PER_PAGE = 8;

// Rechtliche Boilerplate-Seiten NICHT indexieren: Datenschutz/AGB/Cookies etc.
// sind lang, selten Support-Themen und "kapern" die Suche (sie reden über
// E-Mail/Kontakt/Daten und verdrängen die echte Kontakt-/Impressum-Seite).
// Das Impressum bleibt drin (enthält die echten Kontaktdaten).
const SKIP_INDEX_PATH =
  /(datenschutz|privacy|datenschutzerkl|agb|terms|nutzungsbedingungen|widerruf|cookie|gtc)/i;

export interface IndexProgress extends CrawlProgress {
  phase: "crawling" | "indexing" | "done";
  chunks: number;
}

export interface IndexResult {
  pages: number;
  chunks: number;
}

export async function crawlAndIndex(
  bot: BotRow,
  onProgress?: (p: IndexProgress) => void,
): Promise<IndexResult> {
  if (!bot.crawl_start_url) throw new Error("Bot hat keine crawl_start_url.");

  // 1) Crawlen
  const pages = await crawl(bot.crawl_start_url, {
    maxPages: bot.crawl_max_pages,
    onProgress: (p) =>
      onProgress?.({ ...p, phase: "crawling", chunks: 0 }),
  });

  // Schutz beim (Auto-)Recrawl: Lieferte der Crawl KEINE Seite (Website down,
  // blockiert, Timeout), NICHT den alten Index löschen — alten Stand behalten
  // und Fehler signalisieren (Anforderung: bei Fehlschlag nichts wegwerfen).
  if (pages.length === 0) {
    throw new Error("Keine Seiten gecrawlt (Website nicht erreichbar oder blockiert).");
  }

  // 2) Bestehende Wissensbasis ersetzen (frischer Index).
  clearBotKnowledge(bot.id);

  // 3a) Pass 1: alle Seiten extrahieren (rechtliche Boilerplate ausklammern).
  const extracted: { url: string; title: string; text: string }[] = [];
  for (const page of pages) {
    if (SKIP_INDEX_PATH.test(page.url)) continue;
    const { title, text } = extractContent(page.html);
    if (text) extracted.push({ url: page.url, title, text });
  }

  // 3b) Seitenübergreifendes Boilerplate ermitteln (Menü/Footer/Cookie-Zeilen, die
  //     auf vielen Seiten identisch vorkommen) und aus jedem Seitentext entfernen.
  const boilerplate = detectBoilerplateLines(extracted.map((e) => e.text));

  // 3c) Pass 2: bereinigen, chunking, embedden, speichern.
  let totalChunks = 0;
  let indexedPages = 0;
  for (const page of extracted) {
    const text = stripBoilerplate(page.text, boilerplate);
    if (text.length < 40) continue; // nach Bereinigung leer/trivial -> überspringen
    const title = page.title;

    upsertPage(bot.id, page.url, title || null, sha256(text));
    indexedPages++;

    let chunks = chunkText(text);
    if (chunks.length === 0) continue;
    // Chunks pro Seite deckeln: verhindert, dass eine sehr lange Seite (z. B. eine
    // ausführliche Datenschutzerklärung) die Wissensbasis dominiert und relevante
    // Inhalte anderer Seiten in der Suche verdrängt.
    if (chunks.length > MAX_CHUNKS_PER_PAGE) {
      chunks = chunks.slice(0, MAX_CHUNKS_PER_PAGE);
    }

    // Embeddings für alle Chunks der Seite auf einmal (lokal, In-Process).
    const embeddings = await embed(chunks);
    for (let i = 0; i < chunks.length; i++) {
      insertChunk(
        bot.id,
        chunks[i],
        embeddings[i],
        page.url,
        title || null,
        estimateTokens(chunks[i]),
      );
      totalChunks++;
    }

    onProgress?.({
      phase: "indexing",
      fetched: pages.length,
      queued: 0,
      currentUrl: page.url,
      chunks: totalChunks,
    });
  }

  setLastCrawledAt(bot.id, Date.now());
  onProgress?.({
    phase: "done",
    fetched: pages.length,
    queued: 0,
    currentUrl: "",
    chunks: totalChunks,
  });

  return { pages: indexedPages, chunks: totalChunks };
}

/**
 * Ermittelt "Boilerplate"-Zeilen: Textzeilen, die auf vielen Seiten identisch
 * vorkommen (Navigationsmenü, Footer, Cookie-Hinweis, Copyright etc.). Solche
 * Zeilen tragen keinen seitenspezifischen Inhalt, machen aber alle Seiten
 * ähnlich und verschlechtern die Suche — daher werden sie entfernt.
 *
 * Schwelle: eine Zeile gilt als Boilerplate, wenn sie auf >= 40 % der Seiten
 * (mindestens aber 3 Seiten) vorkommt.
 */
function detectBoilerplateLines(texts: string[]): Set<string> {
  const n = texts.length;
  const boiler = new Set<string>();
  if (n < 3) return boiler; // zu wenige Seiten für eine sinnvolle Erkennung
  const threshold = Math.max(3, Math.ceil(n * 0.4));
  const counts = new Map<string, number>();
  for (const t of texts) {
    const seenOnPage = new Set<string>();
    for (const raw of t.split("\n")) {
      const line = raw.trim();
      if (line.length < 3) continue;
      if (seenOnPage.has(line)) continue; // pro Seite nur einmal zählen
      seenOnPage.add(line);
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }
  for (const [line, c] of counts) if (c >= threshold) boiler.add(line);
  return boiler;
}

function stripBoilerplate(text: string, boiler: Set<string>): string {
  if (boiler.size === 0) return text.trim();
  return text
    .split("\n")
    .filter((l) => !boiler.has(l.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
