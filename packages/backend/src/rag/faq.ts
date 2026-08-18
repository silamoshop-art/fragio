/**
 * Matching für manuelle FAQ-Antworten (Prompt 14 #5).
 *
 * Redaktionell gepflegte Frage/Antwort-Paare (Tabelle manual_faqs) werden bei der
 * Anfrage-Verarbeitung VORRANGIG berücksichtigt: passt die Besucherfrage stark zu
 * einer FAQ, wird deren Antwort wörtlich ausgegeben (garantiert die gewünschte
 * Formulierung, spart LLM-Tokens). Bei mittlerer Ähnlichkeit fließt die FAQ als
 * hochrelevanter Kontext in die normale RAG-Antwort ein.
 *
 * Das Matching nutzt denselben lokalen Embedder wie die Chunk-Suche. Die FAQ-Frage
 * wird als "passage" eingebettet, die Besucherfrage als "query" — analog zur
 * Chunk-Retrieval-Kalibrierung, damit dieselben Distanz-Schwellen gelten.
 */
import type { ManualFaqRow } from "../db/repo.js";
import { listManualFaqs } from "../db/repo.js";
import { embed } from "../llm/embedder.js";

export interface FaqMatch {
  faq: ManualFaqRow;
  distance: number; // Cosine-Distanz in [0,2]; kleiner = ähnlicher
}

/** Cosine-Distanz für L2-normalisierte Vektoren (= 1 - Skalarprodukt). */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return 1 - dot;
}

/**
 * Beste manuelle FAQ zur Besucherfrage (per Embedding-Ähnlichkeit) — oder null,
 * wenn der Bot keine FAQs hat. Die Distanz-Schwellen wertet der Aufrufer aus.
 */
export async function matchManualFaq(
  botId: string,
  queryEmbedding: number[],
): Promise<FaqMatch | null> {
  const faqs = listManualFaqs(botId);
  if (faqs.length === 0) return null;
  const embs = await embed(
    faqs.map((f) => f.question),
    "passage",
  );
  let best: FaqMatch | null = null;
  for (let i = 0; i < faqs.length; i++) {
    const d = cosineDistance(queryEmbedding, embs[i]);
    if (!best || d < best.distance) best = { faq: faqs[i], distance: d };
  }
  return best;
}
