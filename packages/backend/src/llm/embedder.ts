/**
 * Lokaler In-Process-Embedder via @xenova/transformers (KEIN Ollama, kein API-Key).
 *
 * Lädt beim ersten Aufruf ein mehrsprachiges Satz-Embedding-Modell (ONNX) in den
 * Node-Prozess und cached es. Mean-Pooling + L2-Normalisierung liefern Vektoren,
 * die sich gut mit der Cosine-Distanz von sqlite-vec vertragen.
 *
 * Alle Provider (auch die Hosted-Chat-Provider) nutzen diesen Embedder, damit der
 * gemeinsame Vektor-Index eine konstante Dimension behält (siehe types.ts).
 *
 * Hinweis: Beim ALLERERSTEN Aufruf werden die Modellgewichte von HuggingFace
 * geladen und lokal gecached (Netzwerk nötig). Danach läuft es offline.
 */
import { config } from "../config.js";

// Der Typ von `pipeline` wird dynamisch importiert, daher hier locker gehalten.
type FeatureExtractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<FeatureExtractor> | null = null;

async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      // Dynamischer Import (reines ESM-Paket).
      const { pipeline, env } = await import("@xenova/transformers");
      // Nur Remote-Modelle vom Hub laden; lokaler Cache unter node_modules/.cache.
      env.allowLocalModels = false;
      const pipe = await pipeline("feature-extraction", config.EMBEDDING_MODEL);
      return pipe as unknown as FeatureExtractor;
    })();
  }
  return extractorPromise;
}

/**
 * Texte -> Embeddings (Reihenfolge bleibt erhalten).
 * `kind` steuert das e5-Präfix: indexierte Chunks = "passage", Suchfragen = "query".
 * (Bei Nicht-e5-Modellen sind die Präfixe unschädlich, aber e5 braucht sie für
 *  gute Trennung zwischen relevanten und irrelevanten Treffern.)
 */
export async function embed(
  texts: string[],
  kind: "query" | "passage" = "passage",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const prefixed = config.EMBEDDING_MODEL.includes("e5")
    ? texts.map((t) => `${kind}: ${t}`)
    : texts;
  const output = await extractor(prefixed, { pooling: "mean", normalize: true });
  return output.tolist();
}

/** Signatur des aktuellen Embedding-Setups (für Index-Reset bei Modellwechsel). */
export function embedSignature(): string {
  return `${config.EMBEDDING_MODEL}:${config.EMBEDDING_DIM}`;
}
