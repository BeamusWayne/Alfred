/** Provider registry. Swap LLM backends without touching tool or loop code. */
import type { Provider } from "./types.ts";
import { AnthropicProvider } from "./anthropic.ts";

export type ProviderName = "anthropic";

export function getProvider(name: ProviderName): Provider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider();
    default:
      throw new Error(`Unknown provider: ${name satisfies never}`);
  }
}

export { AnthropicProvider } from "./anthropic.ts";
export type { Provider } from "./types.ts";
