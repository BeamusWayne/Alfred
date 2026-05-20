import { getGitContext, formatGitContext } from "./git.js";
import { discoverClaudeMds, formatClaudeMds } from "./claudemd.js";

export interface SystemContext {
  gitStatus: string | null;
  claudeMd: string | null;
  currentDate: string;
  workingDir: string;
}

export async function buildSystemContext(workingDir: string): Promise<SystemContext> {
  const [gitCtx, claudeMdFiles] = await Promise.all([
    getGitContext(workingDir),
    Promise.resolve(discoverClaudeMds(workingDir)),
  ]);

  return {
    gitStatus: gitCtx ? formatGitContext(gitCtx) : null,
    claudeMd: claudeMdFiles.length > 0 ? formatClaudeMds(claudeMdFiles) : null,
    currentDate: `Today's date is ${new Date().toISOString().split("T")[0]}.`,
    workingDir,
  };
}

export function buildSystemPrompt(context: SystemContext): string {
  const parts: string[] = [
    "You are Alfred, an AI-powered CLI coding assistant.",
    "You help users with software engineering tasks by reading, writing, and editing files, running commands, and searching code.",
    "",
    `Working directory: ${context.workingDir}`,
    context.currentDate,
  ];

  if (context.claudeMd) {
    parts.push("", "## Project Instructions (CLAUDE.md)", context.claudeMd);
  }

  if (context.gitStatus) {
    parts.push("", "## Git Context", context.gitStatus);
  }

  return parts.join("\n");
}

export { discoverClaudeMds, formatClaudeMds } from "./claudemd.js";
export { getGitContext, formatGitContext } from "./git.js";
