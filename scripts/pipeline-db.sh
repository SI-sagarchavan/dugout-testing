#!/usr/bin/env bash
# The pipeline's database (`fanos`) inside dugout's Postgres container (ADR 0021).
#
#   scripts/pipeline-db.sh                  create the role and database if they are missing
#   scripts/pipeline-db.sh import [source]  copy a control-plane database into it, from another
#                                           Postgres container (default api-postgres-1, the old
#                                           trial stack). Replaces what `fanos` holds, so it
#                                           refuses a database that already has exports unless
#                                           --force is the last argument.
#
# The source is only read.
set -euo pipefail

DST="${DUGOUT_PG_CONTAINER:-dugout-postgres-1}"
admin() { docker exec -i "$DST" psql -v ON_ERROR_STOP=1 -U harness -d harness -At "$@"; }

ensure() {
  admin -c "DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fanos') THEN
      CREATE ROLE fanos LOGIN REPLICATION PASSWORD 'fanos';
    END IF;
  END \$\$" >/dev/null
  for name in fanos fanos_test; do
    if [ -z "$(admin -c "SELECT 1 FROM pg_database WHERE datname = '$name'")" ]; then
      admin -c "CREATE DATABASE $name OWNER fanos" >/dev/null
      echo "created database $name"
    else
      echo "database $name exists"
    fi
  done
}

case "${1:-ensure}" in
  ensure) ensure ;;
  import)
    force=false; [ "${*: -1}" = "--force" ] && force=true
    src="${2:-api-postgres-1}"; [ "$src" = "--force" ] && src=api-postgres-1
    ensure
    held=$(docker exec -i "$DST" psql -U fanos -d fanos -At -c "SELECT count(*) FROM figma_exports" 2>/dev/null || echo 0)
    if [ "${held:-0}" -gt 0 ] && [ "$force" != true ]; then
      echo "fanos already holds $held exports; importing replaces them. Pass --force to do it." >&2
      exit 1
    fi
    # Check the source and take the whole dump before anything is dropped: an unreachable source
    # must leave the target as it is.
    if [ "$(docker inspect -f '{{.State.Running}}' "$src" 2>/dev/null)" != true ]; then
      echo "$src is not running, so there is nothing to import. Start it (docker start $src) and retry." >&2
      exit 1
    fi
    dump="$(mktemp)"; trap 'rm -f "$dump"' EXIT
    docker exec "$src" pg_dump -U fanos -Fc fanos > "$dump"
    if [ ! -s "$dump" ]; then echo "the dump from $src is empty; nothing was changed." >&2; exit 1; fi
    if ! admin -c "DROP DATABASE fanos WITH (FORCE)" >/dev/null 2>&1; then
      echo "could not replace fanos: Electric holds a replication slot on it. Stop it first (pnpm infra down)." >&2
      exit 1
    fi
    admin -c "CREATE DATABASE fanos OWNER fanos" >/dev/null
    docker exec -i "$DST" pg_restore -U fanos -d fanos --no-owner --exit-on-error < "$dump"
    echo "imported from $src:"
    docker exec -i "$DST" psql -U fanos -d fanos -At -c \
      "SELECT 'exports ' || count(*) FROM figma_exports UNION ALL SELECT 'artifacts ' || count(*) FROM artifacts"
    ;;
  *) echo "usage: $0 [ensure | import [source-container] [--force]]" >&2; exit 2 ;;
esac
