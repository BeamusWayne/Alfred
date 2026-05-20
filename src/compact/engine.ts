export interface CompactableMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface CompactResult {
  summary: string;
  kept: CompactableMessage[];
}

export interface CompactOptions {
  keepRecent: number;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function shouldCompact(
  messages: CompactableMessage[],
  tokenThreshold: number,
): boolean {
  const totalTokens = messages.reduce(
    (sum, m) => sum + estimateTokens(m.content),
    0,
  );
  return totalTokens > tokenThreshold;
}

export function compactMessages(
  messages: CompactableMessage[],
  options: CompactOptions,
): CompactResult {
  if (messages.length <= options.keepRecent) {
    return { summary: "", kept: [...messages] };
  }

  const splitIdx = messages.length - options.keepRecent;
  const toCompress = messages.slice(0, splitIdx);
  const kept = messages.slice(splitIdx);

  const summary = toCompress
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n");

  return { summary, kept };
}
