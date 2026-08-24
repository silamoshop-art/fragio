/**
 * PDF-Inhalte beim Crawlen mit auslesen (Prompt 16 #2) — mit TABELLEN-Rekonstruktion
 * (Prompt 17 #2).
 *
 * Viele Firmen (v. a. Fahrschulen) hinterlegen Preise als PDF-Preisliste, oft als
 * MATRIX-Tabelle (Führerscheinklassen als Spalten, Leistungen als Zeilen). Eine
 * naive Fließtext-Extraktion (wie pdf-parse) verklebt die Zahlen und zerstört den
 * Zeilen-/Spaltenbezug ("2117,001697,00…759,00" ohne erkennbare Klasse).
 *
 * Deshalb positionsbasiert via pdfjs-dist: jedes Text-Item hat x/y-Koordinaten.
 * Wir gruppieren nach Zeilen (y), trennen Zellen anhand horizontaler Lücken und —
 * wenn eine Tabelle erkannt wird — leiten Spalten aus der saubersten Zahlenzeile ab
 * und geben pro Zelle einen "Zeile — Spaltenüberschrift: Wert"-Datensatz aus. So
 * bleibt z. B. "Ausbildung komplett — F: 759,00" als auffindbare Aussage erhalten.
 *
 * Robustheit: Größenlimit, Signatur-Check, und bei nicht lesbaren PDFs (gescannte
 * Bilder, passwortgeschützt, korrupt) sauberes null statt Exception.
 */
import { checkPublicHttpUrl } from "../util/url-guard.js";
import { CRAWLER_UA } from "./crawl.js";

/** Obergrenze pro PDF (Speicher-/Zeitschutz). */
export const MAX_PDF_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * PDF laden + Text (inkl. rekonstruierter Tabellen) extrahieren. Gibt den Text
 * zurück oder null, wenn das PDF nicht erreichbar, zu groß, kein echtes PDF oder
 * nicht lesbar ist.
 */
export async function fetchAndExtractPdf(url: string): Promise<string | null> {
  if (!checkPublicHttpUrl(url).ok) return null; // SSRF-Schutz

  let res: Response;
  try {
    res = await fetch(url, { headers: { "user-agent": CRAWLER_UA }, redirect: "follow" });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const looksPdf = ct.includes("pdf") || ct.includes("octet-stream") || /\.pdf(\?|$)/i.test(url);
  if (!looksPdf) return null;

  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > MAX_PDF_BYTES) return null;

  let bytes: Uint8Array;
  try {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_PDF_BYTES) return null;
    bytes = new Uint8Array(ab);
  } catch {
    return null;
  }
  if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return null;

  try {
    return await extractPdfStructured(bytes);
  } catch {
    return null; // passwortgeschützt / korrupt / nicht parsebar
  }
}

interface Item {
  s: string;
  x: number;
  xEnd: number; // echtes Zeilenende (x + Item-Breite) für zuverlässige Spalten-Lücken
  y: number;
}

/** Ganzes PDF positionsbasiert extrahieren (Seite für Seite, mit Tabellen-Rekonstruktion). */
async function extractPdfStructured(data: Uint8Array): Promise<string | null> {
  // Dynamischer Import: reines ESM-Paket, legacy-Build läuft in Node.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    // Kein Worker in Node (verhindert Worker-Setup-Fehler).
    disableFontFace: true,
  } as never).promise;

  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items: Item[] = (tc.items as { str: string; transform: number[]; width?: number }[])
      .map((i) => ({
        s: i.str.replace(/\s+/g, " ").trim(),
        x: Math.round(i.transform[4]),
        xEnd: Math.round(i.transform[4] + (i.width ?? 0)),
        y: Math.round(i.transform[5]),
      }))
      .filter((i) => i.s);
    if (items.length) pages.push(reconstructPage(items));
    if (typeof (page as { cleanup?: () => void }).cleanup === "function") (page as { cleanup: () => void }).cleanup();
  }
  await (doc as { destroy?: () => Promise<void> }).destroy?.();

  const text = pages.join("\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length >= 40 ? text : null;
}

const NUM_RE = /^\d[\d.]*,\d{2}$/; // deutsche Geldzahl, z. B. 759,00 / 1.697,00

/**
 * Eine Seite rekonstruieren: Zeilen aus y-Positionen, Zellen aus x-Lücken. Wird
 * eine Matrix-Tabelle erkannt (eine Zeile mit ≥3 Geldzahlen), zusätzlich pro Zelle
 * ein "Zeile — Spaltenüberschrift: Wert"-Datensatz erzeugt.
 */
function reconstructPage(items: Item[]): string {
  // Zeilen nach y (oben→unten), innerhalb der Zeile nach x.
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Item[][] = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last[0].y - it.y) <= 3) last.push(it);
    else rows.push([it]);
  }
  rows.forEach((r) => r.sort((a, b) => a.x - b.x));

  // 1) Zeilenweise Rekonstruktion mit Zell-Trennung (de-glued): " | " bei Lücke.
  const lines = rows.map((r) => {
    let out = "";
    let prevEnd = -1e9;
    for (const c of r) {
      const gap = c.x - prevEnd;
      // Nur bei DEUTLICHER Lücke (echte Spalten-/Tabellengrenze) trennen — normale
      // Wortabstände im Fließtext bleiben ein Leerzeichen.
      out += (prevEnd > -1e9 && gap > 14 ? " | " : out ? " " : "") + c.s;
      prevEnd = c.xEnd;
    }
    return out.trim();
  });

  // 2) Spalten aus der saubersten Zahlenzeile ableiten (robuster als x-Clustering
  //    über alle Items, da Header/Labels den Raum kontinuierlich füllen).
  let valRow: Item[] = [];
  for (const r of rows) {
    const n = r.filter((c) => NUM_RE.test(c.s)).length;
    if (n > valRow.filter((c) => NUM_RE.test(c.s)).length) valRow = r;
  }
  const centers = valRow.filter((c) => NUM_RE.test(c.s)).map((c) => c.x).sort((a, b) => a - b);

  if (centers.length < 3) return lines.join("\n"); // keine Tabelle -> nur Fließtext

  // Header pro Spalte: nächstgelegenes Nicht-Zahl-Item aus der Kopfregion
  // (oberhalb der Wertezeile). Bei mehrzeiligen/verschachtelten Headern
  // unscharf, für die klar stehenden Klassenspalten (z. B. "F") aber korrekt.
  const headerY = valRow[0].y;
  const headerItems = items.filter((i) => i.y > headerY && !NUM_RE.test(i.s));
  const colHeader = centers.map((cx) => {
    let best = "";
    let bd = 30; // max. 30px Abstand
    for (const h of headerItems) {
      const d = Math.abs(h.x - cx);
      if (d < bd) {
        bd = d;
        best = h.s;
      }
    }
    return best;
  });
  const nearCol = (x: number) => centers.reduce((bi, cx, i) => (Math.abs(cx - x) < Math.abs(centers[bi] - x) ? i : bi), 0);
  const minCol = Math.min(...centers);

  // 3) Pro Datenzeile (hat ein Label links der ersten Wertespalte) je Wert einen
  //    "Label — SpaltenHeader: Wert"-Datensatz. So bleibt die Zuordnung erhalten,
  //    auch wenn ein Chunk mitten in der Tabelle geschnitten würde.
  const records: string[] = [];
  for (const r of rows) {
    const labelCells = r.filter((c) => c.x < minCol - 20 && !NUM_RE.test(c.s));
    const label = labelCells.map((c) => c.s).join(" ").replace(/^[=\s]+/, "").trim();
    if (!label) continue;
    const values = r.filter((c) => c.x >= minCol - 30 && (NUM_RE.test(c.s) || /^\d+$/.test(c.s)));
    for (const v of values) {
      const h = colHeader[nearCol(v.x)];
      records.push(h ? `${label} — ${h}: ${v.s}` : `${label}: ${v.s}`);
    }
  }

  const table = lines.join("\n");
  return records.length ? `${table}\n\nStrukturierte Werte:\n${records.join("\n")}` : table;
}
