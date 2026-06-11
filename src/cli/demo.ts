/**
 * `alfred demo` — the 30-second offline proof, built into the package so
 * `bunx alfred-agent demo` works without cloning the repo or setting a key.
 *
 * Scaffolds a RED project in a temp dir (failing test + pending feature),
 * shows the gate failing, lets a scripted model drive the REAL harness to
 * green, verifies the signed ledger, then flips one byte in a copy and shows
 * the tamper being caught. Engine, tools, gate and ledger are all real —
 * only the model is recorded.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/manager.ts";
import { DEMO_ADD_TEST_TS, DEMO_FEATURE_LIST, DEMO_VERIFY_CMD } from "../demo/assets.ts";
import { demoScripts } from "../demo/scripts.ts";
import { runVerify } from "../harness/verify.ts";
import { Journal } from "../orchestrator/journal.ts";
import { Ledger } from "../orchestrator/ledger.ts";
import { DEFAULT_LEDGER_SECRET, formatVerifyOutcome } from "../orchestrator/ledgerLocate.ts";
import { createRuntime } from "../orchestrator/runtime.ts";
import { autonomousRun } from "../orchestrator/workflows/autonomousRun.ts";
import { MockProvider } from "../providers/mock.ts";
import { palette } from "./colors.ts";
import { renderAutonomousEvent } from "./renderRun.ts";

/** Run the offline demo end-to-end. Returns the process exit code. */
export async function runDemo(): Promise<number> {
  const c = palette(process.stderr);
  const out = (s: string) => process.stderr.write(`${s}\n`);

  const dir = await mkdtemp(join(tmpdir(), "alfred-demo-"));
  await Bun.write(join(dir, "add.test.ts"), DEMO_ADD_TEST_TS);
  await Bun.write(
    join(dir, "feature_list.json"),
    `${JSON.stringify(DEMO_FEATURE_LIST, null, 2)}\n`,
  );

  out(c.bold("alfred demo — a verified autonomous run, no API key"));
  out(c.dim(`  sandbox: ${dir}`));
  out(
    c.dim(
      "  real engine · real tools · real verify gate · real signed ledger — only the model is scripted",
    ),
  );
  out("");

  // Show RED for real: the gate fails before the agent has done anything.
  const red0 = await runVerify(DEMO_VERIFY_CMD, { cwd: dir, timeoutMs: 60_000 });
  out(`RED  gate:full ${c.red("✗")} exit ${red0.exitCode} — add.ts does not exist yet`);
  out("");

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(dir, ".alfred", "workflows", runId);
  const journal = new Journal(join(runDir, "journal.jsonl"));
  const ledgerPath = join(runDir, "ledger.jsonl");
  const ledger = new Ledger(ledgerPath, DEFAULT_LEDGER_SECRET);
  const runtime = createRuntime(runId, {
    provider: new MockProvider(demoScripts),
    model: loadConfig({}).model,
    permissions: {
      mode: "bypass",
      allowedTools: new Set(),
      deniedTools: new Set(),
      workingDir: dir,
    },
    journal,
  });

  const result = await autonomousRun({
    runtime,
    ledger,
    cwd: dir,
    featureListPath: join(dir, "feature_list.json"),
    verifyCmd: DEMO_VERIFY_CMD,
    maxFeatures: 1,
    onEvent: (ev) => {
      const line = renderAutonomousEvent(ev, c);
      if (line !== null) out(line);
    },
  });
  await journal.close();

  out("");
  const rows = await ledger.readAll();
  const outcome = await ledger.verify();
  out(formatVerifyOutcome(ledgerPath, rows.length, outcome));

  // Tamper drill: flip one byte in a COPY, watch verification reject it.
  const raw = await Bun.file(ledgerPath).text();
  const tamperedPath = join(runDir, "ledger.tampered.jsonl");
  await Bun.write(tamperedPath, raw.replace('"passing"', '"passinG"'));
  const head = Bun.file(`${ledgerPath}.head`);
  if (await head.exists()) {
    await Bun.write(`${tamperedPath}.head`, await head.text());
  }
  const drill = await new Ledger(tamperedPath, DEFAULT_LEDGER_SECRET).verify();
  out("");
  out(
    drill.ok
      ? c.red("✗ tamper drill FAILED — the flipped byte went unnoticed (this is a bug)")
      : `tamper drill: flipped one byte in a copy → ${c.green("caught")} (row ${drill.brokenAt}: ${drill.reason})`,
  );

  out("");
  out(c.bold("everything above ran for real — only the model was scripted."));
  out(c.dim(`  receipt:  ${ledgerPath}`));
  out(c.dim(`  inspect:  alfred ledger show ${ledgerPath}`));
  out(
    c.dim(
      '  next:     alfred init · alfred run --verify "bun test" · beamuswayne.github.io/Alfred',
    ),
  );

  const ok = result.passing === 1 && result.blocked === 0 && outcome.ok && !drill.ok;
  return ok ? 0 : 1;
}
