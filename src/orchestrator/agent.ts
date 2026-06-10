/**
 * Structured sub-agent: runs the engine over an isolated message list and,
 * when a Zod schema is supplied, forces a validated object out via a dedicated
 * `structured_output` tool — no brittle text parsing required.
 *
 * This is the `agent(prompt, {schema})` primitive from the dynamic-workflow
 * model described in ADR 0001 §5. It is intentionally stateless: each call
 * creates a fresh message list and drains the engine generator internally,
 * returning a typed `AgentRun` without leaking events to the caller.
 */

import { z } from "zod";
import { runQuery } from "../query/engine.ts";
import { modelProfile } from "../config/modelCatalog.ts";
import { toStrictJsonSchema } from "./strictSchema.ts";
import type { QueryState } from "../query/types.ts";
import type { Provider } from "../providers/types.ts";
import type { Tool } from "../tools/types.ts";
import { buildTool } from "../tools/types.ts";
import type { ToolPermissionContext } from "../permissions/types.ts";
import type { Role } from "../config/roles.ts";
import { allow } from "../permissions/types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  readonly provider: Provider;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly schema?: z.ZodTypeAny;
  readonly tools?: readonly Tool[];
  readonly permissions: ToolPermissionContext;
  readonly maxTurns?: number;
  readonly signal?: AbortSignal;
  /** Role for effort defaults (architect=xhigh … subagent=low, ADR 0005). */
  readonly role?: Role;
  /** Remaining orchestration token budget, surfaced to capable models (beta). */
  readonly taskBudgetTokens?: number;
}

export interface AgentRun<T = unknown> {
  /** Concatenation of all text blocks from the last assistant message. */
  readonly text: string;
  /** Validated structured data when a schema was provided; null otherwise. */
  readonly data: T | null;
  readonly status: QueryState["status"];
  readonly cost: QueryState["cost"];
  readonly turns: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const STRUCTURED_OUTPUT_TOOL_NAME = "structured_output";

/**
 * Appended to the system prompt when schema mode is active.  We rely on
 * instruction rather than a `tool_choice` parameter (not yet in the provider
 * abstraction), with a JSON-text fallback in case the model ignores us.
 */
const SCHEMA_SYSTEM_SUFFIX =
  "When you have the final answer, call the `structured_output` tool with it. " +
  "Respond ONLY via that tool.";

/** Extract the text content of the last assistant message in a message list. */
function extractLastAssistantText(state: QueryState): string {
  const messages = state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg !== undefined && msg.role === "assistant") {
      return msg.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function runAgent<T = unknown>(
  prompt: string,
  opts: RunAgentOptions,
): Promise<AgentRun<T>> {
  const {
    provider,
    model,
    systemPrompt,
    schema,
    tools,
    permissions,
    maxTurns,
    signal,
    role,
    taskBudgetTokens,
  } = opts;

  // When schema mode is active we wire a capture closure into the tool.
  let captured: unknown;

  // Native structured outputs: when the model enforces a JSON-schema response
  // format AND the schema fits the strict subset (no optional properties),
  // skip the synthetic tool entirely — the run becomes a single constrained
  // response, parsed by the existing JSON fallback below. Schema runs are
  // tool-less by design (the synthetic path also replaces caller tools), so
  // the native path only applies when the caller supplied no tools.
  const strictSchema =
    schema && tools === undefined
      ? toStrictJsonSchema(z.toJSONSchema(schema) as Record<string, unknown>)
      : null;
  const useNative = strictSchema !== null && modelProfile(model).supportsStructuredOutput;

  const resolvedTools: readonly Tool[] | undefined = (() => {
    if (!schema) return tools;
    if (useNative) return [];

    // Build a minimal read-only tool whose `call` captures the validated input.
    const structuredOutputTool = buildTool({
      name: STRUCTURED_OUTPUT_TOOL_NAME,
      description: "Emit the final structured answer. Input must match the required schema.",
      inputSchema: schema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      checkPermissions: async () => allow(),
      describeCall: () => STRUCTURED_OUTPUT_TOOL_NAME,
      call: async (input) => {
        captured = input;
        return { content: "recorded" };
      },
    });

    // Schema mode keeps any caller-supplied tools (e.g. a rubric judge gets
    // read-only file access to gather evidence) and appends the answer tool.
    return [...(tools ?? []), structuredOutputTool];
  })();

  const resolvedSystemPrompt =
    schema && !useNative && systemPrompt
      ? `${systemPrompt}\n\n${SCHEMA_SYSTEM_SUFFIX}`
      : schema && !useNative
      ? SCHEMA_SYSTEM_SUFFIX
      : systemPrompt;

  // Drain the async generator; we expose only the final QueryState.
  const gen = runQuery(prompt, {
    provider,
    model,
    systemPrompt: resolvedSystemPrompt,
    tools: resolvedTools,
    permissions,
    maxTurns,
    signal,
    role,
    taskBudgetTokens,
    ...(useNative && strictSchema !== null ? { responseSchema: strictSchema } : {}),
  });

  let state: QueryState;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = await gen.next();
    if (step.done) {
      state = step.value;
      break;
    }
    // Events are intentionally discarded; callers use `AgentRun` instead.
  }

  const text = extractLastAssistantText(state);

  // Resolve `data` for schema mode.
  let data: T | null = null;
  if (schema) {
    if (captured !== undefined) {
      // The tool was called; `captured` is already schema-validated by `buildTool`
      // (the engine calls `inputSchema.safeParse` before invoking `call`).
      data = captured as T;
    } else {
      // Fallback: model returned JSON text instead of calling the tool.
      try {
        const parsed = JSON.parse(text);
        const result = schema.safeParse(parsed);
        if (result.success) {
          data = result.data as T;
        }
      } catch {
        // JSON.parse failed; data stays null.
        data = null;
      }
    }
  }

  return {
    text,
    data,
    status: state.status,
    cost: state.cost,
    turns: state.turns,
  } as AgentRun<T>;
}
