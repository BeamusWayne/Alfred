export type CommandResult =
  | { type: "text"; content: string }
  | { type: "clear" }
  | { type: "skip" }
  | { type: "model"; model: string }
  | { type: "error"; message: string };

export interface Command {
  name: string;
  description: string;
  aliases?: string[];
  execute(args: string): Promise<CommandResult>;
}

const commandRegistry = new Map<string, Command>();

export function registerCommand(cmd: Command): void {
  commandRegistry.set(cmd.name, cmd);
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      commandRegistry.set(alias, cmd);
    }
  }
}

export function getCommand(name: string): Command | undefined {
  return commandRegistry.get(name);
}

export function getAllCommands(): Command[] {
  const seen = new Set<string>();
  const cmds: Command[] = [];
  for (const cmd of commandRegistry.values()) {
    if (!seen.has(cmd.name)) {
      seen.add(cmd.name);
      cmds.push(cmd);
    }
  }
  return cmds.sort((a, b) => a.name.localeCompare(b.name));
}

export function clearCommands(): void {
  commandRegistry.clear();
}

export function parseCommand(input: string): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { name: trimmed.slice(1), args: "" };
  }
  return { name: trimmed.slice(1, spaceIdx), args: trimmed.slice(spaceIdx + 1).trim() };
}
