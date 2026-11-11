#!/usr/bin/env bash
set -euo pipefail
controller_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export LISTEN_HOST="${LISTEN_HOST:-0.0.0.0}"
exec bash "$controller_dir/start.sh"
