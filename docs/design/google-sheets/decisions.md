# Architecture decisions

## GS-001 — Google Sheets is the integration target

Status: accepted.

Google Sheets is the collaborative exploration and presentation surface. Google Docs is outside this project.

## GS-002 — Manual refresh launches the SPA

Status: accepted.

The spreadsheet contains a hyperlink to the ClickHouse-hosted SQL Browser SPA. Google does not call SQL Browser, and SQL Browser does not listen for inbound requests.

## GS-003 — Binding definitions are stored in ClickHouse

Status: accepted.

Bindings use append-only versions in a deployment-configured ClickHouse table. This enables durable cross-browser resolution while preserving ClickHouse authorization as the security boundary.

## GS-004 — Bindings pin saved-query snapshots

Status: accepted.

Editing a workspace query does not silently change an existing spreadsheet. Updating the binding is explicit and versioned.

## GS-005 — Full refresh uses staging

Status: accepted.

The previous managed dataset remains live until the complete replacement is uploaded and published into the stable managed sheet ID.

## GS-006 — Append mode requires newer ClickHouse

Status: accepted.

Append mode begins with a configurable minimum of ClickHouse 26.8 and remains subject to runtime capability probes. Older or incompatible servers use full refresh only.

## GS-007 — Append cursor uses commit position

Status: accepted.

The checkpoint is a per-partition map of `_block_number` and `_block_offset`. Values are stored as decimal strings. Updates and deletes are not represented.

## GS-008 — Streaming SELECT is out of scope

Status: accepted.

`SELECT ... STREAM` is not used. Manual refresh consists of finite bounded queries followed by a Google commit.

## GS-009 — Google state is the destination commit authority

Status: accepted.

The hidden `_ASB_STATE` worksheet records the committed row count, generation, hashes, and append checkpoint. Rows and checkpoint are advanced together.

## GS-010 — Managed and user-owned sheets are separate

Status: accepted.

SQL Browser modifies only control, state, staging, and managed data worksheets. User analysis, pivot, and chart worksheets are preserved.

## GS-011 — No silent fallback or truncation

Status: accepted.

Append incompatibility requires explicit full refresh approval. Capacity and limit failures stop with diagnostics rather than truncating or weakening publication safety.

## GS-012 — Concurrency is advisory in V1

Status: accepted.

Use refresh leases and generation checks, but do not promise strict distributed locking between collaborators without a coordinating backend or Apps Script.
