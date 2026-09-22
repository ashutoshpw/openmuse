#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bun_store="$repo_root/node_modules/.bun"
babel_runtime="$(find "$bun_store" -maxdepth 1 -type d -name '@babel+runtime@*' -print -quit 2>/dev/null || true)"

# Bun's isolated store does not always expose Babel's runtime through the
# mobile workspace's Node resolution during Jest startup. Keep this workaround
# in one canonical command until the workspace resolver no longer needs it.
if [[ -n "$babel_runtime" ]]; then
  export NODE_PATH="${babel_runtime}/node_modules${NODE_PATH:+:${NODE_PATH}}"
fi

cd "$repo_root/apps/mobile"
exec bun run test
