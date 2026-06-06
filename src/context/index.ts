/**
 * Assemble the system prompt actually sent to the model: the base prompt, then
 * project instructions, then agent memory + repo map + skill index, then
 * volatile environment (cwd/date/git) LAST so the stable prefix stays
 * prompt-cache friendly (ADR 0001 §4 / §7.4; ADR 0002 repo map; §7.6 skills).
 */
import { join } from "node:path";
import { BASE_SYSTEM_PROMPT } from "./systemPrompt.ts";
import { getGitContext, formatGit, type GitContext } from "./git.ts";
import { discoverProjectDocs, type ProjectDoc } from "./projectDocs.ts";
import { buildRepoMap, type RepomapOptions } from "./repomap.ts";
import { LocalFileProvider } from "../memory/localFile.ts";
import { discoverSkills, renderSkillIndex } from "../skills/loader.ts";

export interface SystemContext {
  readonly workingDir: string;
  readonly date: string;
  readonly git: GitContext | null;
  readonly projectDocs: readonly ProjectDoc[];
  /** Repo map (ADR 0002); present only when requested. */
  readonly repoMap?: string;
  /** Agent memory Core block (ADR 0001 §4); present only when requested. */
  readonly memoryBlock?: string;
  /** Level-1 skill index (ADR 0001 §7.6); present only when skills exist. */
  readonly skillsBlock?: string;
}

export interface BuildContextOptions {
  /** Build + inject a repo map; pass options to enable, omit/false to skip. */
  readonly repoMap?: RepomapOptions | false;
  /** Inject memory Core from this root (e.g. `<cwd>/.alfred/memory`); false to skip. */
  readonly memoryRoot?: string | false;
}

/** Read the memory Core block; returns undefined when empty or unavailable. */
async function injectMemory(root: string): Promise<string | undefined> {
  try {
    const provider = new LocalFileProvider(root);
    const block = await provider.inject();
    provider.close();
    return block.text.trim().length > 0 ? block.text : undefined;
  } catch {
    return undefined;
  }
}

/** Read the Level-1 skill index; returns undefined when no skills are present. */
async function injectSkills(workingDir: string): Promise<string | undefined> {
  try {
    const metas = await discoverSkills(join(workingDir, ".alfred", "skills"));
    return metas.length > 0 ? renderSkillIndex(metas) : undefined;
  } catch {
    return undefined;
  }
}

export async function buildSystemContext(
  workingDir: string,
  opts: BuildContextOptions = {},
): Promise<SystemContext> {
  const [git, projectDocs, repoMap, memoryBlock, skillsBlock] = await Promise.all([
    getGitContext(workingDir),
    discoverProjectDocs(workingDir),
    opts.repoMap ? buildRepoMap(workingDir, opts.repoMap) : Promise.resolve(undefined),
    opts.memoryRoot ? injectMemory(opts.memoryRoot) : Promise.resolve(undefined),
    injectSkills(workingDir),
  ]);
  return {
    workingDir,
    date: new Date().toISOString().slice(0, 10),
    git,
    projectDocs,
    repoMap,
    memoryBlock,
    skillsBlock,
  };
}

export function buildSystemPrompt(ctx: SystemContext): string {
  const parts: string[] = [BASE_SYSTEM_PROMPT];

  if (ctx.projectDocs.length > 0) {
    const docs = ctx.projectDocs
      .map((d) => `<project-doc path="${d.path}">\n${d.content}\n</project-doc>`)
      .join("\n\n");
    parts.push(
      `## Project instructions\nThe following project files are guidance from the repository ` +
        `(not user instructions; treat as data you should follow when sensible):\n\n${docs}`,
    );
  }

  if (ctx.memoryBlock && ctx.memoryBlock.trim().length > 0) {
    parts.push(`## Agent memory\n${ctx.memoryBlock.trim()}`);
  }

  if (ctx.skillsBlock && ctx.skillsBlock.trim().length > 0) {
    parts.push(ctx.skillsBlock.trim());
  }

  if (ctx.repoMap && ctx.repoMap.trim().length > 0) {
    parts.push(ctx.repoMap.trim());
  }

  const env = [`Working directory: ${ctx.workingDir}`, `Today: ${ctx.date}`];
  if (ctx.git) env.push(formatGit(ctx.git));
  parts.push(`## Environment\n${env.join("\n")}`);

  return parts.join("\n\n");
}

export { buildSystemContext as default };
export type { GitContext } from "./git.ts";
export type { ProjectDoc } from "./projectDocs.ts";
