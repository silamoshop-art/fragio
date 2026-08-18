/**
 * Factory: liefert für einen Bot den passenden LLMProvider.
 *
 * Auswahllogik:
 *   1. trial_mode aktiv  -> zentraler Trial-Key (Anthropic), NICHT der Kundenkey.
 *   2. llm_provider = "anthropic" | "openai" -> Kundenkey entschlüsseln.
 *   3. sonst / kein Key  -> lokaler Ollama-Provider (Gratis-Modus).
 *
 * Optionaler Fallback: Ist `fallback_to_local` gesetzt und der Hosted-Provider
 * fällt aus (ProviderUnavailableError), BEVOR ein Token gestreamt wurde, wird
 * transparent auf den lokalen Provider umgeschaltet.
 */
import { config } from "../config.js";
import { decryptSecret } from "../crypto/secrets.js";
import type { ChatOptions, LLMProvider, ProviderId } from "./types.js";
import { ProviderUnavailableError } from "./types.js";
import { OllamaProvider } from "./providers/ollama.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import { isTrialActive, type TrialFields } from "../trial/state.js";

/** Minimal-Konfiguration eines Bots, die für die Provider-Wahl nötig ist. */
export interface BotLLMConfig extends TrialFields {
  llm_provider: ProviderId;
  encrypted_api_key: string | null;
  chat_model: string | null;
  fallback_to_local: number; // 0/1
}

/**
 * Standard-Engine (wenn kein Kunden-Key & kein Trial): Claude Haiku 4.5 über den
 * Operator-Key ANTHROPIC_API_KEY. Optional (DEFAULT_ENGINE="ollama") lokaler Modus.
 */
function buildDefaultEngine(chatModel: string | null): LLMProvider {
  if (config.DEFAULT_ENGINE === "ollama") {
    return new OllamaProvider(chatModel ?? undefined);
  }
  if (!config.ANTHROPIC_API_KEY) {
    throw new ProviderUnavailableError(
      "ANTHROPIC_API_KEY ist nicht gesetzt — die Standard-Engine (Claude Haiku 4.5) " +
        "kann nicht antworten. Key in der .env hinterlegen oder DEFAULT_ENGINE=ollama setzen.",
    );
  }
  return new AnthropicProvider(config.ANTHROPIC_API_KEY, chatModel ?? config.ANTHROPIC_DEFAULT_MODEL);
}

/** Nutzt der Bot einen eigenen (Kunden-)Key? (relevant für Fallback) */
function usesCustomerKey(bot: BotLLMConfig): boolean {
  return (
    !isTrialActive(bot) &&
    (bot.llm_provider === "anthropic" || bot.llm_provider === "openai") &&
    !!bot.encrypted_api_key
  );
}

function buildPrimary(bot: BotLLMConfig): LLMProvider {
  // 1. Aktiver Trial: zentraler Trial-Key (oder Operator-Key), Haiku 4.5.
  if (isTrialActive(bot)) {
    const trialKey = config.TRIAL_ANTHROPIC_API_KEY || config.ANTHROPIC_API_KEY;
    if (trialKey) {
      return new AnthropicProvider(trialKey, bot.chat_model ?? config.TRIAL_ANTHROPIC_MODEL);
    }
    return buildDefaultEngine(bot.chat_model); // kein Key -> Standard-Engine
  }

  // 2. Erzwungen lokales Modell (Datenschutz-Premium): läuft komplett auf dem
  //    eigenen Server, KEINE Chat-Anfragen an Anthropic/US-Anbieter.
  if (bot.llm_provider === "ollama") {
    return new OllamaProvider(bot.chat_model ?? undefined);
  }

  // 3. Bring-your-own-Key (Kunde hat eigenen Key hinterlegt).
  if (bot.llm_provider === "anthropic" || bot.llm_provider === "openai") {
    if (bot.encrypted_api_key) {
      const apiKey = decryptSecret(bot.encrypted_api_key);
      return bot.llm_provider === "anthropic"
        ? new AnthropicProvider(apiKey, bot.chat_model ?? undefined)
        : new OpenAIProvider(apiKey, bot.chat_model ?? undefined);
    }
    // Provider gewählt, aber (noch) kein Key -> Standard-Engine.
    return buildDefaultEngine(bot.chat_model);
  }

  // 3. Standard-Engine (Haiku 4.5 über Operator-Key).
  return buildDefaultEngine(bot.chat_model);
}

/**
 * Wrapper, der bei Ausfall des Primär-Providers auf einen lokalen Provider
 * zurückfällt — aber nur, bevor das erste Token gestreamt wurde.
 */
class FallbackProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly chatModel: string;
  readonly embedModel: string;

  constructor(
    private primary: LLMProvider,
    private fallback: LLMProvider,
  ) {
    this.id = primary.id;
    this.chatModel = primary.chatModel;
    this.embedModel = primary.embedModel;
  }

  // Embeddings sind ohnehin immer lokal -> direkt durchreichen.
  embed(texts: string[]): Promise<number[][]> {
    return this.primary.embed(texts);
  }

  async *streamAnswer(opts: ChatOptions): AsyncIterable<string> {
    let emitted = false;
    try {
      for await (const piece of this.primary.streamAnswer(opts)) {
        emitted = true;
        yield piece;
      }
    } catch (err) {
      if (err instanceof ProviderUnavailableError && !emitted) {
        console.warn(
          `⚠️  Provider "${this.primary.id}" ausgefallen — Fallback auf Standard-Engine. (${err.message})`,
        );
        yield* this.fallback.streamAnswer(opts);
        return;
      }
      throw err;
    }
  }

  async generateAnswer(opts: ChatOptions): Promise<string> {
    let full = "";
    for await (const piece of this.streamAnswer(opts)) full += piece;
    return full;
  }
}

export function getProviderForBot(bot: BotLLMConfig): LLMProvider {
  const primary = buildPrimary(bot);
  // Fallback nur sinnvoll, wenn ein Kunden-Key genutzt wird: fällt der aus, auf
  // die Standard-Engine (Operator-Key, Haiku 4.5) zurückfallen.
  if (bot.fallback_to_local && usesCustomerKey(bot)) {
    return new FallbackProvider(primary, buildDefaultEngine(null));
  }
  return primary;
}

export type { LLMProvider } from "./types.js";
export { ProviderUnavailableError } from "./types.js";
