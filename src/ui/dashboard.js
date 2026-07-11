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
import { classifyTile } from '../core/dashboard.js';
import { formatBytes, formatRows } from '../core/format.js';
import {
  analyzeParameterizedSources, prepareParameterizedBatch, mergedSourceArgs, mergedSourceSql, fieldControls,
  fieldControlKind,
} from '../core/param-pipeline.js';
import { hasOptionalBlocks } from '../core/optional-blocks.js';
import { effectiveFilterActive } from '../state.js';
import { applyFieldState } from './var-field.js';
import { buildRelativeTimeField } from './relative-time-field.js';
import { buildRecentField } from './recent-field.js';
import { buildEnumField } from './enum-field.js';
import { wireComboInput } from './combobox.js';
import { recentOptions } from '../core/recent-values.js';

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

// A tile whose SQL still has an empty/absent, or invalid (#170), {name:Type}
// value never calls app.runTile — it shows this placeholder instead (reusing
// the card's header/footer chrome so it doesn't look broken), and stays
// visible: unlike a classifyTile `skip`, one filter value away it becomes
// chartable, so it is NOT counted in the header's "N not shown" note.
function setSlotUnfilled(slot, names) {
  destroySlotChart(slot);
  slot.status = 'unfilled';
  slot.card.style.display = '';
  slot.body.replaceChildren(h('div', { class: 'dash-tile-unfilled' }, 'Enter a value for: ' + names.join(', ')));
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

// Run (or re-run) one favorite's tile into its slot, gated by its prepared
// source from the wave's batch (#173): unfilled OR invalid (#170) `{name:Type}`
// values show the placeholder (never calling app.runTile — an invalid value
// left to reach the server would either error confusingly or, for Int/UInt,
// silently wrap; see param-validate.js), a per-source error (e.g. a value
// that can't serialize for this tile's declaration) shows an error card —
// blocking only this tile, never its siblings — otherwise fetch with the
// batch's prepared args and classify. `onSettled()` fires after every
// transition (unfilled, errored or fetched) so the caller can recompute the
// live "N not shown" count. The generation bump happens before the gate check
// so a superseded in-flight fetch is discarded even if the newer edit resolves
// to "unfilled".
async function runSlotTile(app, q, slot, onSettled, src) {
  const myGen = ++slot.gen;
  if (src.missing.length || src.invalid.length) {
    setSlotUnfilled(slot, src.missing.concat(src.invalid));
    onSettled();
    return;
  }
  if (src.errors.length) {
    applyTileResult(app, q, slot, { error: src.errors[0] });
    onSettled();
    return;
  }
  setSlotLoading(slot);
  // The wire text is the wave's materialized execution view (#165) — only when
  // the favorite actually is a template; block-free SQL keeps its exact bytes.
  const execSql = hasOptionalBlocks(q.sql) ? mergedSourceSql(src, q.sql) : q.sql;
  const r = await app.runTile(execSql, mergedSourceArgs(src));
  if (slot.gen !== myGen) return; // a newer edit started after this fetch; discard
  applyTileResult(app, q, slot, r);
  // #171: this tile completed successfully — record its bound params (the
  // exact wave's boundParams snapshot, so a param confined to an inactive
  // optional block — never in `src.statements[*].boundParams` — is never
  // recorded). A superseded/discarded fetch (the `return` above) never
  // reaches here at all.
  if (r.error == null) app.recordBoundParams(src.statements.flatMap((s) => s.boundParams));
  onSettled();
}

// The global filter bar (#149 D3): one field per `{name:Type}` parameter
// referenced by any favorite — detected on the all-active analysis view
// (#165), so a param confined to /*[ ]*/ optional blocks is listed too, marked
// optional (blank keeps its predicates out instead of blocking the tile) —
// sharing `app.state.varValues`/`app.state.filterActive` with the SQL Browser
// workbench. Hidden entirely (no row, no spacing) when there are no detected
// params — same convention as the workbench's `var-strip`. Typing debounces
// before calling `onCommit(name)`; Enter or blur fires immediately, clearing
// any pending debounce so a value never applies twice. `getField(name, mode)`
// reads the field's current #170-validated state ('input' while typing —
// neutral on a plausible prefix; 'execute' on blur/Enter — hardens it) for
// the shared invalid-field affordance (var-field.js); `commitNow`'s no-op
// short-circuit (nothing pending) is independent of that repaint, so blurring
// an untouched-since-last-commit field still (re)shows the right state.
function buildFilterBar(app, params, onCommit, getField) {
  if (!params.length) return h('div', { class: 'dash-filters', style: { display: 'none' } });
  return h('div', { class: 'dash-filters' }, ...params.map((p) => {
    let timer = null;
    // #173 acceptance (review F1): a type-conflicted param (declared with
    // disagreeing types across favorites) degrades to the plain text control
    // (fieldControlKind below) and says so visibly — a warning style distinct
    // from is-invalid (the VALUE isn't wrong; the declarations disagree) plus
    // a tooltip listing them.
    const conflictNote = p.conflict
      ? 'Conflicting type declarations: ' + p.conflict.join(' vs ') : null;
    const baseTitle = p.name + ': ' + p.type
      + (p.optional ? ' — optional: blank leaves its filter block out' : '')
      + (conflictNote ? ' — ' + conflictNote : '');
    const commitNow = () => {
      if (timer == null) return;
      clearTimeout(timer);
      timer = null;
      onCommit(p.name);
    };
    // The shared control-kind priority (fieldControlKind, review F8): #172
    // enum members (v1 only here — the declaration travels with the tile SQL;
    // v2 schema-cache inference is workbench-only, and #160's curated
    // `filter:` query is the Dashboard's no-declaration alternative) > #169
    // date-like preset combobox + live preview > plain text with recents.
    // The field stays free-text in every case; D3's debounce/Enter/blur
    // commit semantics are unchanged either way.
    const ctl = fieldControlKind(p);
    let combo = null;
    let input;
    const onValueInput = () => {
      app.state.varValues[p.name] = input.value;
      // Text controls sync activation with the value (#165): an activation
      // flip re-runs affected tiles exactly like a value change (same
      // debounce + generation guard downstream).
      app.state.filterActive[p.name] = input.value !== '';
      app.saveVarValues();
      app.saveFilterActive();
      applyFieldState(input, getField(p.name, 'input'), baseTitle, combo && combo.previewEl);
      clearTimeout(timer);
      timer = setTimeout(commitNow, FILTER_DEBOUNCE_MS);
    };
    const onCommitHard = () => {
      applyFieldState(input, getField(p.name, 'execute'), baseTitle, combo && combo.previewEl);
      commitNow();
    };
    // #171: live-filtered recents for this field (type + typed text), read
    // fresh on every open/keystroke (never a snapshot — see recent-field.js's
    // header comment). (#160's curated-param opt-out hook: nothing to check
    // yet — no curated param exists before #160 lands.)
    const getRecents = (text) => recentOptions(app.state.varRecent, p.name, p.type, text);
    const onClearRecent = () => app.clearVarRecent(p.name);
    // A preset/recent pick is a deliberate, complete action (like Enter) —
    // run immediately, bypassing the debounce `onValueInput` just armed,
    // rather than waiting out FILTER_DEBOUNCE_MS for an explicit choice.
    const onPick = () => {
      applyFieldState(input, getField(p.name, 'execute'), baseTitle, combo && combo.previewEl);
      clearTimeout(timer);
      timer = null;
      onCommit(p.name);
    };
    const fieldOpts = {
      document: app.document, name: p.name, type: p.type, value: app.state.varValues[p.name] || '',
      baseTitle, onValueInput, onCommit: onPick, getRecents, onClearRecent,
    };
    if (ctl.kind === 'enum') combo = buildEnumField({ ...fieldOpts, values: ctl.enumOptions });
    else if (ctl.kind === 'date') combo = buildRelativeTimeField({ ...fieldOpts, wallNow: app.wallNow });
    else combo = buildRecentField(fieldOpts);
    input = combo.input;
    // The shared listener block (review F8): the combobox hooks first, then
    // D3's own persist-on-type / Enter-blur hard-commit bodies.
    wireComboInput(combo, { onValueInput, onCommit: onCommitHard });
    if (conflictNote) input.classList.add('is-conflict');
    applyFieldState(input, getField(p.name, 'execute'), baseTitle, combo && combo.previewEl);
    return h('label', { class: 'var-field' + (p.optional ? ' is-optional' : '') },
      h('span', { class: 'var-name' }, p.name), combo.el);
  }));
}

/** Render the dashboard into `app.root`. */
export function renderDashboard(app) {
  const { document: doc, state } = app;
  doc.documentElement.setAttribute('data-theme', state.theme);
  doc.documentElement.setAttribute('data-density', state.density);
  app.dom = {};

  const favorites = state.savedQueries.filter((q) => q.favorite);

  // The favorites snapshot is fixed for this render, so the parameter analysis
  // (#173 phase 1 — structure only) runs once; each wave (runAll / a filter's
  // runAffected) prepares it against the current varValues with one wall-clock
  // read, and every tile gate + fetch of that wave reads the same batch.
  const tileId = (i) => 'tile:' + i;
  const analysis = analyzeParameterizedSources(favorites.map((q, i) => ({
    id: tileId(i), label: q.name, kind: 'tile', sql: q.sql, bindPolicy: 'row-returning',
  })));
  const prepareBatch = (validationMode = 'execute') => prepareParameterizedBatch(analysis, {
    values: app.state.varValues,
    active: effectiveFilterActive(app.state.varValues, app.state.filterActive),
    wallNowMs: app.wallNow(), validationMode,
  });
  const prepareWave = () => prepareBatch('execute').sources;
  // The filter bar's per-keystroke field-state read (#170): 'input' while
  // typing (neutral on a plausible prefix), 'execute' on blur/Enter (hardens).
  const getFilterField = (name, mode) => prepareBatch(mode).fields[name];

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
  const filterBar = buildFilterBar(app, fieldControls(analysis), (name) => runAffected(name), getFilterField);
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
  // debounced/committed edit, #149 D3) — not the whole grid. Affected-source
  // detection comes from the analysis (#173): `optionalIn` keeps a tile
  // affected even while the param's optional blocks are inactive (#165), so an
  // activation flip re-runs it exactly like a value change. A no-op before
  // the first successful run (slots not built yet).
  function runAffected(name) {
    if (!slots.length) return;
    const f = analysis.fields[name]; // the filter bar only renders analyzed params
    const affected = new Set(f.requiredIn.concat(f.optionalIn));
    const wave = prepareWave();
    const targets = favorites.map((q, i) => i).filter((i) => affected.has(tileId(i)));
    return Promise.all(targets.map((i) => runSlotTile(app, favorites[i], slots[i], updateSkipNote, wave[i])));
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
    // One prepared batch (and one wall-clock read) for the whole refresh wave.
    const wave = prepareWave();
    // try/finally so the button always re-enables and the timestamp always
    // updates — even if a tile render unexpectedly throws (runSlotTile itself
    // is total, so this is belt-and-suspenders against the pool rejecting).
    try {
      await runPool(favorites, TILE_CONCURRENCY, (q, i) => runSlotTile(app, q, slots[i], updateSkipNote, wave[i]));
    } finally {
      updated.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      refreshBtn.disabled = false;
    }
  };
  refreshBtn.onclick = runAll;
  return runAll();
}
