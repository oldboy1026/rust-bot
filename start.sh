#!/usr/bin/env bash
set -euo pipefail

controller_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$controller_dir"
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 22 or newer is required: https://nodejs.org/' >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo 'This project requires Node.js 22 or newer.' >&2
  exit 1
fi
if [[ ! -f node_modules/steam-user/package.json ]]; then
  npm ci --registry=https://registry.npmjs.org --no-audit --no-fund
fi
exec node src/main.js
