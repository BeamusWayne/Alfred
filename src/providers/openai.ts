import OpenAI from "openai";
import type {
  ContentBlock,
  LLMResponse,
  Message,
  Provider,
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
  Usage,
} from "./types.js";

function toOpenAIMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    switch (msg.role) {
      case "system":
        return { role: "system" as const, content: msg.content };
      case "user":
        return {
          role: "user" as const,
          content: typeof msg.content === "string"
            ? msg.content
            : msg.content.map(blockToOpenAI),
        };
      case "assistant":
        return {
          role: "assistant" as const,
          content: textContentFromBlocks(msg.content),
          tool_calls: extractToolCalls(msg.content),
        };
      case "tool_result":
        return {
          role: "tool" as const,
          tool_call_id: msg.toolUseId,
          content: msg.content,
        };
    }
  });
}

function blockToOpenAI(block: ContentBlock): OpenAI.ChatCompletionContentPart {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  return { type: "text", text: `[tool_use: ${block.name}]` };
}

function textContentFromBlocks(blocks: ContentBlock[]): string | null {
  const texts = blocks.filter((b): b is ContentBlock & { type: "text" } => b.type === "text");
  if (texts.length === 0) return null;
  return texts.map((t) => t.text).join("");
}

function extractToolCalls(blocks: ContentBlock[]): OpenAI.ChatCompletionMessageToolCall[] | undefined {
  const toolBlocks = blocks.filter((b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use");
  if (toolBlocks.length === 0) return undefined;
  return toolBlocks.map((b) => ({
    id: b.id,
    type: "function" as const,
    function: {
      name: b.name,
      arguments: JSON.stringify(b.input),
    },
  }));
}

function toOpenAITools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToOpenAISchema(tool.inputSchema),
    },
  }));
}

function zodToOpenAISchema(schema: unknown): Record<string, unknown> {
  if (typeof schema === "object" && schema !== null && "_def" in schema) {
    const def = (schema as { _def: unknown })._def as Record<string, unknown>;
    if (def.shape) {
      const shape = def.shape as Record<string, unknown>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToOpenAISchema(value);
        required.push(key);
      }
      return {
        type: "object",
        properties,
        required,
      };
    }
    if (def.typeName === "ZodString") return { type: "string" };
    if (def.typeName === "ZodNumber") return { type: "number" };
    if (def.typeName === "ZodBoolean") return { type: "boolean" };
    if (def.typeName === "ZodArray") return { type: "array", items: zodToOpenAISchema(def.type) };
    if (def.typeName === "ZodOptional") return zodToOpenAISchema(def.innerType);
  }
  return { type: "string" };
}

function fromOpenAIContent(message: OpenAI.ChatCompletionAssistantMessageParam): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (message.content && typeof message.content === "string") {
    blocks.push({ type: "text", text: message.content });
  }
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || "{}"),
      });
    }
  }
  return blocks;
}

function mapStopReason(reason: string | null): LLMResponse["stopReason"] {
  switch (reason) {
    case "stop": return "end_turn";
    case "tool_calls": return "tool_use";
    case "length": return "max_tokens";
    default: return "end_turn";
  }
}

export class OpenAIProvider implements Provider {
  readonly name = "openai";

  private getClient(config: ProviderConfig): OpenAI {
    return new OpenAI({
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      baseURL: config.baseUrl,
    });
  }

  async chat(
    messages: Message[],
    tools: ToolDefinition[],
    config: ProviderConfig,
  ): Promise<LLMResponse> {
    const client = this.getClient(config);
    const allMessages: Message[] = config.systemPrompt
      ? [{ role: "system", content: config.systemPrompt }, ...messages]
      : messages;

    const response = await client.chat.completions.create({
      model: config.model,
      max_tokens: config.maxTokens ?? 4096,
      temperature: config.temperature,
      messages: toOpenAIMessages(allMessages),
      tools: tools.length > 0 ? toOpenAITools(tools) : undefined,
    });

    const choice = response.choices[0];
    if (!choice) throw new Error("No response choice returned");

    const assistantMsg = choice.message;
    return {
      content: fromOpenAIContent(assistantMsg),
      stopReason: mapStopReason(choice.finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model,
    };
  }

  async *stream(
    messages: Message[],
    tools: ToolDefinition[],
    config: ProviderConfig,
  ): AsyncGenerator<StreamEvent, LLMResponse> {
    const client = this.getClient(config);
    const allMessages: Message[] = config.systemPrompt
      ? [{ role: "system", content: config.systemPrompt }, ...messages]
      : messages;

    const stream = await client.chat.completions.create({
      model: config.model,
      max_tokens: config.maxTokens ?? 4096,
      temperature: config.temperature,
      messages: toOpenAIMessages(allMessages),
      tools: tools.length > 0 ? toOpenAITools(tools) : undefined,
      stream: true,
    });

    let currentToolId = "";
    let currentToolName = "";
    let currentToolArgs = "";
    const toolResults: ContentBlock[] = [];
    let textContent = "";
    let model = "";

    for await (const chunk of stream) {
      model = chunk.model ?? model;
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        textContent += delta.content;
        yield { type: "text_delta", text: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id) {
            currentToolId = tc.id;
            currentToolName = tc.function?.name ?? "";
            currentToolArgs = "";
            yield {
              type: "tool_use_start",
              toolUseId: currentToolId,
              toolName: currentToolName,
            };
          }
          if (tc.function?.arguments) {
            currentToolArgs += tc.function.arguments;
            yield {
              type: "tool_use_delta",
              toolUseId: currentToolId,
              toolInputDelta: tc.function.arguments,
            };
          }
          if (tc.function?.name === undefined && tc.function?.arguments === undefined) {
            toolResults.push({
              type: "tool_use",
              id: currentToolId,
              name: currentToolName,
              input: JSON.parse(currentToolArgs || "{}"),
            });
          }
        }
      }
    }

    const content: ContentBlock[] = [];
    if (textContent) content.push({ type: "text", text: textContent });
    content.push(...toolResults);

    return {
      content,
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      model,
    };
  }

  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 4);
  }
}
