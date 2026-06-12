/**
 * `alfred doctor` — diagnose a setup in one pass.
 *
 * Every fact a support thread would ask for, with the fix next to the
 * finding: runtime version, provider key, hooks config, feature_list,
 * ledger secret, last receipt, git, and whether a flight recorder
 * (NightWatch) is available. `gatherDoctor` does the IO; `renderDoctor`
 * is pure (unit-tested). Exit 1 only on hard failures.
 */
import { join } from "node:path";
import { loadHooksConfig } from "../hooks/engine.ts";
import { Ledger } from "../orchestrator/ledger.ts";
import { DEFAULT_LEDGER_SECRET, findLatestLedger } from "../orchestrator/ledgerLocate.ts";
import { VERSION } from "../version.ts";
import type { Palette } from "./colors.ts";
import { isStarterFeatureList } from "./init.ts";
import { keyEnvName, keyPresent, mockActive } from "./session.ts";

const MIN_BUN_MINOR = { major: 1, minor: 3 } as const;

export type CheckLevel = "ok" | "warn" | "fail" | "info";

export interface DoctorCheck {
  readonly name: string;
  readonly level: CheckLevel;
  readonly detail: string;
  /** The exact command or export that resolves a warn/fail. */
  readonly fix?: string;
}

export interface DoctorEnv {
  readonly provider: string;
  readonly model: string;
  /** Injectable for tests. Defaults to Bun.version. */
  readonly bunVersion?: string;
  /** Injectable for tests. Defaults to Bun.which. */
  readonly which?: (bin: string) => string | null;
}

function bunCheck(version: string): DoctorCheck {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const ok =
    major > MIN_BUN_MINOR.major ||
    (major === MIN_BUN_MINOR.major && minor >= MIN_BUN_MINOR.minor);
  return ok
    ? { name: "runtime", level: "ok", detail: `bun ${version}` }
    : {
        name: "runtime",
        level: "fail",
        detail: `bun ${version} — alfred needs ≥ ${MIN_BUN_MINOR.major}.${MIN_BUN_MINOR.minor}`,
        fix: "bun upgrade",
      };
}

function providerCheck(env: DoctorEnv): DoctorCheck {
  if (mockActive()) {
    return {
      name: "provider",
      level: "ok",
      detail: `${env.provider} — scripted (ALFRED_MOCK_SCRIPTS, no API calls)`,
    };
  }
  if (keyPresent(env.provider)) {
    return { name: "provider", level: "ok", detail: `${env.provider} · ${env.model} — key ✓` };
  }
  return {
    name: "provider",
    level: "fail",
    detail: `no ${keyEnvName(env.provider)} set`,
    fix: "alfred init — interactive provider setup (or export the key)",
  };
}

async function hooksCheck(cwd: string): Promise<DoctorCheck> {
  const path = join(cwd, ".alfred", "hooks.json");
  try {
    const cfg = await loadHooksConfig(path);
    if (cfg.hooks.length === 0) {
      return { name: "hooks", level: "info", detail: "none configured" };
    }
    const events = [...new Set(cfg.hooks.map((h) => h.event))].join(", ");
    return { name: "hooks", level: "ok", detail: `${cfg.hooks.length} hook(s) — ${events}` };
  } catch (err) {
    return {
      name: "hooks",
      level: "fail",
      detail: err instanceof Error ? err.message : String(err),
      fix: "fix or remove .alfred/hooks.json",
    };
  }
}

async function featureListCheck(cwd: string): Promise<DoctorCheck> {
  const path = join(cwd, "feature_list.json");
  if (!(await Bun.file(path).exists())) {
    return {
      name: "feature_list",
      level: "info",
      detail: "none",
      fix: "alfred init — scaffold one for `alfred run`",
    };
  }
  try {
    const { loadFeatureList } = await import("../harness/featureList.ts");
    const list = await loadFeatureList(path);
    if (isStarterFeatureList(list)) {
      return {
        name: "feature_list",
        level: "warn",
        detail: "still the starter scaffold",
        fix: "edit feature_list.json — describe a real feature first",
      };
    }
    return { name: "feature_list", level: "ok", detail: `${list.features.length} feature(s)` };
  } catch (err) {
    return {
      name: "feature_list",
      level: "fail",
      detail: err instanceof Error ? err.message : String(err),
      fix: "fix feature_list.json — `alfred init --force` rescaffolds",
    };
  }
}

function ledgerSecretCheck(): DoctorCheck {
  if (process.env.ALFRED_LEDGER_SECRET) {
    return { name: "ledger secret", level: "ok", detail: "ALFRED_LEDGER_SECRET set" };
  }
  return {
    name: "ledger secret",
    level: "warn",
    detail: "using the built-in default — receipts are tamper-evident but not private to you",
    fix: "export ALFRED_LEDGER_SECRET=$(openssl rand -hex 32)",
  };
}

async function lastReceiptCheck(cwd: string): Promise<DoctorCheck> {
  try {
    const path = await findLatestLedger(cwd);
    if (path === null) {
      return { name: "last receipt", level: "info", detail: "no runs yet" };
    }
    const secret = process.env.ALFRED_LEDGER_SECRET ?? DEFAULT_LEDGER_SECRET;
    const ledger = new Ledger(path, secret);
    const rows = (await ledger.readAll()).length;
    const outcome = await ledger.verify();
    return outcome.ok
      ? { name: "last receipt", level: "ok", detail: `chain intact (${rows} rows)` }
      : {
          name: "last receipt",
          level: "fail",
          detail: `TAMPERED — ${outcome.reason ?? "chain broken"}`,
          fix: "alfred ledger verify — see the exact failing row",
        };
  } catch (err) {
    return {
      name: "last receipt",
      level: "warn",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function gitCheck(which: (bin: string) => string | null): DoctorCheck {
  return which("git") !== null
    ? { name: "git", level: "ok", detail: "available" }
    : {
        name: "git",
        level: "warn",
        detail: "not found — checkpoints, rollback and best-of-N need it",
        fix: "install git",
      };
}

function recorderCheck(which: (bin: string) => string | null): DoctorCheck {
  return which("nightwatch") !== null
    ? {
        name: "recorder",
        level: "ok",
        detail: "NightWatch detected — record runs with `nightwatch init --agent alfred`",
      }
    : {
        name: "recorder",
        level: "info",
        detail: "no flight recorder — `npm i -g nightwatch-agent` adds black-box session records",
      };
}

/** Collect every diagnostic for `cwd`. Never throws. */
export async function gatherDoctor(cwd: string, env: DoctorEnv): Promise<readonly DoctorCheck[]> {
  const which = env.which ?? ((bin: string) => Bun.which(bin));
  const [hooks, featureList, lastReceipt] = await Promise.all([
    hooksCheck(cwd),
    featureListCheck(cwd),
    lastReceiptCheck(cwd),
  ]);
  return [
    bunCheck(env.bunVersion ?? Bun.version),
    providerCheck(env),
    hooks,
    featureList,
    ledgerSecretCheck(),
    lastReceipt,
    gitCheck(which),
    recorderCheck(which),
  ];
}

const MARKS: Record<CheckLevel, string> = { ok: "✓", warn: "⚠", fail: "✗", info: "·" };

/** Render the report (pure; color via the injected palette). */
export function renderDoctor(checks: readonly DoctorCheck[], c: Palette): string {
  const width = Math.max(...checks.map((ch) => ch.name.length));
  const lines = [`${c.bold(`alfred doctor v${VERSION}`)}`, ""];
  for (const ch of checks) {
    const paint =
      ch.level === "ok"
        ? c.green
        : ch.level === "warn"
          ? c.yellow
          : ch.level === "fail"
            ? c.red
            : c.dim;
    lines.push(`  ${paint(MARKS[ch.level])} ${ch.name.padEnd(width)}  ${ch.detail}`);
    if (ch.fix !== undefined && ch.level !== "ok") {
      lines.push(`    ${" ".repeat(width)}  ${c.dim(`→ ${ch.fix}`)}`);
    }
  }
  const fails = checks.filter((ch) => ch.level === "fail").length;
  const warns = checks.filter((ch) => ch.level === "warn").length;
  lines.push(
    "",
    fails > 0
      ? c.red(`${fails} failure(s), ${warns} warning(s)`)
      : warns > 0
        ? c.yellow(`healthy with ${warns} warning(s)`)
        : c.green("all checks passed"),
  );
  return lines.join("\n");
}

/** True when any check is a hard failure (drives the exit code). */
export function hasFailure(checks: readonly DoctorCheck[]): boolean {
  return checks.some((ch) => ch.level === "fail");
}
