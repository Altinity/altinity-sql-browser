# shellcheck shell=bash
# Shared ClickHouse plumbing for deploy/install.sh and deploy/uninstall.sh (#692).
# Sourced, never executed. Callers set (before using any function):
#   CH_HOST CH_USER SECURE TRANSPORT(native|http) HTTP_PORT DDL_TIMEOUT CLUSTER TMP
# and CH_PASSWORD (a plain shell variable, NOT exported: the caller moves it out of the
# environment so npm/node/curl never inherit it). It reaches clickhouse-client only as an
# env prefix on that one invocation, and curl only inside a 0600 header file; it is never
# in argv.

# ---------------------------------------------------------------- basics
fail() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "$*"; }

# SQL single-quoted-literal escaping: backslash first, then the quote.
sql_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g"; }

sha256_of() {  # sha256_of <file> -> lowercase hex
  local out
  if command -v sha256sum >/dev/null 2>&1; then out="$(sha256sum "$1")"
  else out="$(shasum -a 256 "$1")"; fi
  printf '%s' "${out%% *}"
}
size_of() { local n; n="$(wc -c < "$1")"; printf '%s' "${n//[[:space:]]/}"; }

validate_cluster_name() {  # injection guard: the name lands in SQL
  [[ "$1" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "invalid --cluster name '$1' (allowed: A-Z a-z 0-9 _ . -)"
}
validate_token() { [[ "$1" =~ ^[A-Za-z0-9_]+$ ]] || fail "invalid stage token '$1' (allowed: A-Z a-z 0-9 _)"; }
validate_uint() { [[ "$2" =~ ^[0-9]+$ ]] || fail "$1 must be a non-negative integer (got '$2')"; }
# 0 would make ClickHouse run the DDL asynchronously (no wait, no error surfaced): refuse it.
# Digits only, no leading zero (bash arithmetic would read 09 as a bad octal and 010 as 8), at most 6.
validate_pos() { [[ "$2" =~ ^[1-9][0-9]{0,5}$ ]] || fail "$1 must be a decimal integer from 1 to 999999 without leading zeros (got '$2'; 0 means asynchronous DDL in ClickHouse)"; }

# ---------------------------------------------------------------- transport
setup_transport() {
  if [[ "$TRANSPORT" == http ]]; then
    command -v curl >/dev/null 2>&1 || fail "curl is required for --transport http"
    local scheme=http port="${HTTP_PORT:-8123}"
    if [[ "$SECURE" == 1 ]]; then scheme=https; port="${HTTP_PORT:-8443}"; fi
    HTTP_URL="${scheme}://${CH_HOST}:${port}/"
    case "$CH_USER$CH_PASSWORD" in *$'\n'*|*$'\r'*) fail "user/password must not contain newlines (--transport http)" ;; esac
    # Credentials travel in headers read from a 0600 file (curl -H @file): never argv.
    ( umask 077; printf 'X-ClickHouse-User: %s\nX-ClickHouse-Key: %s\n' "$CH_USER" "$CH_PASSWORD" > "$TMP/auth" )
    chmod 600 "$TMP/auth"
  else
    command -v clickhouse-client >/dev/null 2>&1 || fail "clickhouse-client is required for --transport native"
    build_native_args
  fi
  return 0
}

# distributed_ddl_output_mode is pinned: a profile/user default of never_throw or
# *_only_active would turn a dead node's DDL failure into a silent success.
build_native_args() {
  CH=(clickhouse-client --host "$CH_HOST" --user "$CH_USER" "--distributed_ddl_task_timeout=${DDL_TIMEOUT}" --distributed_ddl_output_mode=throw --format TSV)
  # Cleanup only: bound every socket wait too, so an unreachable node cannot stall it for minutes.
  if (( CLIENT_SLACK < 100 )); then
    CH+=("--connect_timeout=${CONNECT_TIMEOUT}" "--send_timeout=$((DDL_TIMEOUT + CLIENT_SLACK))" "--receive_timeout=$((DDL_TIMEOUT + CLIENT_SLACK))")
  fi
  [[ "$SECURE" == 1 ]] && CH+=(--secure)
  return 0
}

# Client-side bounds. A normal call may legitimately take --ddl-timeout plus a long tail
# (fan-out of a large file), so it gets 300 s of slack; cleanup gets 10 s and a 10 s connect
# timeout. limit_ddl_timeout (cleanup only) therefore makes every cleanup call finish within
# min(--ddl-timeout, <max-seconds>) + 10 s, whatever the server or network does.
CLIENT_SLACK=300 CONNECT_TIMEOUT=30
limit_ddl_timeout() {  # limit_ddl_timeout <max-seconds>
  (( DDL_TIMEOUT <= $1 )) || DDL_TIMEOUT="$1"
  CLIENT_SLACK=10 CONNECT_TIMEOUT=10
  [[ "$TRANSPORT" == http ]] || build_native_args
  return 0
}

# Print a failure's text plus a targeted hint. $1 = file holding the text.
explain_failure() {
  head -n 20 "$1" >&2
  local t; t="$(cat "$1")"
  case "$t" in
    *AUTHENTICATION_FAILED*|*"Code: 516"*)
      echo "HINT: authentication failed. If the first connection works but cross-node reads fail, the cluster" >&2
      echo "      needs <secret> (or per-replica user/password) in remote_servers, and the deploy user must" >&2
      echo "      exist on every node. Otherwise check the user/password." >&2 ;;
    *ACCESS_DENIED*|*NOT_ENOUGH_PRIVILEGES*|*"Code: 497"*)
      echo "HINT: missing grants - see 'Grants' in docs/ASSET-DISTRIBUTION.md (FILE, CLUSTER, REMOTE," >&2
      echo "      CREATE/DROP TABLE on default.*, SELECT on system.clusters; URL for --pull-url; a --verify-only-only" >&2
      echo "      user also needs CREATE TEMPORARY TABLE)." >&2 ;;
    *TIMEOUT_EXCEEDED*|*"Code: 159"*)
      echo "HINT: a node did not answer the ON CLUSTER DDL within ${DDL_TIMEOUT}s (--ddl-timeout). It may be down;" >&2
      echo "      its queued DDL replays when it returns. Bring it back and re-run." >&2 ;;
    *"Code: 209"*|*"Code: 210"*|*NETWORK_ERROR*|*"Connection refused"*|*"Could not resolve"*|*"Failed to connect"*|*"Couldn't connect"*)
      echo "HINT: node unreachable - check the host/port and that every cluster node is up." >&2 ;;
  esac
}

# ch_query <sql> [stdin-file] -> TSV rows on stdout. Failure: text on stderr, rc 1.
ch_query() {
  if [[ "$TRANSPORT" == http ]]; then ch_query_http "$@"; else ch_query_native "$@"; fi
}

ch_query_native() {
  local sql="$1" in="${2:-/dev/null}" wrap=()
  # Cleanup only: clickhouse-client's send/receive timeouts are IDLE timeouts, not a total bound, so
  # wrap the call in coreutils `timeout` when it exists (absent on stock macOS: idle timeouts only).
  if (( CLIENT_SLACK < 100 )) && command -v timeout >/dev/null 2>&1; then wrap=(timeout "$((DDL_TIMEOUT + CLIENT_SLACK))"); fi
  if ! CLICKHOUSE_PASSWORD="$CH_PASSWORD" "${wrap[@]}" "${CH[@]}" --query "$sql" < "$in" 2>"$TMP/err"; then
    explain_failure "$TMP/err"; return 1
  fi
}

ch_query_http() {
  local sql="$1" in="${2:-}" code
  : > "$TMP/body"; : > "$TMP/hdrs"
  if [[ -n "$in" ]]; then { printf '%s\n' "$sql"; cat "$in"; } > "$TMP/req"; else printf '%s' "$sql" > "$TMP/req"; fi
  if ! code="$(curl -q -sS --connect-timeout "$CONNECT_TIMEOUT" --max-time "$((DDL_TIMEOUT + CLIENT_SLACK))" -o "$TMP/body" -D "$TMP/hdrs" -w '%{http_code}' \
      -H "@$TMP/auth" -H 'Content-Type: text/plain' --data-binary "@$TMP/req" \
      "${HTTP_URL}?wait_end_of_query=1&distributed_ddl_task_timeout=${DDL_TIMEOUT}&distributed_ddl_output_mode=throw" 2>"$TMP/err")"; then
    explain_failure "$TMP/err"; return 1
  fi
  local line body; body="$(cat "$TMP/body")"
  local bad=0
  [[ "$code" =~ ^2[0-9][0-9]$ ]] || bad=1
  # A header LINE, not a substring: Access-Control-Expose-Headers lists the name on every response.
  while IFS= read -r line; do
    line="$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')"
    case "$line" in x-clickhouse-exception-code:*) bad=1 ;; esac
  done < "$TMP/hdrs"
  case "$body" in *__exception__*) bad=1 ;; esac
  if (( bad )); then
    { echo "HTTP ${code}"; printf '%s\n' "$body"; } > "$TMP/err"
    explain_failure "$TMP/err"; return 1
  fi
  printf '%s' "$body"; [[ -z "$body" ]] || echo
  return 0
}

# ddl <label> <sql>: run a statement for its side effect; stdout discarded.
ddl() {
  info "    $1"
  ch_query "$2" >/dev/null || fail "$1 failed"
}

# write_file_stmt <table> <user_files-name> <select-body>
# One statement that (over)writes a user_files file from a SELECT.
#   cluster:     CREATE TABLE ... ON CLUSTER ... ENGINE=File('RawBLOB', name) AS SELECT ...
#                (the only SQL fan-out that works: cluster-function INSERTs fail with Code 55)
#   single node: INSERT INTO FUNCTION file(...) SELECT ... - needs only the FILE grant; a
#                CTAS would additionally demand INSERT on the temp table (found in #692 tests).
# <select-body> must carry engine_file_truncate_on_insert=1 (a failed CTAS empties its target).
write_file_stmt() {
  if [[ -n "$CLUSTER" ]]; then
    printf "CREATE TABLE %s%s ENGINE=File('RawBLOB','%s') AS %s" "$1" "$ON_CLUSTER" "$2" "$3"
  else
    printf "INSERT INTO FUNCTION file('%s','RawBLOB') SETTINGS engine_file_truncate_on_insert=1 %s" "$2" "$3"
  fi
}

# ---------------------------------------------------------------- verify
# ON_CLUSTER is " ON CLUSTER `c`" in cluster mode, empty otherwise.
# shellcheck disable=SC2034  # ON_CLUSTER is consumed by the sourcing script
set_cluster_clause() {
  ON_CLUSTER=""
  [[ -z "$CLUSTER" ]] || ON_CLUSTER=" ON CLUSTER \`${CLUSTER}\`"
}

# Per-node row (id, host, n, len, sha; id = serverUUID(), the node identity - unique per server instance, independent of ports) for a user_files file; a missing file yields a row, not an error.
verify_sql() {  # verify_sql <user_files-name>
  local inner="SELECT toString(serverUUID()) id, hostName() host, count() n, sum(length(c)) len, lower(hex(SHA256(any(c)))) sha FROM file('$1','RawBLOB','c String')"
  if [[ -n "$CLUSTER" ]]; then
    printf "SELECT id, host, n, len, sha FROM clusterAllReplicas('%s', view(%s)) ORDER BY host, id SETTINGS engine_file_empty_if_not_exists=1" "$CLUSTER" "$inner"
  else
    printf '%s SETTINGS engine_file_empty_if_not_exists=1' "$inner"
  fi
}

# check_rows <name> <expected-len> <expected-sha> <show 0|1> [one|any]
# Sets ROWS (rows returned), HOSTS (distinct node identities = serverUUID(), so several instances on one host stay distinct) and MATCH (rows matching
# len+sha, and - in mode "one", the default - exactly one row n==1 in the file). Mode "any"
# also accepts n==0 (uninstall's empty-file check: a 0-byte RawBLOB may yield 0 rows).
# Prints a table when show=1. Returns 0 iff ROWS == HOSTS == EXPECTED_NODES and every row
# matches (a dropped, extra or duplicated-host row all fail); 2 if the query failed.
check_rows() {
  local name="$1" elen="$2" esha="$3" show="$4" mode="${5:-one}" out id h n len sha mark seen=""
  ROWS=0; MATCH=0; HOSTS=0
  out="$(ch_query "$(verify_sql "$name")")" || return 2
  [[ "$show" != 1 ]] || printf '    %-36s %-16s %-10s %-64s %s\n' "NODE (serverUUID)" "HOST" "BYTES" "SHA256" "$name"
  while IFS=$'\t' read -r id h n len sha; do
    [[ -n "$id" ]] || continue
    ROWS=$((ROWS + 1)); seen+="${id}"$'\n'; mark="MISMATCH"
    if [[ "$len" == "$elen" && "$sha" == "$esha" && ( "$n" == 1 || ( "$mode" == any && "$n" == 0 ) ) ]]; then MATCH=$((MATCH + 1)); mark="ok"; fi
    [[ "$show" != 1 ]] || printf '    %-36s %-16s %-10s %-64s %s\n' "$id" "$h" "$len" "$sha" "$mark"
  done <<< "$out"
  HOSTS="$(printf '%s' "$seen" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')"
  [[ "$ROWS" == "$EXPECTED_NODES" && "$HOSTS" == "$EXPECTED_NODES" && "$MATCH" == "$ROWS" ]]
}

# verify_files <label> <mode one|any> <name> <len> <sha> [<name> <len> <sha> ...]
verify_files() {
  local label="$1" mode="$2" ok=0 rc; shift 2
  info "==> Verifying ${label} (${EXPECTED_NODES} node(s))"
  while [[ $# -ge 3 ]]; do
    if check_rows "$1" "$2" "$3" 1 "$mode"; then rc=0; else rc=$?; fi
    if (( rc == 2 )); then echo "ERROR: verification query failed for $1" >&2; ok=1
    elif (( rc != 0 )); then echo "ERROR: $1: ${MATCH}/${EXPECTED_NODES} nodes match (rows returned: ${ROWS}, distinct nodes: ${HOSTS}; expected ${EXPECTED_NODES} each) [${label}]" >&2; ok=1; fi
    shift 3
  done
  return "$ok"
}

# Cluster size from system.clusters; fail closed on query error, junk, or 0.
cluster_node_count() {
  local n
  n="$(ch_query "SELECT count() FROM system.clusters WHERE cluster = '${CLUSTER}'")" \
    || fail "could not query system.clusters on ${CH_HOST} to check cluster '${CLUSTER}'"
  n="${n//[[:space:]]/}"
  [[ "$n" =~ ^[0-9]+$ ]] || fail "unexpected system.clusters output for cluster '${CLUSTER}': '${n}' (expected a node count). Refusing to continue."
  (( n > 0 )) || fail "cluster '${CLUSTER}' was not found in system.clusters on ${CH_HOST} (0 replicas). Check the cluster name and the node you connected to."
  EXPECTED_NODES="$n"
}

# Every node reachable, interserver auth working.
preflight_cluster() {
  local out rows ids
  cluster_node_count
  info "==> Preflight: cluster '${CLUSTER}' has ${EXPECTED_NODES} node(s)"
  out="$(ch_query "SELECT id FROM clusterAllReplicas('${CLUSTER}', view(SELECT toString(serverUUID()) AS id)) ORDER BY 1")" \
    || fail "preflight failed: cannot reach every node of '${CLUSTER}' (needs <secret> or per-replica credentials for cross-node reads)"
  rows="$(printf '%s\n' "$out" | sed '/^$/d' | wc -l | tr -d ' ')"
  [[ "$rows" == "$EXPECTED_NODES" ]] || fail "preflight: only ${rows} of ${EXPECTED_NODES} nodes answered; refusing to continue"
  ids="$(printf '%s\n' "$out" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')"
  [[ "$ids" == "$EXPECTED_NODES" ]] || fail "preflight: ${ids} distinct node identities (serverUUID) for ${EXPECTED_NODES} nodes; the cluster definition repeats an instance. Refusing to continue"
  return 0
}
