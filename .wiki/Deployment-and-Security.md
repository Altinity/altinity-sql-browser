# Deployment and security

Back to [[Home]]. Related: [[Operations-Memory]], [[Product-and-Features]].

## Artifact and routes

The build produces `dist/sql.html`. Deployment copies it to ClickHouse
`user_files` and configures HTTP handlers for the SPA and public `config.json`.
Cluster distribution options and tradeoffs are documented in
[`docs/ASSET-DISTRIBUTION.md`](../docs/ASSET-DISTRIBUTION.md).

## Authentication modes

- Native/Bearer OAuth for ClickHouse variants with token processors and ephemeral
  users.
- Basic transport (`username: JWT`) through `ch-jwt-verify` for stock ClickHouse.
- Direct credential login where configured.
- Multiple IdPs are supported; mappings must avoid username collisions.

`config.json` is served to browsers and is therefore public. Prefer PKCE public
clients. If an IdP requires a client secret, treat it as exposed and tightly lock
the redirect URI. Never commit rendered `deploy/config.json`; only
`deploy/config.json.example` belongs in version control.

## Demo-cluster operational rule

Build and upload the HTML without a restart. For ClickHouse `config.d` changes on
ACM-managed demo clusters, use ACM settings plus cluster push; direct ConfigMap
edits are reconciled away. Verify the effective preprocessed ClickHouse config.

**otel runs two replica pods** (`chi-otel-otel-0-0-0` and `chi-otel-otel-0-1-0`,
since ~2026-07-20); `user_files` is per-pod local disk, not shared, and the
ClickHouse Service load-balances across both — a deploy must `kubectl cp` to
**every** `chi-otel-otel-0-*-0` pod, or roughly half of live requests 500 with
`Code 79 INCORRECT_FILE_NAME`. github.demo and antalya remain single-replica.
Re-check replica count (`kubectl get pods -n demo -l clickhouse.altinity.com/chi=otel`)
before every otel deploy — a ClickHouse Operator `chi` can add replicas
independent of any SPA-deploy action. See [[Operations-Memory]].

## Standalone nginx image + Helm chart (sql.demo.altinity.cloud)

Distinct from the three ClickHouse-hosted deploys above: the SPA also ships as a
production **nginx** container image (`ghcr.io/altinity/altinity-sql-browser`,
public, multi-arch) built by `.github/workflows/docker.yml` (`edge`+`sha-<c>` on
every push to `main`; `X.Y.Z`+`latest` on a `vX.Y.Z` tag push — the release
image) and a **Helm chart** (`helm/altinity-sql-browser/`, published to
`oci://ghcr.io/altinity/altinity-sql-browser/helm/altinity-sql-browser` by
`release.yml` on `v*`).
The container is a standalone static server (nginx-unprivileged, uid 101, port
8080); it never proxies — the browser POSTs queries cross-origin to whatever
cluster the login picker selects.

Live at **https://sql.demo.altinity.cloud/sql** (ns `demo`, Helm release
`sql-browser`), exposed via the same edge-proxy Service-annotation pattern used
elsewhere on demo.altinity.cloud (no ingress/DNS/cert-manager — a
`*.demo.altinity.cloud` wildcard cert + SNI routing, `443:tls-to-tcp:8080`):

```sh
export KUBECONFIG=~/tmp/acm-session.kubeconfig
helm upgrade --install sql-browser \
  oci://ghcr.io/altinity/altinity-sql-browser/helm/altinity-sql-browser \
  --version 0.6.2 \
  -n demo -f deploy/helm/values-demo.yaml
kubectl rollout status deploy/sql-browser-altinity-sql-browser -n demo
```

`deploy/helm/values-demo.yaml` pins `image.tag` to the current release
(`"0.6.1"` as of this writing) — bump it as part of every release round rather
than letting it drift on the rolling `edge` tag between releases. Verify the
target tag is actually published first (`gh api
/orgs/Altinity/packages/container/altinity-sql-browser/versions`), then confirm
the rollout via in-pod `wget http://127.0.0.1:8080/sql` /`/healthz` plus a live
agent-Chrome check.

**Known gap:** SSO from sql.demo fails `redirect_uri_mismatch` — the demo Google
OAuth clients (antalya, github.demo) only register redirect URIs on their own
hosts, not `sql.demo.altinity.cloud`; `demo:demo` basic login works without it.

Canonical source: [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md),
[`docs/CLICKHOUSE-OAUTH.md`](../docs/CLICKHOUSE-OAUTH.md),
[`docs/CLICKHOUSE-OSS-OAUTH.md`](../docs/CLICKHOUSE-OSS-OAUTH.md), and
[`SECURITY.md`](../SECURITY.md).
