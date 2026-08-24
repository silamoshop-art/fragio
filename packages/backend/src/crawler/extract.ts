/**
 * HTML -> sauberer Text. Entfernt Navigation, Footer, Cookie-Banner, Skripte etc.
 * und liefert Haupttext + Titel. Nutzt Cheerio (serverseitiges jQuery-artiges DOM).
 */
import * as cheerio from "cheerio";

// Elemente, die praktisch nie Inhalt tragen, den ein Chatbot beantworten soll.
const STRIP_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
  // gängige Cookie-/Consent-/Menü-Muster (heuristisch per id/class-Substring)
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
  '[id*="gdpr" i]',
  '[class*="newsletter" i]',
  '[class*="breadcrumb" i]',
];

export interface ExtractedPage {
  title: string;
  text: string;
}

export function extractContent(html: string): ExtractedPage {
  const $ = cheerio.load(html);

  const title =
    $("title").first().text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("h1").first().text().trim() ||
    "";

  // Tabellen VOR dem generischen Text-Extrakt strukturiert umwandeln (Prompt 17 #1):
  // sonst reihen sich Zellen ohne Spaltenbezug aneinander und die Zuordnung
  // (z. B. Führerscheinklasse -> Preis) geht verloren. Jede Tabelle wird durch
  // aufeinanderfolgende <p>-Zeilen ersetzt (Markdown-Tabelle + "Zeile — Spalte: Wert"
  // Datensätze), damit die Zuordnung im Chunk-Text erhalten bleibt.
  $("table").each((_, el) => {
    const lines = tableToLines($, el);
    if (lines.length) {
      $(el).replaceWith(`<div>${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}</div>`);
    }
  });

  for (const sel of STRIP_SELECTORS) {
    $(sel).remove();
  }

  // Bevorzugt semantischen Hauptbereich; sonst gesamten Body.
  const root =
    $("main").first().length
      ? $("main").first()
      : $("article").first().length
        ? $("article").first()
        : $("body");

  // Blocktrennung: Überschriften/Absätze/Listenpunkte mit Zeilenumbrüchen versehen.
  root.find("h1,h2,h3,h4,h5,h6,p,li,tr,br").each((_, el) => {
    $(el).append("\n");
  });

  const raw = root.text();
  const text = normalizeWhitespace(raw);
  return { title, text };
}

/**
 * Eine HTML-Tabelle in strukturierte Zeilen umwandeln: eine Markdown-artige Tabelle
 * (Spaltenbezug bleibt sichtbar) PLUS pro Datenzelle einen "Zeilenlabel — Spalten-
 * überschrift: Wert"-Datensatz (auffindbar, auch wenn ein Chunk die Tabelle teilt).
 */
function tableToLines($: cheerio.CheerioAPI, table: unknown): string[] {
  const rows: string[][] = [];
  $(table as never)
    .find("tr")
    .each((_, tr) => {
      const cells: string[] = [];
      $(tr)
        .find("th,td")
        .each((__, cell) => {
          cells.push($(cell).text().replace(/\s+/g, " ").trim());
        });
      if (cells.some((c) => c)) rows.push(cells);
    });
  if (rows.length < 2) {
    // Keine echte Tabelle (oder Layout-Tabelle mit einer Zeile) -> als Zeile ausgeben.
    return rows.map((r) => r.filter(Boolean).join(" | "));
  }

  const headers = rows[0];
  const cols = Math.max(...rows.map((r) => r.length));
  const out: string[] = [];

  // Markdown-Tabelle (für die LLM-Lesbarkeit).
  out.push("| " + headers.map((h) => h || " ").join(" | ") + " |");
  out.push("| " + Array.from({ length: headers.length }, () => "---").join(" | ") + " |");
  for (let r = 1; r < rows.length; r++) {
    out.push("| " + Array.from({ length: cols }, (_, c) => rows[r][c] || " ").join(" | ") + " |");
  }

  // Pro-Zelle-Datensätze: Zeilenlabel (erste Zelle) — Spaltenüberschrift: Wert.
  out.push("Strukturierte Werte:");
  for (let r = 1; r < rows.length; r++) {
    const label = rows[r][0] || "";
    for (let c = 1; c < cols; c++) {
      const val = rows[r][c];
      if (!val) continue;
      const head = headers[c] || "";
      out.push(label ? `${label} — ${head}: ${val}` : `${head}: ${val}`);
    }
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Grobe Token-Schätzung ohne Tokenizer-Abhängigkeit (~4 Zeichen/Token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
