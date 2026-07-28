#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/compose.postgres-test.yml"
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55433/agent_runtime_test"
VITEST_BIN="$ROOT_DIR/node_modules/.bin/vitest"
if [[ ! -x "$VITEST_BIN" ]]; then
  VITEST_BIN="$ROOT_DIR/../../node_modules/.bin/vitest"
fi
if [[ ! -x "$VITEST_BIN" ]]; then
  echo "Unable to find Vitest from $ROOT_DIR or the monorepo root." >&2
  exit 1
fi

cleanup() {
  docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans
}

trap cleanup EXIT INT TERM

docker compose -f "$COMPOSE_FILE" up --detach --wait

cd "$ROOT_DIR"
DATABASE_URL="$DATABASE_URL" \
  "$VITEST_BIN" run --exclude 'dist/**' tests/postgres*.test.ts
