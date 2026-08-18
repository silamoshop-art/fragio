/**
 * Text in RAG-taugliche Chunks zerlegen (~300–500 Tokens) mit Overlap.
 *
 * Strategie: an Absätzen (Doppel-Zeilenumbruch) trennen; Absätze bis zur
 * Zielgröße akkumulieren. Zu große Absätze werden satzweise weiter zerlegt.
 * Overlap = die letzten paar Sätze werden in den nächsten Chunk übernommen,
 * damit Kontext an Chunk-Grenzen nicht verloren geht.
 */
import { estimateTokens } from "./extract.js";

export interface ChunkOptions {
  targetTokens?: number; // Zielgröße pro Chunk
  overlapTokens?: number; // ungefährer Overlap zwischen benachbarten Chunks
  minTokens?: number; // kleinere Rest-Chunks verwerfen (Rauschen)
}

const DEFAULTS: Required<ChunkOptions> = {
  targetTokens: 400,
  overlapTokens: 60,
  minTokens: 20,
};

function splitSentences(text: string): string[] {
  // einfache Satztrennung; für RAG völlig ausreichend
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const { targetTokens, overlapTokens, minTokens } = { ...DEFAULTS, ...opts };
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  // In Satz-Einheiten zerlegen, die nie größer als das Ziel sind.
  const units: string[] = [];
  for (const p of paragraphs) {
    if (estimateTokens(p) <= targetTokens) {
      units.push(p);
    } else {
      let buf = "";
      for (const sentence of splitSentences(p)) {
        if (buf && estimateTokens(buf + " " + sentence) > targetTokens) {
          units.push(buf);
          buf = sentence;
        } else {
          buf = buf ? buf + " " + sentence : sentence;
        }
      }
      if (buf) units.push(buf);
    }
  }

  // Einheiten bis zur Zielgröße zusammenfassen, mit Overlap.
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (currentTokens >= minTokens && current.length) {
      chunks.push(current.join("\n").trim());
    }
  };

  for (const unit of units) {
    const unitTokens = estimateTokens(unit);
    if (currentTokens + unitTokens > targetTokens && current.length) {
      flush();
      // Overlap aufbauen: letzte Einheiten übernehmen, bis overlapTokens erreicht.
      const overlap: string[] = [];
      let ot = 0;
      for (let i = current.length - 1; i >= 0 && ot < overlapTokens; i--) {
        overlap.unshift(current[i]);
        ot += estimateTokens(current[i]);
      }
      current = [...overlap];
      currentTokens = ot;
    }
    current.push(unit);
    currentTokens += unitTokens;
  }
  flush();

  return chunks;
}
