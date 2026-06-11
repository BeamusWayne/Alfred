/**
 * `alfred init` — scaffold a project for `alfred run`.
 *
 * Writes a starter `feature_list.json`, keeps `.alfred/` runtime state out of
 * git, and prints the exact next commands. Refuses to overwrite without
 * `--force`.
 */
import { join } from "node:path";
import { palette } from "./colors.ts";

const STARTER_FEATURE_LIST = {
  features: [
    {
      id: "feature-1",
      title: "Describe your first feature",
      description:
        "State what must be TRUE when this feature is done. The verify command (e.g. `bun test`) is the arbiter — only its exit 0 can mark this passing.",
      status: "pending",
    },
  ],
};

const GITIGNORE_BLOCK = "# Alfred runtime state (memory, journals, run ledgers)\n.alfred/\n";

/**
 * Returns the new .gitignore content, or null when no change is needed.
 * Pure — unit-tested separately from the IO below.
 */
export function gitignoreWithAlfred(existing: string | null): string | null {
  if (existing === null) return GITIGNORE_BLOCK;
  const hasEntry = existing
    .split("\n")
    .some((line) => line.trim() === ".alfred/" || line.trim() === ".alfred");
  if (hasEntry) return null;
  const sep = existing.endsWith("\n") || existing === "" ? "" : "\n";
  return `${existing}${sep}\n${GITIGNORE_BLOCK}`;
}

export async function runInit(cwd: string, opts: { force?: boolean }): Promise<number> {
  const c = palette(process.stderr);
  const out = (s: string) => process.stderr.write(`${s}\n`);
  const listPath = join(cwd, "feature_list.json");

  if (!opts.force && (await Bun.file(listPath).exists())) {
    out(
      c.yellow("feature_list.json already exists — edit it, or rerun with --force to overwrite."),
    );
    return 1;
  }
  await Bun.write(listPath, `${JSON.stringify(STARTER_FEATURE_LIST, null, 2)}\n`);
  out(`${c.green("✓")} feature_list.json created`);

  // Keep runtime state out of git: append to an existing .gitignore, or
  // create one when this is a git repo. (A non-repo directory is left alone.)
  const gitignorePath = join(cwd, ".gitignore");
  const gitignoreFile = Bun.file(gitignorePath);
  const hasGitignore = await gitignoreFile.exists();
  const isRepo = await Bun.file(join(cwd, ".git", "HEAD")).exists();
  if (hasGitignore || isRepo) {
    const next = gitignoreWithAlfred(hasGitignore ? await gitignoreFile.text() : null);
    if (next !== null) {
      await Bun.write(gitignorePath, next);
      out(`${c.green("✓")} .gitignore: .alfred/ excluded`);
    }
  }

  out("");
  out(c.dim("next:"));
  out(
    '  1. edit feature_list.json — one entry per feature; "done" is decided by the verify command',
  );
  out("  2. export ALFRED_LEDGER_SECRET=$(openssl rand -hex 32)   # signs the run receipts");
  out('  3. alfred run --verify "bun test"');
  return 0;
}
