#!/usr/bin/env bash
# Integration test for deploy/install.sh + deploy/uninstall.sh (#692).
#
# Brings up Keeper + a 2-shard x 2-replica ClickHouse cluster (cluster has a
# <secret>), a password-protected deploy user holding ONLY the documented
# minimal grants, the repo's deploy/http_handlers.xml (so /sql and
# /sql/config.json are really served), and a tiny HTTP file server with a
# redirect chain (a ClickHouse node's own static + redirect handlers) for
# --pull-url. The installer runs from a client container of the SAME image, then
# every scenario asserts the installer exit code and the byte-exact sha256 of
# /sql and /sql/config.json fetched over HTTP from EVERY node.
#
#   CH_IMAGE=clickhouse/clickhouse-server:26.3.18.32 tests/deploy/run.sh
#   (npm run test:deploy)
#
# Env: CH_IMAGE (server+client image), KEEPER_IMAGE, DOCKER_NETWORK (reuse an
# existing network, which MUST be user-defined: the default `bridge` network has
# no container-name DNS, so the nodes could not find each other; else a private
# user-defined one is created and removed), KEEP=1 (leave
# containers running for debugging), ASB_TEST_ARTIFACT (artifact to install;
# default dist/sql.html if built, else a synthetic 1 MB binary-hostile file).
# Needs: docker, bash, base64, sha256sum|shasum. Network (apt) for curl in the client.
# shellcheck disable=SC2016  # $VARs in the container entrypoints are expanded by the container shell
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# Exact patch tags: a moving tag (26.3, 25.8) must not turn this red unrelated to a diff.
CH_IMAGE="${CH_IMAGE:-clickhouse/clickhouse-server:26.3.18.32}"
KEEPER_IMAGE="${KEEPER_IMAGE:-clickhouse/clickhouse-keeper:25.8.33.6}"
PFX="asbd$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/asb-deploy-test.XXXXXX")"
LOGS="$WORK/logs"; mkdir -p "$LOGS"
UF=/var/lib/clickhouse/user_files
NODES=(1 2 3 4)
CLI="$PFX-cli" WEB="$PFX-web"
OWN_NET=0
if [[ -n "${DOCKER_NETWORK:-}" ]]; then NET="$DOCKER_NETWORK"; else NET="$PFX-net"; OWN_NET=1; fi
ISSUER="http://idp.invalid" CLIENT_ID="asb-test"
CFG_EXPECT="{\"issuer\":\"${ISSUER}\",\"client_id\":\"${CLIENT_ID}\"}"

cleanup() {
  local rc=$? c
  trap - EXIT
  if (( rc != 0 )); then
    # Also on early failures (before any scenario ran): keep every container's log.
    for c in $(docker ps -aq --filter "label=asbd=$PFX" 2>/dev/null); do
      docker logs "$c" > "$LOGS/container-$(docker inspect -f '{{.Name}}' "$c" 2>/dev/null | tr -d /).log" 2>&1 || true
    done
    mkdir -p "$ROOT/dist/deploy-test-logs" && cp -R "$LOGS/." "$ROOT/dist/deploy-test-logs/" 2>/dev/null && echo "logs (installer + container) copied to dist/deploy-test-logs" >&2
  fi
  if [[ "${KEEP:-0}" == 1 ]]; then
    echo "KEEP=1: containers labelled asbd=$PFX left running (network $NET, work dir $WORK)"
  else
    # shellcheck disable=SC2046
    docker rm -f $(docker ps -aq --filter "label=asbd=$PFX") >/dev/null 2>&1 || true
    if (( OWN_NET )); then docker network rm "$NET" >/dev/null 2>&1 || true; fi
    rm -rf "$WORK"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

sha_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
b64() { base64 < "$1" | tr -d '\n'; }
render() { sed "s/@PFX@/$PFX/g" "$1" > "$2"; }

# ------------------------------------------------------------------ results
declare -a RESULTS=()
SC_FAIL=0
t() {  # t <description> <command...>
  local d="$1" out; shift
  if out="$("$@" 2>&1)"; then echo "    PASS  $d"; else echo "    FAIL  $d"; [[ -z "$out" ]] || printf '%s\n' "$out" | head -n 8; SC_FAIL=$((SC_FAIL + 1)); fi
}
scenario() { SC_NAME="$1"; SC_FAIL=0; echo; echo "=== $1"; }
end_scenario() {
  if (( SC_FAIL )); then RESULTS+=("FAIL  $SC_NAME (${SC_FAIL} failed assertion(s))"); else RESULTS+=("PASS  $SC_NAME"); fi
}

# ------------------------------------------------------------------ artifacts
mkdir -p "$WORK/art"
if [[ -n "${ASB_TEST_ARTIFACT:-}" ]]; then cp "$ASB_TEST_ARTIFACT" "$WORK/art/base"
elif [[ -f "$ROOT/dist/sql.html" ]]; then cp "$ROOT/dist/sql.html" "$WORK/art/base"
else head -c 1000000 /dev/urandom > "$WORK/art/base"; fi
# Distinct byte-hostile variants: NUL, 0xFF, invalid UTF-8, CRLF, trailing NUL.
cp "$WORK/art/base" "$WORK/art/A.html"
{ cat "$WORK/art/base"; printf '\000\377\r\n\303\050\376\377\r\n\r\nB\000'; } > "$WORK/art/B.html"
{ cat "$WORK/art/base"; printf '\n<!--C-->\377\000\r\n\200'; } > "$WORK/art/C.html"
SHA_A="$(sha_of "$WORK/art/A.html")" SHA_B="$(sha_of "$WORK/art/B.html")" SHA_C="$(sha_of "$WORK/art/C.html")"
printf '%s' "$CFG_EXPECT" > "$WORK/art/cfg.json"; SHA_CFG="$(sha_of "$WORK/art/cfg.json")"
echo "artifact base $(wc -c < "$WORK/art/base" | tr -d ' ') bytes; sha A=${SHA_A:0:12} B=${SHA_B:0:12} C=${SHA_C:0:12}; image $CH_IMAGE"

# ------------------------------------------------------------------ bring up
mkdir -p "$WORK/cfg"
for f in keeper cluster web; do render "$HERE/cfg/$f.xml" "$WORK/cfg/$f.xml"; done
if (( OWN_NET )); then docker network create "$NET" >/dev/null || exit 1; fi
RUN=(docker run -d --label "asbd=$PFX" --network "$NET")

"${RUN[@]}" --name "$PFX-k" -e CFG="$(b64 "$WORK/cfg/keeper.xml")" --entrypoint bash "$KEEPER_IMAGE" \
  -c 'echo $CFG | base64 -d > /etc/clickhouse-keeper/keeper_config.xml; exec /entrypoint.sh' >/dev/null || exit 1
"${RUN[@]}" --name "$WEB" --hostname "$WEB" -e WX="$(b64 "$WORK/cfg/web.xml")" --entrypoint bash "$CH_IMAGE" \
  -c "mkdir -p $UF; chown -R clickhouse:clickhouse $UF; echo \$WX | base64 -d > /etc/clickhouse-server/config.d/w.xml; exec /entrypoint.sh" >/dev/null || exit 1
for i in "${NODES[@]}"; do
  "${RUN[@]}" --name "$PFX-n$i" --hostname "$PFX-n$i" \
    -e C1="$(b64 "$WORK/cfg/cluster.xml")" -e C2="$(b64 "$HERE/cfg/users.xml")" -e C3="$(b64 "$ROOT/deploy/http_handlers.xml")" \
    --entrypoint bash "$CH_IMAGE" \
    -c 'echo $C1 | base64 -d > /etc/clickhouse-server/config.d/cluster.xml; echo $C3 | base64 -d > /etc/clickhouse-server/config.d/sql-browser.xml; echo $C2 | base64 -d > /etc/clickhouse-server/users.d/u.xml; exec /entrypoint.sh' >/dev/null || exit 1
done
"${RUN[@]}" --name "$CLI" --entrypoint sleep "$CH_IMAGE" infinity >/dev/null || exit 1

wait_node() {  # wait_node <container> [--nopw]   (cluster nodes use the default user's password)
  local c="$1" auth=(--password defpw)
  [[ "${2:-}" != --nopw ]] || auth=()
  for _ in $(seq 120); do
    docker exec "$c" clickhouse-client "${auth[@]}" -q 'select 1' >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "node $c did not become ready" >&2; docker logs --tail 30 "$c" >&2; return 1
}
for i in "${NODES[@]}"; do wait_node "$PFX-n$i" || exit 1; done
wait_node "$WEB" --nopw || exit 1
echo "cluster up: $(docker exec "$PFX-n1" clickhouse-client --password defpw -q "select version(), count() from system.clusters where cluster='c'" | tr '\t' ' ')"

# client: curl for the http transport / file fetches (apt is reachable in CI and locally)
for _ in 1 2 3; do
  docker exec "$CLI" bash -c 'command -v curl >/dev/null || (apt-get update -qq && apt-get install -y -qq curl >/dev/null)' >/dev/null 2>&1 && break
  sleep 3
done
docker exec "$CLI" bash -c "command -v curl" >/dev/null || { echo "could not install curl in the client container" >&2; exit 1; }
docker exec "$CLI" mkdir -p /work
tar -C "$ROOT" -cf - deploy | docker exec -i "$CLI" tar --warning=no-unknown-keyword -xf - -C /work
tar -C "$WORK/art" -cf - A.html B.html C.html | docker exec -i "$CLI" tar --warning=no-unknown-keyword -xf - -C /work
docker exec "$CLI" mkdir -p /work/dist

# ------------------------------------------------------------------ helpers
INSTALL_RC=0
# run_install <logname> [args...]  -> INSTALL_RC, log in $LOGS/<logname>.log
run_install() {
  local log="$1" pw="deploypw"; shift
  docker exec -e CLICKHOUSE_PASSWORD="$pw" "$CLI" bash /work/deploy/install.sh \
    --ch-host "$PFX-n1" --client-id "$CLIENT_ID" --issuer "$ISSUER" "$@" > "$LOGS/$log.log" 2>&1
  INSTALL_RC=$?
}
run_uninstall() {
  local log="$1"; shift
  docker exec -e CLICKHOUSE_PASSWORD=deploypw "$CLI" bash /work/deploy/uninstall.sh --ch-host "$PFX-n1" "$@" > "$LOGS/$log.log" 2>&1
  INSTALL_RC=$?
}
show_log() { sed 's/^/      | /' "$LOGS/$1.log" | tail -n "${2:-25}"; }

http_sha() {  # http_sha <node> <path> -> sha256 of the response body ("HTTP<code>" prefix-free)
  docker exec "$CLI" bash -c "curl -s -m 30 -o /tmp/body -w '%{http_code}' http://$PFX-n$1:8123$2 > /tmp/code; if [ \"\$(cat /tmp/code)\" = 200 ]; then sha256sum /tmp/body | cut -d' ' -f1; else echo HTTP\$(cat /tmp/code); fi"
}
# all_serve <html-sha> <cfg-sha> [nodes...]
all_serve() {
  local hs="$1" cs="$2" i ok=0; shift 2
  local nodes=("$@"); (( ${#nodes[@]} )) || nodes=("${NODES[@]}")
  for i in "${nodes[@]}"; do
    [[ "$(http_sha "$i" /sql)" == "$hs" ]] || { echo "      n$i /sql sha mismatch: $(http_sha "$i" /sql)"; ok=1; }
    [[ "$(http_sha "$i" /sql/config.json)" == "$cs" ]] || { echo "      n$i /sql/config.json sha mismatch: $(http_sha "$i" /sql/config.json)"; ok=1; }
  done
  return "$ok"
}
EMPTY_SHA="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
rc_zero() { [[ "$INSTALL_RC" == 0 ]]; }
rc_nonzero() { [[ "$INSTALL_RC" != 0 ]]; }
log_has() { rg -q -- "$2" "$LOGS/$1.log" 2>/dev/null || grep -Eq -- "$2" "$LOGS/$1.log"; }
node_exec() { docker exec "$PFX-n$1" bash -c "$2"; }
# Stage files: every one on every node is 0 bytes; and (positive control) at least $1 exist at all,
# so an empty `find` result cannot be mistaken for "the check looked in the wrong place".
stage_files_empty() {
  local want="${1:-1}" i total=0 n
  for i in "${NODES[@]}"; do
    [[ -z "$(node_exec "$i" "find $UF -name '_asb_stage_*' -size +0")" ]] || { echo "      n$i has a non-empty stage file"; return 1; }
    n="$(node_exec "$i" "find $UF -name '_asb_stage_*' -size 0 | wc -l" | tr -d ' ')"; total=$((total + n))
  done
  (( total >= want )) || { echo "      found only $total 0-byte stage file(s), expected >= $want (positive control)"; return 1; }
}
# No _asb_* table on ANY of the 4 nodes. Positive control first: a table created ON CLUSTER must be
# seen on all 4, otherwise "0 found" proves nothing.
CH1=(docker exec "$PFX-n1" clickhouse-client --password defpw -q)
asb_tables() { "${CH1[@]}" "SELECT countIf(name LIKE '\\_asb\\_%'), uniqExact(hostName()) FROM clusterAllReplicas('c', system.tables)"; }
temp_tables_gone() {
  "${CH1[@]}" "CREATE TABLE default._asb_ctl ON CLUSTER c (x UInt8) ENGINE=Memory" >/dev/null || { echo "      control create failed"; return 1; }
  local seen gone
  seen="$(asb_tables)"
  "${CH1[@]}" "DROP TABLE default._asb_ctl ON CLUSTER c SYNC" >/dev/null
  [[ "$seen" == "$(printf '4\t4')" ]] || { echo "      positive control failed: saw '$seen', expected 4 tables on 4 hosts"; return 1; }
  gone="$(asb_tables)"
  [[ "$gone" == "$(printf '0\t4')" ]] || { echo "      leftover _asb_ tables: '$gone' (count, hosts)"; return 1; }
}
# stage + next files of the whole cluster are listed in one place for debugging
wait_ddl_queue_settled() {  # wait until no DDL queue entry for cluster c is unfinished
  local n
  for _ in $(seq 90); do
    n="$("${CH1[@]}" "SELECT count() FROM system.distributed_ddl_queue WHERE cluster = 'c' AND status != 'Finished'" 2>/dev/null || echo x)"
    [[ "$n" == 0 ]] && return 0
    sleep 1
  done
  echo "      DDL queue not settled after 90s (unfinished entries: $n)"; return 1
}
# serves_b_or_c <node...>: each node's live /sql is byte-exactly B (previous) or C (new), and the config is intact.
# Never empty, partial or any other bytes: that is the invariant a mid-run kill must not break.
serves_b_or_c() {
  local i s ok=0 c
  for i in "$@"; do
    s="$(http_sha "$i" /sql)"; c="$(http_sha "$i" /sql/config.json)"
    if [[ "$s" == "$SHA_B" ]]; then echo "      n$i serves B (previous)"
    elif [[ "$s" == "$SHA_C" ]]; then echo "      n$i serves C (new)"
    else echo "      n$i /sql is neither B nor C: $s"; ok=1; fi
    [[ "$c" == "$SHA_CFG" ]] || { echo "      n$i /sql/config.json sha mismatch: $c"; ok=1; }
  done
  return "$ok"
}
put_web() { docker exec -i "$WEB" bash -c "cat > $UF/sql.html; chown clickhouse:clickhouse $UF/sql.html" < "$1"; }

LIVE_HTML=""
CLUSTER_ARGS=(--cluster c --ch-user deploy --artifact)

# ------------------------------------------------------------------ scenarios
scenario "(a) native + stage: fresh install"
run_install a "${CLUSTER_ARGS[@]}" /work/A.html
t "installer exit 0" rc_zero
t "every node serves A and the config byte-exact" all_serve "$SHA_A" "$SHA_CFG"
t "stage file exists (connected node) and is 0 bytes; no non-empty stage anywhere" stage_files_empty 1
t "temp tables dropped on all 4 nodes (with positive control)" temp_tables_gone
if rc_zero; then LIVE_HTML="$SHA_A"; else show_log a; fi
end_scenario

scenario "(b) re-install (upgrade to different bytes)"
run_install b "${CLUSTER_ARGS[@]}" /work/B.html
t "installer exit 0" rc_zero
t "every node serves B" all_serve "$SHA_B" "$SHA_CFG"
if rc_zero; then LIVE_HTML="$SHA_B"; else show_log b; fi
end_scenario

scenario "(c) http transport + stage"
run_install c "${CLUSTER_ARGS[@]}" /work/C.html --transport http --http-port 8123
t "installer exit 0" rc_zero
t "every node serves C" all_serve "$SHA_C" "$SHA_CFG"
t "password never printed in the log" bash -c "! grep -q deploypw '$LOGS/c.log'"
if rc_zero; then LIVE_HTML="$SHA_C"; else show_log c; fi
end_scenario

scenario "(d) native + --pull-url through a 2-hop redirect chain"
put_web "$WORK/art/A.html"
run_install d --cluster c --ch-user deploy_url --artifact /work/A.html --pull-url "http://$WEB:8123/rel2/sql.html"
t "installer exit 0" rc_zero
t "every node serves A (pulled)" all_serve "$SHA_A" "$SHA_CFG"
if rc_zero; then LIVE_HTML="$SHA_A"; else show_log d; fi
end_scenario

scenario "(e) wiped node is repaired by re-install"
node_exec 2 "rm -f $UF/sql.html $UF/sql-config.json $UF/_asb_*"
t "wiped node no longer serves the SPA" bash -c "[ \"\$(docker exec $CLI curl -s -o /dev/null -w '%{http_code}' http://$PFX-n2:8123/sql)\" != 200 ]"
run_install e0 "${CLUSTER_ARGS[@]}" /work/A.html --verify-only
t "--verify-only reports failure" rc_nonzero
t "--verify-only names the bad node" log_has e0 "$PFX-n2.*MISMATCH"
run_install e "${CLUSTER_ARGS[@]}" /work/A.html
t "installer exit 0" rc_zero
t "every node serves A again" all_serve "$SHA_A" "$SHA_CFG"
run_install e1 "${CLUSTER_ARGS[@]}" /work/A.html --verify-only
t "--verify-only exit 0" rc_zero
rc_zero || show_log e
end_scenario

scenario "(g) --verify-only detects a tampered node"
node_exec 3 "printf 'tampered' >> $UF/sql.html"
run_install g "${CLUSTER_ARGS[@]}" /work/A.html --verify-only
t "--verify-only exit non-zero" rc_nonzero
t "tampered node reported" log_has g "$PFX-n3.*MISMATCH"
t "healthy node reported ok" log_has g "$PFX-n1.*ok"
run_install g2 "${CLUSTER_ARGS[@]}" /work/A.html
t "re-install repairs it" all_serve "$SHA_A" "$SHA_CFG"
end_scenario

scenario "(f) preflight rejects a dead node (node stopped before the run)"
docker stop "$PFX-n4" >/dev/null
run_install f "${CLUSTER_ARGS[@]}" /work/B.html --ddl-timeout 20
t "installer exit non-zero" rc_nonzero
t "failed in the preflight, before any write" log_has f "(preflight|only 3 of 4|Cannot reach|unreachable|ALL_CONNECTION_TRIES_FAILED)"
t "live files unchanged on the surviving nodes (still A)" all_serve "$SHA_A" "$SHA_CFG" 1 2 3
docker start "$PFX-n4" >/dev/null; wait_node "$PFX-n4" || true
t "restarted node still serves the previous good version" all_serve "$SHA_A" "$SHA_CFG" 4
run_install f2 "${CLUSTER_ARGS[@]}" /work/B.html
t "re-install exit 0" rc_zero
t "every node serves B" all_serve "$SHA_B" "$SHA_CFG"
rc_nonzero && show_log f 8
end_scenario
LIVE_HTML="$SHA_B"

# A node that dies AFTER the preflight, while the installer is running. Deterministic via the installer's
# internal test barrier (ASB_TEST_BARRIER, see install.sh): the installer parks at a defined point and
# creates <barrier>.reached; we kill n4 only then, and release it by creating <barrier>.go. The scenario
# FAILS (not vacuously passes) if the installer exits before reaching the barrier.
# barrier_run <log> <point> <artifact> : sets INSTALL_RC and BARRIER_SEEN (1 = barrier observed while the installer was alive)
barrier_run() {
  local log="$1" point="$2" art="$3" b="/work/$1.barrier" i
  docker exec "$CLI" rm -f "$b.reached" "$b.go"
  rm -f "$WORK/$log.rc"
  (
    docker exec -e CLICKHOUSE_PASSWORD=deploypw -e ASB_TEST_BARRIER="$b" -e ASB_TEST_BARRIER_POINT="$point" "$CLI" bash /work/deploy/install.sh \
      --ch-host "$PFX-n1" --client-id "$CLIENT_ID" --issuer "$ISSUER" "${CLUSTER_ARGS[@]}" "$art" --ddl-timeout 20 > "$LOGS/$log.log" 2>&1
    echo $? > "$WORK/$log.rc"
  ) &
  local bg=$!
  BARRIER_SEEN=0
  for i in $(seq 1200); do
    if docker exec "$CLI" test -f "$b.reached" 2>/dev/null; then BARRIER_SEEN=1; break; fi
    [[ -f "$WORK/$log.rc" ]] && break   # the installer already exited: it never reached the barrier
    sleep 0.1
  done
  if (( BARRIER_SEEN )); then docker stop -t 0 "$PFX-n4" >/dev/null; fi
  docker exec "$CLI" touch "$b.go"
  wait "$bg"; INSTALL_RC="$(cat "$WORK/$log.rc")"
}
barrier_seen() { [[ "$BARRIER_SEEN" == 1 ]]; }
# Failure REASON, not just a non-zero rc (an unrelated early error would also be non-zero).
m_fails_in_fanout_for_the_dead_node() {
  log_has m 'ERROR: fan out sql\.html to every node failed' || { echo "      no 'fan out ... failed' ERROR in the log"; return 1; }
  log_has m 'did not answer the ON CLUSTER DDL|TIMEOUT_EXCEEDED|Code: 159|Code: 209|Code: 210|NETWORK_ERROR|Connection refused|Could not resolve|node unreachable' \
    || { echo "      the log names no dead-node/timeout/connection reason"; return 1; }
  ! log_has m '==> Phase 2' || { echo "      the installer reached phase 2"; return 1; }
}
m3_fails_in_promote_after_phase1_passed() {
  log_has m3 '==> Verifying phase 1 \(next files\)' || { echo "      phase-1 verification never ran"; return 1; }
  ! log_has m3 'phase 1 verification failed|\[phase 1' || { echo "      phase-1 verification failed"; return 1; }
  log_has m3 '==> Phase 2: promote' || { echo "      phase 2 never started"; return 1; }
  log_has m3 'ERROR: promote sql(\.html|-config\.json) failed' || { echo "      the failure is not in the promote phase"; return 1; }
}
# how many survivors (n1-n3) were promoted (serve B, the new file) before the promote DDL gave up
count_promoted() {
  local i n=0; for i in "$@"; do [[ "$(http_sha "$i" /sql)" == "$SHA_B" ]] && n=$((n + 1)); done
  echo "      promoted survivors: $n of $#"
}

scenario "(m) node killed at the barrier BEFORE the phase-1 fan-out: installer fails; survivors still serve B exactly; re-install converges on C"
barrier_run m pre_fanout /work/C.html
t "the barrier was reached while the installer was alive (the kill really landed mid-run)" barrier_seen
t "installer exit non-zero" rc_nonzero
t "failure reason: the fan-out failed on the dead node (timeout/connection), phase 2 never ran" m_fails_in_fanout_for_the_dead_node
t "no live file was touched: every survivor serves exactly B" all_serve "$SHA_B" "$SHA_CFG" 1 2 3
docker start "$PFX-n4" >/dev/null; wait_node "$PFX-n4" || true
t "queued DDL replay settles" wait_ddl_queue_settled
t "after the replay the restarted node serves B (nothing ever promoted)" all_serve "$SHA_B" "$SHA_CFG" 4
run_install m2 "${CLUSTER_ARGS[@]}" /work/C.html
t "re-install exit 0" rc_zero
t "every node serves C" all_serve "$SHA_C" "$SHA_CFG"
t "temp tables gone on all 4 nodes" temp_tables_gone
t "no non-empty stage file anywhere" stage_files_empty 2
rc_zero || show_log m2
rc_nonzero && show_log m 12
end_scenario
LIVE_HTML="$SHA_C"

# Kill between phase-1 verify and the promote: phase 1 had passed everywhere, so survivors may or may not
# have been promoted by the time the promote DDL gives up on n4 (B or C), but never empty/partial/other.
scenario "(m3) node killed at the barrier AFTER phase-1 verify, BEFORE the promote: installer fails; survivors serve C (previous) or B (new), never anything else; re-install converges"
barrier_run m3 pre_promote /work/B.html
t "the barrier was reached while the installer was alive" barrier_seen
t "installer exit non-zero" rc_nonzero
t "failure reason: phase 1 verified, then the promote failed" m3_fails_in_promote_after_phase1_passed
count_promoted 1 2 3
t "each surviving node serves byte-exactly C (previous) or B (new)" serves_b_or_c 1 2 3
docker start "$PFX-n4" >/dev/null; wait_node "$PFX-n4" || true
t "queued DDL replay settles" wait_ddl_queue_settled
t "after the replay the restarted node serves C or B, never a half-staged file" serves_b_or_c 4
run_install m4 "${CLUSTER_ARGS[@]}" /work/C.html
t "re-install exit 0" rc_zero
t "every node serves C" all_serve "$SHA_C" "$SHA_CFG"
t "temp tables gone on all 4 nodes" temp_tables_gone
t "no non-empty stage file anywhere" stage_files_empty 2
rc_zero || show_log m4
rc_nonzero && show_log m3 12
end_scenario
LIVE_HTML="$SHA_C"

scenario "(l) --verify-only as the minimal deploy_verify user"
run_install l --cluster c --ch-user deploy_verify --artifact /work/C.html --verify-only
t "verify-only exit 0 on a healthy cluster" rc_zero
run_install l2 --cluster c --ch-user deploy_verify --artifact /work/A.html --verify-only
t "verify-only exit non-zero when the artifact differs" rc_nonzero
run_install l3 --cluster c --ch-user deploy_verify --artifact /work/A.html
t "a full install as deploy_verify is refused (no CREATE/CLUSTER grants)" rc_nonzero
t "refusal names the privilege problem" log_has l3 "(ACCESS_DENIED|Not enough privileges|missing grants)"
t "live untouched" all_serve "$SHA_C" "$SHA_CFG"
end_scenario

scenario "(j) phase-1 failure (unreachable pull URL): live files untouched"
run_install j --cluster c --ch-user deploy_url --artifact /work/C.html --pull-url "http://$WEB:8123/rel2/nope.html"
t "installer exit non-zero" rc_nonzero
t "every node still serves the previous version" all_serve "$LIVE_HTML" "$SHA_CFG"
end_scenario

scenario "(i) missing grants: clear failure, live untouched"
docker exec -e CLICKHOUSE_PASSWORD=deploypw "$CLI" bash /work/deploy/install.sh --ch-host "$PFX-n1" --client-id "$CLIENT_ID" --issuer "$ISSUER" \
  --cluster c --ch-user deploy_noremote --artifact /work/C.html > "$LOGS/i.log" 2>&1; INSTALL_RC=$?
t "no REMOTE: exit non-zero" rc_nonzero
t "no REMOTE: error names the privilege problem" log_has i "(ACCESS_DENIED|Not enough privileges|missing grants)"
t "no REMOTE: live untouched" all_serve "$LIVE_HTML" "$SHA_CFG"
run_install i2 "${CLUSTER_ARGS[@]}" /work/C.html --pull-url "http://$WEB:8123/rel2/sql.html"
t "no URL grant (--pull-url): exit non-zero" rc_nonzero
t "no URL grant: error names the privilege problem" log_has i2 "(ACCESS_DENIED|Not enough privileges|missing grants)"
t "no URL grant: live untouched" all_serve "$LIVE_HTML" "$SHA_CFG"
end_scenario

scenario "(k) single node (no --cluster): only the connected node changes"
run_install k --ch-user deploy --artifact /work/A.html
t "installer exit 0" rc_zero
t "connected node serves A" all_serve "$SHA_A" "$SHA_CFG" 1
t "other nodes still serve the previous version (C)" all_serve "$SHA_C" "$SHA_CFG" 2 3 4
rc_zero || show_log k
end_scenario

scenario "(h) uninstall: 0-byte files on every node"
run_uninstall h --cluster c --ch-user deploy
t "uninstall exit 0" rc_zero
t "every node serves empty /sql and /sql/config.json" all_serve "$EMPTY_SHA" "$EMPTY_SHA"
t "files are 0 bytes on disk on every node" bash -c "for i in 1 2 3 4; do [ \"\$(docker exec $PFX-n\$i stat -c %s $UF/sql.html $UF/sql-config.json | tr '\n' ' ')\" = '0 0 ' ] || exit 1; done"
rc_zero || show_log h
end_scenario

# ------------------------------------------------------------------ summary
echo
echo "==================== deploy integration summary (${CH_IMAGE}) ===================="
FAILED=0
for r in "${RESULTS[@]}"; do echo "$r"; [[ "$r" == FAIL* ]] && FAILED=1; done
if (( FAILED )); then echo "RESULT: FAILED (logs: $LOGS; re-run with KEEP=1 to inspect)"; exit 1; fi  # the EXIT trap copies the logs out
echo "RESULT: ALL PASSED"
