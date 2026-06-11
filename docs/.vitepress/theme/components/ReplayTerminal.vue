<script setup lang="ts">
/**
 * ReplayTerminal — a client-side replay of a real recorded `alfred run`.
 *
 * Honesty contract: every line below is the verbatim output of
 * `bun run demo` / `alfred ledger verify` in examples/demo (timestamps
 * shortened). Nothing executes in the browser — this is a recording, replayed,
 * which is exactly the mechanism `alfred eval` uses to gate regressions in CI.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";

type Kind = "dim" | "json" | "ok" | "err" | "cmd";
interface Line {
  readonly text: string;
  readonly kind: Kind;
}
interface Step {
  readonly label: string;
  readonly cmd: string;
  readonly lines: readonly Line[];
}

const RUN_ID = "2026-06-11T03-01-31Z";

const STEPS: readonly Step[] = [
  {
    label: "1 · autonomous run",
    cmd: 'alfred run --verify "bun test add.test.ts" --max-features 1',
    lines: [
      { text: "[mock] scripted provider — ./scripts.ts (no API calls)", kind: "dim" },
      { text: `[run ${RUN_ID}] feature_list=feature_list.json verify="bun test add.test.ts"`, kind: "dim" },
      { text: '{"type":"feature_start","feature":{"id":"demo-add","title":"Implement add()", …}}', kind: "json" },
      { text: '{"type":"attempt","featureId":"demo-add","attempt":1}', kind: "json" },
      { text: '{"type":"verify","featureId":"demo-add","attempt":1,"exitCode":0,"passed":true,"gate":"full"}', kind: "json" },
      { text: '{"type":"feature_passing","featureId":"demo-add"}', kind: "json" },
      { text: '{"type":"run_end","passing":1,"blocked":0,"stopped":"all_resolved"}', kind: "json" },
      { text: `[run ${RUN_ID}] passing=1 blocked=0 stopped=all_resolved ledger=ok`, kind: "ok" },
    ],
  },
  {
    label: "2 · verify the receipt",
    cmd: "alfred ledger verify",
    lines: [
      { text: "✓ ledger intact — 2 rows, hash chain + head anchor verified", kind: "ok" },
      { text: `  .alfred/workflows/${RUN_ID}/ledger.jsonl`, kind: "dim" },
    ],
  },
  {
    label: "3 · flip one byte",
    cmd: `sed -i '' 's/"passing"/"PASSING"/' .alfred/workflows/*/ledger.jsonl`,
    lines: [
      { text: "alfred ledger verify", kind: "cmd" },
      { text: "✗ TAMPER DETECTED at row 0: Signature mismatch at seq 0", kind: "err" },
      { text: `  .alfred/workflows/${RUN_ID}/ledger.jsonl`, kind: "dim" },
      { text: "exit status 1", kind: "err" },
    ],
  },
];

const root = ref<HTMLElement | null>(null);
const stepIndex = ref(0);
const typed = ref("");
const shown = ref<Line[]>([]);
const stepDone = ref(false);
const visited = ref<boolean[]>(STEPS.map(() => false));

let timers: number[] = [];
let disconnect: (() => void) | null = null;

function clearTimers(): void {
  for (const t of timers) window.clearTimeout(t);
  timers = [];
}

function schedule(fn: () => void, ms: number): void {
  timers.push(window.setTimeout(fn, ms));
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function play(i: number): void {
  const step = STEPS[i];
  if (!step) return;
  clearTimers();
  stepIndex.value = i;
  typed.value = "";
  shown.value = [];
  stepDone.value = false;

  const finish = (): void => {
    stepDone.value = true;
    visited.value = visited.value.map((v, j) => v || j === i);
  };

  if (prefersReducedMotion()) {
    typed.value = step.cmd;
    shown.value = [...step.lines];
    finish();
    return;
  }

  let pos = 0;
  const revealLine = (j: number): void => {
    const line = step.lines[j];
    if (!line) {
      finish();
      return;
    }
    shown.value = [...shown.value, line];
    schedule(() => revealLine(j + 1), line.kind === "json" ? 130 : 200);
  };
  const typeChar = (): void => {
    pos += 1;
    typed.value = step.cmd.slice(0, pos);
    if (pos < step.cmd.length) schedule(typeChar, 13);
    else schedule(() => revealLine(0), 260);
  };
  typeChar();
}

const nextIndex = (): number | null => (stepIndex.value + 1 < STEPS.length ? stepIndex.value + 1 : null);

onMounted(() => {
  const el = root.value;
  if (el && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          disconnect = null;
          play(0);
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    disconnect = () => io.disconnect();
  } else {
    play(0);
  }
});

onBeforeUnmount(() => {
  clearTimers();
  disconnect?.();
});
</script>

<template>
  <div ref="root" class="rt">
    <div class="rt-chrome">
      <span class="rt-dot rt-red" /><span class="rt-dot rt-amber" /><span class="rt-dot rt-green" />
      <span class="rt-title">examples/demo — replaying a signed run</span>
      <button class="rt-replay" type="button" @click="play(0)">↻ replay</button>
    </div>

    <div class="rt-tabs" role="tablist" aria-label="demo steps">
      <button
        v-for="(step, i) in STEPS"
        :key="step.label"
        type="button"
        role="tab"
        class="rt-tab"
        :class="{ active: i === stepIndex, visited: visited[i] }"
        :aria-selected="i === stepIndex"
        @click="play(i)"
      >
        {{ step.label }}<span v-if="visited[i] && i !== stepIndex" class="rt-check"> ✓</span>
      </button>
    </div>

    <div class="rt-screen" aria-live="polite">
      <div class="rt-line rt-cmdline">
        <span class="rt-prompt">❯</span>
        <span>{{ typed }}</span>
        <span v-if="!stepDone" class="rt-cursor" aria-hidden="true" />
      </div>
      <div v-for="(line, j) in shown" :key="j" class="rt-line" :class="`rt-${line.kind}`">
        <template v-if="line.kind === 'cmd'"><span class="rt-prompt">❯</span> {{ line.text }}</template>
        <template v-else>{{ line.text }}</template>
      </div>
      <div v-if="stepDone && nextIndex() !== null" class="rt-line">
        <button class="rt-next" type="button" @click="play(nextIndex()!)">
          ▸ next: {{ STEPS[nextIndex()!].label }}
        </button>
      </div>
    </div>

    <p class="rt-caption">
      Pre-recorded replay of a real run — the same record/replay mechanism
      <code>alfred eval</code> uses in CI. Reproduce it yourself with
      <code>bun run demo</code>: no API key; the engine, tools, verify gate and
      signed ledger all run for real.
    </p>
  </div>
</template>

<style scoped>
.rt {
  max-width: 880px;
  margin: 0 auto;
}
.rt-chrome {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 14px;
  background: #232329;
  border: 1px solid #2e2e36;
  border-bottom: none;
  border-radius: 12px 12px 0 0;
}
.rt-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
}
.rt-red { background: #ff5f57; }
.rt-amber { background: #febc2e; }
.rt-green { background: #28c840; }
.rt-title {
  margin-left: 8px;
  font-size: 12px;
  font-family: var(--vp-font-family-mono);
  color: #8b8b96;
}
.rt-replay {
  margin-left: auto;
  font-size: 12px;
  font-family: var(--vp-font-family-mono);
  color: #8b8b96;
  transition: color 0.2s;
}
.rt-replay:hover { color: #e8e8ef; }
.rt-tabs {
  display: flex;
  gap: 0;
  background: #1c1c21;
  border: 1px solid #2e2e36;
  border-bottom: 1px solid #2e2e36;
}
.rt-tab {
  flex: 1;
  padding: 8px 6px;
  font-size: 12.5px;
  font-family: var(--vp-font-family-mono);
  color: #8b8b96;
  border-right: 1px solid #2e2e36;
  transition: color 0.2s, background 0.2s;
}
.rt-tab:last-child { border-right: none; }
.rt-tab:hover { color: #e8e8ef; }
.rt-tab.active {
  color: #a8b1ff;
  background: #16161a;
  box-shadow: inset 0 -2px 0 #a8b1ff;
}
.rt-check { color: #4ade80; }
.rt-screen {
  min-height: 285px;
  padding: 16px 18px;
  background: #16161a;
  border: 1px solid #2e2e36;
  border-top: none;
  border-radius: 0 0 12px 12px;
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  line-height: 1.75;
  text-align: left;
  overflow-x: auto;
}
.rt-line {
  white-space: pre;
  color: #c7c7d1;
}
.rt-cmdline { color: #e8e8ef; }
.rt-prompt { color: #4ade80; margin-right: 8px; }
.rt-dim { color: #71717c; }
.rt-json { color: #9aa3e8; }
.rt-ok { color: #4ade80; }
.rt-err { color: #f87171; }
.rt-cmd { color: #e8e8ef; }
.rt-cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 2px;
  vertical-align: -2px;
  background: #a8b1ff;
  animation: rt-blink 1s steps(1) infinite;
}
@keyframes rt-blink { 50% { opacity: 0; } }
.rt-next {
  margin-top: 6px;
  padding: 3px 10px;
  font-size: 12px;
  font-family: var(--vp-font-family-mono);
  color: #a8b1ff;
  border: 1px solid #3a3a44;
  border-radius: 6px;
  transition: border-color 0.2s, color 0.2s;
}
.rt-next:hover { border-color: #a8b1ff; }
.rt-caption {
  margin-top: 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  text-align: center;
}
</style>
