/** Provider registry. Swap LLM backends without touching tool or loop code. */

import { AnthropicProvider } from "./anthropic.ts";
import { GoogleProvider } from "./google.ts";
import { OpenAIProvider } from "./openai.ts";
import type { Provider } from "./types.ts";

export type ProviderName = "anthropic" | "openai" | "google";

export function getProvider(name: ProviderName): Provider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
    case "google":
      return new GoogleProvider();
    default:
      throw new Error(`Unknown provider: ${name satisfies never}`);
  }
}

export { AnthropicProvider } from "./anthropic.ts";
export { GoogleProvider } from "./google.ts";
export { OpenAIProvider } from "./openai.ts";
export type { Provider } from "./types.ts";
