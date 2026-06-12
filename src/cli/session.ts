/**
 * Shared one-shot / REPL session plumbing, extracted from the entry point so
 * both surfaces build their QueryConfig the same way: config + model
 * overrides, system context, hooks, memory, MCP/LSP extensions, provider
 * resolution (honouring ALFRED_MOCK_SCRIPTS), and event rendering.
 */
import { join, relative, resolve } from "node:path";
import { type AlfredConfig, type ConfigOverrides, loadConfig } from "../config/manager.ts";
import { loadModelOverrides } from "../config/modelOverrides.ts";
import { buildSystemContext, buildSystemPrompt } from "../context/index.ts";
import { bootstrapExtensions } from "../extensions/bootstrap.ts";
import { loadHooksConfig } from "../hooks/engine.ts";
import { LocalFileProvider } from "../memory/localFile.ts";
import { getProvider } from "../providers/index.ts";
import { MockProvider, type Script } from "../providers/mock.ts";
import type { Provider } from "../providers/types.ts";
import type { QueryConfig, QueryEvent, QueryState } from "../query/types.ts";
import { getAllTools } from "../tools/index.ts";
import { type Palette, palette } from "./colors.ts";

/** True when the scripted offline provider is active (no API key needed). */
export function mockActive(): boolean {
  return Boolean(process.env.ALFRED_MOCK_SCRIPTS);
}

/** Env var holding the API key for `provider`. */
export function keyEnvName(provider: string): string {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "google") return "GOOGLE_API_KEY";
  return "ANTHROPIC_API_KEY";
}

/** True when the configured provider's API key is exported. */
export function keyPresent(provider: string): boolean {
  if (provider === "google") {
    return Boolean(process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY);
  }
  return Boolean(process.env[keyEnvName(provider)]);
}

/**
 * Actionable missing-key message, or null when the run can proceed. Replaces
 * the old warn-and-fail-deep-in-the-SDK behavior: fail at the front door,
 * with the exact export line and the keyless alternative.
 */
export function missingKeyMessage(cfg: AlfredConfig, c: Palette): string | null {
  if (mockActive() || keyPresent(cfg.provider)) return null;
  const envName = keyEnvName(cfg.provider);
  return [
    c.red(`No ${envName} set — alfred needs a model to run.`),
    c.dim(`  export ${envName}=…`),
    c.dim("  no key handy? `alfred demo` shows a full verified run offline."),
    "",
  ].join("\n");
}

/**
 * Actionable missing-feature-list message for `alfred run` — fail at the
 * front door with the next command instead of throwing a stack trace from
 * deep inside the harness (`loadFeatureList`).
 */
export function missingFeatureListMessage(path: string, cwd: string, c: Palette): string {
  const display = relative(cwd, path) || path;
  return [
    c.red(`No feature list at ${display} — \`alfred run\` drives a feature_list.json to green.`),
    c.dim("  alfred init                        scaffold one here"),
    c.dim("  alfred run --feature-list <path>   use an existing list"),
    c.dim("  alfred demo                        watch a full verified run offline first"),
    "",
  ].join("\n");
}

/**
 * Resolve the LLM provider, honouring ALFRED_MOCK_SCRIPTS: a path to a module
 * default-exporting MockProvider `Script[]`. The engine, tools, permissions,
 * verify gate and ledger all run for real — only the model is scripted.
 */
export async function resolveProvider(
  providerName: Parameters<typeof getProvider>[0],
): Promise<Provider> {
  const scriptsPath = process.env.ALFRED_MOCK_SCRIPTS;
  if (!scriptsPath) return getProvider(providerName);
  const mod: { default?: readonly Script[]; scripts?: readonly Script[] } = await import(
    resolve(process.cwd(), scriptsPath)
  );
  const scripts = mod.default ?? mod.scripts;
  if (!Array.isArray(scripts) || scripts.length === 0) {
    process.stderr.write(
      palette(process.stderr).red(
        `ALFRED_MOCK_SCRIPTS must point at a module default-exporting a non-empty Script[]: ${scriptsPath}\n`,
      ),
    );
    process.exit(1);
  }
  process.stderr.write(
    palette(process.stderr).yellow(`[mock] scripted provider — ${scriptsPath} (no API calls)\n`),
  );
  return new MockProvider(scripts);
}

export interface Session {
  readonly cfg: AlfredConfig;
  readonly provider: Provider;
  readonly systemPrompt: string;
  readonly hooks: Awaited<ReturnType<typeof loadHooksConfig>>;
  readonly memory: LocalFileProvider | undefined;
  readonly ext: Awaited<ReturnType<typeof bootstrapExtensions>>;
  readonly tools: QueryConfig["tools"];
  readonly workingDir: string;
  /** One id per CLI session, threaded into every hook payload (§7.5). */
  readonly sessionId: string;
}

/** Build everything a query needs that is independent of the prompt itself. */
export async function buildSession(overrides: ConfigOverrides): Promise<Session> {
  const c = palette(process.stderr);
  const cfg = loadConfig(overrides);
  const workingDir = process.cwd();
  loadModelOverrides(workingDir, (m) => process.stderr.write(c.yellow(`[models] ${m}\n`)));

  const memoryEnabled = Boolean(process.env.ALFRED_MEMORY);
  const memoryRoot = join(workingDir, ".alfred", "memory");
  // One provider instance drives prefetch (in the engine) and extract (on end).
  const memory = memoryEnabled ? new LocalFileProvider(memoryRoot) : undefined;

  const [sysCtx, hooks, ext] = await Promise.all([
    buildSystemContext(workingDir, {
      repoMap: process.env.ALFRED_REPOMAP ? {} : false,
      memoryRoot: memoryEnabled ? memoryRoot : false,
    }),
    loadHooksConfig(join(workingDir, ".alfred", "hooks.json")),
    bootstrapExtensions(workingDir, {
      // Surface MCP/LSP launch failures instead of silently exposing no tools.
      onWarn: (m) => process.stderr.write(c.yellow(`[ext] ${m}\n`)),
    }),
  ]);

  return {
    cfg,
    provider: await resolveProvider(cfg.provider),
    systemPrompt: buildSystemPrompt(sysCtx),
    hooks,
    memory,
    ext,
    tools: ext.tools.length > 0 ? [...getAllTools(), ...ext.tools] : undefined,
    workingDir,
    sessionId: `alfred-${crypto.randomUUID()}`,
  };
}

/** The prompt-independent slice of a QueryConfig, shared by one-shot and REPL. */
export function queryConfigFromSession(session: Session): Omit<QueryConfig, "permissions"> & {
  permissions: QueryConfig["permissions"];
} {
  const { cfg } = session;
  return {
    provider: session.provider,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    systemPrompt: session.systemPrompt,
    maxTokens: cfg.maxTokens,
    maxTurns: cfg.maxTurns,
    maxContextTokens: cfg.maxContextTokens,
    effort: cfg.effort,
    thinking: cfg.thinking,
    roles: cfg.roles,
    hooks: session.hooks,
    sessionId: session.sessionId,
    memory: session.memory,
    tools: session.tools,
    permissions: {
      mode: cfg.permissionMode,
      allowedTools: new Set(),
      deniedTools: new Set(),
      workingDir: session.workingDir,
    },
  };
}

/** The session's identity as hook payloads carry it (HookContext, §7.5). */
export function hookContext(session: Session): {
  sessionId: string;
  cwd: string;
  model: string;
} {
  return {
    sessionId: session.sessionId,
    cwd: session.workingDir,
    model: session.cfg.model,
  };
}

/** Memory GC + extension teardown — best-effort, never fails the run. */
export async function closeSession(session: Session): Promise<void> {
  if (session.memory) {
    try {
      await session.memory.extract();
      session.memory.close();
    } catch {
      // best-effort; never fail the run on a GC error
    }
  }
  await session.ext.close();
}

/** Render one engine event: answer text → stdout, traces → stderr. */
export function renderEvent(ev: QueryEvent, c: Palette): void {
  switch (ev.type) {
    case "text":
      process.stdout.write(ev.text);
      break;
    case "tool_use":
      process.stderr.write(c.dim(`\n⚙ ${ev.describe}\n`));
      break;
    case "tool_result": {
      const body = ev.output.length > 500 ? `${ev.output.slice(0, 500)} …` : ev.output;
      process.stderr.write((ev.isError ? c.red : c.dim)(`  ${body.replace(/\n/g, "\n  ")}\n`));
      break;
    }
    case "retrying":
      process.stderr.write(c.dim(`\n↻ retry ${ev.attempt} in ${ev.delayMs}ms (${ev.reason})\n`));
      break;
    case "error":
      process.stderr.write(c.red(`\n✗ ${ev.message}\n`));
      break;
    case "done":
      process.stderr.write(c.dim(`\n[${ev.status}]\n`));
      break;
    default:
      break;
  }
}

/** Drain a query generator, rendering every event; returns the final state. */
export async function drainRendered(
  gen: AsyncGenerator<QueryEvent, QueryState>,
  c: Palette,
): Promise<QueryState> {
  let result = await gen.next();
  while (!result.done) {
    renderEvent(result.value, c);
    result = await gen.next();
  }
  return result.value;
}
