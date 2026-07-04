// The standalone read-only Dashboard page (#149 D1). Render module over the
// `app` controller: it builds a header + a grid of chart tiles, one per
// favorited Library query (a snapshot taken when the tab opens — Refresh re-runs
// the data, it does not re-scan the Library). Each tile runs its SQL read-only
// via `app.runTile` and draws through the shared `renderChart` seam; single-row
// (KPI) and non-chartable favorites are skipped, counted in a header note. KPI
// tiles, filters, layout, and export arrive in later phases (D2–D7).

import { h } from './dom.js';
import { Icon } from './icons.js';
import { renderChart } from './results.js';
import { schemaKey } from '../core/chart-data.js';
import { classifyTile } from '../core/dashboard.js';
import { formatBytes, formatRows } from '../core/format.js';

// At most this many tile queries run at once, so a large favorites list doesn't
// fire a thundering herd of concurrent reads at ClickHouse (saturating the
// browser's per-host pool and the cluster) on open and on every Refresh.
const TILE_CONCURRENCY = 6;

/**
 * Build a segmented control (`Arrange | Report`, `2 | 3`): a row of buttons of
 * which exactly one reads active. `getActive` returns the currently-selected
 * value; `onPick(value)` fires on a click. Returns `{ el, sync }` — `sync()`
 * repaints the active button from `getActive()` (called after a pick so the
 * two controls can share one `apply()`).
 */
function buildSeg(cls, options, getActive, onPick) {
  const btns = options.map(([, label]) =>
    h('button', { class: 'dash-seg-btn', type: 'button' }, label));
  const sync = () => btns.forEach((b, i) => {
    const on = options[i][0] === getActive();
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  btns.forEach((b, i) => { b.onclick = () => onPick(options[i][0]); });
  const el = h('div', { class: 'dash-seg ' + cls, role: 'group' }, ...btns);
  sync();
  return { el, sync };
}

/** Build a tile's footer meta row (rows · ms · bytes), omitting stats CH didn't return. */
function tileFooter(meta) {
  const parts = [h('span', null, formatRows(meta.rows) + ' rows')];
  if (meta.ms != null) parts.push(h('span', null, meta.ms + ' ms'));
  if (meta.bytes != null) parts.push(h('span', null, formatBytes(meta.bytes) + ' scanned'));
  return parts;
}

/**
 * Bounded-concurrency map that preserves append order. Workers grab the next
 * index in turn; each `worker` appends its card synchronously before its first
 * await, so cards land in favorite order regardless of which query returns
 * first. Returns the per-item results in index order.
 */
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

// Render one favorite into a freshly-appended tile card: run its SQL (via
// app.runTile), then draw the chart, drop the card (skip), or show the error.
// Resolves to the outcome ('chart' | 'skip' | 'error') so the caller can tally
// the skipped count. A chartable tile pushes a `{ destroy }` handle onto `tiles`
// so the caller can tear its Chart.js instance down on the next Refresh (else
// orphaned charts + their ResizeObservers leak on a long-lived tab).
async function renderTile(app, q, grid, tiles) {
  const body = h('div', { class: 'dash-tile-body' },
    h('div', { class: 'dash-tile-load' }, Icon.spinner(), h('span', null, 'Loading…')));
  const foot = h('div', { class: 'dash-tile-foot' });
  // Header: the favorite's name, plus its saved description as a subtitle when it
  // has one (single line, ellipsized) — mirrors the design mockup's tile header.
  const head = h('div', { class: 'dash-tile-head' },
    h('span', { class: 'dash-tile-name', title: q.name }, q.name));
  if (q.description) head.appendChild(h('div', { class: 'dash-tile-desc', title: q.description }, q.description));
  const card = h('div', { class: 'dash-tile' }, head, body, foot);
  grid.appendChild(card);

  const r = await app.runTile(q.sql);
  if (r.error != null) {
    body.replaceChildren(h('div', { class: 'dash-tile-error' }, r.error));
    return 'error';
  }
  const cls = classifyTile(r.columns, r.rows, q.chart);
  if (cls.kind === 'skip') { card.remove(); return 'skip'; }

  // Seed an isolated per-tile config with the resolved cfg + its schema key so
  // renderChart honours it (a schema-key mismatch would make it re-derive with
  // autoChart, discarding a favorite's saved chart shape). controls:false — D1
  // tiles are read-only, so renderChart omits the Type/X/Y config bar entirely
  // (and so never re-renders); its Chart.js instance is torn down centrally on
  // the next Refresh via the `tiles` handle below.
  const res = { columns: r.columns, rows: r.rows };
  const chartTab = { chartKey: schemaKey(r.columns), chartCfg: cls.cfg };
  let inst = null;
  body.replaceChildren(renderChart(app, res, {
    tab: chartTab, setChart: (c) => { inst = c; }, running: false, controls: false, hideGrid: true,
  }));
  tiles.push({ destroy: () => inst.destroy() });
  foot.replaceChildren(...tileFooter(r.meta));
  return 'chart';
}

/** Render the dashboard into `app.root`. */
export function renderDashboard(app) {
  const { document: doc, state } = app;
  doc.documentElement.setAttribute('data-theme', state.theme);
  doc.documentElement.setAttribute('data-density', state.density);
  app.dom = {};

  const favorites = state.savedQueries.filter((q) => q.favorite);

  const favChip = h('span', { class: 'dash-chip dash-fav' },
    Icon.star(true),
    h('span', null, favorites.length + (favorites.length === 1 ? ' favorite' : ' favorites')));
  const skipNote = h('span', { class: 'dash-skip', style: { display: 'none' } });
  const updated = h('span', { class: 'dash-updated' });
  const refreshBtn = h('button', { class: 'dash-btn', title: 'Re-run all tiles' },
    Icon.refresh(), h('span', null, 'Refresh'));
  // Theme toggle, mirroring the workbench header: reuse app.toggleTheme (persists
  // the pref + flips data-theme), and register the button as app.dom.themeBtn so
  // that helper repaints its icon on toggle.
  const themeBtn = h('button', { class: 'dash-icobtn', title: 'Toggle theme', onclick: () => app.toggleTheme() });
  themeBtn.appendChild(state.theme === 'dark' ? Icon.sun() : Icon.moon());
  app.dom.themeBtn = themeBtn;

  const header = h('div', { class: 'dash-header' },
    h('a', { class: 'dash-back', href: app.basePath || '/sql', title: 'Back to SQL Browser' },
      Icon.arrow(), h('span', null, 'SQL Browser')),
    h('div', { class: 'dash-title' }, state.libraryName.value),
    favChip,
    skipNote,
    h('div', { class: 'dash-spacer', style: { flex: '1' } }),
    h('span', { class: 'dash-chip dash-src', title: app.host() },
      h('span', { class: 'dash-dot' }), app.host()),
    updated,
    themeBtn,
    refreshBtn);

  const grid = h('div', { class: 'dash-grid' });
  const empty = h('div', { class: 'dash-empty', style: { display: favorites.length ? 'none' : '' } },
    'No favorites yet — star a query in the Library to add it to the dashboard.');

  // Layout toolbar (#149 D2), the row that becomes the filter bar in D4. The
  // Arrange|Report switcher is the primary control; the 2/3 column count is a
  // secondary setting, meaningful only in Arrange (hidden in Report's single
  // column). Both are presentation-only: `apply()` reshapes the grid and the
  // tiles' Chart.js instances resize themselves via their ResizeObserver — no
  // tile re-query. State is mutated + persisted (asb:dashLayout/dashCols) so the
  // choice survives reloads and Refresh (which rebuilds the grid's children, not
  // the grid element, so its class/`--dash-cols` persist across a refresh).
  const apply = () => {
    grid.classList.toggle('is-report', state.dashLayout === 'report');
    grid.style.setProperty('--dash-cols', String(state.dashCols));
    colsWrap.style.display = state.dashLayout === 'report' ? 'none' : '';
    layoutSeg.sync();
    colsSeg.sync();
  };
  const layoutSeg = buildSeg('dash-seg-layout', [['arrange', 'Arrange'], ['report', 'Report']],
    () => state.dashLayout, (v) => {
      if (v === state.dashLayout) return;
      state.dashLayout = v;
      app.savePref('dashLayout', v);
      apply();
    });
  const colsSeg = buildSeg('dash-seg-cols', [[2, '2'], [3, '3']],
    () => state.dashCols, (v) => {
      if (v === state.dashCols) return;
      state.dashCols = v;
      app.savePref('dashCols', v);
      apply();
    });
  const colsWrap = h('div', { class: 'dash-cols-wrap' },
    h('span', { class: 'dash-seg-label' }, 'Columns'), colsSeg.el);
  const toolbar = h('div', { class: 'dash-toolbar' },
    layoutSeg.el,
    h('div', { class: 'dash-spacer', style: { flex: '1' } }),
    colsWrap);
  apply();

  // #root is a fixed, overflow:hidden flex column (the workbench layout), so the
  // dashboard needs its own scroll container — otherwise a tall grid clips with
  // no vertical scroll. The header + toolbar share one sticky top bar inside it.
  app.root.replaceChildren(h('div', { class: 'dash-page' },
    h('div', { class: 'dash-topbar' }, header, toolbar), empty, grid));

  // Chart.js instances of the tiles currently in the grid, torn down before the
  // next Refresh rebuilds them (grid.replaceChildren() alone would orphan them,
  // leaking the charts + their ResizeObservers on a long-lived tab).
  let liveTiles = [];

  const refresh = async () => {
    // Resolve (and refresh) the auth token ONCE up front. This both avoids N
    // tiles racing an expired-token refresh and lets a lost session redirect to
    // login exactly once — rather than each tile firing onSignedOut in parallel.
    if (!(await app.ensureFreshToken())) { app.chCtx.onSignedOut(); return; }
    refreshBtn.disabled = true;
    liveTiles.forEach((t) => t.destroy());
    liveTiles = [];
    grid.replaceChildren();
    let skipped = 0;
    // try/finally so the button always re-enables and the timestamp always
    // updates — even if a tile render unexpectedly throws (runTile itself is
    // total, so this is belt-and-suspenders against the pool rejecting).
    try {
      const outcomes = await runPool(favorites, TILE_CONCURRENCY, (q) => renderTile(app, q, grid, liveTiles));
      skipped = outcomes.filter((o) => o === 'skip').length;
    } finally {
      if (skipped) {
        skipNote.style.display = '';
        skipNote.textContent = skipped + ' not shown';
        skipNote.title = skipped + ' single-row (KPI) or non-chartable favorite(s) — coming in a later phase.';
      } else {
        skipNote.style.display = 'none';
      }
      updated.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      refreshBtn.disabled = false;
    }
  };
  refreshBtn.onclick = refresh;
  return refresh();
}
