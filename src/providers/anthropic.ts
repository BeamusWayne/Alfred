import Anthropic from "@anthropic-ai/sdk";
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

function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    switch (msg.role) {
      case "user":
        return {
          role: "user" as const,
          content: typeof msg.content === "string"
            ? msg.content
            : msg.content.map(blockToAnthropic),
        };
      case "assistant":
        return {
          role: "assistant" as const,
          content: msg.content.map(blockToAnthropic),
        };
      case "tool_result":
        return {
          role: "user" as const,
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolUseId,
              content: msg.content,
              is_error: msg.isError ?? false,
            },
          ],
        };
      default:
        throw new Error(`Unsupported message role: ${(msg as { role: string }).role}`);
    }
  });
}

function blockToAnthropic(block: ContentBlock): Anthropic.ContentBlockParam | Anthropic.ToolUseBlockParam {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  return {
    type: "tool_use",
    id: block.id,
    name: block.name,
    input: block.input,
  };
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.ToolUnion[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

function fromAnthropicContent(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type === "text") {
      return { type: "text" as const, text: block.text };
    }
    if (block.type === "tool_use") {
      return {
        type: "tool_use" as const,
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    }
    return { type: "text" as const, text: JSON.stringify(block) };
  });
}

function fromAnthropicUsage(usage: Anthropic.Usage): Usage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
  };
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";

  private getClient(config: ProviderConfig): Anthropic {
    return new Anthropic({
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
      baseURL: config.baseUrl,
    });
  }

  async chat(
    messages: Message[],
    tools: ToolDefinition[],
    config: ProviderConfig,
  ): Promise<LLMResponse> {
    const client = this.getClient(config);
    const response = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens ?? 4096,
      temperature: config.temperature,
      system: config.systemPrompt,
      messages: toAnthropicMessages(messages),
      tools: tools.length > 0 ? toAnthropicTools(tools) : undefined,
    });

    return {
      content: fromAnthropicContent(response.content),
      stopReason: response.stop_reason as LLMResponse["stopReason"],
      usage: fromAnthropicUsage(response.usage),
      model: response.model,
    };
  }

  async *stream(
    messages: Message[],
    tools: ToolDefinition[],
    config: ProviderConfig,
  ): AsyncGenerator<StreamEvent, LLMResponse> {
    const client = this.getClient(config);
    const stream = client.messages.stream({
      model: config.model,
      max_tokens: config.maxTokens ?? 4096,
      temperature: config.temperature,
      system: config.systemPrompt,
      messages: toAnthropicMessages(messages),
      tools: tools.length > 0 ? toAnthropicTools(tools) : undefined,
    });

    const toolBuffers = new Map<string, { name: string; input: string }>();

    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          yield { type: "text_delta", text: delta.text };
        } else if (delta.type === "input_json_delta") {
          const idx = event.index;
          const buf = toolBuffers.get(String(idx));
          if (buf) {
            buf.input += delta.partial_json;
            yield {
              type: "tool_use_delta",
              toolUseId: String(idx),
              toolInputDelta: delta.partial_json,
            };
          }
        }
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          toolBuffers.set(String(event.index), {
            name: event.content_block.name,
            input: "",
          });
          yield {
            type: "tool_use_start",
            toolUseId: event.content_block.id,
            toolName: event.content_block.name,
          };
        }
      } else if (event.type === "message_stop") {
        yield { type: "message_stop" };
      }
    }

    const finalMessage = await stream.finalMessage();
    return {
      content: fromAnthropicContent(finalMessage.content),
      stopReason: finalMessage.stop_reason as LLMResponse["stopReason"],
      usage: fromAnthropicUsage(finalMessage.usage),
      model: finalMessage.model,
    };
  }

  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 4);
  }
}
