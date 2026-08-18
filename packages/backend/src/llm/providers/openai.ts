/**
 * OpenAI-Provider (Premium / Bring-your-own-Key).
 *
 * Chat über die Chat-Completions-API (Streaming). Embeddings delegieren bewusst
 * an den lokalen Ollama-Embedder, damit der gemeinsame Vektor-Index eine
 * konstante Dimension behält (siehe types.ts) — NICHT an OpenAI-Embeddings.
 */
import OpenAI from "openai";
import { config } from "../../config.js";
import type { ChatOptions, LLMProvider, ProviderId } from "../types.js";
import { ProviderUnavailableError } from "../types.js";
import { embed as localEmbed } from "../embedder.js";

export class OpenAIProvider implements LLMProvider {
  readonly id: ProviderId = "openai";
  readonly chatModel: string;
  readonly embedModel: string = config.EMBEDDING_MODEL;
  private client: OpenAI;

  constructor(apiKey: string, chatModel?: string) {
    if (!apiKey) throw new Error("OpenAIProvider benötigt einen API-Key.");
    this.client = new OpenAI({ apiKey });
    this.chatModel = chatModel || config.OPENAI_DEFAULT_MODEL;
  }

  embed(texts: string[]): Promise<number[][]> {
    return localEmbed(texts);
  }

  async *streamAnswer(opts: ChatOptions): AsyncIterable<string> {
    try {
      const stream = await this.client.chat.completions.create({
        model: this.chatModel,
        max_tokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.2,
        stream: true,
        messages: [
          { role: "system", content: opts.system },
          ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      });
      for await (const chunk of stream) {
        const piece = chunk.choices[0]?.delta?.content;
        if (piece) yield piece;
      }
    } catch (err) {
      throw new ProviderUnavailableError("OpenAI-API-Aufruf fehlgeschlagen.", err);
    }
  }

  async generateAnswer(opts: ChatOptions): Promise<string> {
    let full = "";
    for await (const piece of this.streamAnswer(opts)) full += piece;
    return full;
  }
}
