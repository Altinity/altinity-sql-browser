#!/usr/bin/env bash
# Empty the Altinity SQL Browser assets (sql.html, sql-config.json) in every
# node's user_files/ - SQL-only, same fan-out pattern as install.sh (#692).
# A 0-byte file makes the /sql handler answer 200 with an empty body; removing
# the http_handlers config (config.d/) and reloading is the real uninstall:
# SQL cannot delete a file.
#
# Concurrent runs against the same cluster are unsupported (no lock); see install.sh.
# curl calls ignore ~/.curlrc (-q) but honour HTTP(S)_PROXY: plain-HTTP credentials
# would traverse a configured proxy.
#
# Usage:
#   CLICKHOUSE_PASSWORD=... ./deploy/uninstall.sh --ch-host H [--ch-user U] \
#     [--cluster C] [--transport native|http] [--http-port N] [--ddl-timeout 180] [--secure]
set -euo pipefail

# shellcheck source=deploy/lib/asb-ch.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/asb-ch.sh"

CH_HOST="" CH_USER="default" CLUSTER="" SECURE=0
TRANSPORT="native" HTTP_PORT="" DDL_TIMEOUT=180
while [[ $# -gt 0 ]]; do
  case "$1" in
    --secure) SECURE=1; shift; continue ;;
  esac
  case "$1" in
    --ch-host|--ch-user|--cluster|--transport|--http-port|--ddl-timeout)
      [[ $# -ge 2 ]] || { echo "missing value for $1" >&2; exit 2; } ;;
  esac
  case "$1" in
    --ch-host) CH_HOST="$2"; shift 2 ;;
    --ch-user) CH_USER="$2"; shift 2 ;;
    --cluster) CLUSTER="$2"; shift 2 ;;
    --transport) TRANSPORT="$2"; shift 2 ;;
    --http-port) HTTP_PORT="$2"; shift 2 ;;
    --ddl-timeout) DDL_TIMEOUT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$CH_HOST" ]] || { echo "--ch-host is required" >&2; exit 2; }
case "$TRANSPORT" in native|http) ;; *) echo "--transport must be native or http" >&2; exit 2 ;; esac
[[ -z "$CLUSTER" ]] || validate_cluster_name "$CLUSTER"
validate_pos --ddl-timeout "$DDL_TIMEOUT"
[[ -z "$HTTP_PORT" ]] || validate_uint --http-port "$HTTP_PORT"

if [[ -z "${CLICKHOUSE_PASSWORD:-}" ]]; then
  read -r -s -p "ClickHouse password for $CH_USER@$CH_HOST: " CLICKHOUSE_PASSWORD; echo
fi
CH_PASSWORD="${CLICKHOUSE_PASSWORD:-}"
unset CLICKHOUSE_PASSWORD   # only clickhouse-client gets it (env prefix); see lib/asb-ch.sh

T_RM_HTML="default._asb_t_rm_html" T_RM_CFG="default._asb_t_rm_cfg"
T_NX_HTML="default._asb_t_next_html" T_NX_CFG="default._asb_t_next_cfg"
EXPECTED_NODES=1 ON_CLUSTER="" CLEANUP_ARMED=0
CH=()
TMP="$(mktemp -d)"
cleanup() {
  local rc=$? t
  trap '' INT TERM
  trap - EXIT
  set +e   # always reach `rm -rf "$TMP"` (it holds the credentials)
  if [[ "$CLEANUP_ARMED" == 1 ]]; then
    limit_ddl_timeout 30   # bounded: each call ends within min(--ddl-timeout,30)+10 s
    for t in "$T_RM_HTML" "$T_RM_CFG" "$T_NX_HTML" "$T_NX_CFG"; do
      ch_query "DROP TABLE IF EXISTS ${t}${ON_CLUSTER} SYNC" >/dev/null \
        || echo "WARN: could not drop ${t}; drop it by hand" >&2
    done
  fi
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
set_cluster_clause

setup_transport
if [[ -n "$CLUSTER" ]]; then preflight_cluster; else info "==> Single-node mode: only ${CH_HOST} is emptied (pass --cluster for every node)"; fi

CLEANUP_ARMED=1
info "==> Pre-clean"
ddl "drop ${T_RM_HTML}" "DROP TABLE IF EXISTS ${T_RM_HTML}${ON_CLUSTER} SYNC"
ddl "drop ${T_RM_CFG}" "DROP TABLE IF EXISTS ${T_RM_CFG}${ON_CLUSTER} SYNC"
ddl "drop ${T_NX_HTML}" "DROP TABLE IF EXISTS ${T_NX_HTML}${ON_CLUSTER} SYNC"
ddl "drop ${T_NX_CFG}" "DROP TABLE IF EXISTS ${T_NX_CFG}${ON_CLUSTER} SYNC"

info "==> Emptying sql.html and sql-config.json (and the _asb_next_* copies: they hold a full copy of the SPA)"
ddl "empty sql.html" "$(write_file_stmt "$T_RM_HTML" sql.html "SELECT '' AS c SETTINGS engine_file_truncate_on_insert=1")"
ddl "empty sql-config.json" "$(write_file_stmt "$T_RM_CFG" sql-config.json "SELECT '' AS c SETTINGS engine_file_truncate_on_insert=1")"
ddl "empty _asb_next_sql.html" "$(write_file_stmt "$T_NX_HTML" _asb_next_sql.html "SELECT '' AS c SETTINGS engine_file_truncate_on_insert=1")"
ddl "empty _asb_next_sql-config.json" "$(write_file_stmt "$T_NX_CFG" _asb_next_sql-config.json "SELECT '' AS c SETTINGS engine_file_truncate_on_insert=1")"
ddl "drop ${T_RM_HTML}" "DROP TABLE IF EXISTS ${T_RM_HTML}${ON_CLUSTER} SYNC"
ddl "drop ${T_RM_CFG}" "DROP TABLE IF EXISTS ${T_RM_CFG}${ON_CLUSTER} SYNC"
ddl "drop ${T_NX_HTML}" "DROP TABLE IF EXISTS ${T_NX_HTML}${ON_CLUSTER} SYNC"
ddl "drop ${T_NX_CFG}" "DROP TABLE IF EXISTS ${T_NX_CFG}${ON_CLUSTER} SYNC"

EMPTY_SHA="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
# mode "any": a 0-byte RawBLOB may legitimately yield n=0 rows (the only caller allowed to accept that)
verify_files "emptied files" any sql.html 0 "$EMPTY_SHA" sql-config.json 0 "$EMPTY_SHA" _asb_next_sql.html 0 "$EMPTY_SHA" _asb_next_sql-config.json 0 "$EMPTY_SHA" \
  || fail "some files were not emptied on every node"
echo "==> Asset files emptied on ${EXPECTED_NODES} node(s). Remove deploy/http_handlers.xml from config.d/ to disable /sql."
