// Pure assembly + sizing of the rich node "cards" the fullscreen schema graph
// draws. No DOM, no fetch — the column rows come from ch-client
// (loadSchemaCards) and the SVG drawing lives in src/ui/explain-graph.js. Kept
// pure so the geometry (which dagre needs *before* layout) is fully testable
// under happy-dom, which has no layout engine to measure rendered text.
//
// Data-skipping indexes are deliberately NOT part of the card model (#179): a
// flattened idx: line inflated card width from the widest index name/type and
// distorted graph spacing. Index metadata lives in the bottom detail drawer
// (schema-detail.js), fetched per-open by ch.loadTableDetail — see that module.

import { formatRows, formatBytes } from './format.js';
import { compactType } from './type-display.js';

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
  MAX_TYPE: 28, // compact the displayed column type — a big Enum/Tuple/Map would
                // otherwise blow the card (and the whole graph) absurdly wide.
};

// Compact an over-long column type for the card (#177): a semantic summary
// (`Enum8(41 values)`) rather than the old blind character cut. The full type
// stays reachable — a per-column <title> in the SVG renderer + the detail pane.
const clampType = (t: unknown): string => compactType(t, CARD.MAX_TYPE);

// A ClickHouse UInt8 flag is 1/0, but JSON vs JSONStrings formats deliver it as
// a number or a string — treat both (and a real boolean) uniformly.
const isFlag = (v: unknown): boolean => v === true || Number(v) === 1;

/** A lineage-graph node, as `buildCardModel`/`buildCardGraph` read it — the
 *  common shape shared by core/schema-graph.ts's `SchemaGraphNode`/
 *  `ExpandLineageNode` (real callers) and a bare test fixture. */
export interface CardGraphNode {
  id?: string;
  label?: string;
  kind?: string;
  [k: string]: unknown;
}

/** One lineage-graph edge, passed through by `buildCardGraph` untouched. */
export interface CardGraphEdge {
  from: string;
  to: string;
  kind: string;
}

/** A `system.tables` row as this module reads it for one card's header — a
 *  subset of net/ch-client.ts's `LineageTableRow`, loose enough for a test's
 *  partial fixture too (every field the card summary reads may be absent —
 *  an external/dictionary-source leaf has no matching row at all). */
export interface CardTableRow {
  database?: string;
  name?: string;
  engine?: string;
  total_rows?: number | string;
  total_bytes?: number | string;
  comment?: string;
}

/** The key-role flags `columnRoles` keys badges on — the minimal shape it
 *  needs regardless of what else a full column row carries. Values arrive as
 *  a number, string, or boolean (JSON vs JSONStrings formats — see `isFlag`
 *  above). */
export interface ColumnRoleFlags {
  is_in_primary_key?: number | string | boolean;
  is_in_sorting_key?: number | string | boolean;
  is_in_partition_key?: number | string | boolean;
  is_in_sampling_key?: number | string | boolean;
  [k: string]: unknown;
}

/** A `system.columns` row as this module reads it for one card — a subset of
 *  net/ch-client.ts's `CardColumnRow` (the loader's real shape). */
export interface SchemaCardColumnRow extends ColumnRoleFlags {
  name: string;
  type: string;
  position?: number;
}

/** The key-role badges a column carries, in display order. */
export function columnRoles(col?: ColumnRoleFlags | null): string[] {
  const c = col || ({} as ColumnRoleFlags);
  const roles: string[] = [];
  if (isFlag(c.is_in_primary_key)) roles.push('PK');
  if (isFlag(c.is_in_sorting_key)) roles.push('SK');
  if (isFlag(c.is_in_partition_key)) roles.push('PARTITION');
  if (isFlag(c.is_in_sampling_key)) roles.push('SAMPLING');
  return roles;
}

/** One column row inside a card's built display model (`buildCardModel`'s
 *  per-column shape) — also `cardSize`'s per-column input. `fullType` differs
 *  from `type` only when the type text was compacted (#177). */
export interface CardModelColumn {
  name: string;
  type: string;
  fullType?: string;
  roles: string[];
}

/** The pure display model one card is built from — `buildCardModel`'s return
 *  shape, and `cardSize`'s (+ dagre's) input. `comment` is a hover-only
 *  tooltip, never a drawn row (#179) — see the module doc above. */
export interface CardModel {
  title: string;
  kind: string;
  summary: string;
  comment: string;
  cols: CardModelColumn[];
  overflow: number;
}

// formatRows/formatBytes take `number | null | undefined`; a total_rows/
// total_bytes value carried as a numeric string (some JSON shapes) is coerced
// the same way the old bare arithmetic-free pass-through effectively was —
// this never changes which values are accepted, only satisfies the stricter
// parameter type.
function numberish(v: number | string | undefined): number | null {
  if (v == null) return null;
  return typeof v === 'number' ? v : Number(v);
}

/**
 * Build the display model for one node's card from its lineage row + columns.
 * `node` carries `{ label, kind }`; `tableRow` is the system.tables row
 * (engine/total_rows/total_bytes/comment) and `columns` the system.columns rows —
 * either may be missing (an external/dictionary-source leaf has none), degrading
 * to a header-only card. Data-skipping indexes are intentionally absent (#179):
 * they belong in the detail drawer, not in card geometry. `comment` (trimmed,
 * untruncated) isn't drawn as its own row — like the plain inline graph, it's a
 * hover-only tooltip on the whole card, so it never affects the card's own layout.
 * `_legacySkipIndexes` is never read — a bygone skip-index-rows argument some
 * callers still pass; accepted and ignored so it can never affect the model.
 */
export function buildCardModel(
  node?: CardGraphNode | null,
  tableRow?: CardTableRow | null,
  columns?: SchemaCardColumnRow[] | null,
  _legacySkipIndexes?: unknown,
): CardModel {
  const n = node || {};
  const tr = tableRow || {};
  const engine = tr.engine || n.kind || 'table';
  const summary = engine + ' · ' + formatRows(numberish(tr.total_rows)) + ' rows · ' + formatBytes(numberish(tr.total_bytes));
  const comment = (tr.comment || '').trim();
  const allCols = columns || [];
  // `fullType` always carries the declared type (same contract as completion
  // items, #177); the renderer compares it against `type` to decide whether a
  // hover <title> adds anything.
  const cols: CardModelColumn[] = allCols.slice(0, CARD.MAX_COLS).map((c) => ({
    name: c.name, type: clampType(c.type), fullType: c.type, roles: columnRoles(c),
  }));
  const overflow = Math.max(0, allCols.length - CARD.MAX_COLS);
  return { title: n.label || n.id || '', kind: n.kind || 'table', summary, comment, cols, overflow };
}

/** `cardSize`'s size-constant overrides (used by tests). */
export interface CardSizeOpts {
  rowH?: number;
  headerH?: number;
  charW?: number;
  padX?: number;
  badgeW?: number;
}

/** `cardSize`'s model input — a loose subset of `CardModel` (`kind` is never
 *  read, so it stays absent from every fixture/test without harm). */
export interface CardSizeModel {
  title?: string;
  summary?: string;
  comment?: string;
  cols: CardModelColumn[];
  overflow: number;
}

/**
 * The pixel size {w,h} of a card, computed purely from its model so dagre can lay
 * it out. Height = header + one row per shown column (+ an overflow row) — the
 * comment is a hover-only tooltip on the whole card, not a row, so it never
 * affects height or width, and data-skipping indexes aren't part of the card at
 * all (#179), so index count/name/type can't change card geometry. Width = the
 * widest text line (monospace estimate) plus side padding, floored at MIN_W.
 * `opts` overrides the CARD constants (used by tests).
 */
export function cardSize(model?: CardSizeModel | null, opts: CardSizeOpts = {}): { w: number; h: number } {
  const m = model || { title: '', summary: '', comment: '', cols: [], overflow: 0 };
  const ROW_H = opts.rowH != null ? opts.rowH : CARD.ROW_H;
  const HEADER_H = opts.headerH != null ? opts.headerH : CARD.HEADER_H;
  const CHAR_W = opts.charW != null ? opts.charW : CARD.CHAR_W;
  const PAD_X = opts.padX != null ? opts.padX : CARD.PAD_X;
  const BADGE_W = opts.badgeW != null ? opts.badgeW : CARD.BADGE_W;
  const rowCount = m.cols.length + (m.overflow ? 1 : 0);
  const h = HEADER_H + rowCount * ROW_H;
  const textW = (str: unknown): number => String(str).length * CHAR_W;
  let maxLine = Math.max(textW(m.title), textW(m.summary));
  for (const c of m.cols) {
    maxLine = Math.max(maxLine, textW(c.name + ' ' + c.type) + c.roles.length * BADGE_W);
  }
  if (m.overflow) maxLine = Math.max(maxLine, textW('+' + m.overflow + ' more'));
  const w = Math.max(CARD.MIN_W, Math.round(maxLine + PAD_X * 2));
  return { w, h };
}

/**
 * Attach a `.card` model to every node of a lineage `graph` (from
 * buildSchemaGraph), looking up each node's row/columns by `db.table` id. Pure:
 * `data = { tables, columnsByKey }`. Returns a new graph `{ nodes, edges }`
 * (edges passed through) for the rich renderer.
 */
export function buildCardGraph(
  graph?: { nodes?: CardGraphNode[]; edges?: CardGraphEdge[] } | null,
  data?: { tables?: CardTableRow[]; columnsByKey?: Record<string, SchemaCardColumnRow[]> } | null,
): { nodes: (CardGraphNode & { card: CardModel })[]; edges: CardGraphEdge[] } {
  const g = graph || {};
  const d = data || {};
  // `String(...)`: the same coercion `t.database + '.' + t.name` applies
  // implicitly in JS for a missing field — spelled out because both fields are
  // optional here (an external/dictionary-source leaf's row never reaches this
  // key-building in practice, but the type has to allow for it).
  const tablesByKey = new Map((d.tables || []).map((t) => [String(t.database) + '.' + String(t.name), t]));
  const colsByKey = d.columnsByKey || {};
  const nodes = (g.nodes || []).map((n) => {
    // `!`: every real caller's node (SchemaGraphNode/ExpandLineageNode) requires
    // `id`; only the loose CardGraphNode fixture type allows it absent — the
    // original .js read `n.id` bare here.
    const id = n.id!;
    return { ...n, card: buildCardModel(n, tablesByKey.get(id), colsByKey[id]) };
  });
  return { nodes, edges: g.edges || [] };
}
