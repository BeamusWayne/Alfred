import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: ToolCall[];
}

interface ToolCall {
  name: string;
  status: "running" | "done" | "error";
  output?: string;
}

interface ReplProps {
  onSubmit: (input: string, onChunk: (chunk: StreamChunk) => void) => Promise<void>;
  modelName?: string;
}

export interface StreamChunk {
  type: "text" | "tool_start" | "tool_end" | "error" | "done";
  text?: string;
  toolName?: string;
  toolOutput?: string;
  error?: string;
}

export function Repl({ onSubmit, modelName }: ReplProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

  useEffect(() => {
    if (!isProcessing) return;
    const timer = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, [isProcessing]);

  const terminalWidth = stdout?.columns ?? 80;

  const handleChunk = useCallback((chunk: StreamChunk, msgIndex: number) => {
    if (chunk.type === "text" && chunk.text) {
      setMessages((prev) => {
        const updated = [...prev];
        const msg = updated[msgIndex];
        if (msg) {
          updated[msgIndex] = { ...msg, content: msg.content + chunk.text };
        }
        return updated;
      });
    } else if (chunk.type === "tool_start" && chunk.toolName) {
      setMessages((prev) => {
        const updated = [...prev];
        const msg = updated[msgIndex];
        if (msg) {
          const tools = [...(msg.toolCalls ?? []), { name: chunk.toolName!, status: "running" as const }];
          updated[msgIndex] = { ...msg, toolCalls: tools };
        }
        return updated;
      });
      setStatusText(`Running ${chunk.toolName}...`);
    } else if (chunk.type === "tool_end" && chunk.toolName) {
      setMessages((prev) => {
        const updated = [...prev];
        const msg = updated[msgIndex];
        if (msg) {
          const tools = (msg.toolCalls ?? []).map((t) =>
            t.name === chunk.toolName ? { ...t, status: "done" as const, output: chunk.toolOutput } : t,
          );
          updated[msgIndex] = { ...msg, toolCalls: tools };
        }
        return updated;
      });
      setStatusText("");
    } else if (chunk.type === "error" && chunk.error) {
      setMessages((prev) => {
        const updated = [...prev];
        const msg = updated[msgIndex];
        if (msg) {
          updated[msgIndex] = { ...msg, content: msg.content + `\n\nError: ${chunk.error}` };
        }
        return updated;
      });
    }
  }, []);

  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      exit();
      return;
    }

    if (key.escape) {
      if (isProcessing) return;
      exit();
      return;
    }

    if (key.return) {
      if (input.trim() === "" || isProcessing) return;

      const userMessage = input.trim();
      setInput("");
      const msgIndex = messages.length;

      setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
      setMessages((prev) => [...prev, { role: "assistant", content: "", toolCalls: [] }]);
      setIsProcessing(true);
      setStatusText("Thinking...");

      onSubmit(userMessage, (chunk) => handleChunk(chunk, msgIndex + 1))
        .catch((err) => {
          handleChunk(
            { type: "error", error: err instanceof Error ? err.message : String(err) },
            msgIndex + 1,
          );
        })
        .finally(() => {
          setIsProcessing(false);
          setStatusText("");
        });
      return;
    }

    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }

    if (key.leftArrow) {
      return;
    }
    if (key.rightArrow) {
      return;
    }

    if (char && !key.ctrl && !key.meta) {
      setInput((prev) => prev + char);
    }
  });

  const visibleMessages = messages.slice(-50);

  return (
    <Box flexDirection="column" paddingBottom={1}>
      <Header modelName={modelName} width={terminalWidth} />

      {visibleMessages.map((msg, i) => (
        <MessageBlock key={i} message={msg} width={terminalWidth} />
      ))}

      {isProcessing && statusText && (
        <Box paddingLeft={3} marginTop={1}>
          <Text color="cyan">{SPINNER_FRAMES[spinnerFrame]}</Text>
          <Text dimColor> {statusText}</Text>
        </Box>
      )}

      <InputLine input={input} isProcessing={isProcessing} width={terminalWidth} />

      <StatusBar modelName={modelName} isProcessing={isProcessing} />
    </Box>
  );
}

function Header({ modelName, width }: { modelName?: string; width: number }) {
  const title = ` Alfred `;
  const model = modelName ?? "";
  const padLen = Math.max(0, width - title.length - model.length - 4);
  const line = "─".repeat(width);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>{title}</Text>
        <Text dimColor>{model}</Text>
        <Text dimColor>{" ".repeat(padLen)}</Text>
      </Box>
      <Text color="gray">{line}</Text>
    </Box>
  );
}

function MessageBlock({ message, width }: { message: Message; width: number }) {
  if (message.role === "user") {
    return <UserMessage content={message.content} width={width} />;
  }
  if (message.role === "system") {
    return <SystemMessage content={message.content} />;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {message.toolCalls && message.toolCalls.length > 0 && (
        <ToolCallsBlock calls={message.toolCalls} />
      )}
      {message.content && <AssistantMessage content={message.content} width={width} />}
    </Box>
  );
}

function UserMessage({ content, width }: { content: string; width: number }) {
  const maxLen = width - 5;
  const display = content.length > maxLen ? content.slice(0, maxLen) + "..." : content;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="green" bold>{"▸ You"}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color="gray">{display}</Text>
      </Box>
    </Box>
  );
}

function AssistantMessage({ content, width }: { content: string; width: number }) {
  const blocks = parseBlocks(content);
  const maxBlocks = 80;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>{"◆ Alfred"}</Text>
      </Box>
      <Box paddingLeft={2} flexDirection="column">
        {blocks.slice(0, maxBlocks).map((block, i) => {
          if (block.type === "code") {
            return <CodeBlock key={i} code={block.content} lang={block.lang} width={width - 4} />;
          }
          return (
            <Box key={i} flexDirection="column">
              {block.content.split("\n").map((line, j) => (
                <FormattedLine key={`${i}-${j}`} line={line} width={width - 4} />
              ))}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

interface ContentBlock {
  type: "text" | "code";
  content: string;
  lang?: string;
}

function parseBlocks(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", content: codeLines.join("\n"), lang });
      i++; // skip closing ```
    } else {
      let textLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        textLines.push(lines[i]);
        i++;
      }
      if (textLines.length > 0) {
        blocks.push({ type: "text", content: textLines.join("\n") });
      }
    }
  }

  return blocks;
}

function CodeBlock({ code, lang, width }: { code: string; lang?: string; width: number }) {
  const lines = code.split("\n");
  const lineNumWidth = String(lines.length).length;

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Box>
        <Text color="gray" dimColor>{"╭"}</Text>
        {lang && <Text color="yellow" dimColor>{` ${lang} `}</Text>}
        <Text color="gray" dimColor>{"─".repeat(Math.max(0, width - (lang?.length ?? 0) - 6))}</Text>
      </Box>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color="gray" dimColor>{`│`}</Text>
          <Text dimColor>{String(i + 1).padStart(lineNumWidth)} </Text>
          <Text color="green">{line.slice(0, width - lineNumWidth - 3)}</Text>
        </Box>
      ))}
      <Box>
        <Text color="gray" dimColor>{"╰" + "─".repeat(width - 1)}</Text>
      </Box>
    </Box>
  );
}

function FormattedLine({ line, width }: { line: string; width: number }) {
  const trimmed = line.length > width ? line.slice(0, width) : line;

  if (trimmed.startsWith("```")) {
    return <Text color="gray" dimColor>{trimmed}</Text>;
  }
  if (trimmed.startsWith("# ")) {
    return <InlineText text={trimmed} wrapStyle={{ bold: true, color: "magenta" }} />;
  }
  if (trimmed.startsWith("## ")) {
    return <InlineText text={trimmed} wrapStyle={{ bold: true, color: "cyan" }} />;
  }
  if (trimmed.startsWith("### ")) {
    return <InlineText text={trimmed} wrapStyle={{ bold: true, color: "white" }} />;
  }
  if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
    return (
      <Box>
        <Text color="cyan">{"  • "}</Text>
        <InlineText text={trimmed.slice(2)} />
      </Box>
    );
  }
  if (/^\d+\.\s/.test(trimmed)) {
    const match = trimmed.match(/^(\d+\.\s)/);
    const prefix = match?.[1] ?? "";
    return (
      <Box>
        <Text color="cyan">{`  ${prefix}`}</Text>
        <InlineText text={trimmed.slice(prefix.length)} />
      </Box>
    );
  }
  if (trimmed.startsWith("> ")) {
    return (
      <Box paddingLeft={2}>
        <InlineText text={trimmed.slice(2)} wrapStyle={{ italic: true, color: "gray" }} />
      </Box>
    );
  }
  if (trimmed.trim() === "") {
    return <Text>{" "}</Text>;
  }

  return <InlineText text={trimmed} />;
}

interface InlinePart {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

function parseInlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g;
  let lastIdx = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push({ text: text.slice(lastIdx, match.index) });
    }
    if (match[0].startsWith("**")) {
      parts.push({ text: match[2], bold: true });
    } else if (match[0].startsWith("*")) {
      parts.push({ text: match[3], italic: true });
    } else if (match[0].startsWith("`")) {
      parts.push({ text: match[4], code: true });
    }
    lastIdx = regex.lastIndex;
  }

  if (lastIdx < text.length) {
    parts.push({ text: text.slice(lastIdx) });
  }

  return parts.length > 0 ? parts : [{ text }];
}

function InlineText({ text, wrapStyle }: { text: string; wrapStyle?: Record<string, unknown> }) {
  const parts = parseInlineParts(text);

  if (wrapStyle && parts.length === 1 && !parts[0].bold && !parts[0].italic && !parts[0].code) {
    return React.createElement(Text, wrapStyle, parts[0].text);
  }

  const children = parts.map((part, i) => {
    if (part.code) {
      return React.createElement(Text, { key: i, color: "yellow", bgColor: "gray" }, ` ${part.text} `);
    }
    const style: Record<string, unknown> = {};
    if (part.bold) style.bold = true;
    if (part.italic) style.italic = true;
    return React.createElement(Text, { key: i, ...style }, part.text);
  });

  if (wrapStyle) {
    return React.createElement(Text, wrapStyle, ...children);
  }
  return React.createElement(Text, null, ...children);
}

function SystemMessage({ content }: { content: string }) {
  return (
    <Box paddingLeft={3} marginTop={1}>
      <Text color="yellow">{content}</Text>
    </Box>
  );
}

function ToolCallsBlock({ calls }: { calls: ToolCall[] }) {
  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
      {calls.map((call, i) => {
        const icon = call.status === "running" ? "⏳" : call.status === "error" ? "✗" : "✓";
        const color = call.status === "running" ? "yellow" : call.status === "error" ? "red" : "green";
        return (
          <Box key={i}>
            <Text color={color}>{icon}</Text>
            <Text dimColor> {call.name}</Text>
            {call.status === "done" && (
              <Text dimColor color="green"> ✓</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function InputLine({ input, isProcessing, width }: { input: string; isProcessing: boolean; width: number }) {
  const maxInputLen = width - 4;
  const display = input.length > maxInputLen ? input.slice(-maxInputLen) : input;

  return (
    <Box marginTop={1}>
      <Text color={isProcessing ? "gray" : "cyan"} bold>
        {"❯ "}
      </Text>
      <Text color={isProcessing ? "gray" : "white"}>{display}</Text>
      {!isProcessing && <Text color="cyan" bold>█</Text>}
    </Box>
  );
}

function StatusBar({ modelName, isProcessing }: { modelName?: string; isProcessing: boolean }) {
  return (
    <Box>
      <Text dimColor>
        {modelName ?? "no model"}
        {" | "}
        {isProcessing ? "processing..." : "Enter to send | Esc to exit"}
      </Text>
    </Box>
  );
}
