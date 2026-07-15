# Dashboard Setup role: shared-session setup wave and role-aware drawer integration

## Goal

Implement the `setup` Dashboard role on top of the role-aware result selector and Dashboard role partition introduced by #160.

A favorited Setup query runs hidden preparation statements before Filter queries and displayed Panels.

Persisted Spec:

```json
{
  "favorite": true,
  "dashboard": {
    "role": "setup"
  }
}
```

A Setup query:

- creates no Dashboard tile;
- runs before Filter queries and Panels;
- may create temporary tables and set session settings;
- shares one ClickHouse HTTP session with all later queries in the same Dashboard wave;
- executes sequentially because ClickHouse permits only one active query per session;
- exposes status and errors without pretending to be a Panel;
- preserves dormant Panel configuration.

This issue adds `Setup` to the selector foundation shipped by #160.

---

## Dependencies

Required:

1. #160 — role-aware result selector, role partition, Filter execution, and Dashboard wave foundation;
2. #165 — optional SQL blocks and explicit activation;
3. #173 — shared parameter analysis/preparation with `bindPolicy: "all"`;
4. #166 — Panel registry and workbench/Dashboard shared renderers;
5. #211 — saved-query v2 model;
6. #212 — SQL and Spec editors with atomic Save;
7. #220 / PR #222 — canonical Presentation Spec schema and validation service;
8. #221 — schema-driven Spec completion.

---

## Persisted model

Setup is a Dashboard execution role:

```js
query.spec.dashboard.role === "setup"
```

It is not a Panel type.

Do not add `setup` to:

```text
panel.cfg.type
PANEL_TYPE_IDS
PANEL_PICKER_OPTIONS
PANEL_TYPES
autoPanel()
resolvePanel()
isQuerylessPanel()
```

A Setup query may retain a complete dormant `spec.panel` object.

Switching to Setup changes only `spec.dashboard.role`.

Switching from Setup to a Panel choice changes the effective role to Panel and restores or updates the preserved Panel configuration through the existing `switchPanelType()` behavior.

No `specVersion` change is required.

Unknown `dashboard` fields remain preserved.

---

## Canonical schema

The canonical `dashboard.role` enum already includes:

```json
["panel", "filter", "setup"]
```

Update the `setup` completion information to document:

- automatic Dashboard execution occurs before Filter and Panel queries;
- the query creates no tile;
- statements run sequentially in a shared session;
- only the supported safe statement classes are accepted automatically;
- parameters use the shared Dashboard filter state.

Do not add a Setup branch to `panelCfg`.

---

## Drawer selector

Extend the role-choice list created by #160:

```text
Panel
  KPI
  Column
  Horizontal bar
  Line
  Area
  Pie
  Logs
  Text

Dashboard role
  Filter
  Setup
```

Normal Setup query header:

```text
[ Table ] [ JSON ] [ Setup ▾ ]
```

The closed control uses:

```text
Setup
```

Do not display `Setup source` in the drawer header.

### Selecting Setup

Selecting `Setup`:

1. patches only `spec.dashboard.role = "setup"`;
2. preserves all unknown `dashboard` siblings;
3. preserves the complete `spec.panel` object;
4. activates the transient `setup` drawer view;
5. marks the Spec draft dirty;
6. runs normal validation;
7. does not execute SQL;
8. does not modify `spec.view`.

### Selecting a Panel choice from Setup

Selecting any Panel choice:

1. patches the effective role to `panel`;
2. preserves unknown `dashboard` siblings;
3. uses `switchPanelType()` for the selected visualization;
4. activates the `panel` drawer view;
5. preserves existing Panel continuity and chart-role stash behavior.

### Table and JSON

Table and JSON:

- inspect the last explicit workbench result;
- do not change the Setup role;
- do not execute SQL.

### Transient view

Extend result-view state with:

```text
setup
```

`setup` is not persisted into `spec.view`.

Retain it across explicit reruns during the current tab lifetime. Restore the normal persisted view when the tab is recreated.

---

## Workbench Setup view

The Setup view is an authoring and last-run status surface. It never runs the Dashboard setup wave.

### Static execution plan

Before any Run, show the parsed Setup plan:

```text
Setup

1  SET max_threads = 4
   Allowed · session setting

2  CREATE TEMPORARY TABLE daily AS SELECT …
   Allowed · temporary table

3  SELECT count() FROM daily
   Allowed · output discarded on Dashboard
```

For each statement show:

- statement number;
- compact SQL preview;
- classified kind;
- allowed or blocked state;
- declared parameters;
- optional parameters;
- blocking diagnostic.

The plan is produced by the same pure classifier used by Dashboard automatic execution.

### No explicit Run result

Show:

```text
Run the query to test this script in the workbench.
Dashboard execution uses a fresh serialized session.
```

### Running

Show current explicit workbench status without simulating Dashboard execution.

### Completed explicit Run

Reuse the workbench’s existing per-statement result/status data.

Show:

- statement status;
- elapsed time;
- error;
- first-row preview or result link where the existing script result provides it.

The ordinary workbench Run path remains unchanged:

- it is an explicit development/debug action;
- it is not forced through Dashboard `readonly=2`;
- it does not create or replace the Dashboard session;
- it does not trigger Filter queries or Panels.

### Single row-returning statement

Table and JSON remain available for the explicit result.

Setup view shows its classified Dashboard behavior and last-run status.

### Multi-statement script

The Setup view becomes the primary role-specific representation. Reuse the existing script-grid data rather than creating a second result model.

The drawer toolbar may show:

```text
[ Setup ▾ ]    Script · 3 statements
```

when Table/JSON are not meaningful for the script result.

The role selector remains available even in the script-result toolbar.

---

## Library and workbench labels

Use compact UI labels:

```text
[Setup]
```

Library row:

```text
★ Build daily temporary data    [Setup]
```

Workbench title badge:

```text
Setup
```

Clicking either badge:

1. activates the query tab;
2. switches to Spec mode;
3. navigates to `dashboard.role`.

Do not display `Setup source` in the drawer header.

---

## Dashboard partition

Partition the favorited Library snapshot before execution:

1. effective role `setup` → Setup scheduler, no grid slot;
2. effective role `filter` → Filter scheduler from #160, no grid slot;
3. effective role `panel` → displayed Panel;
4. unknown role → excluded with a diagnostic.

Setup and Filter queries:

- create no grid slots;
- are excluded from “N not shown” counts;
- remain absent when not favorited.

---

## Shared-session rule

When at least one favorited Setup query exists, the complete Dashboard wave uses one fresh named HTTP session.

Wave order:

```text
Setup queries in Library order
→ Filter queries in Library order
→ Filter reconciliation
→ Panel queries in Library order
```

Only one request may be active in the session at a time.

Do not run Filter queries or Panels concurrently in Setup mode.

When no Setup query exists, retain #160’s normal behavior:

- Filter queries may use the bounded concurrency limiter;
- Panels may use the bounded concurrency limiter;
- no named session is required.

This conditional preserves performance for normal dashboards.

---

## Session identity and lifetime

Generate a cryptographically random session ID for each fresh setup wave.

Suggested shape:

```text
asb-dashboard-<random UUID>
```

Send on every request in the wave:

```text
session_id
session_timeout
```

Suggested timeout:

```js
DASHBOARD_SESSION_TIMEOUT_SECONDS = 600
```

The timeout must respect the server’s configured maximum. A server rejection is surfaced as a setup/session error.

Maintain Dashboard session state:

```js
{
  id,
  generation,
  createdAt,
  status,
  setupFingerprint,
  abortController
}
```

The session is abandoned by forgetting its ID. No explicit DROP cleanup is required.

A new fresh session is required for:

- Dashboard open;
- Dashboard Refresh;
- any committed parameter change affecting a Setup query;
- one recovery attempt after a session-expiry or missing-temporary-table failure.

---

## Setup SQL contract

A Setup saved query may contain one or more SQL statements.

Split with the canonical statement splitter.

Execute statements sequentially.

Use the parameter pipeline with:

```js
bindPolicy: "all"
```

Use one prepared batch and one `wallNowMs` for the complete fresh wave.

### Allowed automatic statements

V1 accepts only:

#### SET

```sql
SET max_threads = 4
```

Requirements:

- one normal SET statement;
- no attempt to change `readonly`;
- server setting constraints remain authoritative.

#### CREATE TEMPORARY TABLE AS SELECT

```sql
CREATE TEMPORARY TABLE daily AS
SELECT ...
```

Accepted syntax includes an optional:

```text
IF NOT EXISTS
```

The statement must:

- explicitly contain `TEMPORARY`;
- create an unqualified temporary table name;
- contain an `AS SELECT` row-returning source;
- not use `ON CLUSTER`;
- not use a permanent database-qualified target;
- not include an authored top-level output FORMAT.

`CREATE OR REPLACE` is not supported in v1. Every recomputation uses a fresh session, so replacement is unnecessary.

#### Row-returning read statement

Examples:

```sql
SELECT ...
SHOW ...
DESCRIBE ...
EXPLAIN ...
```

The result is discarded during automatic Dashboard execution.

Use this for cache warming, validation reads, or session-local checks.

### Rejected statements

Reject client-side before any setup request:

```text
permanent CREATE
CREATE TABLE without TEMPORARY
CREATE OR REPLACE
DROP
ALTER
RENAME
ATTACH
DETACH
TRUNCATE
INSERT
OPTIMIZE
SYSTEM
KILL
GRANT
REVOKE
CREATE USER/ROLE/ROW POLICY/SETTINGS PROFILE/QUOTA
mutations
USE
```

Reject any unclassified statement.

A blocked statement invalidates the complete Setup query.

Do not weaken the allowlist based on server permissions.

---

## Pure Setup classifier

Add:

```text
src/core/setup-plan.js
```

Suggested API:

```js
analyzeSetupSql({
  sql,
  parameterAnalysis
}) -> {
  statements: [
    {
      index,
      sql,
      kind: "set" | "create-temporary-as-select" | "read",
      allowed,
      params,
      optionalParams,
      diagnostics
    }
  ],
  diagnostics,
  valid
}
```

The classifier must use lexical/statement utilities rather than broad regular expressions over raw SQL.

It must correctly ignore keywords inside:

- strings;
- quoted identifiers;
- comments;
- nested SELECT expressions.

It must be:

- pure;
- DOM-free;
- network-free;
- non-mutating;
- covered at 100% per-file.

---

## Parameters

Setup SQL participates in shared Dashboard parameter analysis.

Supported:

- required parameters;
- optional-block parameters;
- typed validation;
- relative-time values;
- activation state;
- persisted values;
- typed serialization;
- exact large integers and arrays supported by the pipeline.

Preparation uses:

```js
bindPolicy: "all"
```

This is required because Setup includes non-row-returning statements.

A missing, invalid, or serialization-failed parameter blocks the fresh wave before the first network request.

### Filter dependency prohibition

A Setup query may not declare a parameter that is curated by a Filter helper from #160.

Reason:

1. Setup must run before Filter queries;
2. Filter reconciliation has not yet validated the selected value;
3. Setup cannot safely consume an option-backed value before its provider runs.

Detect this after Filter helper names are known from the last successful configuration snapshot or after static/provider planning where available.

For a fresh Dashboard open with no provider result yet:

- use the configured Filter query’s last known helper metadata when available;
- otherwise run Filter queries only after Setup as required and treat an overlapping target discovered afterward as a configuration error;
- abort before Panels;
- surface the cycle;
- require the author to remove the dependency.

Persist a lightweight derived helper-name cache only if #160 already provides one for diagnostics. Do not persist option values or option lists.

Diagnostic:

```text
setup-filter-dependency
```

The message names:

- Setup query;
- Filter query;
- parameter.

---

## Automatic statement execution

Add:

```text
src/core/setup-execution.js
```

Suggested API:

```js
setupStatementExecution(statement, defaults = {}) -> {
  owned,
  command,
  format?,
  params,
  error
}
```

### SET and CREATE TEMPORARY

Use a command request path:

- `readonly = 2`;
- same `session_id`;
- same `session_timeout`;
- no result-row parser;
- structured HTTP error handling;
- cancellation;
- timing.

Do not append `FORMAT Null` to command statements.

### Read statements

Use a null-output request:

- `readonly = 2`;
- same session;
- no client row accumulation;
- server-side `FORMAT Null` or equivalent owned format;
- reject authored top-level FORMAT rather than rewriting it;
- retain progress and error handling;
- cancellation.

### Safety settings

Every automatic Setup request includes:

```text
readonly = 2
```

Do not send `allow_ddl = 1` as a query override.

The connected ClickHouse user and server constraints remain authoritative.

---

## Network session seam

Extend the shared HTTP request options:

```js
{
  sessionId,
  sessionTimeout,
  signal
}
```

`chUrl()` maps these to:

```text
session_id
session_timeout
```

Add a command execution seam that:

- uses POST;
- supports typed `param_<name>` values;
- returns elapsed/progress/error metadata;
- does not buffer result rows;
- supports abort;
- uses the same authentication and token-refresh behavior as normal reads.

Filter and Panel execution functions accept optional session fields and pass them unchanged.

No request may omit the active session ID during a Setup wave.

---

## Dashboard wave planner

Add pure planning in:

```text
src/core/dashboard-wave.js
```

Suggested result:

```js
planDashboardWave({
  queries,
  parameterAnalysis,
  filterProviders,
  hasSetup,
  changedParameter?
}) -> {
  mode: "parallel" | "session",
  setupSources,
  filterSources,
  panelSources,
  fullRerun,
  diagnostics
}
```

Rules:

### No Setup

Use existing #160 parallel behavior.

### Fresh Setup wave

Run:

1. all Setup statements in source/statement order;
2. all Filter queries in source order;
3. merge and reconcile Filter helpers;
4. all Panels in source order.

Stop at the first Setup failure.

A Filter failure uses ordinary fallback controls and does not block Panels.

### Parameter change affecting Setup

Start a fresh session and rerun the complete wave.

Conservative v1 rule:

- all Setup queries rerun;
- all Filter queries rerun;
- all Panels rerun.

### Parameter change not affecting Setup

Reuse the current session.

Run only affected Panels, sequentially in the session.

Do not rerun Setup or Filter queries.

### Dashboard Refresh

Start a fresh session and rerun the complete wave.

---

## Setup fingerprint

Compute a pure fingerprint from:

- ordered Setup query IDs;
- Setup SQL text;
- Setup Spec role-relevant data;
- bound parameter snapshots for parameters used by Setup;
- optional-block activation state;
- server/connection identity where already available.

Use the fingerprint to determine whether current session setup state matches the requested wave.

Do not include unrelated Panel-only filter values.

Do not use the fingerprint as a security boundary.

---

## Request scheduling and cancellation

Setup mode uses one serialized request queue.

State:

```text
waveGeneration
current AbortController
session ID
phase
source index
statement index
```

Rules:

- a new full wave reserves a generation immediately;
- abort the current request;
- queued old work checks generation before issuing;
- stale responses never update UI;
- Dashboard close aborts the current request and discards the session;
- a non-Setup affected rerun is queued after the current session request;
- never allow two in-flight requests with the same session ID.

---

## Error behavior

### Setup validation failure

Before network:

- show Setup configuration error;
- do not run any Setup, Filter, or Panel request;
- render Panel slots as blocked.

### Setup execution failure

On first failure:

- stop the current statement;
- skip remaining Setup statements and queries;
- do not run Filter queries;
- do not run Panels;
- preserve the failed statement and ClickHouse message;
- keep the session abandoned.

### Dashboard UI

Header indicator:

```text
Setup · 2 · 340 ms
```

States:

```text
Setup · running
Setup · ready
Setup · failed
```

Expanding shows:

- Setup query name;
- statement number;
- kind;
- status;
- elapsed time;
- error.

Failure banner:

```text
Setup failed
Build daily temporary data · statement 2
<ClickHouse error>
```

Every blocked Panel slot shows:

```text
Setup failed
```

Filter controls remain visible but do not trigger Panel execution until a successful fresh wave.

---

## Session recovery

Recognize only narrow session-state failures:

- session expired or not found;
- unknown temporary table referenced by a Filter or Panel query while Setup mode is active.

On the first recognized failure in a wave:

1. abandon the current session;
2. create a fresh session;
3. rerun the complete Setup → Filter → Panel wave once.

On a second failure:

- stop;
- surface the original phase/source error;
- do not retry again.

Do not retry:

- syntax errors;
- permission errors;
- parameter errors;
- arbitrary unknown-table errors when the table is not known to be created by a Setup statement;
- aborted requests.

Track temporary table names produced by the Setup plan so recovery classification is precise.

---

## Workbench and Dashboard separation

Workbench explicit Run and Dashboard automatic Setup execution are independent.

Workbench:

- develops and debugs the SQL;
- keeps existing multi-statement results;
- may use existing workbench session behavior;
- does not modify Dashboard session state.

Dashboard:

- uses the strict allowlist;
- uses `readonly=2`;
- creates a fresh named session when required;
- discards automatic read output;
- serializes the complete wave.

Selecting Setup in the drawer changes Spec only.

---

## Diagnostics

Stable codes:

```text
setup-sql-empty
setup-statement-unsupported
setup-create-not-temporary
setup-create-not-as-select
setup-create-qualified-target
setup-create-on-cluster
setup-create-or-replace
setup-owned-format
setup-readonly-change
setup-parameter-missing
setup-parameter-invalid
setup-parameter-serialization
setup-filter-dependency

setup-session-create
setup-session-timeout
setup-query-failed
setup-session-expired
setup-temporary-table-missing
setup-recovery-failed
```

Diagnostic shape:

```js
{
  severity,
  code,
  message,
  sourceId?,
  statementIndex?,
  parameterName?,
  path?
}
```

Static Setup plan errors may block Save.

Runtime and cross-Dashboard errors appear in Setup view and Dashboard status.

Only real errors appear in the bottom error area.

---

## Files

Add:

```text
src/core/setup-plan.js
src/core/setup-execution.js
src/core/dashboard-wave.js
src/core/dashboard-session.js

src/ui/setup-view.js
src/ui/setup-status.js
```

Modify:

```text
schemas/query-spec-v1.schema.json
src/generated/json-schemas.js
src/generated/json-schema-validators.js

src/core/result-choice.js
src/core/saved-query.js
src/core/dashboard.js
src/core/param-pipeline.js

src/ui/panels.js
src/ui/results.js
src/ui/dashboard.js
src/ui/saved-history.js
src/ui/app.js

src/net/ch-client.js
src/state.js
src/styles.css

README.md
CHANGELOG.md
docs/saved-query-spec-json-schema.md
docs/visualization-spec-authoring-guide.md
```

Add corresponding unit, integration, live compatibility, and E2E tests.

No new runtime dependency.

---

## Implementation order

### 1. Selector and labels

- append Setup role choice;
- add transient Setup view;
- retain selector in script-result toolbar;
- add compact badges;
- preserve Panel config through role changes.

### 2. Setup plan and validation

- implement pure statement classifier;
- implement allowlist;
- integrate `bindPolicy: "all"`;
- add static diagnostics;
- render workbench Setup plan.

### 3. Session-aware network seam

- add session URL options;
- add command/null-output execution;
- thread session through Filter and Panel paths;
- add cancellation and metadata.

### 4. Dashboard wave

- add session-mode planner;
- serialize Setup, Filter, reconciliation, and Panels;
- retain parallel mode without Setup;
- implement fresh-session triggers and fingerprints.

### 5. Status and errors

- add header status;
- add expanded details;
- add banner and blocked slots;
- implement one recovery attempt.

### 6. Documentation and compatibility

- document safe SQL subset;
- document serialized performance behavior;
- run supported-server compatibility tests;
- update README and changelog.

---

## Tests

### Selector

- Setup option appears after #160 Filter option;
- closed selector label is `Setup`;
- selecting Setup patches only role;
- dormant Panel config survives;
- selecting a Panel type restores Panel role;
- Table/JSON do not change role;
- Setup view is not persisted to `spec.view`;
- Setup never enters panel registries;
- selector remains available for script results.

### Classifier

- SET allowed;
- SET readonly rejected;
- CREATE TEMPORARY TABLE AS SELECT allowed;
- IF NOT EXISTS allowed;
- CREATE OR REPLACE rejected;
- permanent/qualified CREATE rejected;
- ON CLUSTER rejected;
- read statements allowed;
- writes and administrative statements rejected;
- keywords in strings/comments ignored;
- multi-statement order;
- authored FORMAT rejection;
- 100% per-file coverage.

### Parameters

- `bindPolicy: "all"` binds SET/CREATE/read statements;
- required and optional parameters;
- missing/invalid/serialization blockers;
- one wall clock per wave;
- Filter-provider dependency rejection.

### Workbench Setup view

- static plan before Run;
- blocked statement display;
- no Dashboard execution from view;
- existing explicit script result reused;
- single-result Table/JSON inspection;
- no role selection network call.

### Session seam

- session ID and timeout on every wave request;
- no session fields outside Setup mode;
- command path buffers no rows;
- read path uses Null output;
- `readonly=2` always present;
- abort works;
- auth refresh retains session fields.

### Wave planning

- no Setup keeps parallel mode;
- Setup creates serialized mode;
- source/statement Library order;
- Setup → Filter → reconcile → Panel order;
- first Setup error stops wave;
- Filter failure falls back and Panels continue;
- Setup-affecting parameter starts fresh full wave;
- unrelated parameter reuses session and runs affected Panels only;
- Refresh starts fresh full wave;
- no concurrent request uses one session.

### Status and recovery

- running/ready/failed header;
- expanded statement detail;
- failure banner;
- blocked Panel state;
- session-expiry recovery once;
- known temporary-table missing recovery once;
- unrelated unknown table does not trigger recovery;
- second failure stops.

### Compatibility

On every supported ClickHouse version:

- `readonly=2` accepts SET;
- `readonly=2` accepts CREATE TEMPORARY TABLE AS SELECT;
- HTTP parameters bind in allowed statements;
- named session preserves temporary table visibility;
- concurrent same-session request is never issued;
- session timeout behavior is handled.

### Regression

- #160 Filter behavior without Setup;
- ordinary Dashboard concurrency without Setup;
- KPI and Panel renderers;
- workbench scripts;
- optional blocks;
- parameter pipeline;
- Library import/export;
- schema generation;
- build and audit.

---

## Acceptance criteria

- [ ] Setup is implemented as `spec.dashboard.role = "setup"`.
- [ ] Setup never becomes a panel type or renderer.
- [ ] The drawer selector shows `Setup`, not `Setup source`.
- [ ] Selecting Setup preserves the complete Panel configuration.
- [ ] Selecting a Panel choice restores the Panel role.
- [ ] Setup view shows a static execution plan and last explicit Run status.
- [ ] Selecting Setup never executes SQL.
- [ ] Favorited Setup queries create no Dashboard tiles.
- [ ] Without Setup queries, existing parallel Dashboard behavior is unchanged.
- [ ] With Setup queries, the complete wave uses one named session and is serialized.
- [ ] Setup queries run in Library order and statements run in script order.
- [ ] Filter queries run after Setup and before Panels.
- [ ] Reconciliation completes before Panels.
- [ ] Only the documented statement allowlist runs automatically.
- [ ] Every automatic Setup request uses `readonly=2`.
- [ ] SET and CREATE commands buffer no rows.
- [ ] Automatic read output is discarded.
- [ ] Setup parameters use `bindPolicy: "all"`.
- [ ] Setup dependencies on Filter-provided parameters are rejected.
- [ ] Setup failure blocks Filter and Panel execution.
- [ ] Dashboard exposes compact Setup status and detailed errors.
- [ ] Setup-affecting changes start a fresh full wave.
- [ ] Unrelated changes reuse the active session.
- [ ] Session-state failure receives at most one full recovery attempt.
- [ ] New pure modules have 100% per-file coverage.
- [ ] Supported-server compatibility tests pass.
- [ ] `npm test` passes.
- [ ] `npm run build` succeeds.
- [ ] No new runtime dependency is added.
