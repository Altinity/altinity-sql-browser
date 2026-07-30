---
name: sql-browser-dashboard
description: >
  Build and publish Altinity SQL Browser-compatible business analytics dashboards as
  PortableBundleV2 JSON through an Altinity MCP dynamic tool named save_dashboard.
  Use when the user asks to create, assemble, save, publish, or share a SQL Browser
  dashboard and the analytical SQL plus relevant result-column knowledge is already
  available in the conversation or from another skill/tool. This skill owns Dashboard
  composition, Presentation Specs, flow layout, bundle validation, and the final typed
  save_dashboard call. It does not discover ClickHouse schemas, navigate databases,
  design source data models, or execute analytical queries.
---

# SQL Browser Dashboard

Create one SQL Browser Dashboard that communicates useful business insights, package it as one `PortableBundleV2`, validate it, and publish it through the Altinity MCP dynamic tool whose exact basename is `save_dashboard`.

## Required boundaries

- Use only already-known SQL and result-column information.
- Do not inspect ClickHouse databases, tables, columns, or sample rows.
- Do not call generic SQL execution tools to test or publish the Dashboard.
- Do not invent unknown table or column names.
- Do not use BentoClick's panel schema. Produce the SQL Browser schema described in [references/dashboard-authoring-profile.md](references/dashboard-authoring-profile.md).
- Use the typed `save_dashboard` tool for the write. Do not fall back to `execute_query`, raw `INSERT`, HTTP, or shell clients.
- Publish exactly one Dashboard per bundle.

If the requested Dashboard lacks usable SQL or the output-column order needed by a positional chart, ask for that missing input or state that schema/query discovery must be completed outside this skill.

## Load references selectively

1. Read [references/dashboard-authoring-profile.md](references/dashboard-authoring-profile.md) before constructing the bundle.
2. Read [references/panel-guide.md](references/panel-guide.md) for every panel type used.
3. Read [references/save-dashboard-tool.md](references/save-dashboard-tool.md) immediately before publishing.
4. Consult [references/example-dashboard.json](references/example-dashboard.json) when a complete minimal example is useful.
5. Use [references/sql-browser-dashboard-authoring.schema.json](references/sql-browser-dashboard-authoring.schema.json) as the skill's supported authoring-profile schema. SQL Browser's production schemas remain authoritative.

## Workflow

### 1. Confirm the dashboard contract

Determine from the conversation:

- Dashboard title and business purpose.
- Dashboard description or executive takeaway.
- Available analytical queries.
- Exact result-column order for `bar`, `hbar`, `line`, `area`, and `pie` panels.
- Any ClickHouse parameters already present in SQL, written as `{name:Type}`.
- Any supplied option-list SQL for those inferred variables.

Do not restart database discovery. Ask only for data required to serialize the Dashboard correctly.

### 2. Choose an insight structure

Prefer a compact decision-oriented sequence:

1. headline KPIs;
2. trend or comparison;
3. categorical breakdown;
4. supporting detail table;
5. optional explanatory Markdown.

Avoid filling the page with redundant charts. Every tile must answer a distinct business question.

### 3. Create saved queries

Create one `SavedQueryV2` per distinct tile query.

- Use unique, readable IDs containing only stable ASCII slug characters.
- Preserve supplied SQL exactly except for clearly requested formatting corrections.
- Set `specVersion` to `1`.
- Set `spec.view` to `panel`.
- Set `spec.name` and `spec.description` to business-readable text.
- Set `spec.dashboard.role` to `panel`.
- Configure only implemented panel types: `kpi`, `table`, `bar`, `hbar`, `line`, `area`, `pie`, `logs`, and `text`.
- For chart panels, use zero-based result-column indexes. Never guess the projection order.
- Use `fieldConfig.columns` to provide readable labels, units, decimal precision, descriptions, and missing-value text.

Do not add unused Library queries. The bundle's query array must equal the Dashboard's exact query dependency closure.

### 4. Create the Dashboard document

Create one `DashboardDocumentV2`:

- `documentVersion`: `2`.
- `id`: stable dashboard slug, reused as the catalogue identity.
- `title`: user-visible title.
- `description`: concise purpose and intended audience.
- `revision`: `1` for a newly authored Dashboard.
- `tiles`: one tile per visual instance, in semantic reading order.
- `layout`: `flow@1` using `report`, `columns-2`, or `columns-3`.
- `variableConfigs`: include only supplied option SQL keyed by exact case-sensitive inferred variable name.

Tile `queryId` values must resolve to bundled queries. Layout item keys must resolve to tile IDs.

### 5. Create the portable bundle

Create a top-level object with:

- `$schema`: the SQL Browser PortableBundleV2 schema identifier;
- `format`: `altinity-sql-browser/portable-bundle`;
- `version`: `2`;
- `exportedAt`: current RFC 3339 timestamp;
- `metadata.name` and optional `metadata.description`;
- `queries`: exact dependency closure;
- `dashboards`: an array containing exactly one Dashboard.

Never include credentials, hosts, session data, query results, caches, runtime variable values, tabs, drafts, or unrelated queries.

### 6. Validate before publishing

When code execution is available, write the candidate bundle to a temporary JSON file and run:

```bash
python scripts/validate_bundle.py candidate.json
```

Fix every reported error. The validator checks the supported authoring profile and important cross-resource semantics. It does not replace SQL Browser's production decoder.

Without code execution, manually apply the checklist in [references/dashboard-authoring-profile.md](references/dashboard-authoring-profile.md).

### 7. Publish once

Locate the connected MCP tool whose exact basename is `save_dashboard`. Call it with one argument:

```text
payload = JSON-encoded PortableBundleV2
```

Call it only after the full bundle is complete and validated. Do not make one call per query or tile.

Do not automatically retry after a timeout, transport interruption, or ambiguous MCP error because the insert may have committed. Ask the user to verify catalogue state before attempting another save.

### 8. Report the result

On confirmed success, report:

- Dashboard title;
- Dashboard ID;
- query count;
- tile count;
- that it was published to the SQL Browser Dashboard catalogue.

Do not claim a generated server version unless the tool response explicitly returns it.

## Quality rules

- Optimize for business comprehension, not feature demonstration.
- Put the most decision-relevant information first.
- Keep titles short and descriptions specific.
- Use consistent units and precision.
- Avoid pie charts for numerous categories or values requiring close comparison.
- Prefer line/area for ordered time, bar/hbar for category comparison, KPI for a small one-row summary, and table for exact detail.
- Keep Dashboard variables few, predictable, and directly useful.
- Never publish a structurally invalid bundle merely to let the browser diagnose it later.
