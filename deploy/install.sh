#!/usr/bin/env bash
# Install the Altinity SQL Browser onto a ClickHouse cluster:
#   1. build the single-file SPA (dist/sql.html)
#   2. render config.json from the OAuth args
#   3. render dist/http_handlers.xml (CSP connect-src filled from OIDC discovery)
#   4. upload the SPA + config into ClickHouse user_files/ (sql.html, sql-config.json)
#   5. print the next step to enable /sql with the rendered http_handlers.xml
#
# The password is read from the CLICKHOUSE_PASSWORD env var or prompted — never
# passed on the command line (it would leak via `ps`/shell history).
#
# Usage:
#   CLICKHOUSE_PASSWORD=... ./deploy/install.sh \
#     --ch-host clickhouse.example.com \
#     --ch-user admin \
#     --client-id <oauth-client-id> \
#     [--issuer https://accounts.google.com] \
#     [--audience <aud>] \         # audience-gated CH → also sends access_token
#     [--ch-auth basic] \          # OSS CH + ch-jwt-verify → JWT as Basic password
#     [--cluster my_cluster] \     # single-shard multi-replica only
#     [--secure] \
#     [--dry-run]                  # build + render config.json + http_handlers.xml, print, no CH contact
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CH_HOST="" CH_USER="default" ISSUER="https://accounts.google.com"
CLIENT_ID="" AUDIENCE="" CLUSTER="" SECURE=0 CH_AUTH="" DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ch-host) CH_HOST="$2"; shift 2 ;;
    --ch-user) CH_USER="$2"; shift 2 ;;
    --client-id) CLIENT_ID="$2"; shift 2 ;;
    --issuer) ISSUER="$2"; shift 2 ;;
    --audience) AUDIENCE="$2"; shift 2 ;;
    --ch-auth) CH_AUTH="$2"; shift 2 ;;
    --cluster) CLUSTER="$2"; shift 2 ;;
    --secure) SECURE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;   # build + render config.json + http_handlers.xml, print, no ClickHouse contact
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$CLIENT_ID" ]] || { echo "--client-id is required" >&2; exit 2; }
# --ch-host is only needed to reach ClickHouse; a --dry-run just renders artifacts.
[[ -n "$CH_HOST" || "$DRY_RUN" == 1 ]] || { echo "--ch-host is required" >&2; exit 2; }

if [[ "$DRY_RUN" != 1 && -z "${CLICKHOUSE_PASSWORD:-}" ]]; then
  read -r -s -p "ClickHouse password for $CH_USER@$CH_HOST: " CLICKHOUSE_PASSWORD
  echo
fi
export CLICKHOUSE_PASSWORD

CH=(clickhouse-client --host "$CH_HOST" --user "$CH_USER")
[[ "$SECURE" == 1 ]] && CH+=(--secure)

# user_files is node-local, and clusterAllReplicas cannot write to a multi-shard
# Distributed target, so a --cluster install only works on a single shard.
if [[ "$DRY_RUN" != 1 && -n "$CLUSTER" ]]; then
  SHARDS=$("${CH[@]}" --query "SELECT max(shard_num) FROM system.clusters WHERE cluster = '${CLUSTER}'" 2>/dev/null || true)
  if [[ "$SHARDS" =~ ^[0-9]+$ ]] && (( SHARDS > 1 )); then
    echo "ERROR: cluster '${CLUSTER}' has ${SHARDS} shards. clusterAllReplicas can't" >&2
    echo "write across shards, and user_files is node-local. Install per node instead" >&2
    echo "(omit --cluster; point --ch-host at each node), or serve the assets from a" >&2
    echo "replicated table — see docs/ASSET-DISTRIBUTION.md." >&2
    exit 2
  fi
fi

echo "==> Building dist/sql.html"
node "$ROOT/build/build.mjs"

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
CONFIG_FILE="$(mktemp)"
trap 'rm -f "$CONFIG_FILE"' EXIT
printf '%s\n' "$CONFIG_JSON" > "$CONFIG_FILE"

echo "==> Rendering http_handlers.xml (CSP connect-src from OIDC discovery)"
# The CSP connect-src must allow same-origin ('self', for ClickHouse + config.json)
# plus the IdP origins the browser fetches: OIDC discovery (issuer origin) and the
# token endpoint (exchange + refresh). The OAuth /authorize step is a top-level
# navigation, not a fetch, so it needs no connect-src entry. Resolve the real
# origins from the issuer's discovery document; fail soft to the Google default.
ISSUER_ORIGIN="$(printf '%s' "$ISSUER" | grep -oiE '^https?://[^/]+' || true)"
CONNECT_HOSTS="https://accounts.google.com https://oauth2.googleapis.com"
DISC_URL="${ISSUER%/}/.well-known/openid-configuration"
if DISC_JSON="$(curl -fsS --max-time 10 "$DISC_URL" 2>/dev/null)"; then
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
sed -E "s#(connect-src 'self')[^;]*#\1 ${CONNECT_HOSTS}#" \
  "$ROOT/deploy/http_handlers.xml" > "$HANDLERS_OUT"

if [[ "$DRY_RUN" == 1 ]]; then
  echo
  echo "==> DRY RUN — no ClickHouse contact. Rendered artifacts:"
  echo "--- config.json ---"
  cat "$CONFIG_FILE"
  echo "--- dist/http_handlers.xml ---"
  cat "$HANDLERS_OUT"
  exit 0
fi

# Upload raw bytes via FORMAT RawBLOB on stdin — no base64, no command-line
# length limit, written as the clickhouse process so perms are correct.
upload() {  # upload <local-file> <user_files-filename>
  local src="$1"
  local fname="$2"
  local tbl="default._asb_$(echo "$fname" | tr '.-' '__')"
  local on_cluster=""
  [[ -n "$CLUSTER" ]] && on_cluster="ON CLUSTER '${CLUSTER}'"
  "${CH[@]}" --query "CREATE TABLE IF NOT EXISTS ${tbl} ${on_cluster} (content String)
    ENGINE = File('RawBLOB', '/var/lib/clickhouse/user_files/${fname}')"
  if [[ -n "$CLUSTER" ]]; then
    "${CH[@]}" --query "INSERT INTO FUNCTION clusterAllReplicas('${CLUSTER}','${tbl%.*}','${tbl#*.}')
      SETTINGS engine_file_truncate_on_insert = 1 FORMAT RawBLOB" < "$src"
  else
    "${CH[@]}" --query "INSERT INTO ${tbl}
      SETTINGS engine_file_truncate_on_insert = 1 FORMAT RawBLOB" < "$src"
  fi
  "${CH[@]}" --query "DROP TABLE IF EXISTS ${tbl} ${on_cluster}"
}

echo "==> Uploading sql.html"
upload "$ROOT/dist/sql.html" "sql.html"
echo "==> Uploading sql-config.json"
upload "$CONFIG_FILE" "sql-config.json"

cat <<EOF

==> Assets uploaded to ClickHouse user_files/.

Final step — enable the HTTP routes. Add the rendered dist/http_handlers.xml
(its CSP connect-src is filled in for your issuer) to the server config.d/ (or
push it as an ACM cluster setting named "config.d/sql-browser.xml") and reload
ClickHouse. Then open:

    http${SECURE:+s}://$CH_HOST/sql

Also register the OAuth redirect URI  http(s)://$CH_HOST/sql  with your IdP,
and make sure ClickHouse is configured to accept the bearer JWT (token_processor
+ JWKS, or a delegated http_authentication verifier). See README.
EOF
