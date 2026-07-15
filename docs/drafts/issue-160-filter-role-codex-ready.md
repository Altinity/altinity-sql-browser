# Dashboard Filter role: multi-filter option bundles, shared preview, and role-aware result selector

## Goal

Allow one favorited saved query to provide authoritative option lists for several existing Dashboard parameters.

A Filter query is configured with:

```json
{
  "favorite": true,
  "dashboard": {
    "role": "filter"
  }
}
```

It returns exactly one row. Each supported top-level result column is one filter helper:

- the result-column name is the exact target parameter name;
- an `Array(T)` cell provides ordered values;
- an `Array(Tuple(value T, label L))` cell provides ordered values and labels;
- a `Map(K, V)` cell provides value-to-label options.

Example:

```sql
SELECT
    arraySort(groupUniqArray(toString(Origin))) AS origin,
    arraySort(groupUniqArray(toString(Dest))) AS destination,
    arraySort(groupUniqArray(toString(Year))) AS year
FROM ontime
```

This one query upgrades the existing `origin`, `destination`, and `year` Dashboard fields into strict searchable single-select controls.

This issue also replaces the panel-only result selector with a role-aware selector. It implements the `Filter` role option and establishes the extension point used by #175 to add `Setup`.

---

## Dependencies

Required:

1. #165 — optional SQL blocks and explicit filter activation;
2. #173 — shared parameter analysis/preparation and typed serialization;
3. #166 — panel registry and shared workbench/Dashboard panel rendering;
4. #211 — saved-query v2 model;
5. #212 — SQL and Spec editors with atomic Save;
6. #220 / PR #222 — canonical Presentation Spec schema and validation service;
7. #154 — KPI result normalization, owned transport, and shared preview patterns;
8. #221 — schema-driven Spec completion.

Related later work:

- #175 — Setup role and shared-session Dashboard execution;
- #188 — filter-bar polish;
- #189 — multiselect;
- cascading Filter queries.

---

## Persisted model

The saved-query Presentation Spec remains the authority:

```js
query.spec.dashboard.role
```

Supported role values remain:

```text
panel | filter | setup
```

This issue implements runtime and authoring behavior for:

```text
panel | filter
```

`setup` remains schema-valid and preserved, but its selector option and execution behavior are implemented by #175.

A missing `dashboard` object or missing `dashboard.role` means:

```json
{
  "role": "panel"
}
```

Filter is not a panel type.

Do not add `filter` to:

```text
panel.cfg.type
PANEL_TYPE_IDS
PANEL_PICKER_OPTIONS
PANEL_TYPES
autoPanel()
resolvePanel()
isQuerylessPanel()
```

A Filter query may retain a dormant `spec.panel` object. Switching roles never deletes or rewrites that object.

No `specVersion` change is required.

---

## Canonical schema

Use only:

```text
schemas/query-spec-v1.schema.json
```

The existing `dashboard.role` enum remains:

```json
["panel", "filter", "setup"]
```

Update its title, description, examples, and completion information so `filter` documents this contract:

- the query returns exactly one row;
- every supported top-level result column provides options for the parameter with the same exact name;
- a Filter query creates no Dashboard tile;
- Filter SQL has no parameters in this version.

Do not add:

```text
dashboard.param
dashboard.targets
panel.cfg.type = "filter"
```

Unknown fields under `dashboard` remain valid and preserved.

---

## Role-aware result selector

Replace the panel-only result selector with one role-aware selector in the bottom drawer header.

Normal Panel query:

```text
[ Table ] [ JSON ] [ KPI ▾ ]
```

Filter query:

```text
[ Table ] [ JSON ] [ Filter ▾ ]
```

The closed control uses the compact label:

```text
Filter
```

Do not display `Filter source` in the drawer header.

### Dropdown contents

Use one selector with grouped choices:

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
```

`Setup` is not visible in this issue. The choice model must allow #175 to append it without changing selection semantics.

A native `<select>` remains acceptable. Use compact option labels so the selected closed value and the open list remain consistent.

### Choice model

Use discriminated values rather than treating every option as a panel type:

```js
[
  {
    id: "panel:kpi",
    kind: "panel",
    panelType: "kpi",
    label: "KPI"
  },
  {
    id: "panel:line",
    kind: "panel",
    panelType: "line",
    label: "Line"
  },
  {
    id: "role:filter",
    kind: "role",
    role: "filter",
    label: "Filter"
  }
]
```

Suggested exports:

```js
PANEL_RESULT_CHOICES
DASHBOARD_ROLE_RESULT_CHOICES
resultChoiceForSpec(spec)
applyResultChoice(query, choice, columns)
```

`DASHBOARD_ROLE_RESULT_CHOICES` contains only `filter` in this issue. #175 extends it with `setup`.

### Selecting a Panel choice

Selecting a visual Panel choice:

1. switches `dashboard.role` to `panel` only when the current effective role is not Panel;
2. preserves all unknown `dashboard` siblings;
3. calls the existing `switchPanelType()` with the selected panel type;
4. preserves dormant/stashed Panel configuration according to existing rules;
5. activates the transient `panel` drawer view;
6. never rewrites unrelated Spec fields.

For an existing effective Panel query, changing the visual type does not create a new `dashboard` object solely to persist the default role.

### Selecting Filter

Selecting `Filter`:

1. patches only `spec.dashboard.role = "filter"`;
2. preserves every existing `dashboard` sibling;
3. preserves the complete `spec.panel` object;
4. activates the transient `filter` drawer view;
5. marks the Spec draft dirty;
6. runs normal Spec validation;
7. does not execute SQL;
8. does not modify `spec.view`.

### Table and JSON

Selecting Table or JSON:

- changes only the current result view;
- does not change `dashboard.role`;
- does not delete Panel configuration;
- does not execute SQL.

### Current selected value

Resolve the selector value as:

```js
function resultChoiceForSpec(spec) {
  const role = spec.dashboard?.role || "panel";
  if (role === "filter") return "role:filter";
  return `panel:${spec.panel?.cfg?.type || "auto"}`;
}
```

The selector may display a disabled `(auto)` Panel option when the role is Panel but no explicit `panel.cfg.type` exists.

### Transient result views

Extend the workbench result-view state with:

```text
table | json | panel | filter
```

`filter` is transient workbench UI state.

It is not a valid persisted `spec.view` value and must never be written there.

On tab reopen, restore the normal persisted `spec.view`. During the current tab lifetime, retain an explicitly selected Filter preview across reruns.

---

## Saved-query patch helpers

Add a forward-compatible helper:

```js
patchQueryDashboard(query, patch)
```

Contract:

- deep-clone the existing `spec.dashboard`;
- preserve unknown siblings;
- `undefined` removes one known field;
- `null` removes the complete dashboard object;
- never alias saved data;
- return a canonical saved-query clone.

Use this helper for role changes.

Do not patch nested Spec objects directly in UI modules.

---

## Filter SQL validation

A Filter query requires:

- non-empty SQL;
- exactly one SQL statement;
- one row-returning statement;
- no declared `{name:Type}` parameters;
- no authored trailing top-level `FORMAT`.

Optional-block parameters count as declared parameters and are not allowed in this version.

Static failures are feature-validation errors:

```text
filter-sql-empty
filter-sql-statement-count
filter-sql-not-row-returning
filter-source-parameters
filter-owned-format
```

These errors:

- appear through the existing Spec/feature diagnostics service;
- block Save;
- prevent Filter execution;
- preserve the authored SQL and Spec unchanged.

Do not execute SQL during validation.

---

## Filter result transport

A Filter query owns its structured result format.

Add:

```text
src/core/filter-execution.js
```

Suggested API:

```js
filterExecution(sql, defaults = {}) -> {
  owned,
  format,
  rowLimit,
  params,
  error
}
```

Required behavior:

- reject an authored trailing top-level `FORMAT`;
- do not rewrite authored SQL;
- request at most two top-level rows so `>1` is detectable;
- preserve Arrays as arrays;
- preserve Maps as structured key/value data;
- serialize named Tuples as objects;
- preserve large integers and Decimals losslessly;
- retain progress, structured exceptions, cancellation, and query timing;
- use `readonly = 2`;
- apply a dedicated byte cap.

Use a logical format name:

```text
Filter
```

The network adapter maps it to an appropriate ClickHouse JSON-with-progress format and settings.

Required format settings include equivalents of:

```text
output_format_json_named_tuples_as_objects = 1
output_format_json_quote_64bit_integers = 1
output_format_json_quote_decimals = 1
output_format_json_quote_64bit_floats = 1
```

Do not use a strings format that converts the complete nested Array, Map, or Tuple value into one quoted ClickHouse literal requiring a second parser.

Suggested limits:

```js
FILTER_TOP_LEVEL_ROW_LIMIT = 2
FILTER_OPTION_CAP = 1000
FILTER_HELPER_CAP = 50
FILTER_RESULT_BYTE_CAP = 10_000_000
```

The client must enforce its own row and option limits even when server limits are overridden.

---

## Shared ClickHouse type parser

Extract reusable nested type parsing from KPI into:

```text
src/core/clickhouse-type.js
```

Required support:

- whitespace;
- nested parentheses;
- quoted member names;
- `Nullable(T)`;
- `Array(T)`;
- `Map(K, V)`;
- named `Tuple(name Type, ...)`;
- malformed/unbalanced input.

Suggested API:

```js
parseClickHouseType(text)
unwrapNullable(node)
arrayElement(node)
mapTypes(node)
namedTupleMembers(node)
isSupportedOptionScalar(node)
```

KPI must consume the shared parser and retain identical behavior.

Do not duplicate tuple parsing in Filter code.

---

## One-row option-bundle contract

A valid Filter result contains exactly one row.

| Top-level row count | Behavior |
|---:|---|
| 0 | source error |
| 1 | normalize helpers |
| >1 | source error |

Diagnostics:

```text
filter-row-count
filter-duplicate-helper-name
filter-helper-cap
filter-no-valid-helpers
```

A result with duplicate top-level column names is invalid as a complete source because object-shaped streaming cannot represent those columns unambiguously.

Every top-level result column is evaluated independently after the envelope passes.

The exact column name is the target parameter name.

Matching is case-sensitive.

---

## Supported helper shapes

### Scalar array

ClickHouse type:

```text
Array(T)
```

Example:

```sql
SELECT arraySort(groupUniqArray(toString(Origin))) AS origin
FROM ontime
```

Runtime value:

```json
{
  "origin": ["ATL", "JFK", "LAX"]
}
```

Normalized options:

```js
[
  { value: "ATL", label: "ATL" },
  { value: "JFK", label: "JFK" },
  { value: "LAX", label: "LAX" }
]
```

Rules:

- preserve array order;
- each item must be a supported non-NULL scalar;
- normalized value and label are the same string;
- empty string is valid;
- a NULL or unsupported item invalidates this helper.

### Labeled named-tuple array

ClickHouse type:

```text
Array(Tuple(value T, label L))
```

Example:

```sql
SELECT
    arraySort(
        item -> item.label,
        groupUniqArray((
            Origin AS value,
            OriginCityName AS label
        ))
    ) AS origin
FROM ontime
```

Runtime value:

```json
{
  "origin": [
    { "value": "ATL", "label": "Atlanta, GA" },
    { "value": "JFK", "label": "New York, NY" }
  ]
}
```

Rules:

- the Tuple must have named members;
- `value` is required;
- `label` is required;
- member order is irrelevant;
- both members must be supported non-NULL scalars;
- unknown named members are ignored;
- preserve array order;
- positional unnamed Tuples are unsupported;
- a missing or invalid member invalidates this helper.

### Map

ClickHouse type:

```text
Map(K, V)
```

Example:

```sql
SELECT
    mapFromArrays(
        groupArray(Origin),
        groupArray(OriginCityName)
    ) AS origin
FROM (
    SELECT DISTINCT Origin, OriginCityName
    FROM ontime
    ORDER BY OriginCityName, Origin
)
```

Rules:

- Map keys become option values;
- Map values become labels;
- keys and labels must be supported non-NULL scalars;
- normalize both to exact strings;
- sort normalized options by label, then value;
- use an Array helper when source-controlled ordering matters;
- an invalid entry invalidates this helper.

---

## Supported option scalar values

Support values that can be validated and serialized losslessly by the existing parameter pipeline:

- String and FixedString;
- UUID;
- signed and unsigned integers;
- Decimal;
- Float;
- Bool;
- Date and Date32;
- DateTime and DateTime64;
- Enum values represented by their bound string.

Large integers and Decimals must remain strings end-to-end.

NULL is not supported.

Unsupported nested arrays, maps, tuples, objects, and Dynamic values invalidate the helper.

---

## Duplicate options

Within one helper:

- deduplicate by normalized `value`;
- first occurrence wins;
- retain the first label;
- duplicate labels are allowed;
- active empty string remains distinct from inactive state.

Emit an informational diagnostic:

```text
filter-duplicate-option
```

Duplicate options do not invalidate the helper.

---

## Pure option reader

Add:

```text
src/core/filter-options.js
```

Suggested API:

```js
readFilterOptions({
  columns,
  row,
  rowCount,
  optionCap = FILTER_OPTION_CAP,
  helperCap = FILTER_HELPER_CAP
}) -> {
  helpers,
  diagnostics
}
```

Helper result:

```js
{
  name: "origin",
  columnIndex: 0,
  sourceType: "Array(Tuple(value String, label String))",
  shape: "array" | "tuple-array" | "map",
  options: [
    {
      value: "ATL",
      label: "Atlanta, GA"
    }
  ],
  totalOptions: 321,
  truncated: false
}
```

Diagnostic result:

```js
{
  severity: "error" | "warning" | "info",
  code: string,
  message: string,
  helperName?: string,
  optionIndex?: number
}
```

The reader must be:

- pure;
- deterministic;
- non-mutating;
- DOM-free;
- state-free;
- network-free;
- covered at 100% per-file.

### Partial helper success

A malformed helper does not discard valid sibling helpers.

Example:

```text
origin       valid Array(String)
destination  invalid String
year         valid Map(String, String)
```

Outcome:

- `origin` and `year` remain usable;
- `destination` receives a helper error;
- Dashboard uses the ordinary fallback control for `destination`.

The complete source fails only when:

- query execution fails;
- static SQL validation fails;
- row count is not one;
- duplicate top-level helper names exist;
- no valid helper remains.

---

## Consumer matching and validation

The Dashboard discovers parameter fields from executable Panel queries through the existing parameter pipeline.

A helper matches a consumer field by exact name.

### Matching consumer

For one consistent declared target type:

1. validate every normalized helper value through the existing parameter validator/serializer;
2. do not add Filter-specific coercion;
3. upgrade the existing field in place to a strict curated selector;
4. retain existing persistence and activation semantics.

One incompatible option invalidates the complete helper. Do not silently drop individual invalid options.

Diagnostic:

```text
filter-option-consumer-invalid
```

### No consumer

A helper with no current Panel consumer:

- remains visible in the workbench Filter preview;
- is omitted from the Dashboard filter bar;
- produces a warning;
- does not block Save;
- does not invalidate sibling helpers.

Diagnostic:

```text
filter-helper-unused
```

### Conflicting consumer types

When the shared parameter analysis reports conflicting declarations:

- do not use the curated helper;
- keep the ordinary fallback field;
- produce a configuration diagnostic;
- keep sibling helpers usable.

Diagnostic:

```text
filter-target-type-conflict
```

---

## Duplicate providers

If two favorited Filter queries provide the same helper name:

- neither provider wins for that name;
- keep the ordinary fallback field for that parameter;
- report both provider query names;
- keep non-conflicting helpers from both queries usable;
- never choose by Library order.

Diagnostic:

```text
filter-duplicate-provider
```

Provider conflict is per helper name, not per complete Filter query.

---

## Shared strict option control

Add:

```text
src/ui/filter-option-field.js
```

Suggested interface:

```js
buildFilterOptionField({
  document,
  name,
  declaredType,
  options,
  value,
  active,
  inactiveLabel,
  preview,
  onValueChange,
  onCommit
}) -> {
  el,
  input,
  destroy?
}
```

Use the existing accessible combobox foundation.

Required behavior:

- searchable options;
- keyboard and pointer navigation;
- strict selection;
- unmatched arbitrary text rejected;
- inactive state distinct from active empty string;
- no automatic first selection;
- option labels displayed separately from values;
- exact values persisted;
- no separate recent-values section while curated options are healthy.

Inactive labels:

- `All` when optional in every affected Panel;
- `Not set` when required by at least one affected Panel.

Lifecycle states:

```text
Loading options…
No options
Options failed · Retry
Invalid options
Conflicting providers
Showing first 1,000 options
```

On any curated failure, retain the existing ordinary field as fallback.

---

## Workbench Filter preview

Selecting `Filter` in the drawer selector activates the transient Filter preview.

It uses only the active tab’s last completed explicit Run result.

It never executes SQL.

### No result

Show:

```text
Run the query to preview Filter options.
```

### Running

Show:

```text
Filter preview appears when the query completes.
```

Do not render partially streamed helpers.

### Successful result

Render one helper section per result column, in result-column order:

```text
origin                         342 options
[ All                         ▾ ]

destination                    355 options
[ All                         ▾ ]

year                            38 options
[ All                         ▾ ]
```

Each section displays:

- target name;
- ClickHouse source type;
- normalized option count;
- truncation;
- matching consumer type when available;
- unused/invalid status;
- helper diagnostics.

Use the shared strict option control with local sandbox state.

Preview interactions:

- do not write `state.varValues`;
- do not write `state.filterActive`;
- do not save recents;
- do not rerun SQL;
- do not rerun Dashboard queries;
- may reset after a new Run or tab recreation.

### Invalid result

Render source-level errors and all valid helper previews that remain available.

A result-shape error does not turn a successfully executed SQL query into a query execution error. Table and JSON inspection remain available.

---

## Workbench execution

When the effective role is Filter, the normal Run action uses `filterExecution()`.

The resulting structured row remains available in:

```text
Table
JSON
Filter
```

Normal Run:

- remains explicit;
- uses the current query parameters gate, which must reject Filter SQL because source parameters are unsupported;
- updates ordinary result statistics;
- supports cancellation;
- does not affect Dashboard state.

Selecting a role does not run the query.

---

## Dashboard partition

Partition the favorited snapshot before parameter analysis:

1. effective role `filter` → Filter scheduler, no grid slot;
2. effective role `setup` → reserved for #175, excluded with a not-implemented diagnostic until #175 lands;
3. effective role `panel` → normal Dashboard Panel;
4. unknown non-empty role → excluded with a diagnostic.

A Filter query:

- never creates a tile;
- never enters Panel auto-detection;
- never enters the panel registry;
- is excluded from “N not shown” counts;
- contributes zero or more curated helpers;
- is absent when not favorited.

Panel parameter analysis excludes Filter SQL.

---

## Dashboard execution sequence

### Open

1. snapshot favorited queries;
2. partition roles;
3. analyze Panel-query parameters;
4. render ordinary filter controls immediately;
5. statically validate Filter queries;
6. run valid Filter queries in parallel under the existing Dashboard concurrency ceiling;
7. normalize each result;
8. merge helpers by exact name;
9. detect duplicate providers and consumer conflicts;
10. replace matching ordinary fields with curated strict fields;
11. reconcile persisted values and activation;
12. run Panels after reconciliation.

No Panel query starts before reconciliation completes.

A failed Filter query falls back to ordinary fields and does not block Panel execution.

### Refresh

Dashboard Refresh:

1. supersedes and aborts all current Filter requests;
2. reruns all valid Filter queries;
3. normalizes and merges helpers;
4. reconciles persisted values;
5. reruns all Panels.

No cache is introduced.

### Filter commit

Changing any Dashboard field:

- writes shared values and activation;
- persists through existing stores;
- reruns only affected Panels;
- does not rerun Filter queries.

### Retry

Retry on a failed Filter query:

1. supersedes only that query’s request;
2. reruns and renormalizes it;
3. remerges only affected helper names;
4. reconciles affected values;
5. reruns Panels only when reconciliation changed an active/value state.

---

## Persisted-value reconciliation

For each valid curated field:

- active value present in options → keep active;
- active value absent → deactivate and retain the dormant value;
- inactive value → remain inactive and retain the dormant value;
- active empty-string option present → remain active;
- never select the first option automatically;
- never replace a stale value with another option.

Use only:

```js
state.varValues
state.filterActive
```

Do not introduce a second curated-filter value store.

---

## Request lifecycle

Each Filter query owns:

```text
generation
AbortController
status
lastResult
```

Rules:

- reserve a new generation before queueing;
- abort the previous in-flight request;
- ignore stale queued and completed work;
- Dashboard close aborts all Filter requests;
- Refresh supersedes all Filter requests;
- Retry supersedes one request;
- one Filter failure does not cancel siblings;
- requests use the shared bounded concurrency limiter.

Reuse the Dashboard tile generation/cancellation pattern.

---

## Diagnostics

Stable codes:

```text
filter-sql-empty
filter-sql-statement-count
filter-sql-not-row-returning
filter-source-parameters
filter-owned-format

filter-row-count
filter-duplicate-helper-name
filter-helper-cap
filter-no-valid-helpers
filter-unsupported-helper-type
filter-null-option
filter-invalid-option-tuple
filter-missing-option-value
filter-missing-option-label
filter-option-type
filter-option-consumer-invalid
filter-duplicate-option
filter-options-truncated

filter-helper-unused
filter-target-type-conflict
filter-duplicate-provider
filter-query-failed
```

Diagnostic shape:

```js
{
  severity,
  code,
  message,
  sourceId?,
  helperName?,
  optionIndex?,
  path?
}
```

Static errors may block Save.

Result-aware and cross-Library diagnostics do not block saving a structurally valid query merely because no current result or Dashboard snapshot exists.

Only `severity: "error"` diagnostics appear in the bottom error area.

Warnings and information remain in preview, badges, or Dashboard configuration diagnostics.

---

## Library and workbench labels

Use compact role labels:

```text
[Filter]
```

Do not display `[Filter source]` in the bottom drawer selector.

Library row:

```text
★ Airport options    [Filter]
```

Workbench title badge:

```text
Filter
```

Clicking either badge:

1. activates the query tab;
2. switches to Spec mode;
3. navigates to `dashboard.role`.

A successful current Run may show a transient helper summary:

```text
Filter · origin, destination, year
```

Do not persist derived helper names.

---

## Spec completion

At:

```json
{
  "dashboard": {
    "role": ""
  }
}
```

offer:

```text
panel
filter
setup
```

The `filter` documentation comes from the canonical schema and describes the one-row multi-helper contract.

Do not offer `dashboard.param`.

Target names are authored as SQL aliases and discovered from the result.

---

## Files

Add:

```text
src/core/clickhouse-type.js
src/core/filter-execution.js
src/core/filter-options.js
src/core/dashboard-filters.js
src/core/result-choice.js

src/ui/filter-option-field.js
src/ui/filter-preview.js
```

Modify:

```text
schemas/query-spec-v1.schema.json
src/generated/json-schemas.js
src/generated/json-schema-validators.js

src/core/kpi.js
src/core/saved-query.js
src/core/panel-cfg.js
src/core/dashboard.js
src/core/stream.js

src/ui/panels.js
src/ui/results.js
src/ui/dashboard.js
src/ui/filter-bar.js
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

Add or update corresponding unit and E2E tests.

No new runtime dependency.

---

## Implementation order

### 1. Model and selector foundation

- add `patchQueryDashboard`;
- add discriminated result-choice model;
- replace `renderPanelTypePicker` with role-aware selector;
- implement Panel and Filter selection;
- add transient `filter` result view;
- preserve existing Panel behavior;
- reserve role-choice extension for #175.

### 2. Shared type parser

- extract KPI tuple parsing;
- support Array, Map, Tuple, and Nullable;
- migrate KPI;
- retain KPI regression behavior.

### 3. Filter execution and parsing

- add owned transport resolver;
- add logical Filter stream format;
- implement one-row option reader;
- add limits and diagnostics;
- implement partial helper success.

### 4. Preview

- add shared strict option field;
- add Filter preview;
- wire local preview state;
- retain Table and JSON inspection.

### 5. Dashboard integration

- partition roles;
- run Filter queries;
- merge helpers;
- validate against consumers;
- reconcile persisted values;
- upgrade/fallback controls;
- add Retry, Refresh, cancellation, and stale guards.

### 6. Labels, completion, and docs

- update badges;
- update schema annotations;
- remove any `dashboard.param` assumptions;
- document SQL examples and limits;
- update changelog.

---

## Tests

### Selector and model

- effective missing role resolves to Panel;
- existing Panel selection behavior is unchanged;
- choosing Filter patches only `dashboard.role`;
- Panel config survives Filter selection;
- choosing a Panel type from Filter switches role to Panel;
- unknown `dashboard` fields survive;
- Table/JSON do not change role;
- Filter view does not persist into `spec.view`;
- `filter` never enters panel registries;
- role choice list is extendable by #175.

### Type parser and KPI regression

- nested Array/Map/Tuple/Nullable parsing;
- quoted tuple names;
- malformed types;
- all KPI tests unchanged.

### Static validation

- empty SQL;
- multiple statements;
- non-row-returning statement;
- required or optional parameters;
- authored trailing FORMAT;
- no network call after static failure.

### Result envelope

- zero, one, and multiple rows;
- duplicate column names;
- zero columns;
- helper cap;
- no valid helpers.

### Array helpers

- supported scalar types;
- large integers and Decimals;
- empty array;
- active empty string;
- NULL item;
- unsupported nested item;
- order;
- cap and truncation.

### Tuple-array helpers

- named value/label;
- member order;
- extra members;
- missing members;
- NULL members;
- unsupported member types;
- positional tuple rejection;
- order and cap.

### Map helpers

- supported key/value types;
- deterministic label/value sorting;
- empty Map;
- invalid entry;
- cap and truncation.

### Partial success and duplicates

- valid siblings survive invalid helper;
- duplicate option first-wins;
- duplicate provider affects only one target;
- no Library-order winner.

### Consumer matching

- exact case-sensitive matching;
- unused helper warning;
- target type validation;
- conflicting target types;
- invalid option fallback.

### Preview

- no-result and running hints;
- successful helpers;
- partial errors;
- local-only selection;
- no SQL execution;
- no shared-state writes;
- Table/JSON remain available.

### Dashboard

- Filter creates no tile;
- non-favorite Filter absent;
- ordinary fields paint immediately;
- Filter queries run before Panels;
- reconciliation precedes Panel requests;
- stale active value deactivates without replacement;
- active empty string remains active;
- failure uses ordinary fallback;
- Refresh and Retry behavior;
- filter commits do not rerun Filter queries;
- abort/generation guards.

### Regression

- SQL editor and Spec editor behavior;
- KPI;
- Panel registry;
- Dashboard ordinary filters without Filter queries;
- optional blocks;
- parameter serializer;
- recents;
- Library import/export;
- generated schema drift;
- build and audit.

---

## Acceptance criteria

- [ ] One Filter query can provide several parameter option lists.
- [ ] The result contains exactly one top-level row.
- [ ] Exact result-column names are target parameter names.
- [ ] Array, labeled named-tuple Array, and Map helpers are supported.
- [ ] Values remain lossless.
- [ ] NULL and unsupported options are rejected.
- [ ] Duplicate values are first-wins.
- [ ] Valid sibling helpers survive an invalid helper.
- [ ] Duplicate providers fall back only for the conflicting target.
- [ ] `dashboard.param` is not used.
- [ ] Filter remains a Dashboard role and never becomes a panel type.
- [ ] The drawer selector shows `Filter`, not `Filter source`.
- [ ] The role-aware selector preserves all existing Panel behavior.
- [ ] The selector architecture can add Setup without redesign.
- [ ] Selecting Filter preserves the complete Panel configuration.
- [ ] Selecting a Panel type switches the effective role back to Panel.
- [ ] Filter preview uses only the last explicit Run.
- [ ] Filter preview never executes SQL or changes shared Dashboard values.
- [ ] Preview and Dashboard share the same reader and strict control.
- [ ] Filter queries create no Dashboard tiles.
- [ ] Curated values reconcile before Panels execute.
- [ ] Failures degrade to ordinary controls.
- [ ] Request cancellation and generation guards prevent stale results.
- [ ] Static errors block Save; warnings remain non-blocking.
- [ ] Only real errors appear in the bottom error area.
- [ ] KPI regression tests pass.
- [ ] New pure core modules have 100% per-file coverage.
- [ ] `npm test` passes.
- [ ] `npm run build` succeeds.
- [ ] No new runtime dependency is added.
