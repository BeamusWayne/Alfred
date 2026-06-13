/**
 * Slash-command registry + the autocomplete menu state (Claude Code parity:
 * typing `/` opens a filtered list; ↑/↓ select, Tab completes, Enter runs
 * the selection). Pure — the controller owns execution.
 */

export interface SlashCommand {
  readonly name: string; // without the leading /
  readonly args?: string; // e.g. "[model]" — display only
  readonly description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", description: "show commands and keys" },
  { name: "status", description: "provider · feature_list · last run" },
  { name: "model", args: "[name]", description: "show or switch the model for this session" },
  { name: "cost", description: "session spend so far" },
  { name: "doctor", description: "diagnose the setup in one pass" },
  { name: "clear", description: "drop the conversation history" },
  { name: "version", description: "print the alfred version" },
  { name: "exit", description: "leave (also /quit, ctrl-d)" },
  { name: "quit", description: "leave" },
];

/**
 * The menu is active while the input is a single line starting with `/`
 * and the first token is still being typed (no space yet → still choosing).
 */
export function menuActive(text: string): boolean {
  return text.startsWith("/") && !text.includes("\n") && !text.includes(" ");
}

export function filterCommands(text: string): readonly SlashCommand[] {
  if (!menuActive(text)) return [];
  const prefix = text.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}

export interface MenuState {
  readonly matches: readonly SlashCommand[];
  readonly selected: number;
}

export function menuFor(text: string, previous?: MenuState): MenuState {
  const matches = filterCommands(text);
  // Keep the selection on the same command across keystrokes when possible.
  const kept = previous?.matches[previous.selected];
  const keep = kept ? matches.findIndex((m) => m.name === kept.name) : -1;
  return { matches, selected: keep === -1 ? 0 : keep };
}

export function moveSelection(menu: MenuState, dir: -1 | 1): MenuState {
  if (menu.matches.length === 0) return menu;
  const n = menu.matches.length;
  return { ...menu, selected: (menu.selected + dir + n) % n };
}

/** The input text Tab-completion produces for the current selection. */
export function completion(menu: MenuState): string | null {
  const cmd = menu.matches[menu.selected];
  return cmd ? `/${cmd.name}` : null;
}
