#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3.10 or newer is required." >&2
  exit 1
fi
if ! command -v openshell >/dev/null 2>&1; then
  echo "openshell was not found in PATH." >&2
  exit 1
fi

echo "Starting TrustRoute Korea on http://0.0.0.0:${PORT:-3000}"
exec python3 ui/server/index.py
