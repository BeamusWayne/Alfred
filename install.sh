#!/usr/bin/env bash
# Alfred installer — one line, handles the runtime for you:
#
#   curl -fsSL https://raw.githubusercontent.com/BeamusWayne/Alfred/main/install.sh | bash
#
# What it does, in order:
#   1. installs Bun (the runtime Alfred is built on) if it is missing
#   2. installs the alfred-agent package globally via bun
#   3. verifies `alfred --version` and prints the 30-second next steps
#
# Works on macOS and Linux (incl. WSL2). Windows: use WSL2.
set -euo pipefail

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  \033[2m%s\033[0m\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"

# --- 1. Bun ---------------------------------------------------------------
BUN_BIN="$(command -v bun || true)"
if [ -z "$BUN_BIN" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_BIN="$HOME/.bun/bin/bun"
fi

if [ -z "$BUN_BIN" ]; then
  say "Installing Bun (Alfred's runtime)…"
  curl -fsSL https://bun.sh/install | bash
  BUN_BIN="$HOME/.bun/bin/bun"
  [ -x "$BUN_BIN" ] || die "Bun install finished but $BUN_BIN is missing — see https://bun.sh"
else
  note "Bun found: $("$BUN_BIN" --version)"
fi

# Bun >= 1.3 required (Alfred is a Bun CLI, not a Node one).
BUN_VERSION="$("$BUN_BIN" --version)"
BUN_MAJOR="${BUN_VERSION%%.*}"
BUN_REST="${BUN_VERSION#*.}"
BUN_MINOR="${BUN_REST%%.*}"
if [ "$BUN_MAJOR" -lt 1 ] || { [ "$BUN_MAJOR" -eq 1 ] && [ "$BUN_MINOR" -lt 3 ]; }; then
  say "Bun $BUN_VERSION is too old (need >= 1.3) — upgrading…"
  "$BUN_BIN" upgrade
fi

# --- 2. alfred-agent --------------------------------------------------------
say "Installing alfred-agent…"
"$BUN_BIN" install -g alfred-agent

# --- 3. verify + next steps -------------------------------------------------
ALFRED_BIN="$HOME/.bun/bin/alfred"
[ -x "$ALFRED_BIN" ] || ALFRED_BIN="$(command -v alfred || true)"
[ -n "$ALFRED_BIN" ] || die "install finished but alfred is not on PATH — add ~/.bun/bin to PATH"

say ""
say "✓ alfred $("$ALFRED_BIN" --version) installed"
case ":$PATH:" in
  *":$HOME/.bun/bin:"*) ;;
  *) note "add Bun to your PATH first:  export PATH=\"\$HOME/.bun/bin:\$PATH\"  (then reload your shell)" ;;
esac
say ""
say "Next steps:"
note "alfred demo     30-second offline proof — no API key needed"
note "alfred init     interactive setup: provider, key, feature list"
note "alfred doctor   check the whole setup in one pass"
note "alfred          start a conversation (or: alfred \"explain this repo\")"
