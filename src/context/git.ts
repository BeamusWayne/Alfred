import { execFile } from "child_process";

const MAX_STATUS_CHARS = 2000;

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000 }, (error, stdout) => {
      resolve(error ? "" : stdout.trim());
    });
  });
}

async function isGitRepo(dir: string): Promise<boolean> {
  const result = await execGit(["rev-parse", "--is-inside-work-tree"], dir);
  return result === "true";
}

export interface GitContext {
  branch: string;
  mainBranch: string;
  status: string;
  recentCommits: string;
  userName: string;
}

export async function getGitContext(workingDir: string): Promise<GitContext | null> {
  if (!await isGitRepo(workingDir)) return null;

  const [branch, mainBranch, status, log, userName] = await Promise.all([
    execGit(["branch", "--show-current"], workingDir),
    execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], workingDir)
      .then((ref) => ref.replace("refs/remotes/origin/", "") || "main")
      .catch(() => "main"),
    execGit(["--no-optional-locks", "status", "--short"], workingDir),
    execGit(["--no-optional-locks", "log", "--oneline", "-n", "5"], workingDir),
    execGit(["config", "user.name"], workingDir),
  ]);

  const truncatedStatus = status.length > MAX_STATUS_CHARS
    ? status.substring(0, MAX_STATUS_CHARS) + "\n... (truncated)"
    : status;

  return { branch, mainBranch, status: truncatedStatus, recentCommits: log, userName };
}

export function formatGitContext(ctx: GitContext): string {
  return [
    "This is the git status at the start of the conversation. Note that this status is a snapshot in time and will not update during the conversation.",
    `Current branch: ${ctx.branch}`,
    `Main branch (you will usually use this for PRs): ${ctx.mainBranch}`,
    ...(ctx.userName ? [`Git user: ${ctx.userName}`] : []),
    `Status:\n${ctx.status || "(clean)"}`,
    `Recent commits:\n${ctx.recentCommits}`,
  ].join("\n\n");
}
