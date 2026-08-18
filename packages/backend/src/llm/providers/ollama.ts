/**
 * OPTIONALER lokaler Chat-Provider via Ollama.
 *
 * Nur aktiv, wenn DEFAULT_ENGINE="ollama" gesetzt ist. Standardmäßig antwortet
 * das Produkt über Claude Haiku 4.5 (siehe llm/index.ts). Embeddings laufen
 * IMMER über den In-Process-Embedder (embedder.ts), nicht mehr über Ollama.
 */
import { config } from "../../config.js";
import type { ChatOptions, LLMProvider, ProviderId } from "../types.js";
import { ProviderUnavailableError } from "../types.js";
import { embed as localEmbed } from "../embedder.js";

async function ollamaFetch(pathname: string, body: unknown): Promise<Response> {
  const url = `${config.OLLAMA_BASE_URL}${pathname}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderUnavailableError(
        `Ollama ${pathname} antwortete ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    return res;
  } catch (err) {
    if (err instanceof ProviderUnavailableError) throw err;
    throw new ProviderUnavailableError(
      `Ollama nicht erreichbar unter ${config.OLLAMA_BASE_URL}. Läuft der Dienst? (ollama serve)`,
      err,
    );
  }
}

export class OllamaProvider implements LLMProvider {
  readonly id: ProviderId = "ollama";
  readonly chatModel: string;
  readonly embedModel: string;

  constructor(chatModel?: string) {
    this.chatModel = chatModel || config.OLLAMA_CHAT_MODEL;
    this.embedModel = config.EMBEDDING_MODEL;
  }

  embed(texts: string[]): Promise<number[][]> {
    return localEmbed(texts);
  }

  async *streamAnswer(opts: ChatOptions): AsyncIterable<string> {
    const res = await ollamaFetch("/api/chat", {
      model: this.chatModel,
      stream: true,
      options: {
        temperature: opts.temperature ?? 0.2,
        num_predict: opts.maxTokens ?? 512,
      },
      messages: [
        { role: "system", content: opts.system },
        ...opts.messages,
      ],
    });

    if (!res.body) throw new ProviderUnavailableError("Ollama-Stream ohne Body.");

    // Ollama streamt NDJSON (eine JSON-Zeile pro Token-Batch).
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as {
            message?: { content?: string };
            done?: boolean;
          };
          const piece = obj.message?.content;
          if (piece) yield piece;
        } catch {
          // unvollständige Zeile ignorieren (sollte durch NDJSON nicht passieren)
        }
      }
    }
  }

  async generateAnswer(opts: ChatOptions): Promise<string> {
    let full = "";
    for await (const piece of this.streamAnswer(opts)) full += piece;
    return full;
  }
}
