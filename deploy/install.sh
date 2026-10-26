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
# Prerequisites: bash, node 22+ and npm (the installer builds the SPA from source),
# curl (only for OIDC discovery; it falls back to the Google connect-src without
# it), and clickhouse-client (not needed for --dry-run). To skip the build, take
# the prebuilt sql.html from the GitHub release and upload it yourself; see
# docs/ASSET-DISTRIBUTION.md.
#
# Usage:
#   CLICKHOUSE_PASSWORD=... ./deploy/install.sh \
#     --ch-host clickhouse.example.com \
#     --ch-user admin \
#     --client-id <oauth-client-id> \
#     [--issuer https://accounts.google.com] \
#     [--audience <aud>] \         # audience-gated CH → also sends access_token
#     [--ch-auth basic] \          # OSS CH + ch-jwt-verify → JWT as Basic password
#     [--cluster my_cluster] \     # BROKEN on multi-replica clusters (#692); omit
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

# user_files is node-local. NOTE: --cluster is currently broken (#692): the
# clusterAllReplicas INSERT below fails on any cluster with more than one
# replica (STORAGE_REQUIRES_PARAMETER). This multi-shard guard is only a partial
# early stop; see docs/ASSET-DISTRIBUTION.md for the manual procedure.
if [[ "$DRY_RUN" != 1 && -n "$CLUSTER" ]]; then
  SHARDS=$("${CH[@]}" --query "SELECT max(shard_num) FROM system.clusters WHERE cluster = '${CLUSTER}'" 2>/dev/null || true)
  if [[ "$SHARDS" =~ ^[0-9]+$ ]] && (( SHARDS > 1 )); then
    echo "ERROR: cluster '${CLUSTER}' has ${SHARDS} shards. --cluster is currently" >&2
    echo "broken on multi-replica clusters (#692); user_files is node-local. See" >&2
    echo "'Multi-node clusters (interim, manual)' in docs/ASSET-DISTRIBUTION.md." >&2
    exit 2
  fi
fi

echo "==> Building @altinity/clickhouse-http"
npm --prefix "$ROOT" run build:clickhouse-http

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

# Print the post-install instructions. Called after upload, and also by --dry-run
# so the URL/scheme logic is testable without a ClickHouse. The native port
# --ch-host is used with (9000/9440) differs from the HTTP(S) port the browser
# needs, so print the HTTP defaults (8123 plain / 8443 TLS) explicitly.
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
  echo "==> DRY RUN — no ClickHouse contact. Rendered artifacts:"
  echo "--- config.json ---"
  cat "$CONFIG_FILE"
  echo "--- dist/http_handlers.xml ---"
  cat "$HANDLERS_OUT"
  print_next_steps
  exit 0
fi

# Upload raw bytes via FORMAT RawBLOB on stdin — no base64, no command-line
# length limit, written as the clickhouse process so perms are correct.
upload() {  # upload <local-file> <user_files-filename>
  local src="$1"
  local fname="$2"
  local tbl
  tbl="default._asb_$(echo "$fname" | tr '.-' '__')"
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

echo
echo "==> Assets uploaded to ClickHouse user_files/."
print_next_steps
