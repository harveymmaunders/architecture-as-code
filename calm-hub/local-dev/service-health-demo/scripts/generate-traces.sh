#!/usr/bin/env bash
# Usage: generate-traces.sh [flow-slug|all] [count]
# Runs the flows now as real calls between the mock services, count times, and sends the traces to Tempo.
set -euo pipefail

flow="${1:-all}"
count="${2:-1}"

if [[ ! "$flow" =~ ^[a-z0-9-]+$ || ! "$count" =~ ^[1-9][0-9]{0,3}$ ]]; then
  echo "Usage: $0 [flow-slug|all] [count 1-9999]" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
docker compose run --rm --no-deps flow-driver \
  node flow-driver.mjs "$flow" "$count"
