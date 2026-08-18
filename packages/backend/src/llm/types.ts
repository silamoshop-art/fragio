/**
 * LLM-Provider-Abstraktion (zentrale Anforderung).
 *
 * Ein Bot wählt seine "Engine" (local | anthropic | openai). Der gesamte
 * RAG-Pipeline-Code spricht nur gegen dieses Interface — nie direkt gegen eine
 * konkrete API. So ist der Provider pro Bot austauschbar (kostenloser lokaler
 * Modus vs. Bring-your-own-Key vs. Trial).
 *
 * WICHTIG — Embeddings sind vom Chat-Provider ENTKOPPELT:
 * Der Vektor-Index (vec_chunks) hat eine feste Dimension (config.EMBEDDING_DIM).
 * Würde Bot A mit OpenAI (1536 Dim) und Bot B mit nomic-embed-text (768 Dim)
 * indexieren, wäre der gemeinsame Index inkonsistent. Außerdem MUSS die Frage
 * mit demselben Modell embeddet werden wie die indexierten Chunks.
 * Deshalb laufen ALLE Embeddings über den lokalen Provider (kostenlos, konstante
 * Dimension). `embed()` der Hosted-Provider delegiert an den lokalen Embedder.
 * Der Chat-Provider (generateAnswer/streamAnswer) bleibt frei wählbar.
 */

// "local" = Server-Standard-Engine (i. d. R. Anthropic Haiku); "ollama" = erzwungen
// lokales Modell auf dem eigenen Server (Datenschutz-Option, keine US-Übermittlung).
export type ProviderId = "local" | "anthropic" | "openai" | "ollama";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  /** System-Prompt — strikt getrennt von Nutzereingaben (Prompt-Injection-Schutz). */
  system: string;
  /** Konversationsverlauf; letzte Nachricht ist die aktuelle Nutzerfrage. */
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface LLMProvider {
  /** Welcher Provider für die Chat-Generierung genutzt wird. */
  readonly id: ProviderId;
  /** Konkretes Chat-Modell (z. B. "phi3", "claude-haiku-4-5-…", "gpt-4o-mini"). */
  readonly chatModel: string;
  /** Embedding-Modell (immer lokal, konstante Dimension). */
  readonly embedModel: string;

  /** Texte -> Embeddings. Reihenfolge bleibt erhalten. Immer lokal. */
  embed(texts: string[]): Promise<number[][]>;

  /** Antwort als Token-Stream (gute UX). */
  streamAnswer(opts: ChatOptions): AsyncIterable<string>;

  /** Antwort am Stück (sammelt intern den Stream). */
  generateAnswer(opts: ChatOptions): Promise<string>;
}

/** Fehler, der signalisiert: Hosted-API nicht verfügbar -> ggf. Fallback auf lokal. */
export class ProviderUnavailableError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}
