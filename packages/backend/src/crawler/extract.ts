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
