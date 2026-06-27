// Pure assembly + sizing of the rich node "cards" the fullscreen schema graph
// draws. No DOM, no fetch — the column/skip-index rows come from ch-client
// (loadSchemaCards) and the SVG drawing lives in src/ui/explain-graph.js. Kept
// pure so the geometry (which dagre needs *before* layout) is fully testable
// under happy-dom, which has no layout engine to measure rendered text.

import { formatRows, formatBytes } from './format.js';

// Card geometry — the single source of truth shared by cardSize() (which feeds
// dagre) and the SVG renderer (which places text at these offsets). HEADER_H
// covers the title + summary lines; each column/overflow/skip row is ROW_H tall.
export const CARD = {
  ROW_H: 15,
  HEADER_H: 36, // title + summary band; the divider sits at HEADER_H
  TITLE_Y: 15, // title text baseline (within the header band)
  SUMMARY_Y: 29, // summary text baseline (must stay < HEADER_H)
  ROW_BASELINE: 11, // text baseline offset within each ROW_H column row
  CHAR_W: 6.5, // monospace width estimate (mirrors dot-layout's CHAR_W intent)
  PAD_X: 10,
  BADGE_W: 26, // approx width of one role badge (PK/SK/PARTITION/SAMPLING)
  MIN_W: 130,
  MAX_COLS: 16,
  MAX_TYPE: 28, // truncate the displayed column type — a big Enum/Tuple/Map would
                // otherwise blow the card (and the whole graph) absurdly wide.
};

// Clamp an over-long column type for the card (the full type stays in the detail
// pane). Keeps a giant inline Enum8('a'=1, …) from stretching the layout.
const clampType = (t) => {
  const s = String(t == null ? '' : t);
  return s.length > CARD.MAX_TYPE ? s.slice(0, CARD.MAX_TYPE - 1) + '…' : s;
};

// A ClickHouse UInt8 flag is 1/0, but JSON vs JSONStrings formats deliver it as
// a number or a string — treat both (and a real boolean) uniformly.
const isFlag = (v) => v === true || Number(v) === 1;

/** The key-role badges a column carries, in display order. */
export function columnRoles(col) {
  const c = col || {};
  const roles = [];
  if (isFlag(c.is_in_primary_key)) roles.push('PK');
  if (isFlag(c.is_in_sorting_key)) roles.push('SK');
  if (isFlag(c.is_in_partition_key)) roles.push('PARTITION');
  if (isFlag(c.is_in_sampling_key)) roles.push('SAMPLING');
  return roles;
}

/**
 * Build the display model for one node's card from its lineage row + columns +
 * skip-indices. `node` carries `{ label, kind }`; `tableRow` is the system.tables
 * row (engine/total_rows/total_bytes), `columns` the system.columns rows, and
 * `skipIndices` the system.data_skipping_indices rows — any may be missing (an
 * external/dictionary-source leaf has none), degrading to a header-only card.
 */
export function buildCardModel(node, tableRow, columns, skipIndices) {
  const n = node || {};
  const tr = tableRow || {};
  const engine = tr.engine || n.kind || 'table';
  const summary = engine + ' · ' + formatRows(tr.total_rows) + ' rows · ' + formatBytes(tr.total_bytes);
  const allCols = columns || [];
  const cols = allCols.slice(0, CARD.MAX_COLS).map((c) => ({
    name: c.name, type: clampType(c.type), roles: columnRoles(c),
  }));
  const overflow = Math.max(0, allCols.length - CARD.MAX_COLS);
  const idx = skipIndices || [];
  const skipLine = idx.length
    ? 'idx: ' + idx.map((i) => i.name + ' (' + (i.type || '') + ')').join(', ')
    : '';
  return { title: n.label || n.id || '', kind: n.kind || 'table', summary, cols, overflow, skipLine };
}

/**
 * The pixel size {w,h} of a card, computed purely from its model so dagre can lay
 * it out. Height = header + one row per shown column (+ overflow + skip rows);
 * width = the widest text line (monospace estimate) plus side padding, floored at
 * MIN_W. `opts` overrides the CARD constants (used by tests).
 */
export function cardSize(model, opts = {}) {
  const m = model || { title: '', summary: '', cols: [], overflow: 0, skipLine: '' };
  const ROW_H = opts.rowH != null ? opts.rowH : CARD.ROW_H;
  const HEADER_H = opts.headerH != null ? opts.headerH : CARD.HEADER_H;
  const CHAR_W = opts.charW != null ? opts.charW : CARD.CHAR_W;
  const PAD_X = opts.padX != null ? opts.padX : CARD.PAD_X;
  const BADGE_W = opts.badgeW != null ? opts.badgeW : CARD.BADGE_W;
  const rowCount = m.cols.length + (m.overflow ? 1 : 0) + (m.skipLine ? 1 : 0);
  const h = HEADER_H + rowCount * ROW_H;
  const textW = (str) => String(str).length * CHAR_W;
  let maxLine = Math.max(textW(m.title), textW(m.summary));
  for (const c of m.cols) {
    maxLine = Math.max(maxLine, textW(c.name + ' ' + c.type) + c.roles.length * BADGE_W);
  }
  if (m.overflow) maxLine = Math.max(maxLine, textW('+' + m.overflow + ' more'));
  if (m.skipLine) maxLine = Math.max(maxLine, textW(m.skipLine));
  const w = Math.max(CARD.MIN_W, Math.round(maxLine + PAD_X * 2));
  return { w, h };
}

/**
 * Attach a `.card` model to every node of a lineage `graph` (from
 * buildSchemaGraph), looking up each node's row/columns/skip-indices by `db.table`
 * id. Pure: `data = { tables, columnsByKey, skipByKey }`. Returns a new graph
 * `{ nodes, edges }` (edges passed through) for the rich renderer.
 */
export function buildCardGraph(graph, data) {
  const g = graph || {};
  const d = data || {};
  const tablesByKey = new Map((d.tables || []).map((t) => [t.database + '.' + t.name, t]));
  const colsByKey = d.columnsByKey || {};
  const skipByKey = d.skipByKey || {};
  const nodes = (g.nodes || []).map((n) => ({
    ...n,
    card: buildCardModel(n, tablesByKey.get(n.id), colsByKey[n.id], skipByKey[n.id]),
  }));
  return { nodes, edges: g.edges || [] };
}
