#!/usr/bin/env bash
#
# Reproducible minimal Alfred-Bench: the agent must implement two functions
# (slugify, truncate) that pass a HELD-OUT test suite it never sees, with a
# signed FAIL->PASS receipt. Requires a provider key, e.g.:
#
#   ALFRED_PROVIDER=google GOOGLE_API_KEY=...      examples/bench/run.sh
#   ALFRED_PROVIDER=openai OPENAI_API_KEY=...      examples/bench/run.sh
#   ALFRED_PROVIDER=anthropic ANTHROPIC_API_KEY=... examples/bench/run.sh
#
# The model works in a throwaway temp dir; this committed example is read-only.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/alfred-bench-XXXXXX")"

mkdir -p "$WORK/target"
cp "$HERE/feature_list.json" "$WORK/target/feature_list.json"

cat > "$WORK/spec.json" <<JSON
{
  "targetDir": "$WORK/target",
  "heldOutTestsDir": "$HERE/heldout",
  "featureListPath": "$WORK/target/feature_list.json",
  "buildCmd": "bun -e \"const {slugify}=await import('./src/slugify.ts'); const {truncate}=await import('./src/truncate.ts'); if(slugify('Hello, World!')!=='hello-world')process.exit(1); if(truncate('hello world',5)!=='hello…')process.exit(2);\"",
  "testCmd": "bun test ./slugify.test.ts ./truncate.test.ts"
}
JSON

export ALFRED_LEDGER_SECRET="${ALFRED_LEDGER_SECRET:-bench-example-secret}"
echo "[example-bench] workspace: $WORK"
echo "[example-bench] provider: ${ALFRED_PROVIDER:-anthropic}  model: ${ALFRED_MODEL:-<provider default>}"
bun run "$REPO/src/bench/cli.ts" "$WORK/spec.json"
