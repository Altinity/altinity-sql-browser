# OAuth on stock/OSS ClickHouse® via ch-jwt-verify

Stock (OSS) ClickHouse has no `<token_processors>`, so it can't validate a
`Bearer` JWT itself (it returns `Code: 516. 'Bearer' HTTP Authorization scheme
is not supported`). The way to still get per-user OAuth is to put a small JWT
**verifier service** behind ClickHouse's `<http_authentication_servers>` and
send the JWT as the **HTTP Basic password**.

[Altinity's **ch-jwt-verify**](https://github.com/Altinity/ch-jwt-verify) is such
a verifier. This doc shows the generic wiring. For the Antalya-build native path
(Bearer + `<token_processors>`), see [CLICKHOUSE-OAUTH.md](CLICKHOUSE-OAUTH.md).

## The flow

```
browser ──Authorization: Basic base64(email : <jwt>)──▶ ClickHouse (OSS)
                                                          │  user is IDENTIFIED WITH
                                                          │  http SERVER 'ch_jwt_verify'
                                                          ▼
                                                  ch-jwt-verify /verify
                                                  validates the JWT (the password)
                                                  against the IdP's JWKS + claims
```

The username half of the Basic credential is the user's email (from the JWT);
the password half is the JWT itself. ClickHouse forwards it to the verifier,
which checks the signature/issuer/audience/expiry and that the token's
`username_claim` matches the username.

## Does the SQL browser support this? Yes — `ch_auth: "basic"`

By default the browser sends `Authorization: Bearer <token>`. Set `ch_auth` to
`basic` in `config.json` and it instead sends
`Authorization: Basic base64(<email>:<token>)`, where `<email>` is taken from the
token's `email` claim (falling back to `preferred_username` / `sub`):

```json
{
  "issuer": "https://issuer.example.com",
  "client_id": "<client-id>",
  "ch_auth": "basic"
}
```

`bearer` usually stays at its default `id_token` here (ch-jwt-verify validates
the id_token as the password). Combine with `audience` only if your verifier
enforces one.

## 1. Run ch-jwt-verify

Deploy the verifier (see its repo for images/Helm). It needs to know your IdP:

```yaml
# generic ch-jwt-verify config
oauth:
  issuer:    https://issuer.example.com
  jwks_url:  https://issuer.example.com/.well-known/jwks.json
  audience:  ""                      # set to your API audience to enforce aud
identity:
  username_claim: email              # claim compared to the Basic username
  match_mode:     lowercase_equal
listen:
  tcp: 0.0.0.0:9999                  # exposes POST /verify
```

Make it reachable from the ClickHouse nodes (e.g. a Service at
`http://ch-jwt-verify.example:9999`).

## 2. Point ClickHouse at the verifier

A `config.d/*.xml` fragment on every node:

```xml
<clickhouse>
  <http_authentication_servers>
    <ch_jwt_verify>
      <uri>http://ch-jwt-verify.example:9999/verify</uri>
      <!-- forward the incoming Authorization header to the verifier -->
      <forward_headers>
        <header>Authorization</header>
      </forward_headers>
      <connection_timeout_ms>1000</connection_timeout_ms>
      <receive_timeout_ms>3000</receive_timeout_ms>
      <send_timeout_ms>1000</send_timeout_ms>
    </ch_jwt_verify>
  </http_authentication_servers>
</clickhouse>
```

## 3. Create users and roles

Unlike the Antalya `<token>` directory, OSS http-auth does **not** auto-create
users — each user is defined once, bound to the verifier with `SCHEME 'BASIC'`.
The username must equal the JWT's `username_claim` value (the email). Use
`ON CLUSTER '<cluster>'` on a multi-node cluster.

```sql
CREATE ROLE IF NOT EXISTS sql_reader;
GRANT SELECT ON *.* TO sql_reader;
GRANT SELECT ON system.tables TO sql_reader;   -- schema browser
GRANT SELECT ON system.columns TO sql_reader;

CREATE USER IF NOT EXISTS `you@example.com`
  IDENTIFIED WITH http SERVER 'ch_jwt_verify' SCHEME 'BASIC';
GRANT sql_reader TO `you@example.com`;
```

> **Gotcha — a same-named password user shadows the http one.** If
> `you@example.com` already exists with `sha256_password`, the password identity
> wins and the JWT is never checked. Drop it first
> (`DROP USER IF EXISTS \`you@example.com\``) and recreate `IDENTIFIED WITH http
> …`. Confirm with `SELECT auth_type FROM system.users WHERE name = '…'` →
> should read `['http']`. DDL needs an admin user (a read-only `default` can't).

## 4. config.json + IdP

- `config.json`: `issuer`, `client_id`, and `ch_auth: "basic"` (above).
- Register the redirect URI `https://<ch-host>/sql` with your IdP.
- Ensure the JWT actually carries the `email` claim (scopes / a mapper), since
  it is both the Basic username and what the verifier matches.

## 5. Verify

```bash
# username = email, password = the JWT
curl -s -u "you@example.com:$JWT" 'https://<ch-host>/?query=SELECT%20currentUser()'
# → you@example.com
```

If it fails: confirm the user exists with `auth_type = ['http']`; the verifier is
reachable from CH and returns 200 for a good token; the Basic username equals the
token's `email`; and the role is granted.

## When to use this vs. the Antalya path

| | OSS + ch-jwt-verify (this doc) | Antalya `<token_processors>` |
|---|---|---|
| ClickHouse build | any (stock/OSS) | Antalya |
| Browser config | `ch_auth: "basic"` | default (`bearer`) |
| On the wire | `Basic base64(email:jwt)` | `Bearer jwt` |
| Users | pre-created per user | auto-created by `<token>` directory |
| Extra service | yes (ch-jwt-verify) | no |
