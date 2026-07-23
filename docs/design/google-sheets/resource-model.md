# Resource model

## Binding

A linked spreadsheet is a first-class workspace resource. One saved query may have multiple bindings.

```ts
interface GoogleSheetBindingV1 {
  version: 1;
  id: string;
  name: string;

  spreadsheetId: string;
  controlSheetId: number;
  managedSheetId: number;
  stateSheetId: number;

  sourceQueryId: string | null;
  sourceQuerySnapshot: SavedQueryPortableV1;
  sourceQueryHash: string;
  schemaHash: string | null;

  refreshMode: 'full' | 'append';
  parameterPolicy: 'stored' | 'prompt' | 'defaults';
  parameters: Record<string, string>;

  appendConfig?: GoogleSheetAppendConfigV1;
  limits: GoogleSheetLimitsV1;
}
```

The pinned query snapshot is authoritative. Editing the workspace query does not silently change the binding. Updating a binding to the current query is explicit and creates a new binding version.

## Append configuration

```ts
interface GoogleSheetAppendConfigV1 {
  kind: 'clickhouse-commit-order';
  minimumClickHouseVersion: string;
  database: string;
  table: string;
  tableUuid: string;
  engine: 'MergeTree' | 'ReplicatedMergeTree';
  initialization: 'history' | 'future-only';
}
```

## Limits

```ts
interface GoogleSheetLimitsV1 {
  maxRowsFullRefresh: number;
  maxRowsPerAppendRun: number;
  maxManagedCells: number;
  maxSerializedBytes: number;
  googleRequestTargetBytes: number;
  commitBatchRows: number;
}
```

## Google checkpoint

The hidden state worksheet is authoritative for destination commit state.

```ts
interface GoogleSheetCheckpointV1 {
  version: 1;
  bindingId: string;
  generation: string;
  committedRows: string;
  sourceQueryHash: string;
  schemaHash: string;
  tableUuid?: string;
  partitions?: Record<string, {
    blockNumber: string;
    blockOffset: string;
  }>;
  lastRefreshId: string;
  lastRefreshAt: string;
}
```

All `UInt64` values are decimal strings and must never round-trip through JavaScript `number`.

## Server storage

Bindings are stored as append-only versions in a configured ClickHouse table. Refresh history is stored in a separate configured append-only table. The SPA never creates, alters, or migrates these tables.

ClickHouse grants and row policies remain the authorization layer. The application does not implement a second ACL system.

## Portability

Workspace export preserves binding metadata needed for navigation and relinking, but never exports Google or ClickHouse credentials. Imported bindings must be revalidated against the current server, binding table, spreadsheet identity, and current user permissions before refresh is enabled.
