/**
 * PDF-Inhalte beim Crawlen mit auslesen (Prompt 16 #2).
 *
 * Viele Firmenwebsites (v. a. Fahrschulen) hinterlegen wichtige Infos wie
 * Preislisten NICHT als HTML-Text, sondern als verlinkte PDF-Datei. Dieses Modul
 * lädt ein (same-site, SSRF-geprüftes) PDF herunter, extrahiert den Text und gibt
 * ihn zurück — der Aufrufer behandelt ihn wie normalen Seitentext (chunk/embed/
 * speichern), mit der PDF-URL als Quelle.
 *
 * Robustheit: Größenlimit, Content-Type-Prüfung, und bei nicht lesbaren PDFs
 * (gescannte Bilder ohne Textebene, passwortgeschützt, korrupt) sauberes null
 * statt einer Exception, damit der Gesamt-Crawl nicht abbricht.
 */
import { createRequire } from "node:module";
import { checkPublicHttpUrl } from "../util/url-guard.js";
import { CRAWLER_UA } from "./crawl.js";

// pdf-parse hat im Haupt-Entry einen bekannten Bug (führt beim Import eine
// Test-Datei aus, wenn kein module.parent existiert — bricht unter ESM). Deshalb
// direkt das innere Modul via createRequire laden (Standard-Workaround).
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
  buf: Buffer,
) => Promise<{ text: string; numpages: number }>;

/** Obergrenze pro PDF (Speicher-/Zeitschutz). */
export const MAX_PDF_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * PDF laden + Text extrahieren. Gibt den bereinigten Text zurück, oder null, wenn
 * das PDF nicht erreichbar, zu groß, kein echtes PDF oder nicht lesbar ist.
 */
export async function fetchAndExtractPdf(url: string): Promise<string | null> {
  // SSRF-Schutz: nur öffentliche http(s)-Ziele (keine internen/privaten Adressen).
  if (!checkPublicHttpUrl(url).ok) return null;

  let res: Response;
  try {
    res = await fetch(url, { headers: { "user-agent": CRAWLER_UA }, redirect: "follow" });
  } catch {
    return null; // Netzwerkfehler/Timeout -> überspringen
  }
  if (!res.ok) return null;

  // Content-Type grob prüfen (application/pdf); manche Server liefern octet-stream.
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const looksPdf = ct.includes("pdf") || ct.includes("octet-stream") || /\.pdf(\?|$)/i.test(url);
  if (!looksPdf) return null;

  // Größenlimit: schon per Content-Length früh abbrechen, wenn bekannt.
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > MAX_PDF_BYTES) return null;

  let buf: Buffer;
  try {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_PDF_BYTES) return null;
    buf = Buffer.from(ab);
  } catch {
    return null;
  }
  // Muss mit der PDF-Signatur "%PDF" beginnen (sonst z. B. HTML-Fehlerseite).
  if (buf.length < 5 || buf.toString("latin1", 0, 5) !== "%PDF-") return null;

  try {
    const data = await pdfParse(buf);
    const text = (data.text || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    // Gescannte PDFs ohne Textebene liefern (fast) leeren Text -> als unlesbar behandeln.
    return text.length >= 40 ? text : null;
  } catch {
    return null; // passwortgeschützt / korrupt / nicht parsebar
  }
}
