/**
 * Anthropic-Provider (Premium / Bring-your-own-Key + Trial).
 *
 * Chat läuft über die Anthropic Messages API (Streaming). Embeddings delegieren
 * an den lokalen Ollama-Embedder (Anthropic bietet keine Embeddings-API und der
 * Vektor-Index muss dimensionskonstant bleiben — siehe types.ts).
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config.js";
import type { ChatOptions, LLMProvider, ProviderId } from "../types.js";
import { ProviderUnavailableError } from "../types.js";
import { embed as localEmbed } from "../embedder.js";

export class AnthropicProvider implements LLMProvider {
  readonly id: ProviderId = "anthropic";
  readonly chatModel: string;
  readonly embedModel: string = config.EMBEDDING_MODEL;
  private client: Anthropic;

  constructor(apiKey: string, chatModel?: string) {
    if (!apiKey) throw new Error("AnthropicProvider benötigt einen API-Key.");
    this.client = new Anthropic({ apiKey });
    this.chatModel = chatModel || config.ANTHROPIC_DEFAULT_MODEL;
  }

  embed(texts: string[]): Promise<number[][]> {
    return localEmbed(texts);
  }

  async *streamAnswer(opts: ChatOptions): AsyncIterable<string> {
    try {
      const stream = this.client.messages.stream({
        model: this.chatModel,
        max_tokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.2,
        system: opts.system,
        messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield event.delta.text;
        }
      }
    } catch (err) {
      throw new ProviderUnavailableError("Anthropic-API-Aufruf fehlgeschlagen.", err);
    }
  }

  async generateAnswer(opts: ChatOptions): Promise<string> {
    let full = "";
    for await (const piece of this.streamAnswer(opts)) full += piece;
    return full;
  }
}
