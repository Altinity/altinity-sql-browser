#!/usr/bin/env bash
# Remove the Altinity SQL Browser assets from a ClickHouse cluster's
# user_files/. Does NOT remove the http_handlers config (edit config.d/ and
# reload to fully disable the /sql routes).
#
# Usage:
#   CLICKHOUSE_PASSWORD=... ./deploy/uninstall.sh --ch-host H [--ch-user U] [--cluster C] [--secure]
# NOTE: with --cluster this only truncates the files on the connected node: the
# CREATE/DROP run ON CLUSTER but the INSERT that empties the file is local.
set -euo pipefail

CH_HOST="" CH_USER="default" CLUSTER="" SECURE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ch-host) CH_HOST="$2"; shift 2 ;;
    --ch-user) CH_USER="$2"; shift 2 ;;
    --cluster) CLUSTER="$2"; shift 2 ;;
    --secure) SECURE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$CH_HOST" ]] || { echo "--ch-host is required" >&2; exit 2; }

if [[ -z "${CLICKHOUSE_PASSWORD:-}" ]]; then
  read -r -s -p "ClickHouse password for $CH_USER@$CH_HOST: " CLICKHOUSE_PASSWORD; echo
fi
export CLICKHOUSE_PASSWORD

CH=(clickhouse-client --host "$CH_HOST" --user "$CH_USER")
[[ "$SECURE" == 1 ]] && CH+=(--secure)

# Truncate the asset files to empty by writing 0 bytes through a File table.
for fname in sql.html sql-config.json; do
  tbl="default._asb_rm_$(echo "$fname" | tr '.-' '__')"
  "${CH[@]}" --query "CREATE TABLE IF NOT EXISTS ${tbl} ${CLUSTER:+ON CLUSTER '${CLUSTER}'} (content String)
    ENGINE = File('RawBLOB', '/var/lib/clickhouse/user_files/${fname}')"
  "${CH[@]}" --query "INSERT INTO ${tbl} SETTINGS engine_file_truncate_on_insert = 1 SELECT ''"
  "${CH[@]}" --query "DROP TABLE IF EXISTS ${tbl} ${CLUSTER:+ON CLUSTER '${CLUSTER}'}"
done
echo "==> Asset files emptied. Remove deploy/http_handlers.xml from config.d/ to disable /sql."
