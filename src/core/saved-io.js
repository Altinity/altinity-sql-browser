// Pure import/export of saved queries. No DOM, no globals.
// A saved entry is { id, name, sql, favorite, description?, panel?, view?,
// chart? }: `description` is an optional free-text note, `panel` the panel
// config `{ cfg, key? }` (#166 — cfg.type ∈ chart family | table | logs |
// text; `key` is the chart family's schema signature), and `view` the
// remembered result view (table/json/panel). `chart` is the LEGACY chart
// payload — still written as a dual-write mirror of chart-family panels for
// one release (rollback safety), and upgraded into `panel` on every read.
// Panel cfgs are validated at render/restore time, so they pass through here
// opaquely (unknown types and extra fields are preserved, never stripped).
//
// `version` stays 1: `panel` is an additive optional field (imports hard-
// reject version > 1, so bumping would break every older build; old builds
// simply drop the unknown `panel` field and read the mirror).
//
// NEXT-MINOR OBLIGATION (pinned in #166): when the `chart` mirror is removed,
// `upgradeSavedEntry` must start actively DELETING `chart` when `panel`
// exists — entries persisted by this release carry both forever otherwise.

import { isChartFamily } from './panel-cfg.js';

const FORMAT = 'altinity-sql-browser/saved-queries';
const VERSION = 1;
const MAX = 1000;

/** A panel payload is kept only if it's an object carrying a `cfg` object with a type. */
const cleanPanel = (p) =>
  (p && typeof p === 'object' && p.cfg && typeof p.cfg === 'object' && typeof p.cfg.type === 'string' ? p : undefined);

/**
 * Upgrade one saved entry (a plain object; NOT mutated) to the panel format
 * (#166). Applied at every ingress — localStorage startup, JSON import,
 * replace/append/merge, tab restoration, share decode — and idempotent:
 *   - `panel` already present → kept (the legacy `chart` mirror is ignored);
 *   - `view:'table'` with a latent `chart` → `panel:{cfg:{type:'table',
 *     chart:{...cfg, key}}}` — D9's table-over-chart precedence is preserved
 *     losslessly: the old roles ride in the `chart` stash (an unknown field to
 *     the table arm, kept by ignore-and-preserve) so switching the type back
 *     to a chart can prefill them. The legacy top-level `chart` is dropped
 *     (the mirror exists only for chart-family panels — a rollback sees
 *     `view:'table'` and renders the same grid);
 *   - a bare `chart:{cfg,key}` → `panel:{cfg, key}` (chart-family type,
 *     indices untouched; `chart` stays as the dual-write mirror);
 *   - `view:'chart'` → `view:'panel'` (the drawer tab was renamed).
 */
export function upgradeSavedEntry(entry) {
  const out = { ...entry };
  const chart = cleanChart(out.chart);
  if (!cleanPanel(out.panel) && chart) {
    if (out.view === 'table') {
      out.panel = { cfg: { type: 'table', chart: { ...chart.cfg, key: chart.key ?? null } } };
      delete out.chart;
    } else {
      out.panel = { cfg: { ...chart.cfg }, key: chart.key ?? null };
    }
  }
  if (out.view === 'chart') out.view = 'panel';
  return out;
}

/**
 * Enforce the dual-write mirror invariant on an entry (mutated in place, also
 * returned): the legacy `chart` field is a pure function of `panel` — present
 * (as `{cfg, key}`) iff the panel is chart-family, deleted otherwise. Every
 * write site (save, replace, merge-by-id, export, share encode) routes
 * through this, so mirror and panel can never drift. (`view:'panel'` is NOT
 * mirrored: an older build simply ignores the unknown view value and keeps
 * its current drawer tab — benign, and rewriting `view` here would corrupt
 * the live entry, which doubles as the persisted one.)
 */
export function withChartMirror(entry) {
  const panel = cleanPanel(entry.panel);
  if (panel && isChartFamily(panel.cfg.type)) {
    entry.chart = { cfg: { ...panel.cfg }, key: panel.key ?? null };
  } else {
    delete entry.chart;
  }
  return entry;
}

/** Build the export envelope. `nowISO` is injected for deterministic tests. */
export function buildExportDoc(queries, nowISO) {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: nowISO,
    // Every exported entry is upgraded + mirror-enforced (a copy — the live
    // entry is not touched), so the file carries `panel` plus the legacy
    // `chart` mirror for chart-family panels: an older build reading it still
    // shows its charts.
    queries: queries.map((raw) => {
      const q = withChartMirror(upgradeSavedEntry(raw));
      return {
        id: q.id, name: q.name, sql: q.sql, favorite: !!q.favorite,
        ...(q.description ? { description: q.description } : {}),
        ...(cleanPanel(q.panel) ? { panel: q.panel } : {}),
        ...(q.chart ? { chart: q.chart } : {}),
        ...(cleanView(q.view) ? { view: q.view } : {}),
      };
    }),
  };
}

/** A chart payload is kept only if it's an object carrying a `cfg` object. */
const cleanChart = (c) => (c && typeof c === 'object' && c.cfg && typeof c.cfg === 'object' ? c : undefined);
/**
 * A view is kept only if it's a known result view. Legacy `'chart'` is still
 * accepted here — `upgradeSavedEntry` (which every ingress runs AFTER this
 * cleaning) maps it to `'panel'`; dropping it first would lose the remembered
 * tab of every pre-#166 file.
 */
const cleanView = (v) => (v === 'table' || v === 'json' || v === 'panel' || v === 'chart' ? v : undefined);

/**
 * Parse + validate an import file's text. Returns { queries } (normalized,
 * upgraded entries with string name+sql), or throws Error(userMessage) on a
 * bad file. Per-item entries missing a string name or sql are dropped
 * silently (sql may be '' — a text panel needs none).
 */
export function parseImportDoc(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file');
  }
  if (!doc || doc.format !== FORMAT) throw new Error('Unrecognized file format');
  if (typeof doc.version !== 'number' || doc.version > VERSION) throw new Error('Unsupported file version');
  if (!Array.isArray(doc.queries)) throw new Error('No queries in file');
  if (doc.queries.length > MAX) throw new Error('Too many queries (max ' + MAX + ')');
  const queries = doc.queries
    .filter((q) => q && typeof q.name === 'string' && typeof q.sql === 'string')
    .map((q) => upgradeSavedEntry({
      id: typeof q.id === 'string' ? q.id : undefined,
      name: q.name,
      sql: q.sql,
      favorite: !!q.favorite,
      description: typeof q.description === 'string' ? (q.description.trim() || undefined) : undefined,
      panel: cleanPanel(q.panel),
      chart: cleanChart(q.chart),
      view: cleanView(q.view),
    }));
  return { queries };
}

/**
 * Merge `incoming` saved queries into `existing` (not mutated). Skips exact
 * content duplicates; updates an entry matched by id when its content differs;
 * otherwise adds a new entry (reusing a unique incoming id, else `genId()`).
 * Returns { merged, added, updated, skipped }.
 */
export function mergeSaved(existing, incoming, genId) {
  const merged = existing.map((q) => ({ ...q }));
  // Panel config is first-class content (#166), especially for SQL-less text
  // panels. Exclude `chart`: it is only a derived rollback mirror of `panel`.
  const contentKey = (q) => JSON.stringify([
    q.name, q.sql, !!q.favorite, q.description || null, cleanPanel(q.panel) || null,
    cleanView(q.view) || null,
  ]);
  const seen = new Set(merged.map(contentKey));
  let added = 0, updated = 0, skipped = 0;

  for (const rawInc of incoming) {
    const inc = upgradeSavedEntry(rawInc);
    const byId = inc.id ? merged.find((q) => q.id === inc.id) : null;
    if (byId) {
      if (contentKey(byId) === contentKey(inc)) { skipped++; continue; }
      seen.delete(contentKey(byId));
      byId.name = inc.name;
      byId.sql = inc.sql;
      byId.favorite = !!inc.favorite;
      if (inc.description) byId.description = inc.description; else delete byId.description;
      // panel + its chart mirror are rewritten TOGETHER (withChartMirror), so
      // an incoming non-chart panel can't leave the target's stale mirror
      // behind — and vice versa (#166 dual-write invariant).
      if (cleanPanel(inc.panel)) byId.panel = inc.panel; else delete byId.panel;
      withChartMirror(byId);
      if (cleanView(inc.view)) byId.view = inc.view; else delete byId.view;
      seen.add(contentKey(byId));
      updated++;
      continue;
    }
    if (seen.has(contentKey(inc))) { skipped++; continue; }
    const entry = withChartMirror({
      id: inc.id || genId(), name: inc.name, sql: inc.sql, favorite: !!inc.favorite,
      ...(inc.description ? { description: inc.description } : {}),
      ...(cleanPanel(inc.panel) ? { panel: inc.panel } : {}),
      ...(cleanView(inc.view) ? { view: inc.view } : {}),
    });
    merged.push(entry);
    seen.add(contentKey(entry));
    added++;
  }
  return { merged, added, updated, skipped };
}

// ── One-way share/publish exports ───────────────────────────────────────────
// Markdown and SQL are lossy, export-only formats (JSON is the canonical
// round-trip format). They carry only name, optional description, and SQL.

/** A text panel's Markdown body, or null when the entry isn't a text panel. */
const textPanelContent = (q) => {
  const p = cleanPanel(q.panel);
  return p && p.cfg.type === 'text' && typeof p.cfg.content === 'string' ? p.cfg.content : null;
};

/**
 * Render the library as a Markdown "query cookbook": each query is a `### name`
 * heading, an optional description paragraph, and a fenced ```sql block. The
 * fence widens to four backticks if a query body already contains a triple
 * backtick, so the block can't be terminated early. A text panel (#166) emits
 * its `cfg.content` as the Markdown body instead — plus the sql block only
 * when the entry actually carries SQL (an empty fenced block reads as noise).
 */
export function buildMarkdownDoc(queries) {
  return queries.map((q) => {
    const blocks = ['### ' + q.name.replace(/\s+/g, ' ').trim()]; // keep the heading on one line
    if (q.description) blocks.push(q.description);
    const content = textPanelContent(q);
    if (content) blocks.push(content.trim());
    if (q.sql.trim() || content == null) {
      const fence = q.sql.includes('```') ? '````' : '```';
      blocks.push(fence + 'sql\n' + q.sql.trim() + '\n' + fence);
    }
    return blocks.join('\n\n');
  }).join('\n\n') + '\n';
}

/**
 * Render the library as a `.sql` script: each query is a `/* name … *​/` comment
 * block (carrying its description) followed by the statement, `;`-terminated so
 * the file is a runnable batch. Any `*​/` inside the comment is defanged.
 * SQL-less entries (text panels, #166) are skipped entirely — a bare `;`
 * would break the "runnable batch" contract.
 */
export function buildSqlDoc(queries) {
  const safe = (s) => s.replace(/\*\//g, '* /');
  return queries.filter((q) => q.sql.trim()).map((q) => {
    const head = q.description ? q.name + '\n' + q.description : q.name;
    const body = q.sql.trim().replace(/;+\s*$/, '');
    return '/* ' + safe(head) + ' */\n' + body + ';';
  }).join('\n\n') + '\n';
}
