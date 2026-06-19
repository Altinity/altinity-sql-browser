# Deployment

The app is three things on the target ClickHouse:
1. `user_files/sql.html` — the SPA, served at `/sql`
2. `user_files/sql-config.json` — OAuth config, served at `/sql/config.json`
3. an `<http_handlers>` config fragment wiring those routes

`deploy/install.sh` does 1 + 2; you wire 3 once.

## 1–2. Upload assets

```bash
CLICKHOUSE_PASSWORD=… ./deploy/install.sh \
  --ch-host clickhouse.example.com --ch-user admin \
  --client-id <oauth-client-id> [--issuer …] [--audience …] [--cluster …] [--secure]
```

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

## 4. Make ClickHouse accept the JWT

The SPA sends `Authorization: Bearer <id_token>` on every query. ClickHouse must
validate it. Two supported shapes:

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

Either way, the app itself is unchanged — it only sends the bearer.

## 5. OAuth IdP

Register the redirect URI `https://<ch-host>/sql` with your IdP and put the
`issuer` + `client_id` in `config.json` (the installer does this from
`--issuer`/`--client-id`). Whether `config.json` also needs a `client_secret`
depends on the IdP and client type — see the "Configuring OAuth" section in the
README for the trade-offs between a PKCE public client, a secret-bearing web
client, and a server-side broker.

## Verify

Open `https://<ch-host>/sql`, sign in, and run `SELECT currentUser()`. It should
return your authenticated identity (not a static user). Schema appears in the
left tree; results stream into the table view.
