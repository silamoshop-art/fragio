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
      // Review 2026-11-22 (NEU-1/P-002): AbortSignal als zweite Option übergeben,
      // damit der HTTP-Request bei Client-Disconnect wirklich abgebrochen wird
      // (sonst laufen Tokens + Kosten weiter, obwohl niemand mehr zuhört).
      const stream = this.client.messages.stream(
        {
          model: this.chatModel,
          max_tokens: opts.maxTokens ?? 512,
          temperature: opts.temperature ?? 0.2,
          // System-Prompt (Regeln/Branding) ist pro Bot stabil und wird bei jeder Frage
          // unverändert erneut gesendet -> Prompt-Caching spart Input-Tokens (~90 % auf
          // Cache-Reads). Liegt der Prefix unter der Cache-Mindestgröße, ignoriert die
          // API cache_control folgenlos (kein Risiko). Kontext/Frage stehen in messages.
          system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
          messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
        },
        opts.signal ? { signal: opts.signal } : undefined,
      );
      for await (const event of stream) {
        if (opts.signal?.aborted) break;
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield event.delta.text;
        }
      }
    } catch (err) {
      // AbortError durch Client-Disconnect ist kein Provider-Fehler → still.
      if (opts.signal?.aborted) return;
      throw new ProviderUnavailableError("Anthropic-API-Aufruf fehlgeschlagen.", err);
    }
  }

  async generateAnswer(opts: ChatOptions): Promise<string> {
    let full = "";
    for await (const piece of this.streamAnswer(opts)) full += piece;
    return full;
  }
}
