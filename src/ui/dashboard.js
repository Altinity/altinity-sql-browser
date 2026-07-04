// The standalone read-only Dashboard page (#149 D1–D3). Render module over the
// `app` controller: it builds a header + a grid of chart tiles, one per
// favorited Library query (a snapshot taken when the tab opens — Refresh re-runs
// the data, it does not re-scan the Library). Each tile runs its SQL read-only
// via `app.runTile` and draws through the shared `renderChart` seam; single-row
// (KPI) and non-chartable favorites are skipped, counted in a header note. A
// global filter bar (D3, below) drives the same `{name:Type}` mechanism the SQL
// Browser workbench uses, fanning it out across every favorite instead of one
// query at a time. KPI tiles, per-tile overrides, and export arrive in later
// phases (D5–D8).

import { h } from './dom.js';
import { Icon } from './icons.js';
import { renderChart } from './results.js';
import { schemaKey } from '../core/chart-data.js';
import { classifyTile, dashboardParams } from '../core/dashboard.js';
import { formatBytes, formatRows } from '../core/format.js';
import { readStatementParams, unfilledParams } from '../core/query-params.js';

// At most this many tile queries run at once, so a large favorites list doesn't
// fire a thundering herd of concurrent reads at ClickHouse (saturating the
// browser's per-host pool and the cluster) on open and on every Refresh.
const TILE_CONCURRENCY = 6;

// Idle time after the last keystroke in a filter field before it triggers a
// re-run (#149 D3) — longer than the FROM-scope column-load debounce
// (codemirror-adapter.js) since this fires a real query, not a metadata fetch.
// Enter/blur bypass this entirely for a fast explicit-commit path.
const FILTER_DEBOUNCE_MS = 500;

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

// One favorite's tile card, built once per dashboard load (favorite order) and
// never removed/re-appended: a filter change can flip a tile between
// skip ⇄ unfilled ⇄ chart repeatedly, and removing/re-inserting DOM nodes would
// both reorder the grid and orphan the "same" tile's identity. Every later
// state transition (`setSlotLoading`/`setSlotUnfilled`/`applyTileResult`)
// updates this same slot's contents/visibility in place instead. `gen` is a
// per-tile monotonically increasing generation counter guarding against
// out-of-order responses (edit A, then B, before A's request returns — B's
// response must win); `destroy` tears down the slot's live Chart.js instance
// (if any) before it's replaced.
function buildTileSlot(q) {
  const body = h('div', { class: 'dash-tile-body' });
  const foot = h('div', { class: 'dash-tile-foot' });
  // Header: the favorite's name, plus its saved description as a subtitle when it
  // has one (single line, ellipsized) — mirrors the design mockup's tile header.
  const head = h('div', { class: 'dash-tile-head' },
    h('span', { class: 'dash-tile-name', title: q.name }, q.name));
  if (q.description) head.appendChild(h('div', { class: 'dash-tile-desc', title: q.description }, q.description));
  const card = h('div', { class: 'dash-tile' }, head, body, foot);
  return { card, body, foot, gen: 0, status: null, destroy: null };
}

function destroySlotChart(slot) {
  if (slot.destroy) { slot.destroy(); slot.destroy = null; }
}

function setSlotLoading(slot) {
  destroySlotChart(slot);
  slot.card.style.display = '';
  slot.body.replaceChildren(h('div', { class: 'dash-tile-load' }, Icon.spinner(), h('span', null, 'Loading…')));
  slot.foot.replaceChildren();
}

// A tile whose SQL still has an empty/absent {name:Type} value never calls
// app.runTile — it shows this placeholder instead (reusing the card's header/
// footer chrome so it doesn't look broken), and stays visible: unlike a
// classifyTile `skip`, one filter value away it becomes chartable, so it is
// NOT counted in the header's "N not shown" note.
function setSlotUnfilled(slot, missing) {
  destroySlotChart(slot);
  slot.status = 'unfilled';
  slot.card.style.display = '';
  slot.body.replaceChildren(h('div', { class: 'dash-tile-unfilled' }, 'Enter a value for: ' + missing.join(', ')));
  slot.foot.replaceChildren();
}

function applyTileResult(app, q, slot, r) {
  destroySlotChart(slot);
  if (r.error != null) {
    slot.status = 'error';
    slot.card.style.display = '';
    slot.body.replaceChildren(h('div', { class: 'dash-tile-error' }, r.error));
    slot.foot.replaceChildren();
    return;
  }
  const cls = classifyTile(r.columns, r.rows, q.chart);
  if (cls.kind === 'skip') {
    slot.status = 'skip';
    slot.card.style.display = 'none';
    // Clear a previous chart's DOM (its Chart.js instance is already torn
    // down by destroySlotChart above) so a tile that flips chart → skip on a
    // later refresh/filter change doesn't leave a dead canvas hidden in the DOM.
    slot.body.replaceChildren();
    slot.foot.replaceChildren();
    return;
  }
  slot.status = 'chart';
  slot.card.style.display = '';
  // Seed an isolated per-tile config with the resolved cfg + its schema key so
  // renderChart honours it (a schema-key mismatch would make it re-derive with
  // autoChart, discarding a favorite's saved chart shape). controls:false — D1
  // tiles are read-only, so renderChart omits the Type/X/Y config bar entirely
  // (and so never re-renders); its Chart.js instance is torn down via
  // destroySlotChart above, on the next result for this same slot.
  const res = { columns: r.columns, rows: r.rows };
  const chartTab = { chartKey: schemaKey(r.columns), chartCfg: cls.cfg };
  let inst = null;
  slot.body.replaceChildren(renderChart(app, res, {
    tab: chartTab, setChart: (c) => { inst = c; }, running: false, controls: false, hideGrid: true,
  }));
  slot.destroy = () => inst.destroy();
  slot.foot.replaceChildren(...tileFooter(r.meta));
}

// Run (or re-run) one favorite's tile into its slot: gate on unfilled
// `{name:Type}` values first (never calling app.runTile while any are empty),
// otherwise fetch and classify. `onSettled()` fires after every transition
// (unfilled or fetched) so the caller can recompute the live "N not shown"
// count. The generation bump happens before the gate check so a superseded
// in-flight fetch is discarded even if the newer edit resolves to "unfilled".
async function runSlotTile(app, q, slot, onSettled) {
  const myGen = ++slot.gen;
  const missing = unfilledParams(q.sql, app.state.varValues);
  if (missing.length) {
    setSlotUnfilled(slot, missing);
    onSettled();
    return;
  }
  setSlotLoading(slot);
  const r = await app.runTile(q.sql);
  if (slot.gen !== myGen) return; // a newer edit started after this fetch; discard
  applyTileResult(app, q, slot, r);
  onSettled();
}

// The global filter bar (#149 D3): one field per `{name:Type}` parameter
// referenced by any favorite, sharing `app.state.varValues` with the SQL
// Browser workbench. Hidden entirely (no row, no spacing) when there are no
// detected params — same convention as the workbench's `var-strip`. Typing
// debounces before calling `onCommit(name)`; Enter or blur fires immediately,
// clearing any pending debounce so a value never applies twice.
function buildFilterBar(app, params, onCommit) {
  if (!params.length) return h('div', { class: 'dash-filters', style: { display: 'none' } });
  return h('div', { class: 'dash-filters' }, ...params.map((p) => {
    let timer = null;
    const commitNow = () => {
      if (timer == null) return;
      clearTimeout(timer);
      timer = null;
      onCommit(p.name);
    };
    const input = h('input', {
      type: 'text', class: 'var-input',
      value: app.state.varValues[p.name] || '',
      placeholder: p.type, title: p.name + ': ' + p.type, 'aria-label': p.name,
      oninput: (e) => {
        app.state.varValues[p.name] = e.target.value;
        app.saveVarValues();
        clearTimeout(timer);
        timer = setTimeout(commitNow, FILTER_DEBOUNCE_MS);
      },
      onkeydown: (e) => { if (e.key === 'Enter') commitNow(); },
      onblur: commitNow,
    });
    return h('label', { class: 'var-field' }, h('span', { class: 'var-name' }, p.name), input);
  }));
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

  // Layout toolbar (#149 D2) + global filter bar (#149 D3). The Arrange|Report
  // switcher is the primary control; the 2/3 column count is a secondary
  // setting, meaningful only in Arrange (hidden in Report's single column).
  // Both are presentation-only: `apply()` reshapes the grid and the tiles'
  // Chart.js instances resize themselves via their ResizeObserver — no tile
  // re-query. State is mutated + persisted (asb:dashLayout/dashCols) so the
  // choice survives reloads and Refresh. The filter bar sits between them; it
  // is entirely absent (no row, no spacing) when no favorite references a
  // `{name:Type}` parameter.
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
  const filterBar = buildFilterBar(app, dashboardParams(favorites), (name) => runAffected(name));
  const toolbar = h('div', { class: 'dash-toolbar' },
    layoutSeg.el,
    filterBar,
    h('div', { class: 'dash-spacer', style: { flex: '1' } }),
    colsWrap);
  apply();

  // #root is a fixed, overflow:hidden flex column (the workbench layout), so the
  // dashboard needs its own scroll container — otherwise a tall grid clips with
  // no vertical scroll. The header + toolbar share one sticky top bar inside it.
  app.root.replaceChildren(h('div', { class: 'dash-page' },
    h('div', { class: 'dash-topbar' }, header, toolbar), empty, grid));

  // One stable slot per favorite (favorite order), built lazily on the first
  // successful run (below) and reused for the tab's lifetime — a filter edit
  // or Refresh updates a slot's contents/visibility in place rather than
  // inserting/removing grid children (see buildTileSlot).
  let slots = [];

  const updateSkipNote = () => {
    const skipped = slots.filter((s) => s.status === 'skip').length;
    if (skipped) {
      skipNote.style.display = '';
      skipNote.textContent = skipped + ' not shown';
      skipNote.title = skipped + ' single-row (KPI) or non-chartable favorite(s) — coming in a later phase.';
    } else {
      skipNote.style.display = 'none';
    }
  };

  // Re-run only the favorites whose SQL references `name` (a filter field's
  // debounced/committed edit, #149 D3) — not the whole grid. A no-op before
  // the first successful run (slots not built yet).
  function runAffected(name) {
    if (!slots.length) return;
    const targets = favorites
      .map((q, i) => [q, i])
      .filter(([q]) => readStatementParams(q.sql).some((p) => p.name === name));
    return Promise.all(targets.map(([q, i]) => runSlotTile(app, q, slots[i], updateSkipNote)));
  }

  const runAll = async () => {
    // Resolve (and refresh) the auth token ONCE up front. This both avoids N
    // tiles racing an expired-token refresh and lets a lost session redirect to
    // login exactly once — rather than each tile firing onSignedOut in parallel.
    if (!(await app.ensureFreshToken())) { app.chCtx.onSignedOut(); return; }
    refreshBtn.disabled = true;
    if (!slots.length) {
      slots = favorites.map((q) => buildTileSlot(q));
      slots.forEach((s) => grid.appendChild(s.card));
    }
    // Every favorite re-runs on a full refresh (unlike a filter's targeted
    // runAffected). Mark every slot loading up front rather than leaving
    // tiles beyond TILE_CONCURRENCY's window showing stale content (or, on
    // first load, an empty card) until the pool gets around to them.
    slots.forEach((s) => setSlotLoading(s));
    // try/finally so the button always re-enables and the timestamp always
    // updates — even if a tile render unexpectedly throws (runSlotTile itself
    // is total, so this is belt-and-suspenders against the pool rejecting).
    try {
      await runPool(favorites, TILE_CONCURRENCY, (q, i) => runSlotTile(app, q, slots[i], updateSkipNote));
    } finally {
      updated.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      refreshBtn.disabled = false;
    }
  };
  refreshBtn.onclick = runAll;
  return runAll();
}
