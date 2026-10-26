# shellcheck shell=bash
# Shared ClickHouse plumbing for deploy/install.sh and deploy/uninstall.sh (#692).
# Sourced, never executed. Callers set (before using any function):
#   CH_HOST CH_USER SECURE TRANSPORT(native|http) HTTP_PORT DDL_TIMEOUT CLUSTER TMP
# and CLICKHOUSE_PASSWORD (env). Nothing here ever puts the password in argv.

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

# ---------------------------------------------------------------- transport
setup_transport() {
  if [[ "$TRANSPORT" == http ]]; then
    command -v curl >/dev/null 2>&1 || fail "curl is required for --transport http"
    local scheme=http port="${HTTP_PORT:-8123}"
    if [[ "$SECURE" == 1 ]]; then scheme=https; port="${HTTP_PORT:-8443}"; fi
    HTTP_URL="${scheme}://${CH_HOST}:${port}/"
    case "$CH_USER$CLICKHOUSE_PASSWORD" in *$'\n'*|*$'\r'*) fail "user/password must not contain newlines (--transport http)" ;; esac
    # Credentials travel in headers read from a 0600 file (curl -H @file): never argv.
    ( umask 077; printf 'X-ClickHouse-User: %s\nX-ClickHouse-Key: %s\n' "$CH_USER" "$CLICKHOUSE_PASSWORD" > "$TMP/auth" )
    chmod 600 "$TMP/auth"
  else
    command -v clickhouse-client >/dev/null 2>&1 || fail "clickhouse-client is required for --transport native"
    CH=(clickhouse-client --host "$CH_HOST" --user "$CH_USER" "--distributed_ddl_task_timeout=${DDL_TIMEOUT}" --format TSV)
    [[ "$SECURE" == 1 ]] && CH+=(--secure)
  fi
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
      echo "      CREATE/DROP TABLE on default._asb_*, SELECT on system.clusters; URL for --pull-url)." >&2 ;;
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
  local sql="$1" in="${2:-/dev/null}"
  if ! "${CH[@]}" --query "$sql" < "$in" 2>"$TMP/err"; then
    explain_failure "$TMP/err"; return 1
  fi
}

ch_query_http() {
  local sql="$1" in="${2:-}" code
  : > "$TMP/body"; : > "$TMP/hdrs"
  if [[ -n "$in" ]]; then { printf '%s\n' "$sql"; cat "$in"; } > "$TMP/req"; else printf '%s' "$sql" > "$TMP/req"; fi
  if ! code="$(curl -sS --max-time "$((DDL_TIMEOUT + 300))" -o "$TMP/body" -D "$TMP/hdrs" -w '%{http_code}' \
      -H "@$TMP/auth" -H 'Content-Type: text/plain' --data-binary "@$TMP/req" \
      "${HTTP_URL}?wait_end_of_query=1&distributed_ddl_task_timeout=${DDL_TIMEOUT}" 2>"$TMP/err")"; then
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

# ---------------------------------------------------------------- verify
# ON_CLUSTER is " ON CLUSTER `c`" in cluster mode, empty otherwise.
# shellcheck disable=SC2034  # ON_CLUSTER is consumed by the sourcing script
set_cluster_clause() {
  ON_CLUSTER=""
  [[ -z "$CLUSTER" ]] || ON_CLUSTER=" ON CLUSTER \`${CLUSTER}\`"
}

# Per-node row (h, n, len, sha) for a user_files file; a missing file yields a row, not an error.
verify_sql() {  # verify_sql <user_files-name>
  local inner="SELECT hostName() h, count() n, sum(length(c)) len, lower(hex(SHA256(any(c)))) sha FROM file('$1','RawBLOB','c String')"
  if [[ -n "$CLUSTER" ]]; then
    printf "SELECT h, n, len, sha FROM clusterAllReplicas('%s', view(%s)) ORDER BY h SETTINGS engine_file_empty_if_not_exists=1" "$CLUSTER" "$inner"
  else
    printf '%s SETTINGS engine_file_empty_if_not_exists=1' "$inner"
  fi
}

# check_rows <name> <expected-len> <expected-sha> <show 0|1>
# Sets ROWS (rows returned) and MATCH (rows matching len+sha); prints a table when show=1.
# Returns 0 iff ROWS == EXPECTED_NODES and every row matches; 2 if the query failed.
check_rows() {
  local name="$1" elen="$2" esha="$3" show="$4" out h n len sha mark
  ROWS=0; MATCH=0
  out="$(ch_query "$(verify_sql "$name")")" || return 2
  [[ "$show" != 1 ]] || printf '    %-32s %-10s %-64s %s\n' "NODE" "BYTES" "SHA256" "$name"
  while IFS=$'\t' read -r h n len sha; do
    [[ -n "$h" ]] || continue
    ROWS=$((ROWS + 1)); mark="MISMATCH"
    if [[ "$len" == "$elen" && "$sha" == "$esha" ]]; then MATCH=$((MATCH + 1)); mark="ok"; fi
    [[ "$show" != 1 ]] || printf '    %-32s %-10s %-64s %s\n' "$h" "$len" "$sha" "$mark"
  done <<< "$out"
  [[ "$ROWS" == "$EXPECTED_NODES" && "$MATCH" == "$ROWS" ]]
}

# verify_files <label> <name> <len> <sha> [<name> <len> <sha> ...]
verify_files() {
  local label="$1" ok=0 rc; shift
  info "==> Verifying ${label} (${EXPECTED_NODES} node(s))"
  while [[ $# -ge 3 ]]; do
    check_rows "$1" "$2" "$3" 1 && rc=0 || rc=$?
    if (( rc == 2 )); then echo "ERROR: verification query failed for $1" >&2; ok=1
    elif (( rc != 0 )); then echo "ERROR: $1: ${MATCH}/${EXPECTED_NODES} nodes match (rows returned: ${ROWS}; expected ${EXPECTED_NODES}) [${label}]" >&2; ok=1; fi
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
  local out rows
  cluster_node_count
  info "==> Preflight: cluster '${CLUSTER}' has ${EXPECTED_NODES} node(s)"
  out="$(ch_query "SELECT hostName() FROM clusterAllReplicas('${CLUSTER}', view(SELECT hostName())) ORDER BY 1")" \
    || fail "preflight failed: cannot reach every node of '${CLUSTER}' (needs <secret> or per-replica credentials for cross-node reads)"
  rows="$(printf '%s\n' "$out" | sed '/^$/d' | wc -l | tr -d ' ')"
  [[ "$rows" == "$EXPECTED_NODES" ]] || fail "preflight: only ${rows} of ${EXPECTED_NODES} nodes answered; refusing to continue"
  return 0
}
