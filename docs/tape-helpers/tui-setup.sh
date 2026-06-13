#!/usr/bin/env bash
# Sandbox + scripted model for docs/tui.tape (keyless, deterministic).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$(mktemp -d)"
cat > "$DIR/mock.ts" <<MOCK
import { textResponse, type Script } from "$REPO/src/providers/mock.ts";
const script: Script = () =>
  textResponse([
    "Good evening. I keep three receipts for every run:",
    "- a signed HMAC ledger (my own receipt)",
    "- a NightWatch black-box record (a witness I cannot edit)",
    "- a trust report your CI can read",
    "Logs are claims. Replays are proofs.",
  ].join("\n"));
export default [script];
MOCK
echo "$DIR"
