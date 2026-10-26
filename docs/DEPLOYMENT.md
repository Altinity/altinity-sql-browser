# Deployment

There are now two distinct deployment surfaces:

1. **ClickHouse®-native hosted mode** — upload `sql.html` + `sql-config.json` into
   ClickHouse `user_files/` and serve them from the cluster itself.
2. **Containerized runtime** — run the static SPA image in Docker or Kubernetes
   for local or shared use, with browser requests sent directly to ClickHouse.

This document focuses on the first mode. For source development, Docker, and
Kubernetes/Helm instructions, see [DEVELOPMENT.md](DEVELOPMENT.md).

The app is three things on the target ClickHouse:
1. `user_files/sql.html` — the SPA, served at `/sql`
2. `user_files/sql-config.json` — OAuth config, served at `/sql/config.json`
3. an `<http_handlers>` config fragment wiring those routes

`deploy/install.sh` does 1 + 2; you wire 3 once.

## 1–2. Upload assets

```bash
CLICKHOUSE_PASSWORD=… ./deploy/install.sh \
  --ch-host clickhouse.example.com --ch-user admin \
  --client-id <oauth-client-id> [--issuer …] [--audience …] [--ch-auth basic] \
  [--cluster …] [--secure]
```

Prerequisites: `npm` + `node` 22+ (the installer builds the SPA), `clickhouse-client`,
and `curl` (OIDC discovery only). `--audience` makes the SPA send the access
token instead of the id_token; `--ch-auth basic` sends the JWT as the HTTP Basic
password (OSS ClickHouse behind a verifier, see section 4). A GitHub release
also ships a prebuilt `sql.html` if you would rather upload it yourself. At the
end the installer prints the URL to open and the redirect URI to register; it
uses the default HTTP(S) ports 8123/8443, so adjust if yours differ.

For a multi-replica cluster pass `--cluster <name>`; the installer fans the
bytes to every replica via `clusterAllReplicas`. The password is read from the
env var or prompted — never placed on the command line.

> **`user_files/` is node-local — re-run `install.sh` after a scale-out.**
> ClickHouse does not replicate `user_files/`, so a replica added or replaced
> later starts without the assets. This is a deliberate trade-off (the bootstrap
> page is then served statically, with no auth). See
> [ASSET-DISTRIBUTION.md](ASSET-DISTRIBUTION.md) for the options (push to
> `user_files`, a replicated table + `predefined_query_handler`, or shipping the
> asset through config distribution) and their trade-offs.

## 3. HTTP routes

Add the http_handlers fragment to ClickHouse `config.d/` (or push it through
your control plane as `config.d/sql-browser.xml`) and reload. It adds static
rules for `/sql` and `/sql/config.json` and keeps `<defaults/>` so the dynamic
query handler at `/` still works. The SPA rule also sends a strict
Content-Security-Policy (`default-src 'none'`, `frame-ancestors 'none'`, and a
`connect-src` scoped to same-origin + your IdP) plus `nosniff` and
`Referrer-Policy: no-referrer` — see README "Security headers".

`deploy/http_handlers.xml` is the committed default (Google `connect-src`).
`install.sh` renders `dist/http_handlers.xml` with `connect-src` filled in for
your `--issuer`; deploy that rendered file. For a manual install with a
non-Google IdP, edit the `connect-src` line to your issuer + token-endpoint
origins.

No compression config is needed here: ClickHouse's HTTP server transparently
gzips any response — including this static handler's — when the client sends
`Accept-Encoding: gzip` (every browser does), independent of `<http_handlers>`
config or the `enable_http_compression` query setting. Verified live on all
three demo clusters. `dist/sql.html` is about 2 MB raw (`ls -l dist/sql.html`);
the bytes on the wire are much smaller. Measure your own build with
`curl -s -o /dev/null -w '%{size_download}\n' -H 'Accept-Encoding: gzip' https://<ch-host>/sql`.

## 4. Make ClickHouse accept the JWT

The SPA sends the IdP token on every query. By default that is the `id_token`
as `Authorization: Bearer <jwt>`; with an `audience` configured it sends the
`access_token` instead; with `"ch_auth": "basic"` the same JWT travels as the
password of `Authorization: Basic base64(user:jwt)`. ClickHouse must validate
it. Two supported shapes:

- **Native token processor** (Antalya build with JWT auth): add a
  `<token_processors>` entry pointing at your IdP's JWKS with `username_claim`,
  and a `<token>` user-directory so users are created on first query. Full
  step-by-step with generic examples: [CLICKHOUSE-OAUTH.md](CLICKHOUSE-OAUTH.md).
- **Delegated verifier (stock/OSS ClickHouse)**: run a JWT-verifier service
  (e.g. Altinity's [ch-jwt-verify](https://github.com/Altinity/ch-jwt-verify))
  referenced from `<http_authentication_servers>`, define users `IDENTIFIED WITH
  http SERVER … SCHEME 'BASIC'`, and set `"ch_auth": "basic"` in the browser
  `config.json` so the JWT is sent as the Basic password. Full guide with generic
  examples: [CLICKHOUSE-OSS-OAUTH.md](CLICKHOUSE-OSS-OAUTH.md).

Either way the SPA only ever sends the IdP-issued JWT; which header carries it
(Bearer or Basic) and which token (id_token or access_token) is set by
`config.json`.

## 5. OAuth IdP

Register the redirect URI the installer printed (e.g. `https://<ch-host>:8443/sql`; it must match the origin exactly, so include the HTTP(S) port unless it is the scheme default, 443/80, or use the externally exposed port/ingress host) with your IdP and put the
`issuer` + `client_id` in `config.json` (the installer does this from
`--issuer`/`--client-id`). Whether `config.json` also needs a `client_secret`
depends on the IdP and client type — see [LOGIN-SCREEN.md](LOGIN-SCREEN.md)
for the trade-offs between a PKCE public client, a secret-bearing web
client, and a server-side broker.

## Verify

Open `https://<ch-host>/sql`, sign in, and run `SELECT currentUser()`. It should
return your authenticated identity (not a static user). Schema appears in the
left tree; results stream into the table view.
