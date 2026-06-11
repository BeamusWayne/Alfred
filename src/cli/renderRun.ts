/**
 * Human rendering for `alfred run` progress (one line per harness event,
 * `terraform apply` style — legibility without a TUI). The raw event stream
 * stays available behind `--json`; this module is the default face.
 *
 * Pure: event in, string out (null = nothing to print). Unit-tested.
 */
import type { AutonomousEvent } from "../orchestrator/workflows/autonomousRun.ts";
import type { Palette } from "./colors.ts";

export function renderAutonomousEvent(ev: AutonomousEvent, c: Palette): string | null {
  switch (ev.type) {
    case "feature_start":
      return `${c.bold(`▸ ${ev.feature.id}`)}  ${ev.feature.title}`;
    case "attempt":
      return c.dim(`  attempt ${ev.attempt}`);
    case "verify": {
      const mark = ev.passed ? c.green("✓") : c.red("✗");
      return `  gate:${ev.gate} ${mark} exit ${ev.exitCode}`;
    }
    case "feature_passing":
      return c.green(`✓ ${ev.featureId} passing`);
    case "feature_blocked":
      return c.red(`✗ ${ev.featureId} blocked — ${ev.reason}`);
    case "run_end":
      return c.bold(`run end: ${ev.passing} passing · ${ev.blocked} blocked · ${ev.stopped}`);
    default:
      return null;
  }
}
