# Dashboard filter sources: multi-filter one-row option bundles, preview UX, and shared normalization

## Summary

Implement query-backed dashboard filter options using a **one-row option bundle** contract.

A single saved query with:

```json
{
  "favorite": true,
  "dashboard": {
    "role": "filter"
  }
}
```

may provide options for several dashboard parameters at once.

The query returns exactly one row. Each supported top-level result column is one **filter helper**:

- the result-column name is the exact target parameter name;
- an `Array(...)` cell provides an ordered option list;
- an `Array(Tuple(value ..., label ...))` cell provides ordered value/label options;
- a `Map(...)` cell provides a value-to-label option mapping.

Example:

```sql
SELECT
    arraySort(groupUniqArray(toString(Origin))) AS origin,
    arraySort(groupUniqArray(toString(Dest))) AS destination,
    arraySort(groupUniqArray(toString(Year))) AS year
FROM ontime
```

This one source can upgrade the existing `origin`, `destination`, and `year` dashboard fields into strict searchable single-select controls.

The implementation should follow the approach established by KPI:

- canonical saved-query Presentation Spec;
- no new panel type for a non-panel concept;
- SQL owns runtime data;
- pure result-shape normalization;
- role-owned result transport;
- exact result-aware diagnostics;
- one shared control renderer for workbench preview and Dashboard;
- workbench preview uses only the last explicit Run result;
- invalid helpers do not discard unrelated valid helpers;
- unknown Spec extensions remain preserved.

---

## Updated title

Replace the current issue title with:

> **Dashboard filter sources: multi-filter one-row option bundles, preview UX, and shared normalization**

The old title and body assume one saved query targets one parameter through `dashboard.param`. This revision intentionally replaces that contract.

---

## Dependencies

Hard dependencies:

1. #165 — optional SQL blocks and explicit filter activation;
2. #173 — shared two-phase parameter pipeline and typed serializer;
3. #166 — panel registry and shared workbench/dashboard panel rendering;
4. #211 — canonical saved-query v2 shape;
5. #212 — SQL and Spec editors with atomic Save;
6. #220 / PR #222 — canonical Presentation Spec schema and shared validation service;
7. #154 — KPI result-shape reader, owned transport, preview, and shared-renderer patterns;
8. #221 — schema-driven Spec autocomplete, when available.

Related follow-ups:

- #175 — setup-source execution;
- #188 — filter-bar polish;
- #189 — multiselect;
- any later cascading-filter issue.

This issue remains a single-select MVP.

---

## Problem

The Dashboard already creates one filter field for every `{name:Type}` parameter referenced by included Panel queries.

Existing fields share:

- `state.varValues`;
- `state.filterActive`;
- validation and type analysis;
- optional SQL block semantics;
- relative-time presets;
- Enum-derived suggestions;
- recent values;
- affected-query reruns.

What is missing is an authoritative query-backed option source.

The current issue assumes:

```json
{
  "dashboard": {
    "role": "filter",
    "param": "origin"
  }
}
```

and a row-per-option result:

```text
value | label
```

That model has several limitations:

- one query can serve only one parameter;
- similar filters require duplicated scans and joins;
- the target name is duplicated between SQL/Spec and consumer queries;
- the result contract does not align with the one-row structured-result pattern used by KPI;
- preview behavior remains underspecified;
- adding Filter to the panel registry would incorrectly model a dashboard role as a visualization type.

The new contract makes the result aliases authoritative:

```text
one source query
→ one row
→ several named option collections
→ several existing dashboard filter fields
```

---

## Goals

1. Allow one Filter-source query to provide options for several parameter names.
2. Use exact top-level result-column names as target parameter names.
3. Support ordered arrays, labeled tuple arrays, and maps.
4. Keep Filter source as a Dashboard role, not a Panel type.
5. Provide a workbench Filter preview from the last explicit Run result.
6. Reuse the same pure reader and option-control renderer in preview and Dashboard.
7. Keep valid helpers usable when another helper in the same row is invalid.
8. Reconcile all persisted curated selections before running dependent Panels.
9. Preserve the existing ordinary field as fallback when a source/helper fails.
10. Keep Library and Spec authoring schema-driven and forward compatible.

---

## Non-goals

This issue does not implement:

- multiselect;
- cascading option-source queries;
- Filter-source SQL parameters;
- option caching or TTL;
- server-side automatic `DISTINCT`;
- automatic SQL generation;
- NULL options;
- nested option groups;
- disabled options;
- per-option icons or colors;
- arbitrary tuple-member mappings;
- positional unnamed option tuples;
- Filter as a panel renderer;
- Filter as `panel.cfg.type`;
- Filter auto-detection from ordinary results;
- a new `specVersion`;
- a large Library role-edit form;
- persisted Filter-preview view preference;
- query-backed options in unrelated non-dashboard surfaces;
- setup-source execution.

---

## Terminology

### Panel

A visual representation of a result:

```text
bar | hbar | line | area | pie | kpi | table | logs | text
```

Panel configuration remains:

```json
{
  "panel": {
    "cfg": {
      "type": "kpi"
    }
  }
}
```

### Dashboard role

How a saved query participates in the Dashboard:

```text
panel | filter | setup
```

Persisted at:

```js
query.spec.dashboard.role
```

### Filter source

A favorited saved query with:

```json
{
  "dashboard": {
    "role": "filter"
  }
}
```

It executes without creating a dashboard tile.

### Filter helper

One top-level result column in a successful Filter-source result.

The exact result-column name is the target dashboard parameter name.

### Option bundle

The complete one-row result containing one or more Filter helpers.

---

## Canonical Presentation Spec contract

The minimal Filter-source Spec is:

```json
{
  "name": "Flight filter options",
  "favorite": true,
  "view": "table",
  "dashboard": {
    "role": "filter"
  }
}
```

There is no `dashboard.param`.

There is no `panel.cfg.type = "filter"`.

There is no list of target parameter names in the Spec.

Target names come from SQL result aliases.

Existing `spec.panel` configuration remains preserved and dormant for Dashboard rendering while the role is `filter`.

Changing the role back to `panel` restores the previous Panel configuration without migration or reconstruction.

### Canonical schema change

Update the canonical schema documentation/annotations for:

```text
schemas/query-spec-v1.schema.json
```

The existing `dashboard.role` enum remains:

```json
["panel", "filter", "setup"]
```

Update the `filter` completion information to explain:

- exactly one row;
- each supported top-level result column provides one parameter’s options;
- result-column aliases are exact target names;
- Filter sources do not render dashboard tiles.

Do not add `dashboard.param`.

Do not add a Filter branch to `panelCfg`.

No `specVersion` increment is required because the role value already exists and the new behavior is additive.

---

## SQL result contract

## Exactly one row

A Filter source must return exactly one data row.

Behavior:

| Row count | Result |
|---:|---|
| 0 | source error: expected one option-bundle row |
| 1 | normalize supported helpers |
| >1 | source error: expected one option-bundle row |

Suggested diagnostic:

```js
{
  severity: "error",
  code: "filter-row-count",
  message: "Expected 1 option-bundle row, got 3"
}
```

The row-count contract mirrors KPI, but the contents are option collections rather than scalar cards.

## One or more result columns

The single row must contain at least one top-level column.

Every column is evaluated independently as a potential Filter helper.

A result with no valid helpers is a source error:

```text
filter-no-valid-helpers
```

## Exact target names

Given:

```sql
SELECT
    ... AS origin,
    ... AS destination
```

the helpers target:

```text
origin
destination
```

Matching is exact and case-sensitive, following ClickHouse parameter names.

Do not normalize case.

Do not infer a target from the query name, description, Library order, or Spec metadata.

## Duplicate result-column names

Duplicate top-level result-column names are invalid because streamed object rows cannot represent them unambiguously.

Reject the complete source result with:

```text
filter-duplicate-helper-name
```

Do not silently choose one.

---

## Supported helper shapes

## 1. Scalar array

```text
Array(T)
```

Example:

```sql
SELECT
    arraySort(groupUniqArray(toString(Origin))) AS origin
FROM ontime
```

Runtime value:

```json
{
  "origin": ["ATL", "JFK", "LAX"]
}
```

Normalization:

```js
[
  { value: "ATL", label: "ATL" },
  { value: "JFK", label: "JFK" },
  { value: "LAX", label: "LAX" }
]
```

Rules:

- array order is authoritative;
- each element must be a supported non-NULL scalar;
- value and label are the same normalized string;
- empty string is valid;
- NULL elements invalidate this helper;
- nested arrays, tuples without the labeled contract, maps, and arbitrary objects are unsupported as scalar values.

## 2. Labeled named-tuple array

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

- the tuple must be named;
- `value` is required;
- `label` is required in v1;
- both members must be supported non-NULL scalar values;
- unknown tuple members are ignored and preserved in raw result data;
- member order is irrelevant;
- option order follows array order;
- positional unnamed tuples are unsupported;
- a tuple missing `value` or `label` invalidates this helper.

The named-tuple approach should reuse or extract the ClickHouse type-parsing logic introduced for KPI rather than adding another ad hoc parser.

## 3. Map

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

Runtime value:

```json
{
  "origin": {
    "ATL": "Atlanta, GA",
    "JFK": "New York, NY"
  }
}
```

Normalization:

```js
[
  { value: "ATL", label: "Atlanta, GA" },
  { value: "JFK", label: "New York, NY" }
]
```

Rules:

- keys are values;
- map values are labels;
- keys and labels must normalize to supported non-NULL strings;
- keys must be unique by query contract;
- map output is intended for convenience, not source-controlled ordering;
- map options are sorted by normalized label, then value, for deterministic UI;
- authors who require explicit order must use an array.

This avoids making JavaScript object-property enumeration part of the public ordering contract.

---

## Supported scalar option values

V1 supports ClickHouse scalar values that can be transported and bound losslessly through the existing typed parameter pipeline, including:

- String and FixedString;
- UUID;
- signed and unsigned integers;
- Decimal;
- Float;
- Bool;
- Date and Date32;
- DateTime and DateTime64;
- Enum values represented as their bound string.

All normalized option values are stored in the filter state using the existing parameter-compatible string representation.

Large integers and Decimals must never pass through a lossy JavaScript `Number`.

NULL is unsupported in v1.

Unsupported complex values invalidate only their helper unless the result envelope itself is malformed.

---

## Duplicate option values

Within one helper:

- deduplicate by normalized `value`;
- first occurrence wins;
- preserve the first occurrence’s label;
- duplicate labels are allowed;
- empty string is a valid value and remains distinct from inactive state.

A duplicate may produce an informational preview note, but it is not a blocking error.

Suggested diagnostic:

```text
filter-duplicate-option
```

with severity `info`.

---

## Partial helper success

The bundle reader follows the KPI field-reader approach.

Example result:

```text
origin       valid Array(String)
destination  invalid String
year         valid Map(String, String)
```

Outcome:

- `origin` helper is usable;
- `year` helper is usable;
- `destination` falls back to the existing ordinary field;
- the source query is not discarded;
- the preview shows the helper-specific error;
- the Dashboard configuration diagnostics identify the invalid helper.

Only envelope-level failures block the whole source:

- query execution failure;
- authored trailing `FORMAT`;
- zero or multiple rows;
- duplicate top-level result-column names;
- no valid helpers.

---

## Pure option-bundle reader

Add:

```text
src/core/filter-options.js
```

Suggested API:

```js
readFilterOptionBundle({
  columns,
  row,
  rowCount,
  consumerFields,
  optionCap,
}) -> {
  helpers: FilterHelper[],
  diagnostics: FilterDiagnostic[]
}
```

Suggested helper shape:

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
  truncated: false,
  consumer: {
    present: true,
    type: "String",
    conflict: false
  }
}
```

Suggested diagnostic shape:

```js
{
  severity: "error" | "warning" | "info",
  code: string,
  message: string,
  helperName?: string,
  optionIndex?: number
}
```

The module must be:

- pure;
- deterministic;
- non-mutating;
- DOM-free;
- storage-free;
- app-state-free;
- network-free;
- independently testable at 100% per-file coverage.

---

## Shared ClickHouse type parser

KPI currently parses numeric and named-tuple structures.

Filter helpers need:

- Array element types;
- named Tuple members;
- Map key/value types;
- Nullable wrappers;
- nested generic splitting.

Extract the reusable parser into a shared pure module rather than duplicating it.

Suggested location:

```text
src/core/clickhouse-type.js
```

Suggested API:

```js
parseClickHouseType(typeText)
unwrapNullable(typeNode)
isScalarOptionType(typeNode)
namedTupleMembers(typeNode)
```

KPI must continue passing its existing regression tests after the extraction.

Do not build filter behavior with substring matching spread across UI code.

---

## Consumer matching

The Dashboard first analyzes executable Panel queries and discovers parameter fields through the existing shared parameter pipeline.

A helper is matched to an existing field by exact name.

## Matching consumer

When a helper name matches a Dashboard field:

- validate every option against the field’s consistent declared type;
- upgrade that existing field to a strict curated single-select;
- retain existing activation and persistence semantics.

## No matching consumer

A helper without a current consumer:

- remains visible in workbench preview;
- is ignored by the Dashboard filter bar;
- produces a warning;
- does not block Save;
- does not invalidate other helpers.

Suggested diagnostic:

```text
filter-helper-unused
```

Message:

```text
No executable dashboard Panel currently uses parameter "origin".
```

This allows a source to be authored before its consumer query is saved or favorited.

## Conflicting consumer declarations

When the shared parameter analysis reports conflicting declarations for a target field:

- do not upgrade it to a curated strict select;
- retain the ordinary fallback control;
- show a configuration diagnostic;
- leave unrelated helpers usable.

Suggested code:

```text
filter-target-type-conflict
```

## Option value validation

For a matched field with one consistent type:

- validate normalized option values through the shared parameter validator/serializer contract;
- do not invent a filter-specific type coercion;
- one invalid option invalidates that helper rather than silently dropping it;
- show the failing option index/value safely in diagnostics;
- preserve exact string transport.

---

## Duplicate providers

Several favorited Filter sources may provide different parameter names.

If two included sources both provide the same helper name:

```text
source A → origin
source B → origin
```

that target has a configuration error.

Behavior:

- neither curated provider wins for `origin`;
- the Dashboard retains the ordinary fallback field for `origin`;
- helpers for other names from both sources remain usable;
- both sources receive a visible configuration diagnostic;
- do not choose by Library order.

Suggested code:

```text
filter-duplicate-provider
```

The conflict is per helper name, not automatically per complete source.

---

## Source SQL validation

A Filter source requires:

- non-empty SQL;
- exactly one statement;
- a row-returning statement;
- no source parameters in v1;
- no trailing authored `FORMAT`.

These conditions are statically discoverable and are real source-local errors.

They may participate in Save gating through the existing feature-validation service.

Suggested codes:

```text
filter-sql-empty
filter-sql-statement-count
filter-sql-not-row-returning
filter-source-parameters
filter-owned-format
```

### Why source parameters remain out of scope

Allowing parameters in a Filter source introduces dependency ordering and cascading refresh semantics.

This issue intentionally keeps every Filter source a root option query:

```text
no source params
→ all sources may run in parallel
→ no dependency graph
→ no cache
→ no cycle detection
```

Cascading helpers remain a later issue.

---

## Role-owned execution transport

A Filter source owns the output transport required by its parser, following the KPI pattern.

Add:

```text
src/core/filter-source-execution.js
```

Suggested API:

```js
filterSourceExecution(sql, defaults?) -> {
  owned,
  format,
  rowLimit,
  params,
  error
}
```

Requirements:

- detect and reject authored trailing top-level `FORMAT`;
- do not rewrite SQL;
- request exactly enough top-level rows to detect `>1`;
- preserve Arrays and Maps as structured JSON;
- serialize named Tuples as objects;
- quote large integers, Decimals, and 64-bit floating values to prevent JavaScript precision loss;
- retain progress and structured exceptions;
- use `readonly=2`;
- apply a dedicated byte cap.

Suggested logical transport:

```text
format: FilterOptions
rowLimit: 2
```

The network adapter may map this logical format onto a ClickHouse JSON-with-progress format configured with settings equivalent to:

```text
output_format_json_named_tuples_as_objects = 1
output_format_json_quote_64bit_integers = 1
output_format_json_quote_decimals = 1
output_format_json_quote_64bit_floats = 1
```

The exact underlying ClickHouse format may differ if tests prove that:

- arrays remain arrays;
- maps remain objects/maps;
- named tuple members remain named;
- exact option values survive;
- existing streaming progress/cancellation works.

Do not use a JSONStrings variant that turns the entire nested Array/Map cell into one quoted ClickHouse literal requiring a second unsafe parser.

---

## Result limits

Because options are nested inside one row, the old “fetch 1,001 rows as a truncation sentinel” design no longer applies.

Use:

```text
FILTER_OPTION_CAP_PER_HELPER = 1000
FILTER_SOURCE_BYTE_CAP = 10 MB
FILTER_HELPER_CAP = 50
```

Exact constant names may vary.

Behavior:

- normalize at most the first 1,000 array options;
- for Map helpers, normalize the first 1,000 entries before deterministic sorting;
- retain `totalOptions` from the received collection length;
- mark the helper truncated when more options were returned;
- display:

```text
Showing first 1,000 options — refine the source query
```

- reject or ignore helpers beyond the helper-count cap with a clear diagnostic;
- use `max_result_bytes` as a best-effort server guard;
- the source SQL remains responsible for query cost and source-side aggregation limits.

The complete nested row may still need to arrive before client truncation. Document this limitation.

---

## Dashboard partition

Partition the favorited Library snapshot before parameter analysis and execution:

1. `dashboard.role === "filter"` → Filter-source scheduler, no tile;
2. `dashboard.role === "setup"` → Setup scheduler, no tile;
3. missing role or `dashboard.role === "panel"` → ordinary Dashboard Panel;
4. unknown non-empty role → excluded with diagnostic.

A Filter source:

- never creates a grid slot;
- never enters panel auto-detection;
- never enters `PANEL_TYPES`;
- never enters `PANEL_PICKER_OPTIONS`;
- is excluded from “N not shown” tile counts;
- contributes zero or more curated helpers;
- is absent when not favorite.

Update stale comments suggesting that Filter will become a queryless panel arm. It is a dashboard role and query-backed source.

---

## Dashboard execution sequence

## Dashboard open

1. snapshot favorited queries;
2. partition Panel, Filter, and Setup roles;
3. analyze Panel-query parameters;
4. render ordinary filter controls immediately;
5. statically validate Filter sources;
6. run valid Filter sources in parallel under the shared concurrency ceiling;
7. normalize each one-row option bundle;
8. merge helpers by exact parameter name;
9. detect duplicate providers and consumer-type conflicts;
10. upgrade valid matching fields to strict curated controls;
11. reconcile persisted values and activation for all curated helpers;
12. run Dashboard Panels using the reconciled state.

No Panel query starts before curated reconciliation completes.

A failed Filter source does not prevent Panel execution after fallback controls are established.

## Refresh

Dashboard Refresh:

1. supersedes and aborts all in-flight Filter-source requests;
2. reruns valid Filter sources;
3. normalizes and merges helpers;
4. reconciles persisted selections;
5. reruns all Dashboard Panels.

No option cache is introduced.

## Filter changes

Changing a dashboard filter:

- updates shared value and activation stores;
- reruns only affected Dashboard Panels;
- does not rerun Filter sources;
- does not alter other helper definitions.

## Retry

A failed Filter source exposes Retry.

Retry:

- supersedes only that source request;
- reparses all helpers from that source;
- remerges the affected helper names;
- reconciles affected persisted selections;
- reruns only Panels affected by a changed active/value state.

If retry only restores the same options and state, it need not rerun unaffected Panels.

---

## Persisted-value reconciliation

For each successfully curated field:

- active stored value present in options → keep active;
- active stored value absent → deactivate and keep the value dormant;
- inactive stored value → remain inactive and keep value dormant;
- active empty-string option present → remain active;
- never auto-select the first option;
- never replace a missing value with another option.

Reconciliation occurs after all providers are merged and before Panel execution.

Use:

```js
state.varValues
state.filterActive
```

without introducing a separate curated-filter value store.

---

## Control behavior

Use the shared accessible combobox foundation in strict mode.

A curated field:

- opens on focus;
- filters its complete normalized option list;
- supports keyboard and pointer selection;
- rejects unmatched arbitrary text;
- distinguishes inactive from active empty string;
- never auto-selects;
- persists exactly through existing state;
- records successful bound values through existing history behavior;
- does not show a separate recent-values section while curated options are healthy.

Inactive labels remain:

- `All` when optional in every affected Panel;
- `Not set` when required by at least one affected Panel.

Lifecycle states:

```text
Loading options…
No options
Option query failed · Retry
Invalid helper · Use ordinary input
Conflicting providers · Use ordinary input
Showing first 1,000 options
```

On source/helper failure:

- keep the ordinary current field available;
- show a warning/configuration affordance;
- do not leave the field permanently disabled.

---

## Shared option control renderer

Extract the strict curated control into a shared leaf renderer used by:

- Dashboard filter bar;
- workbench Filter preview.

Suggested module:

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
  onCommit,
}) -> {
  el,
  input,
  destroy?
}
```

The renderer owns:

- searchable strict selection;
- keyboard/pointer behavior;
- empty/inactive distinction;
- option labels;
- lifecycle display.

It does not own:

- source execution;
- bundle parsing;
- app persistence;
- Dashboard rerun planning;
- role configuration.

The Dashboard injects real shared state and commits.

The preview injects local sandbox state and no Dashboard reruns.

---

## Workbench behavior

A Filter source remains a normal saved query.

In SQL mode:

- Run executes it normally through Filter-source owned transport when the role is `filter`;
- Table and JSON inspection remain available;
- Filter preview becomes available;
- the existing Panel configuration remains preserved;
- explicit Panel preview remains available for inspecting dormant Panel configuration;
- changing the dashboard role never deletes Panel configuration.

The Filter preview never executes SQL itself.

It uses only the last completed explicit Run result.

---

## Preview UX decision

Filter is not a Panel. The UI should not encode it as a Panel type.

Three viable variants follow.

## Variant A — Add “Filter” to the existing Panel selector

Example:

```text
Panel… [KPI | Bar | Line | Logs | Text | Filter]
```

Selecting `Filter` would open the Filter preview and possibly set:

```json
{
  "dashboard": {
    "role": "filter"
  }
}
```

### Pros

- very discoverable;
- uses an existing compact control;
- no extra toolbar button;
- users naturally look near result visualization controls.

### Cons

- current selector is explicitly a `panel.cfg.type` editor;
- every current option maps to `switchPanelType()`;
- Filter would be the only option that mutates `dashboard.role` instead;
- it incorrectly presents Filter as a visualization renderer;
- it risks adding Filter to `PANEL_TYPES`, auto-detection, queryless-panel logic, or dashboard tile dispatch;
- selecting another visual type becomes ambiguous: does it also change role back to Panel?
- dormant Panel configuration may be accidentally replaced or rewritten;
- the control label and accessibility description become false;
- implementation creates a mixed-mode special case at a clean architecture boundary.

### Verdict

**Not recommended.**

Do not add `filter` to:

```text
PANEL_TYPE_IDS
PANEL_PICKER_OPTIONS
panel.cfg.type
```

---

## Variant B — Dedicated “Filter preview” result button beside the Panel selector

Example toolbar:

```text
Table | JSON | Panel… | Filter preview
```

Behavior:

- show the button only when `dashboard.role === "filter"`;
- clicking it activates a transient Filter-preview result mode;
- it does not change the role;
- it does not write `panel.cfg`;
- it does not change persisted `spec.view`;
- Panel preview remains independently available through `Panel…`;
- reopening a tab restores the existing persisted Table/JSON/Panel preference, not Filter preview.

### Pros

- clearest semantic separation;
- one-click discoverability;
- Filter remains a role, not a renderer;
- no panel-registry pollution;
- no special behavior inside `switchPanelType()`;
- dormant Panel configuration remains safe;
- works naturally with last-Run result data;
- easy to make active/inactive like other result controls;
- lets authors compare Table, JSON, Panel, and Filter interpretations of the same result.

### Cons

- adds one toolbar action;
- requires one transient internal result-view state;
- responsive toolbar behavior must be checked;
- the button is meaningful only for Filter-role queries.

### Verdict

**Recommended.**

Label:

```text
Filter preview
```

Accessible title:

```text
Preview this Filter source’s option helpers
```

The role itself remains authored in the Spec editor.

---

## Variant C — Secondary “Filter preview” button or mode inside the Panel drawer

Example:

```text
Panel drawer
[Panel preview] [Filter preview]
```

or, for Filter-role queries:

```text
This query is a Filter source.
[Preview filters]
```

### Pros

- avoids another top-level toolbar control;
- reuses existing drawer layout and body area;
- can expose dormant Panel preview and Filter preview side by side;
- implementation may reuse existing drawer lifecycle.

### Cons

- Filter remains conceptually nested under “Panel”;
- less discoverable;
- requires opening Panel before finding Filter preview;
- adds another local mode/state inside an already type-sensitive drawer;
- unclear which preview should open by default for a Filter source;
- can confuse authors into thinking Filter is a Panel subtype;
- harder to make keyboard and accessibility labels unambiguous.

### Verdict

Acceptable only if toolbar space makes Variant B impractical.

---

## Recommended preview behavior

Adopt Variant B.

When `dashboard.role === "filter"`:

- render a `Filter preview` button beside the Panel selector;
- activating it uses a transient workbench view;
- no Spec field changes;
- no query execution;
- no persisted view change.

## No result yet

Show:

```text
Run the query to preview its Filter helpers.
```

## Query running

Show:

```text
Filter preview renders when the query completes.
```

Do not render partial arrays/maps while streaming.

## Successful result

Show one preview section per normalized helper in result-column order.

Example:

```text
origin                    342 options
[ All ▾ ]

destination               355 options
[ All ▾ ]

year                       38 options
[ All ▾ ]
```

Each preview field uses local sandbox state:

- selecting an option demonstrates strict behavior;
- it does not write `state.varValues`;
- it does not write `state.filterActive`;
- it does not rerun anything;
- reopening/re-running may reset preview selection.

Display helper metadata:

- target name;
- ClickHouse source type;
- normalized option count;
- consumer match;
- target parameter type when known;
- truncation;
- helper-specific warnings/errors.

## Invalid result

Show source-level and helper-level diagnostics in the preview.

Valid helpers may still render beside an invalid helper.

## Matching consumer absent

Preview still works and shows:

```text
No current Dashboard Panel uses parameter "origin".
```

This is a warning, not a Save blocker.

---

## Preview ordering

In workbench preview:

- helper sections follow result-column order;
- array options follow array order;
- map options use deterministic label/value sorting.

In the Dashboard filter bar:

- existing consumer-field order remains authoritative;
- a Filter source upgrades fields in place;
- a source query does not reorder the global filter bar.

---

## Diagnostics and validation surfaces

Follow the separation used by KPI and Spec autocomplete.

## Static source-local errors

Examples:

- empty SQL;
- multiple statements;
- non-row-returning statement;
- Filter-source parameters;
- authored trailing `FORMAT`.

These are real errors and may:

- appear in the Spec/feature diagnostics;
- block Save;
- navigate to the relevant Spec/SQL location where possible.

## Result-aware errors

Examples:

- row count;
- invalid helper type;
- NULL option;
- invalid labeled tuple;
- no valid helpers;
- option incompatible with consumer type.

These appear after Run in:

- Filter preview;
- Dashboard configuration diagnostics;
- source role badge/status.

They do not block saving a structurally valid draft merely because no current result exists.

## Cross-Library errors

Examples:

- duplicate provider for one target;
- conflicting consumer declarations.

These appear in Dashboard configuration diagnostics and relevant role badges.

They should not make the bottom Spec editor area a general warning console.

## Warnings and information

Examples:

- unused helper;
- truncation;
- duplicate option deduplication.

These do not block Save.

Only real blocking errors belong in the bottom error area, consistent with #221.

---

## Suggested stable diagnostics

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
filter-source-failed
```

Diagnostics should include:

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

Do not expose raw parser or network objects directly to UI.

---

## Library and workbench badges

Update role summaries.

Since target names are result-derived and may require execution, persisted Library badges should not claim one target.

Use:

```text
★ Airport options          [Filter source]
★ Authentication errors   [Panel · Logs]
★ Dashboard setup         [Setup]
```

Workbench role badge:

```text
Airport options     Filter source
```

Clicking the badge:

1. opens/activates the saved-query tab;
2. switches to Spec mode;
3. navigates to `dashboard.role`.

After a successful current Run, the workbench may show a transient summary:

```text
Filter source · origin, destination, year
```

Do not persist that derived summary.

---

## Spec autocomplete

With #221:

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

The `filter` information pane explains the one-row multi-helper result contract.

Do not offer `dashboard.param`.

Do not maintain a separate editor-owned role or helper list.

Target names are authored as SQL aliases and become visible through the result/preview.

---

## Dashboard ordinary-control fallback

The ordinary Dashboard field is always the resilience fallback.

Use it when:

- source query fails;
- source is invalid;
- helper is invalid;
- helper is truncated only if policy chooses not to allow truncation;
- duplicate providers conflict;
- consumer declarations conflict;
- option value validation fails.

The fallback retains:

- current stored value;
- current activation state;
- recents;
- Enum suggestions;
- relative-time support where applicable;
- existing validation.

The Dashboard must never leave a filter unusable solely because its curated source failed.

---

## Network and cancellation

Each Filter source owns:

```text
generation
AbortController
status
lastResult
```

Requirements:

- newer request supersedes older;
- abort previous request when practical;
- ignore stale responses;
- Refresh supersedes all current source requests;
- dashboard close aborts outstanding requests;
- Retry supersedes only one source;
- all source queries share a bounded concurrency ceiling;
- source queries complete before the first dependent Panel wave;
- a failed source does not cancel unrelated sources.

Reuse the latest-request/generation patterns already used by Dashboard tiles.

---

## Core orchestration API

Suggested pure planning helpers:

```js
partitionDashboardQueries(queries) -> {
  panels,
  filters,
  setups,
  excluded,
  diagnostics
}

mergeFilterOptionBundles({
  bundles,
  consumerFields
}) -> {
  providersByName,
  helpersByName,
  diagnostics
}

reconcileCuratedFilters({
  values,
  active,
  helpersByName
}) -> {
  values,
  active,
  changedNames,
  diagnostics
}
```

Suggested stateful scheduler remains in Dashboard UI/controller code, but pure planning and reconciliation should be separately tested.

---

## Files

Expected additions:

```text
src/core/clickhouse-type.js
src/core/filter-options.js
src/core/filter-source-execution.js
src/core/dashboard-filters.js

src/ui/filter-option-field.js
src/ui/filter-source-preview.js

tests/unit/clickhouse-type.test.js
tests/unit/filter-options.test.js
tests/unit/filter-source-execution.test.js
tests/unit/dashboard-filters.test.js
tests/unit/filter-option-field.test.js
tests/unit/filter-source-preview.test.js
```

Expected modifications:

```text
schemas/query-spec-v1.schema.json
src/generated/query-spec-v1-schema.js
src/generated/query-spec-v1-validator.js

src/core/kpi.js
src/core/panel-cfg.js
src/core/saved-query.js
src/core/dashboard.js

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

tests/unit/panel-cfg.test.js
tests/unit/panels.test.js
tests/unit/dashboard.test.js
tests/unit/filter-bar.test.js
tests/unit/saved-history.test.js
tests/unit/spec-schema.test.js
tests/unit/app.test.js
tests/e2e/dashboard.spec.js
tests/e2e/editor.spec.js
```

Exact file names may vary, but pure result normalization and shared UI rendering must remain separate.

---

## Implementation plan

## Phase 1 — Freeze contract and schema language

1. Replace the one-source/one-param model.
2. Remove `dashboard.param` from the issue design.
3. Define exact one-row option-bundle contract.
4. Define Array, named-tuple Array, and Map helper types.
5. Define helper-level partial success.
6. Define no-source-parameters rule.
7. Update canonical schema descriptions/annotations.
8. Confirm `specVersion` remains 1.
9. Confirm Filter never enters the panel registry.
10. Record Variant B as the preview decision.

Deliverable: stable public authoring and runtime contract.

## Phase 2 — Shared ClickHouse type parser

1. Extract nested type parsing from KPI.
2. Support Nullable, Array, Map, and named Tuple nodes.
3. Keep KPI behavior byte-for-byte equivalent.
4. Add generic scalar classification.
5. Cover nested commas, quoting, whitespace, and malformed types.
6. Reach 100% per-file coverage.

Deliverable: one parser shared by KPI and Filter helpers.

## Phase 3 — Pure option-bundle reader

1. Implement row-count validation.
2. Detect duplicate result-column names.
3. Normalize scalar arrays.
4. Normalize labeled tuple arrays.
5. Normalize maps.
6. Normalize exact scalar values.
7. Deduplicate first-wins.
8. Apply per-helper caps.
9. Produce helper-specific diagnostics.
10. Support partial success.
11. Match optional consumer metadata.
12. Reach 100% per-file coverage.

Deliverable: normalized helpers independent of DOM/network/state.

## Phase 4 — Owned execution transport

1. Add Filter-source execution resolver.
2. Detect authored trailing `FORMAT`.
3. Add logical structured format.
4. Preserve arrays/maps/named tuples.
5. Quote precision-sensitive values.
6. Set row and byte limits.
7. Keep progress and cancellation.
8. Add request/format tests.

Deliverable: reliable one-row structured source results.

## Phase 5 — Shared strict option control

1. Extract/reuse combobox foundation.
2. Add strict curated options.
3. Preserve inactive versus active empty string.
4. Add local preview mode.
5. Add lifecycle states.
6. Add accessible labels and keyboard tests.
7. Avoid recents while curated options are healthy.
8. Reach 100% per-file coverage where applicable.

Deliverable: one control renderer for preview and Dashboard.

## Phase 6 — Workbench Filter preview

1. Add dedicated Filter-preview button.
2. Show it only for `dashboard.role="filter"`.
3. Add transient result-view state.
4. Do not persist it to `spec.view`.
5. Render from last completed explicit Run only.
6. Show one field per helper.
7. Use sandbox selection state.
8. Show source/helper diagnostics.
9. Keep Table/JSON/Panel inspection available.
10. Add toolbar/responsive/accessibility tests.

Deliverable: author can inspect exactly how helpers become strict controls.

## Phase 7 — Dashboard partition and scheduler

1. Partition roles before tile analysis.
2. Analyze consumer fields from Panel sources only.
3. Create one source request state per Filter source.
4. Run valid sources in parallel.
5. Normalize option bundles.
6. Merge helpers by exact name.
7. detect duplicate providers;
8. validate options against consumer types;
9. upgrade valid fields in place;
10. reconcile persisted state;
11. run Panels after reconciliation;
12. preserve fallback fields for failures.
13. Add Refresh and Retry orchestration.
14. Keep Filter changes from rerunning sources.

Deliverable: multi-helper curated Dashboard filters.

## Phase 8 — Badges, diagnostics, and completion

1. Add `[Filter source]` Library badge.
2. Add workbench role badge.
3. Navigate badge clicks to `dashboard.role`.
4. Add configuration-diagnostics affordance.
5. Update role completion documentation.
6. Remove `dashboard.param` completion/tests.
7. Keep warnings out of bottom error area.
8. Add transient successful helper summary where useful.

Deliverable: understandable authoring and failure UX.

## Phase 9 — Documentation and regression

1. Add simple-array SQL example.
2. Add labeled-array SQL example.
3. Add Map example and ordering caveat.
4. Document exact alias matching.
5. Document limits and byte-cap caveat.
6. Document preview behavior.
7. Update README and changelog.
8. Run unit, integration, E2E, build, and audit.

Deliverable: shippable feature and public contract.

---

## Test plan

## ClickHouse type parser

Cover:

- scalar;
- Nullable scalar;
- Array scalar;
- Array Nullable scalar;
- Map scalar/scalar;
- named Tuple;
- Array named Tuple;
- nested generics;
- quoted tuple-member names;
- whitespace;
- malformed unbalanced types;
- commas inside nested types;
- KPI regression suite unchanged.

## Bundle envelope

Verify:

- zero rows;
- one row;
- multiple rows;
- zero columns;
- duplicate column names;
- helper-count cap;
- input objects/arrays not mutated.

## Scalar arrays

Verify:

- String;
- integer;
- UInt64 beyond safe integer;
- Decimal;
- Float;
- UUID;
- Date/DateTime;
- Bool;
- empty array;
- empty-string option;
- NULL item;
- unsupported nested value;
- order preservation;
- truncation.

## Labeled tuple arrays

Verify:

- value/label;
- member order differences;
- additional tuple members;
- missing value;
- missing label;
- NULL value;
- NULL label;
- unsupported value type;
- unsupported label type;
- unnamed positional tuple;
- exact order;
- truncation.

## Maps

Verify:

- String/String;
- numeric-like key strings;
- exact value conversion;
- deterministic label/value sorting;
- empty Map;
- unsupported nested label;
- truncation;
- query-contract duplicate-key documentation.

## Duplicate values

Verify:

- first value wins;
- first label wins;
- duplicate labels allowed;
- active empty-string option remains distinct;
- informational diagnostic.

## Partial success

Verify:

- valid helper + invalid helper;
- valid helpers survive;
- no valid helpers becomes source error;
- envelope error blocks all helpers.

## Consumer matching

Verify:

- exact name match;
- case mismatch;
- unused helper warning;
- consistent target type;
- conflicting target types;
- invalid option for consumer type;
- unrelated helpers remain usable.

## Duplicate providers

Verify:

- two sources target same name;
- neither wins for that name;
- fallback remains;
- other helper names from both sources remain valid;
- Library order does not select a winner.

## Source validation

Verify:

- empty SQL;
- one row-returning statement;
- multiple statements;
- DDL/non-row-returning;
- own required parameter;
- own optional-block parameter;
- trailing top-level FORMAT;
- FORMAT in string/comment/subquery is not mistaken for trailing clause.

## Owned execution

Verify:

- structured nested output selected;
- row limit detects second row;
- named tuples objects enabled;
- large integers/Decimals/floats quoted safely;
- readonly and byte limit set;
- progress/exception path remains;
- authored FORMAT sends no request.

## Preview UX

Verify:

- button visible only for Filter role;
- button does not mutate Spec;
- button does not mutate `panel.cfg`;
- button does not persist `spec.view`;
- no result hint;
- running hint;
- successful helpers;
- partial helper errors;
- local option selection only;
- no writes to shared filter state;
- no query execution from preview;
- Panel preview remains available.

## Preview variant regression

Verify explicitly:

- `filter` is absent from `PANEL_TYPE_IDS`;
- `filter` is absent from `PANEL_PICKER_OPTIONS`;
- `isKnownPanelType("filter")` is false;
- `switchPanelType(..., "filter")` is never used;
- dashboard role switching preserves panel cfg.

## Dashboard partition

Verify:

- favorite Panel becomes tile;
- favorite Filter becomes source and no tile;
- favorite Setup remains separate;
- non-favorite Filter absent;
- unknown role excluded;
- Filter source not counted as “not shown”;
- Panel parameter analysis excludes Filter-source SQL.

## Dashboard execution

Verify:

- ordinary controls render immediately;
- sources run before Panels;
- several sources run under limiter;
- one source provides several helpers;
- helpers merge before reconciliation;
- persisted active present value retained;
- persisted stale value deactivated/dormant;
- no auto-selection;
- source failure falls back;
- partial helper failure falls back only one field;
- Panel wave starts after reconciliation;
- Filter change reruns affected Panels only;
- Refresh reruns sources then all Panels;
- Retry reruns one source;
- stale/aborted results never land.

## Control behavior

Verify:

- strict unmatched text rejection;
- search/filter;
- keyboard navigation;
- pointer selection;
- inactive sentinel;
- active empty string;
- All versus Not set;
- loading;
- no options;
- failed source;
- duplicate provider;
- truncation message;
- fallback ordinary control;
- no curated recents section.

## Badges and completion

Verify:

- `[Filter source]` badge;
- no stale single-param badge;
- badge navigates to Spec dashboard role;
- role completion includes filter;
- completion docs describe bundle contract;
- no `dashboard.param` suggestion;
- warnings stay out of bottom error area.

## Regression

Verify:

- KPI reader/renderer unchanged;
- existing Panel registry unchanged;
- Table/JSON/Panel workbench views unchanged;
- existing Dashboard ordinary filters unchanged without Filter sources;
- optional-block behavior unchanged;
- typed parameter serializer unchanged;
- recents unchanged for ordinary fields;
- unknown Spec extensions preserved;
- Library v1/v2 import/export unchanged;
- generated schema drift checks pass.

---

## Acceptance criteria

- [ ] One Filter-source query may provide several dashboard filter helpers.
- [ ] The source returns exactly one row.
- [ ] Every top-level result-column name is treated as an exact target parameter name.
- [ ] Scalar Arrays provide ordered value=label options.
- [ ] Named `Array(Tuple(value, label))` provides ordered labeled options.
- [ ] Maps provide deterministic value/label options with documented ordering.
- [ ] Large integers and Decimals remain lossless.
- [ ] NULL options are rejected.
- [ ] Duplicate values are first-wins.
- [ ] Empty-string option remains distinct from inactive.
- [ ] Valid helpers survive unrelated invalid helpers.
- [ ] Duplicate top-level helper names reject the source.
- [ ] Helpers without consumers remain previewable and produce warnings.
- [ ] Conflicting consumer declarations use ordinary fallback.
- [ ] Duplicate providers use ordinary fallback for only the conflicting target.
- [ ] `dashboard.param` is not used.
- [ ] `filter` is not a panel type.
- [ ] `filter` is not added to the panel picker or registry.
- [ ] Existing `spec.panel` remains preserved while role is Filter.
- [ ] Filter sources are configured through `spec.dashboard.role`.
- [ ] `specVersion` remains 1.
- [ ] Filter sources own their structured result transport.
- [ ] Authored trailing FORMAT blocks execution.
- [ ] Source SQL has exactly one row-returning statement and no parameters.
- [ ] Workbench has a dedicated Filter-preview button.
- [ ] Filter preview uses only the last explicit completed Run.
- [ ] Filter preview does not execute SQL.
- [ ] Filter preview uses local sandbox state.
- [ ] Filter preview does not mutate shared filter values.
- [ ] Preview and Dashboard use the same pure reader and control renderer.
- [ ] Filter sources create no dashboard grid slots.
- [ ] Ordinary controls render before option sources complete.
- [ ] All curated selections reconcile before Panel execution.
- [ ] A failed source degrades to ordinary controls.
- [ ] Refresh reruns sources before Panels.
- [ ] Filter changes do not rerun sources.
- [ ] Retry reruns one source.
- [ ] Request cancellation and generation guards prevent stale results.
- [ ] Per-helper option cap and source byte cap are enforced.
- [ ] Library badge says `Filter source`, not one target.
- [ ] Schema completion explains the bundle contract.
- [ ] Only real errors appear in the bottom diagnostics area.
- [ ] Pure new core modules meet 100% per-file coverage requirements.
- [ ] KPI regression tests pass.
- [ ] `npm test` passes.
- [ ] `npm run build` succeeds.
- [ ] No new runtime dependency is introduced.
- [ ] `npm audit --omit=dev` reports no new runtime vulnerability.

---

## Definition of done

A user can save:

```sql
SELECT
    arraySort(groupUniqArray(toString(Origin))) AS origin,
    arraySort(
        item -> item.label,
        groupUniqArray((
            Dest AS value,
            DestCityName AS label
        ))
    ) AS destination,
    mapFromArrays(
        arrayMap(x -> toString(x), arraySort(groupUniqArray(Year))),
        arrayMap(x -> toString(x), arraySort(groupUniqArray(Year)))
    ) AS year
FROM ontime
```

with:

```json
{
  "name": "Flight filter options",
  "favorite": true,
  "dashboard": {
    "role": "filter"
  }
}
```

After Run, the dedicated Filter preview shows three strict searchable fields using the same normalized option data and control renderer as the Dashboard.

On Dashboard open:

- the query creates no tile;
- `origin`, `destination`, and `year` upgrade existing parameter fields;
- persisted values reconcile before Panels run;
- invalid helpers fall back independently;
- no first option is auto-selected;
- no Filter-specific panel type or panel-registry entry exists.
