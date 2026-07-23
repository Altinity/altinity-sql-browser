# Authentication and authorization

## Independent sessions

ClickHouse and Google authorization are independent:

```text
ClickHouse identity → execute query and access binding
Google identity     → edit destination spreadsheet
```

A Google Sheet collaborator does not automatically receive ClickHouse access. A ClickHouse user does not automatically receive permission to edit the spreadsheet.

## ClickHouse authentication

The refresh deep link opens the normal SQL Browser SPA. If the ClickHouse session is absent or expired, the existing authentication flow runs. The pending refresh intent must survive the redirect through the URL fragment or tab-scoped session state.

After authentication, the SPA resolves the binding and executes the pinned query using the current user’s ClickHouse credentials. Binding visibility and query access are enforced by ClickHouse grants and row policies.

## Google authentication

Use the Google Identity Services browser token model. The user explicitly invokes a Continue with Google action, receives a short-lived access token in JavaScript, and the SPA calls Google APIs directly.

Rules:

- keep Google access tokens in browser memory only;
- never put tokens in URLs, logs, IndexedDB, workspace exports, or spreadsheet metadata;
- request the narrowest scopes that support Picker and editing files selected or created by the application;
- handle popup blocking and multiple signed-in Google accounts explicitly;
- request a new token after expiry through a user gesture;
- do not store a Google refresh token;
- do not use service accounts or impersonation in this project.

## Account mismatch

Before modification, show the active Google account and target spreadsheet identity. When the selected Google account lacks edit access, report the account and permission problem without changing the spreadsheet.

## Secrets and sensitive parameters

Spreadsheet developer metadata and hidden worksheets are not secret stores. Never write:

- ClickHouse credentials or JWTs;
- Google tokens;
- complete private SQL unless the design explicitly exposes it;
- password-like parameter values;
- secrets embedded in query parameters.

Sensitive parameters must use prompt-on-refresh mode. Stored non-sensitive parameters remain part of the versioned binding and are validated as typed ClickHouse parameters before execution.
