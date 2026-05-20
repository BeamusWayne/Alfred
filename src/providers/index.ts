import type { Provider, ProviderConfig } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

const providers = new Map<string, () => Provider>();

export function registerProvider(name: string, factory: () => Provider): void {
  providers.set(name, factory);
}

export function getProvider(name: string): Provider {
  const factory = providers.get(name);
  if (!factory) throw new Error(`Unknown provider: ${name}. Available: ${[...providers.keys()].join(", ")}`);
  return factory();
}

export function listProviders(): string[] {
  return [...providers.keys()];
}

// Register built-in providers
registerProvider("anthropic", () => new AnthropicProvider());
registerProvider("openai", () => new OpenAIProvider());

export type { Provider, ProviderConfig, Message, LLMResponse, StreamEvent, ToolDefinition, ContentBlock } from "./types.js";
