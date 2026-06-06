/** Lightweight git context for the system prompt. Returns null outside a repo. */

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return proc.exitCode === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

export interface GitContext {
  readonly branch: string;
  readonly status: string;
}

export async function getGitContext(cwd: string): Promise<GitContext | null> {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branch === null) return null;
  const status = (await git(["status", "--short"], cwd)) ?? "";
  return { branch, status };
}

export function formatGit(g: GitContext): string {
  const clean = g.status.length === 0 ? " (clean)" : `\n${g.status}`;
  return `Git branch: ${g.branch}${clean}`;
}
