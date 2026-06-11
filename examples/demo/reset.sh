#!/usr/bin/env bash
# Reset the offline demo to its starting (RED) state.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf .alfred add.ts
cp feature_list.template.json feature_list.json
echo "demo reset: add.ts removed, feature_list.json back to pending"
