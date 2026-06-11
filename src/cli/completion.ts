/**
 * `alfred completion <shell>` — print a completion script for bash or zsh.
 *
 * Deliberately static word lists (subcommands + common flags): zero runtime
 * cost in the user's shell and nothing to keep in sync beyond the command
 * names, which the entry point passes in from the live commander program.
 */

export const COMPLETION_SHELLS = ["bash", "zsh"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

const COMMON_FLAGS = [
  "--help",
  "--version",
  "--model",
  "--print",
  "--permission-mode",
  "--max-turns",
  "--yes",
  "--json",
];

export function completionScript(shell: CompletionShell, commands: readonly string[]): string {
  const words = [...commands, ...COMMON_FLAGS].join(" ");
  if (shell === "bash") {
    return [
      '# alfred bash completion — eval "$(alfred completion bash)" or save to',
      "# /usr/local/etc/bash_completion.d/alfred",
      `complete -W "${words}" alfred`,
      "",
    ].join("\n");
  }
  return [
    '# alfred zsh completion — eval "$(alfred completion zsh)" or save to a',
    "# directory on your $fpath as _alfred",
    "_alfred() {",
    `  compadd -- ${words}`,
    "}",
    "compdef _alfred alfred",
    "",
  ].join("\n");
}
