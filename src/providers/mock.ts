/**
 * A scriptable provider for tests and offline demos. Feed it a list of
 * "scripts": each is an LLMResponse to return, an Error to throw (to exercise
 * retry), or a function of the current messages. The last script repeats.
 */
import {
  ZERO_USAGE,
  type ContentBlock,
  type LLMResponse,
  type Message,
  type Provider,
  type ProviderConfig,
  type StopReason,
  type ToolDefinition,
} from "./types.ts";

export type Script =
  | LLMResponse
  | Error
  | ((messages: readonly Message[], callIndex: number) => LLMResponse);

export function textResponse(text: string, stopReason: StopReason = "end_turn"): LLMResponse {
  return { content: [{ type: "text", text }], stopReason, usage: ZERO_USAGE, model: "mock" };
}

export function toolUseResponse(
  name: string,
  input: Record<string, unknown>,
  opts: { id?: string; text?: string } = {},
): LLMResponse {
  const content: ContentBlock[] = [];
  if (opts.text) content.push({ type: "text", text: opts.text });
  content.push({ type: "tool_use", id: opts.id ?? `call_${name}`, name, input });
  return { content, stopReason: "tool_use", usage: ZERO_USAGE, model: "mock" };
}

export class MockProvider implements Provider {
  readonly name = "mock";
  private index = 0;
  /** Records each chat() call's messages, for assertions. */
  readonly calls: Array<readonly Message[]> = [];

  constructor(private readonly scripts: readonly Script[]) {}

  async chat(
    messages: readonly Message[],
    _tools: readonly ToolDefinition[],
    _config: ProviderConfig,
  ): Promise<LLMResponse> {
    // Snapshot: the engine mutates its message array in place between turns,
    // so storing the live reference would make every recorded call alias the
    // final transcript instead of the messages as sent.
    this.calls.push([...messages]);
    const callIndex = this.index;
    const script = this.scripts[Math.min(this.index, this.scripts.length - 1)];
    this.index++;
    if (script instanceof Error) throw script;
    if (typeof script === "function") return script(messages, callIndex);
    return script ?? textResponse("(mock: no script)");
  }
}
