# Product scope

## Goal

Provide a browser-only Google Sheets integration for saved ClickHouse queries while preserving ClickHouse as the data authorization boundary.

## User workflows

### Snapshot export

Run a saved query and copy its current result into a new or existing spreadsheet. No refresh binding or synchronization state is created.

### Linked spreadsheet

Create a durable binding between a pinned saved-query snapshot and a spreadsheet. A linked spreadsheet supports manual full refresh and, when eligible, append refresh.

### Manual refresh

A hyperlink in the control worksheet opens the ClickHouse-hosted SQL Browser SPA with an opaque binding identifier in the URL fragment. Google never calls SQL Browser. The user authenticates to ClickHouse and Google in the browser, then the SPA performs the refresh.

## Ownership boundary

SQL Browser owns:

- saved-query snapshot and query hash;
- typed parameter policy and values;
- source validation and execution;
- ClickHouse-to-Sheets type conversion;
- managed data worksheet;
- control and hidden state worksheets;
- staging worksheets;
- refresh status, history, and checkpoints.

Google Sheets owns:

- formulas outside managed worksheets;
- native pivots and charts;
- comments and collaboration;
- sharing and file organization;
- user-created presentation and analysis worksheets.

## Refresh modes

### Full refresh

Replaces all managed data only after query execution and staging upload succeed. It is supported on all compatible ClickHouse versions.

### Append refresh

Appends immutable inserted rows using a ClickHouse commit-order checkpoint. It is available only for validated ClickHouse 26.8+ MergeTree-family sources with persistent `_block_number` and `_block_offset` support.

Append refresh does not reflect updates or deletes. When those semantics are needed, the user runs a full refresh.

## Non-goals

- automatic scheduling;
- background refresh while the SPA is closed;
- inbound callbacks or webhooks to SQL Browser;
- `SELECT ... STREAM`;
- updates, deletes, or generic upsert synchronization;
- arbitrary query rewriting for append eligibility;
- Google Docs;
- Apps Script, add-ons, or an app-specific backend;
- sharing ClickHouse credentials through Google;
- strict collaborative refresh serialization.
