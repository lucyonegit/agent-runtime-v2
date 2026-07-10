#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/compose.postgres-test.yml"
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55433/agent_runtime_test"

cleanup() {
  docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans
}

trap cleanup EXIT INT TERM

docker compose -f "$COMPOSE_FILE" up --detach --wait

cd "$ROOT_DIR"
DATABASE_URL="$DATABASE_URL" \
  ./node_modules/.bin/vitest run --exclude 'dist/**' tests/postgres-store.test.ts
