# Configuring ClickHouse® (Antalya) to accept OAuth JWTs

The SQL browser authenticates each user with your OAuth/OIDC provider in the
browser, then sends the resulting JWT to ClickHouse on **every query**:

```
POST /  Authorization: Bearer <jwt>
```

For ClickHouse to accept that, it must (1) validate the JWT and (2) map it to a
ClickHouse user with some roles. The **Altinity® Antalya** build does this
natively with a `<token_processors>` entry plus a `<token>` user-directory — no
sidecar, no shared service account; every query runs as the real user.

> **Build requirement.** Native JWT auth (`<token_processors>` / `<token>` user
> directory) is an Antalya-build feature. Stock/OSS ClickHouse returns
> `Code: 516. 'Bearer' HTTP Authorization scheme is not supported`. On those
> builds use a delegated verifier instead — see [DEPLOYMENT.md](DEPLOYMENT.md)
> ("Make ClickHouse accept the JWT").

All XML below goes into the server config (a `config.d/*.xml` fragment) and the
SQL into a one-time DDL session. Replace every `*.example.com`, audience, claim
name, and role with your own.

---

## 1. Validate the JWT — `<token_processors>`

A token processor tells ClickHouse how to verify a bearer token's signature and
claims. Two common shapes:

### A. OIDC discovery (recommended for Auth0 / Keycloak / Okta / Entra / Google)

ClickHouse reads the issuer's `.well-known/openid-configuration` to find the
JWKS and validates signature, `iss`, `exp`, and (optionally) `aud`.

```xml
<clickhouse>
  <token_processors>
    <my_oidc>
      <type>openid</type>
      <configuration_endpoint>https://issuer.example.com/.well-known/openid-configuration</configuration_endpoint>
      <!-- Optional but recommended: reject tokens not minted for your API.
           Must byte-equal the `audience` the SQL browser requests. Omit to
           accept any audience from this issuer. -->
      <expected_audience>https://api.example.com/</expected_audience>
      <!-- JWT claim used as the ClickHouse username (see §4). -->
      <username_claim>email</username_claim>
      <!-- Optional: JWT claim (array of strings) mapped to ClickHouse roles. -->
      <groups_claim>roles</groups_claim>
      <token_cache_lifetime>60</token_cache_lifetime>
    </my_oidc>
  </token_processors>
</clickhouse>
```

### B. Explicit JWKS (self-managed Altinity 26.3+)

When you'd rather point at a JWKS URL directly (e.g. Google, or a self-managed
IdP) instead of OIDC discovery. Self-managed Altinity 26.3 supports
`jwt_dynamic_jwks` natively:

```xml
<clickhouse>
  <token_processors>
    <my_jwks>
      <type>jwt_dynamic_jwks</type>
      <jwks_uri>https://issuer.example.com/.well-known/jwks.json</jwks_uri>
      <expected_issuer>https://issuer.example.com/</expected_issuer>
      <!-- For id_tokens this is the OAuth client_id; for API access tokens it's
           the API audience. Must match the token's `aud`. -->
      <expected_audience>YOUR_CLIENT_ID</expected_audience>
      <username_claim>email</username_claim>
      <!-- Suppresses the "expected_typ is not configured" startup warning and
           pins the token type (RFC 8725): `JWT` for OIDC id_tokens,
           `at+jwt` for OAuth 2.0 access tokens. -->
      <expected_typ>JWT</expected_typ>
      <token_cache_lifetime>60</token_cache_lifetime>
      <!-- Some Antalya builds' strict parser also requires a userinfo /
           introspection endpoint to be present even when validation is
           JWKS-only; add them if startup complains: -->
      <!-- <userinfo_endpoint>https://issuer.example.com/userinfo</userinfo_endpoint> -->
      <!-- <token_introspection_endpoint>https://issuer.example.com/userinfo</token_introspection_endpoint> -->
    </my_jwks>
  </token_processors>
</clickhouse>
```

> **`expected_typ`** — the Altinity build logs `TokenAuthentication: expected_typ
> is not configured` at WARNING on every startup until you set it. Use `JWT` for
> id_tokens (the default `bearer` path) or `at+jwt` for access tokens; this also
> follows RFC 8725. It can be added to the OIDC-discovery processor (§A) too.

---

## 2. Auto-create users — the `<token>` user directory

The `<token>` directory creates an ephemeral ClickHouse user on the first valid
token, named from `username_claim`, and assigns roles. Reference the processor
from §1.

```xml
<clickhouse>
  <user_directories>
    <users_xml><path>/etc/clickhouse-server/users.xml</path></users_xml>
    <!-- ...any existing directories (e.g. <replicated/>) stay above... -->

    <!-- The <token> directive MUST be the LAST child of <user_directories>.
         On Antalya builds a basic-auth login that reaches the token storage
         first throws LOGICAL_ERROR "Bad cast from BasicCredentials to
         TokenCredentials" and locks out password users. With <token> last,
         password logins resolve in users_xml/replicated first and JWTs fall
         through cleanly. -->
    <token>
      <processor>my_oidc</processor>
      <!-- Pick ONE role-assignment strategy: -->

      <!-- (a) every authenticated user gets these fixed roles: -->
      <common_roles>
        <role>sql_reader</role>
      </common_roles>

      <!-- (b) OR map roles from the JWT's groups_claim, restricted to an
           allow-list (regex over role names). Requires groups_claim in §1. -->
      <!-- <roles_filter>^(sql_reader|sql_writer)$</roles_filter> -->
    </token>
  </user_directories>
</clickhouse>
```

---

## 3. Roles and grants

The roles referenced above must exist and carry the privileges you want. Create
them once (use `ON CLUSTER '<cluster>'` on a multi-node cluster):

```sql
CREATE ROLE IF NOT EXISTS sql_reader;
GRANT SELECT ON *.* TO sql_reader;
-- system tables power the schema browser:
GRANT SELECT ON system.tables TO sql_reader;
GRANT SELECT ON system.columns TO sql_reader;

-- optional writer role for `roles_filter` setups:
CREATE ROLE IF NOT EXISTS sql_writer;
GRANT SELECT, INSERT, ALTER, CREATE, DROP ON *.* TO sql_writer;
```

With `roles_filter`, the JWT's `groups_claim` array decides which of these a user
gets; with `common_roles`, everyone gets the fixed set.

---

## 4. Claims: username and roles

- **`username_claim`** — the JWT claim used as `currentUser()`. Standard OIDC
  providers expose `email` (enable the `email`/`profile` scopes and "email in
  token" if your IdP gates it). Some setups inject a **namespaced** custom claim
  (e.g. `https://your-domain/email`); use whatever your tokens actually carry.
  Decode a sample token at jwt.io to confirm the claim name.
- **`groups_claim`** — a JWT claim holding an array of role names. Most IdPs need
  a rule/action/mapper to add it (e.g. Auth0 post-login Action, Keycloak group
  mapper). The values must match ClickHouse role names (then filtered by
  `roles_filter`).

---

## 5. id_token vs access_token — match the SQL browser config

This is the most common point of confusion. The token the browser sends must be
the one your `<token_processors>` validates:

| CH config | Token to send | SQL browser `config.json` |
|---|---|---|
| **no** `expected_audience` | the **id_token** is fine (its `aud` is the client_id; CH doesn't check) | `"bearer": "id_token"` (default) |
| `expected_audience` set | the **access_token** (its `aud` is your API audience) | `"bearer": "access_token"` + `"audience": "https://api.example.com/"` |

Google is a special case: its access tokens are opaque (not JWTs), so a
Google-validating processor must use the **id_token** and therefore must **not**
enforce `expected_audience`.

So: if you set `expected_audience` in §1, set `bearer: access_token` and the
matching `audience` in the browser's `config.json`; otherwise leave both at their
defaults. See [LOGIN-SCREEN.md](LOGIN-SCREEN.md).

---

## 6. Apply and verify

1. Drop the `config.d/*.xml` fragments onto every node (your config-management
   channel) and reload/restart ClickHouse.
2. Apply the role DDL once.
3. Register the browser's redirect URI (`https://<ch-host>/sql`) with your IdP.
4. Smoke-test with a real token:

```bash
curl -s 'https://<ch-host>/?query=SELECT%20currentUser()' \
  -H "Authorization: Bearer $JWT"
# → your username_claim value (e.g. you@example.com), not `default`
```

If it returns `default` or 516/AUTHENTICATION_FAILED, check (in order): the
build supports `<token_processors>`; `<token>` is last in `<user_directories>`;
`expected_audience` matches the token's `aud`; `username_claim` matches a real
claim; the mapped role exists and is granted.

---

## Minimal end-to-end example

`config.d/oauth.xml`:

```xml
<clickhouse>
  <token_processors>
    <my_oidc>
      <type>openid</type>
      <configuration_endpoint>https://issuer.example.com/.well-known/openid-configuration</configuration_endpoint>
      <username_claim>email</username_claim>
    </my_oidc>
  </token_processors>
  <user_directories>
    <users_xml><path>/etc/clickhouse-server/users.xml</path></users_xml>
    <token>
      <processor>my_oidc</processor>
      <common_roles><role>sql_reader</role></common_roles>
    </token>
  </user_directories>
</clickhouse>
```

DDL:

```sql
CREATE ROLE IF NOT EXISTS sql_reader;
GRANT SELECT ON *.* TO sql_reader;
```

Browser `config.json` (no audience enforced → default id_token):

```json
{ "issuer": "https://issuer.example.com", "client_id": "<client-id>" }
```
