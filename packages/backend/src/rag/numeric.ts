/**
 * Numerische Zusatzsuche (Prompt 14 #2).
 *
 * Problem: Die semantische Vektorsuche ist schlecht darin, exakte/numerische
 * Filterkriterien zu matchen (z. B. "Objekt mit rund 320 m²", Preisspannen, PLZ).
 * Sie basiert auf Bedeutungsähnlichkeit, nicht auf Zahlenvergleich — "320 m²" und
 * "319 m²" liegen semantisch nicht zwangsläufig nah beieinander.
 *
 * Lösung (ohne Re-Embedding, arbeitet auf dem bestehenden Index): Enthält die
 * Frage erkennbare Zahlen mit Einheit (m²/qm, €, PLZ) oder markante Zahlen, werden
 * die Chunks des Bots zusätzlich nach Zahlenwerten in der NÄHE des gesuchten Werts
 * durchsucht (Toleranz je nach Art) und als hochrelevante Treffer eingespeist.
 */
import type { ChunkHit } from "../db/repo.js";
import { allChunksForBot } from "../db/repo.js";

type NumKind = "area" | "price" | "plz" | "generic";

export interface NumericCriterion {
  value: number;
  kind: NumKind;
}

/** Deutsche Zahl ("1.234,5" / "1 234" / "320") in einen JS-Number wandeln. */
function parseDeNumber(raw: string): number {
  let s = raw.replace(/\s/g, "");
  // Tausenderpunkte entfernen, Dezimalkomma zu Punkt.
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (/\.\d{3}(\D|$)/.test(s + " ")) {
    s = s.replace(/\./g, "");
  }
  return parseFloat(s);
}

/**
 * Erkennt Zahlen-Filterkriterien in einem Text (Frage ODER Chunk-Inhalt).
 * Einheit vor ODER nach der Zahl wird berücksichtigt (m², qm, €, EUR).
 */
export function extractNumericCriteria(text: string): NumericCriterion[] {
  const out: NumericCriterion[] = [];
  const seen = new Set<string>();
  const add = (value: number, kind: NumKind) => {
    if (!isFinite(value)) return;
    const key = kind + ":" + value;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ value, kind });
  };

  const numPat = "\\d{1,3}(?:[.\\s]\\d{3})*(?:,\\d+)?|\\d+(?:,\\d+)?";

  // Fläche: "320 m²", "320m2", "320 qm", "ca. 320 Quadratmeter".
  // Kein trailing \b: nach "²" gibt es keine Wortgrenze; (?![a-z0-9]) verhindert
  // trotzdem, dass "m2000" o. Ä. mitgezogen wird.
  const areaRe = new RegExp(`(${numPat})\\s*(?:m²|m2|qm|quadratmeter)(?![a-z0-9])`, "gi");
  // Preis: "450.000 €", "€ 450000", "450000 EUR", "1,2 Mio €". Ebenfalls kein
  // trailing \b (nach "€" keine Wortgrenze).
  const priceRe = new RegExp(
    `(?:€|eur|euro)\\s*(${numPat})|(${numPat})\\s*(?:€|eur|euro)(?![a-z])`,
    "gi",
  );
  // PLZ: 4- (AT) oder 5-stellig (DE), als eigenständige Zahl.
  const plzRe = /\b(\d{4,5})\b/g;

  let m: RegExpExecArray | null;
  while ((m = areaRe.exec(text))) add(parseDeNumber(m[1]), "area");
  while ((m = priceRe.exec(text))) add(parseDeNumber(m[1] ?? m[2]), "price");
  while ((m = plzRe.exec(text))) add(parseDeNumber(m[1]), "plz");

  return out;
}

/** Toleranz je Art: absolute Nähe, die noch als "passend" gilt. */
function tolerance(c: NumericCriterion): number {
  switch (c.kind) {
    case "area":
      return Math.max(3, c.value * 0.05); // ±5 %, mind. ±3 m²
    case "price":
      return Math.max(1000, c.value * 0.1); // ±10 %, mind. ±1000
    case "plz":
      return 0; // exakt
    default:
      return 0;
  }
}

/**
 * Bewertet einen Chunk gegen die Frage-Kriterien und liefert einen "Score" in
 * [0,1] (1 = perfekter Zahlen-Match) oder 0 (kein Match). Ein Chunk gilt als
 * Treffer, wenn er zu MINDESTENS einem Frage-Kriterium eine Zahl gleicher Art in
 * Toleranz enthält. Exakte Treffer werden höher gewichtet als knappe.
 */
function scoreChunk(content: string, criteria: NumericCriterion[]): number {
  const chunkNums = extractNumericCriteria(content);
  if (chunkNums.length === 0) return 0;
  let best = 0;
  for (const q of criteria) {
    const tol = tolerance(q);
    for (const cn of chunkNums) {
      if (cn.kind !== q.kind) continue;
      const diff = Math.abs(cn.value - q.value);
      if (diff <= tol) {
        // 1.0 bei exaktem Treffer, linear abnehmend bis knapp an der Toleranzgrenze.
        const s = tol === 0 ? 1 : 1 - (diff / tol) * 0.5;
        if (s > best) best = s;
      }
    }
  }
  return best;
}

/**
 * Numerische Treffer als ChunkHit-Liste (mit synthetischer, kleiner Distanz, damit
 * sie beim Merge mit der Vektorsuche als hochrelevant behandelt werden). Gibt eine
 * leere Liste zurück, wenn die Frage keine verwertbaren Zahlen enthält.
 */
export function numericSearch(botId: string, question: string, limit = 4): ChunkHit[] {
  const criteria = extractNumericCriteria(question);
  if (criteria.length === 0) return [];

  const scored: { hit: ChunkHit; score: number }[] = [];
  for (const c of allChunksForBot(botId)) {
    const score = scoreChunk(c.content, criteria);
    if (score > 0) {
      // Distanz aus Score ableiten: hoher Score -> kleine Distanz (0.02 … 0.12).
      scored.push({ hit: { ...c, distance: 0.12 - score * 0.1 }, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.hit);
}
