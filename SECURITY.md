# Security Policy

The Altinity® SQL Browser is a single self-contained HTML file (no application
backend) served from a ClickHouse® cluster's `user_files/` by an
`<http_handlers>` static rule. It talks only to that ClickHouse server and your
OAuth IdP, and makes zero third-party requests. The notes below describe how to
report a vulnerability and the threat model you should deploy against.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**

Report privately, either way:

- **GitHub private advisory** (preferred): on this repository, go to
  **Security → Advisories → Report a vulnerability**. This opens a private
  thread with the maintainers.
- **Email**: `security@altinity.com`. Please include "altinity-sql-browser" in
  the subject and enough detail to reproduce (affected version/commit — see the
  build stamp in the user menu, deploy shape, and steps).

We aim to acknowledge a report within a few business days and to keep you
updated as we triage and fix. Please give us a reasonable window to ship a fix
before any public disclosure; we're happy to credit reporters who want it.

## Threat model

### `config.json` is public — treat it that way

The app loads its OAuth configuration from `config.json` (served as
`/sql/config.json`), which is **delivered to the browser**. Anything in it is
readable by any user who can reach the page. Never put a value in `config.json`
that you would not publish.

- **Prefer a PKCE public client (no secret).** Register a "SPA / public /
  native" client; the PKCE `code_verifier` authenticates the token exchange, so
  no `client_secret` is needed and `config.json` stays secret-free. This is the
  recommended shape and what the supported `deploy/install.sh` renders — it
  **never writes a `client_secret`**, so a standard install is secret-free by
  construction.
- **If your IdP requires a `client_secret`** on the in-browser token exchange
  (e.g. a Google "Web application" client), the code accepts it in
  `config.json`, but because the file ships to browsers you **must** treat it as
  public: **lock the redirect URI to exactly `https://<host>/sql`** with the IdP
  and use a suitably scoped consent screen, so a leaked secret can't be replayed
  to a different redirect. A secret only enters `config.json` through a
  hand-authored config (e.g. an inline `<http_handlers>` rule) — apply this rule
  wherever you do that.
- **Or front the app with a broker.** An OIDC broker / auth proxy holds the
  provider secret and exposes a public PKCE client; the browser talks only to
  the broker and `config.json` carries no secret.

This mirrors the project's contributor rule (`CLAUDE.md` hard rule 3) and the
README's "Configuring OAuth" section.

### Token handling

OAuth tokens (id / access / refresh) and the PKCE `state`/`verifier` used during
the redirect round-trip are kept in **`sessionStorage`**: scoped to the browser
tab and cleared when the tab closes. Tokens are **never** written to
`localStorage` or cookies. There is no server-side session.

### Browser-hardening baseline (CSP and headers)

`deploy/http_handlers.xml` serves the SPA with a strict
**Content-Security-Policy** plus `X-Content-Type-Options: nosniff` and
`Referrer-Policy: no-referrer`. The CSP is `default-src 'none'` with everything
re-allowed explicitly; the load-bearing directive is:

- **`connect-src 'self' <issuer-origins>`** — bounds where the page may send
  data, so an injected script cannot exfiltrate the `sessionStorage` tokens to
  an attacker-controlled host. `'self'` covers ClickHouse queries +
  `config.json`; the issuer origins cover OIDC discovery and the token endpoint.
  `deploy/install.sh` fills this list automatically from your issuer's OIDC
  discovery document (for a manual non-Google install, edit the `connect-src`
  line in `deploy/http_handlers.xml`).
- `frame-ancestors 'none'` (anti-clickjacking), `base-uri 'none'`, `img-src
  data:`, and a `sandbox=""` (script-less, inert) `srcdoc` iframe for the
  result cell-detail HTML preview.

If you deploy the SPA without this handler, you lose these protections —
**ship the provided CSP/headers** (or equivalents).

## Operator responsibilities (out of scope here)

The SPA is a client. The following are configured and secured by whoever
deploys it, not by this project:

- **ClickHouse access control** — what a signed-in user can read/run is governed
  by ClickHouse RBAC / grants and the `<token_processor>` JWT validation, not by
  the browser. The UI cannot grant access the server doesn't already allow.
- **IdP configuration** — client type, redirect-URI allowlist, consent scopes.
- **TLS termination** — always serve the page and the ClickHouse endpoint over
  HTTPS.
