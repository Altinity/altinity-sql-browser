#!/usr/bin/env bash
# Install the Altinity SQL Browser onto a ClickHouse server or cluster, SQL-only
# (no ssh, no per-node upload):
#   1. build the single-file SPA (dist/sql.html), or take --artifact <path>
#   2. render config.json from the OAuth args
#   3. render dist/http_handlers.xml (CSP connect-src filled from OIDC discovery)
#   4. distribute sql.html + sql-config.json into every node's user_files/ with
#      server-side fan-out, in two phases so a failure never half-writes the
#      live files (see "How it works" below)
#   5. print the next step to enable /sql with the rendered http_handlers.xml
#
# The password is read from the CLICKHOUSE_PASSWORD env var or prompted - never
# passed on the command line (it would leak via `ps`/shell history). The script
# takes it out of its environment at once and hands it only to clickhouse-client
# (as an env prefix on that one call); npm, node and the OIDC curl never see it.
# With --transport http it travels in a 0600 header file handed to curl, not argv.
# HTTP(S)_PROXY / NO_PROXY apply to every curl call (curl's own rules, no --noproxy):
# in plain-HTTP mode a configured proxy would see the credentials; use --secure or
# unset the proxy variables. ~/.curlrc is ignored (curl -q).
#
# Concurrent runs against the same cluster are UNSUPPORTED (no lock): two installs
# share the _asb_t_* temp tables and _asb_next_* files and can corrupt each other.
# Run one installer (or uninstaller) at a time.
#
# Prerequisites: bash, node 22+ and npm (unless --artifact), curl (OIDC
# discovery; and the HTTP transport), clickhouse-client (native transport; not
# needed for --dry-run). The prebuilt sql.html from a GitHub release works as
# --artifact; see docs/ASSET-DISTRIBUTION.md.
#
# Usage:
#   CLICKHOUSE_PASSWORD=... ./deploy/install.sh \
#     --ch-host clickhouse.example.com \
#     --ch-user admin \
#     --client-id <oauth-client-id> \
#     [--issuer https://accounts.google.com] \
#     [--audience <aud>] \         # audience-gated CH -> also sends access_token
#     [--ch-auth basic] \          # OSS CH + ch-jwt-verify -> JWT as Basic password
#     [--cluster my_cluster] \     # fan out to every node of this cluster
#     [--artifact dist/sql.html] \ # skip the build; use this prebuilt SPA
#     [--pull-url <url>] \         # cluster mode: nodes fetch the SPA from this URL
#                                  #   (default: upload once, nodes copy from the stage)
#     [--transport native|http] [--http-port N] \
#     [--ddl-timeout 180] \        # distributed_ddl_task_timeout, seconds (>= 1)
#     [--verify-only] \            # only compare every node's live files to the artifact
#     [--secure] \
#     [--dry-run]                  # build + render config.json + http_handlers.xml, print, no CH contact
#
# How it works (cluster mode). Facts proven in #692: a failed CREATE TABLE ...
# AS SELECT truncates its target file, so a remote source is never CTAS'd into
# the live file directly.
#   preflight  every node reachable, cross-node reads authenticate
#   pre-clean  DROP TABLE IF EXISTS default._asb_* ON CLUSTER ... SYNC, and EMPTY the
#              _asb_next_* files on every node (a stale one can never pass phase-1 verify)
#   phase 1    fan out to _asb_next_* on every node (stage upload to the
#              connected node, or url() pull), then verify length + sha256
#   phase 2    only if every node verified: each node copies its own _asb_next_*
#              over the live sql.html / sql-config.json, then verify again
#   always     truncate the stage file, drop the temp tables (live files untouched)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/lib/asb-ch.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/asb-ch.sh"

CH_HOST="" CH_USER="default" ISSUER="https://accounts.google.com"
CLIENT_ID="" AUDIENCE="" CLUSTER="" SECURE=0 CH_AUTH="" DRY_RUN=0
ARTIFACT="" PULL_URL="" TRANSPORT="native" HTTP_PORT="" DDL_TIMEOUT=180 VERIFY_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ch-host|--ch-user|--client-id|--issuer|--audience|--ch-auth|--cluster|--artifact|--pull-url|--transport|--http-port|--ddl-timeout)
      [[ $# -ge 2 ]] || { echo "missing value for $1" >&2; exit 2; } ;;
  esac
  case "$1" in
    --ch-host) CH_HOST="$2"; shift 2 ;;
    --ch-user) CH_USER="$2"; shift 2 ;;
    --client-id) CLIENT_ID="$2"; shift 2 ;;
    --issuer) ISSUER="$2"; shift 2 ;;
    --audience) AUDIENCE="$2"; shift 2 ;;
    --ch-auth) CH_AUTH="$2"; shift 2 ;;
    --cluster) CLUSTER="$2"; shift 2 ;;
    --artifact) ARTIFACT="$2"; shift 2 ;;
    --pull-url) PULL_URL="$2"; shift 2 ;;
    --transport) TRANSPORT="$2"; shift 2 ;;
    --http-port) HTTP_PORT="$2"; shift 2 ;;
    --ddl-timeout) DDL_TIMEOUT="$2"; shift 2 ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --secure) SECURE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;   # build + render config.json + http_handlers.xml, print, no ClickHouse contact
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$CLIENT_ID" ]] || { echo "--client-id is required" >&2; exit 2; }
# --ch-host is only needed to reach ClickHouse; a --dry-run just renders artifacts.
[[ -n "$CH_HOST" || "$DRY_RUN" == 1 ]] || { echo "--ch-host is required" >&2; exit 2; }
case "$TRANSPORT" in native|http) ;; *) echo "--transport must be native or http" >&2; exit 2 ;; esac
[[ -z "$CLUSTER" ]] || validate_cluster_name "$CLUSTER"
validate_pos --ddl-timeout "$DDL_TIMEOUT"
[[ -z "$HTTP_PORT" ]] || validate_uint --http-port "$HTTP_PORT"
if [[ -n "$PULL_URL" && "$VERIFY_ONLY" == 1 ]]; then echo "--pull-url and --verify-only are mutually exclusive" >&2; exit 2; fi
if [[ -n "$ARTIFACT" && ! -f "$ARTIFACT" ]]; then echo "--artifact: no such file: $ARTIFACT" >&2; exit 2; fi
BUILD_DIR="$ROOT/build"; BUILD_ENTRY="$BUILD_DIR/build.mjs"   # (spelled in pieces: see the build-order policy test)
if [[ -z "$ARTIFACT" && ! ( -f "$ROOT/package.json" && -f "$BUILD_ENTRY" ) ]]; then
  echo "no build tree next to this script (package.json or the SPA build entry point is missing); pass --artifact <path to sql.html>" >&2
  exit 2
fi

if [[ "$DRY_RUN" != 1 && -z "${CLICKHOUSE_PASSWORD:-}" ]]; then
  read -r -s -p "ClickHouse password for $CH_USER@$CH_HOST: " CLICKHOUSE_PASSWORD
  echo
fi
# Keep the password out of the environment of everything but clickhouse-client.
CH_PASSWORD="${CLICKHOUSE_PASSWORD:-}"
unset CLICKHOUSE_PASSWORD

# Stage token: unique per run so concurrent/aborted runs never share a stage file.
STAGE_TOKEN="${ASB_STAGE_TOKEN:-$(date +%s)${RANDOM}${RANDOM}}"
validate_token "$STAGE_TOKEN"
STAGE_FILE="_asb_stage_${STAGE_TOKEN}.html"
NEXT_HTML="_asb_next_sql.html" NEXT_CFG="_asb_next_sql-config.json"
# Table names are independent of the file names they point at.
T_NEXT_HTML="default._asb_t_next_html" T_NEXT_CFG="default._asb_t_next_cfg"
T_LIVE_HTML="default._asb_t_live_html" T_LIVE_CFG="default._asb_t_live_cfg"
ALL_TABLES=("$T_NEXT_HTML" "$T_NEXT_CFG" "$T_LIVE_HTML" "$T_LIVE_CFG")
EXPECTED_NODES=1 ON_CLUSTER=""
CLEANUP_ARMED=0 STAGE_USED=0
CH=()

TMP="$(mktemp -d)"
cleanup() {
  local rc=$?
  trap '' INT TERM   # a second ^C must not abandon the cleanup half-done
  trap - EXIT
  set +e             # nothing below may stop us reaching `rm -rf "$TMP"` (it holds the credentials)
  if [[ "$CLEANUP_ARMED" == 1 ]]; then
    limit_ddl_timeout 30   # bounded: every cleanup call ends within min(--ddl-timeout,30)+10 s, even on a dead node
    echo "==> Cleanup (stage file emptied, temp tables dropped; live files are never touched here)"
    if [[ "$STAGE_USED" == 1 ]]; then
      ch_query "INSERT INTO FUNCTION file('${STAGE_FILE}','RawBLOB') SETTINGS engine_file_truncate_on_insert=1 SELECT ''" >/dev/null \
        || echo "WARN: could not empty stage file ${STAGE_FILE} on ${CH_HOST}; remove its contents by hand" >&2
    fi
    local t
    for t in "${ALL_TABLES[@]}"; do
      ch_query "DROP TABLE IF EXISTS ${t}${ON_CLUSTER} SYNC" >/dev/null \
        || echo "WARN: could not drop ${t}; drop it by hand before re-running" >&2
    done
  fi
  rm -rf "$TMP"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
set_cluster_clause

# ---- reachability first, so a bad host/cluster fails before the slow build ----
if [[ "$DRY_RUN" != 1 ]]; then
  setup_transport
  if [[ -n "$CLUSTER" ]]; then preflight_cluster; else info "==> Single-node mode: only ${CH_HOST} is updated (behind a load balancer, pass --cluster to reach every node)"; fi
fi

if [[ -z "$ARTIFACT" ]]; then
  echo "==> Building @altinity/clickhouse-http"
  npm --prefix "$ROOT" run build:clickhouse-http

  echo "==> Building dist/sql.html"
  node "$ROOT/build/build.mjs"
  ARTIFACT="$ROOT/dist/sql.html"
else
  echo "==> Using prebuilt artifact $ARTIFACT (no build)"
fi

echo "==> Rendering config.json"
CONFIG_JSON="{\"issuer\":\"${ISSUER}\",\"client_id\":\"${CLIENT_ID}\""
# An API audience means access tokens (aud = the API) — send those. With no
# audience the IdP returns an id_token (aud = client_id), the default bearer
# path; ClickHouse's expected_audience must then be the client_id (see README
# + docs/CLICKHOUSE-OAUTH.md).
if [[ -n "$AUDIENCE" ]]; then
  CONFIG_JSON+=",\"audience\":\"${AUDIENCE}\",\"bearer\":\"access_token\""
fi
# Basic mode: OSS CH behind a verifier (ch-jwt-verify) — JWT as the Basic password.
if [[ "$CH_AUTH" == "basic" ]]; then
  CONFIG_JSON+=",\"ch_auth\":\"basic\""
fi
CONFIG_JSON+="}"
CONFIG_FILE="$TMP/config.json"
printf '%s' "$CONFIG_JSON" > "$CONFIG_FILE"

echo "==> Rendering http_handlers.xml (CSP connect-src from OIDC discovery)"
# The CSP connect-src must allow same-origin ('self', for ClickHouse + config.json)
# plus the IdP origins the browser fetches: OIDC discovery (issuer origin) and the
# token endpoint (exchange + refresh). The OAuth /authorize step is a top-level
# navigation, not a fetch, so it needs no connect-src entry. Resolve the real
# origins from the issuer's discovery document; fail soft to the Google default.
ISSUER_ORIGIN="$(printf '%s' "$ISSUER" | grep -oiE '^https?://[^/]+' || true)"
CONNECT_HOSTS="https://accounts.google.com https://oauth2.googleapis.com"
DISC_URL="${ISSUER%/}/.well-known/openid-configuration"
if DISC_JSON="$(curl -q -fsS --max-time 10 "$DISC_URL" 2>/dev/null)"; then
  # Pull the origin (scheme://host[:port]) of token/authorization endpoints, add
  # the issuer origin, dedupe. Tolerates whitespace variations in the JSON.
  EP_ORIGINS="$(printf '%s' "$DISC_JSON" \
    | grep -oE '"(token_endpoint|authorization_endpoint)"[[:space:]]*:[[:space:]]*"[^"]+"' \
    | grep -oiE 'https?://[^/"]+' || true)"
  CONNECT_HOSTS="$(printf '%s\n%s\n' "$ISSUER_ORIGIN" "$EP_ORIGINS" \
    | sed '/^$/d' | sort -u | paste -sd' ' -)"
  echo "    connect-src origins: $CONNECT_HOSTS"
else
  echo "WARN: could not fetch $DISC_URL — using the Google default connect-src." >&2
  echo "      If your IdP is not Google, edit connect-src in dist/http_handlers.xml." >&2
fi
# Rewrite only the connect-src host list in the committed template; everything else
# (the rest of the CSP, the other headers) is copied verbatim.
HANDLERS_OUT="$ROOT/dist/http_handlers.xml"
mkdir -p "$ROOT/dist"
sed -E "s#(connect-src 'self')[^;]*#\1 ${CONNECT_HOSTS}#" \
  "$ROOT/deploy/http_handlers.xml" > "$HANDLERS_OUT"

print_next_steps() {
  local scheme="http" port="8123" host="${CH_HOST:-<ch-host>}"
  if [[ "$SECURE" == 1 ]]; then scheme="https"; port="8443"; fi
  cat <<EOT

Final step - enable the HTTP routes. Add the rendered dist/http_handlers.xml
(its CSP connect-src is filled in for your issuer) to the server config.d/ (or
push it as an ACM cluster setting named "config.d/sql-browser.xml") and reload
ClickHouse. Then open:

    ${scheme}://${host}:${port}/sql

(${port} is the default ClickHouse HTTP$([[ "$SECURE" == 1 ]] && echo S) port; use the port your
HTTP endpoint, load balancer, or ingress actually exposes, and omit it if that
is the scheme default.)

Also register the OAuth redirect URI  ${scheme}://${host}:${port}/sql  (same
origin, same port as above) with your IdP, and make sure ClickHouse is
configured to accept the token the SPA sends: a Bearer JWT (token_processor +
JWKS), or with --ch-auth basic the JWT as the Basic password via a delegated
http_authentication verifier. See README.
EOT
}


if [[ "$DRY_RUN" == 1 ]]; then
  echo
  echo "==> DRY RUN - no ClickHouse contact. Rendered artifacts:"
  echo "--- config.json ---"
  cat "$CONFIG_FILE"; echo
  echo "--- dist/http_handlers.xml ---"
  cat "$HANDLERS_OUT"
  print_next_steps
  exit 0
fi

[[ -f "$ARTIFACT" ]] || fail "artifact not found: $ARTIFACT (the build did not produce it)"
ART_LEN="$(size_of "$ARTIFACT")" ART_SHA="$(sha256_of "$ARTIFACT")"
CFG_LEN="$(size_of "$CONFIG_FILE")" CFG_SHA="$(sha256_of "$CONFIG_FILE")"
# A 0-byte file is what a failed write leaves behind and what the static handler serves as an
# empty 200; installing one (or "verifying" it) would be a silent outage. Refuse before any write.
(( ART_LEN > 0 )) || fail "artifact ${ARTIFACT} is empty (0 bytes); refusing to install it"
(( CFG_LEN > 0 )) || fail "rendered config.json is empty; refusing to install"
info "==> Artifact: ${ART_LEN} bytes, sha256 ${ART_SHA}"

verify_live() { verify_files "live files" one sql.html "$ART_LEN" "$ART_SHA" sql-config.json "$CFG_LEN" "$CFG_SHA"; }

if [[ "$VERIFY_ONLY" == 1 ]]; then
  verify_live || fail "live files differ from the artifact"
  info "==> Verified: every node serves the expected files."
  exit 0
fi

# ---------------------------------------------------------------- phases
CLEANUP_ARMED=1

pre_clean() {
  info "==> Pre-clean (drop leftover temp tables, empty stale ${NEXT_HTML} / ${NEXT_CFG})"
  local t
  for t in "${ALL_TABLES[@]}"; do ddl "drop ${t}" "DROP TABLE IF EXISTS ${t}${ON_CLUSTER} SYNC"; done
  # Phase-1 verify must only ever see bytes written by THIS run, never a leftover next file.
  ddl "empty ${NEXT_HTML} on every node" "$(write_file_stmt "$T_NEXT_HTML" "$NEXT_HTML" "SELECT '' AS c SETTINGS engine_file_truncate_on_insert=1")"
  ddl "empty ${NEXT_CFG} on every node" "$(write_file_stmt "$T_NEXT_CFG" "$NEXT_CFG" "SELECT '' AS c SETTINGS engine_file_truncate_on_insert=1")"
  ddl "drop ${T_NEXT_HTML}" "DROP TABLE IF EXISTS ${T_NEXT_HTML}${ON_CLUSTER} SYNC"
  ddl "drop ${T_NEXT_CFG}" "DROP TABLE IF EXISTS ${T_NEXT_CFG}${ON_CLUSTER} SYNC"
}

# next-file source for the SPA, as the SELECT of the fan-out statement.
# A hung or slow url() is bounded: per-query max_execution_time plus HTTP
# connect/receive timeouts, all derived from --ddl-timeout (>= 1).
PULL_TIMEOUT="$DDL_TIMEOUT"
phase1_html_source() {
  if [[ -n "$PULL_URL" ]]; then
    printf "SELECT c FROM url('%s','RawBLOB','c String') SETTINGS max_http_get_redirects=10, engine_file_truncate_on_insert=1, max_execution_time=%s, http_connection_timeout=10, http_receive_timeout=%s" \
      "$(sql_str "$PULL_URL")" "$PULL_TIMEOUT" "$PULL_TIMEOUT"
  else
    printf "SELECT c FROM clusterAllReplicas('%s', file('%s','RawBLOB','c String')) SETTINGS engine_file_empty_if_not_exists=1, engine_file_truncate_on_insert=1" "$CLUSTER" "$STAGE_FILE"
  fi
}

phase1() {
  info "==> Phase 1: distribute to ${NEXT_HTML} / ${NEXT_CFG}"
  local up_name="$STAGE_FILE" rc
  [[ -n "$CLUSTER" ]] || up_name="$NEXT_HTML"
  if [[ -z "$PULL_URL" ]]; then
    info "    uploading $(basename "$ARTIFACT") to ${CH_HOST}:${up_name}"
    if [[ -n "$CLUSTER" ]]; then STAGE_USED=1; fi
    ch_query "INSERT INTO FUNCTION file('${up_name}','RawBLOB') SETTINGS engine_file_truncate_on_insert=1 FORMAT RawBLOB" "$ARTIFACT" >/dev/null \
      || fail "upload of the artifact failed"
    if [[ -n "$CLUSTER" ]]; then
      if check_rows "$STAGE_FILE" "$ART_LEN" "$ART_SHA" 0; then rc=0; else rc=$?; fi
      (( rc == 2 )) && fail "could not verify the staged upload"
      # The stage lives on the connected node only: exactly one node must hold it, and every node must answer.
      [[ "$ROWS" == "$EXPECTED_NODES" && "$HOSTS" == "$EXPECTED_NODES" ]] \
        || fail "stage verification returned ${ROWS} rows / ${HOSTS} distinct nodes; expected ${EXPECTED_NODES}"
      [[ "$MATCH" == 1 ]] || fail "staged upload not found with the expected length/sha256 on exactly one node (matches: ${MATCH}, rows: ${ROWS})"
    fi
  fi
  if [[ -n "$CLUSTER" || -n "$PULL_URL" ]]; then
    ddl "fan out sql.html to every node" "$(write_file_stmt "$T_NEXT_HTML" "$NEXT_HTML" "$(phase1_html_source)")"
  fi
  ddl "write sql-config.json to every node" "$(write_file_stmt "$T_NEXT_CFG" "$NEXT_CFG" "SELECT '$(sql_str "$(cat "$CONFIG_FILE")")' AS c SETTINGS engine_file_truncate_on_insert=1")"
  ddl "drop ${T_NEXT_HTML}" "DROP TABLE IF EXISTS ${T_NEXT_HTML}${ON_CLUSTER} SYNC"
  ddl "drop ${T_NEXT_CFG}" "DROP TABLE IF EXISTS ${T_NEXT_CFG}${ON_CLUSTER} SYNC"
}

phase2() {
  info "==> Phase 2: promote ${NEXT_HTML} / ${NEXT_CFG} over the live files (local copy on each node)"
  ddl "promote sql.html" "$(write_file_stmt "$T_LIVE_HTML" sql.html "SELECT c FROM file('${NEXT_HTML}','RawBLOB','c String') SETTINGS engine_file_truncate_on_insert=1")"
  ddl "promote sql-config.json" "$(write_file_stmt "$T_LIVE_CFG" sql-config.json "SELECT c FROM file('${NEXT_CFG}','RawBLOB','c String') SETTINGS engine_file_truncate_on_insert=1")"
  ddl "drop ${T_LIVE_HTML}" "DROP TABLE IF EXISTS ${T_LIVE_HTML}${ON_CLUSTER} SYNC"
  ddl "drop ${T_LIVE_CFG}" "DROP TABLE IF EXISTS ${T_LIVE_CFG}${ON_CLUSTER} SYNC"
}

pre_clean
phase1
verify_files "phase 1 (next files)" one "$NEXT_HTML" "$ART_LEN" "$ART_SHA" "$NEXT_CFG" "$CFG_LEN" "$CFG_SHA" \
  || fail "phase 1 verification failed; live files were NOT touched"
phase2
verify_live || fail "phase 2 verification failed: some live files do not match; re-run the installer"

echo
echo "==> Assets uploaded to ClickHouse user_files/ and verified on ${EXPECTED_NODES} node(s)."
print_next_steps
