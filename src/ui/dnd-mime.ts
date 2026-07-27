// Drag-and-drop dataTransfer MIME types shared by drag sources (schema tree,
// saved/history lists) and drop targets (the editor adapter, the results pane).
// A neutral module — not the editor — so drag sources never import an editor
// adapter (#143), and the CM6 adapter (#21) consumes the same constants.

// Dragging a schema identifier onto the editor. A dedicated type (not
// text/plain) scopes the drop handler to schema-tree drags, leaving native
// text drag-within-the-editor untouched.
export const IDENT_MIME = 'application/x-asb-identifier';

// Dragging a whole saved/history query onto the editor; the drop wraps it as a
// `( … )` subquery at the drop position (see the editor's drop handler).
export const SUBQUERY_MIME = 'application/x-asb-subquery';

// Dragging a database/table from the schema tree onto the results pane →
// render its lineage graph. Payload is JSON `{kind, db, table?}`.
export const SCHEMA_GRAPH_MIME = 'application/x-asb-schema-graph';

// Dragging a column's type meta (not its name) onto the editor — the full
// schema-provided ClickHouse type, never the compacted display text (#186).
// Kept separate from IDENT_MIME: IDENT_MIME is scoped to identifiers, and a
// type expression is not one.
export const COLUMN_TYPE_MIME = 'application/x-asb-column-type';

// Dragging a LIBRARY query onto a Dashboard destination (#428). Payload is the
// JSON identity `{kind, workspaceId, queryId}` from `core/library-drag.ts`.
//
// A Library row publishes this ALONGSIDE `SUBQUERY_MIME`, so one gesture serves
// two very different readers: the editor takes the SQL snapshot and inserts it,
// while a Dashboard row/Panels group/Variables row takes the identity and
// re-resolves it against committed truth inside `mutateWorkspace`. Keeping them
// separate is what lets the editor stay byte-for-byte unchanged (PR #40) while
// Dashboard assignment refuses to trust anything it read off `dataTransfer`.
//
// History rows deliberately do NOT publish this one: a history entry has no
// stable saved-query identity to re-resolve, so it can only ever be text.
export const LIBRARY_QUERY_MIME = 'application/x-asb-library-query';
