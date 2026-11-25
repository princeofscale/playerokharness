#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${APP_DIR}"

if [ ! -d "node_modules" ]; then
  echo "Устанавливаю зависимости..."
  pnpm install
fi

# Incremental build on every start: a stale dist/ used to run silently after a
# source change. Set PKH_SKIP_BUILD=1 to skip it.
if [ "${PKH_SKIP_BUILD:-0}" != "1" ]; then
  echo "Собираю PlayerOK Harness (pkh)..."
  pnpm build
fi

if [ ! -f "bot_settings/config.json" ]; then
  node packages/app/dist/cli.js setup --data-dir "${APP_DIR}"
fi

exec node packages/app/dist/cli.js start --data-dir "${APP_DIR}"
