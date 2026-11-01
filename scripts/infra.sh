#!/usr/bin/env bash
# pnpm infra up [pipeline] | down | reset
#   up        dugout's Postgres and Valkey; `up pipeline` also makes the fanos database and starts
#             Electric, for the pipeline's apps (ADR 0021)
#   down      stops them all and removes the containers; data stays in the volumes
#   reset     down, and DELETES dugout's volumes (agent memory, runs, approvals)
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  up)
    docker compose up -d --wait
    if [ "${2:-}" = "pipeline" ]; then
      scripts/pipeline-db.sh
      docker compose --profile pipeline up -d --wait pipeline-electric
    fi
    ;;
  down) docker compose --profile pipeline down ;;
  reset) docker compose --profile pipeline down -v ;;
  *) echo "usage: pnpm infra up [pipeline] | down | reset" >&2; exit 2 ;;
esac
