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
