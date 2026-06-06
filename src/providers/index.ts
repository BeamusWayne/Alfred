/** Provider registry. Swap LLM backends without touching tool or loop code. */
import type { Provider } from "./types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAIProvider } from "./openai.ts";

export type ProviderName = "anthropic" | "openai";

export function getProvider(name: ProviderName): Provider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
    default:
      throw new Error(`Unknown provider: ${name satisfies never}`);
  }
}

export { AnthropicProvider } from "./anthropic.ts";
export { OpenAIProvider } from "./openai.ts";
export type { Provider } from "./types.ts";
