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

/** Build a tile's footer meta row (rows · ms · bytes), omitting stats CH didn't return. */
function tileFooter(meta) {
  const parts = [h('span', null, formatRows(meta.rows) + ' rows')];
  if (meta.ms != null) parts.push(h('span', null, meta.ms + ' ms'));
  if (meta.bytes != null) parts.push(h('span', null, formatBytes(meta.bytes) + ' scanned'));
  return parts;
}

// Render one favorite into a freshly-appended tile card: run its SQL (via
// app.runTile), then draw the chart, drop the card (skip), or show the error.
// Resolves to the outcome ('chart' | 'skip' | 'error') so the caller can tally
// the skipped count.
async function renderTile(app, q, grid) {
  const body = h('div', { class: 'dash-tile-body' },
    h('div', { class: 'dash-tile-load' }, Icon.spinner(), h('span', null, 'Loading…')));
  const foot = h('div', { class: 'dash-tile-foot' });
  const card = h('div', { class: 'dash-tile' },
    h('div', { class: 'dash-tile-head' }, h('span', { class: 'dash-tile-name', title: q.name }, q.name)),
    body, foot);
  grid.appendChild(card);

  const r = await app.runTile(q.sql);
  if (r.aborted) { card.remove(); return 'aborted'; } // request cancelled (e.g. navigation) — drop the card
  if (r.error != null) {
    body.replaceChildren(h('div', { class: 'dash-tile-error' }, r.error));
    return 'error';
  }
  const cls = classifyTile(r.columns, r.rows, q.chart);
  if (cls.kind === 'skip') { card.remove(); return 'skip'; }

  // Seed an isolated per-tile config with the resolved cfg + its schema key so
  // renderChart honours it (a schema-key mismatch would make it re-derive with
  // autoChart, discarding a favorite's saved chart shape).
  const res = { columns: r.columns, rows: r.rows };
  const chartTab = { chartKey: schemaKey(r.columns), chartCfg: cls.cfg };
  let inst = null;
  const draw = () => {
    if (inst && inst.destroy) inst.destroy();
    body.replaceChildren(renderChart(app, res, {
      tab: chartTab, rerender: draw, setChart: (c) => { inst = c; }, running: false,
    }));
  };
  draw();
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

  const header = h('div', { class: 'dash-header' },
    h('a', { class: 'dash-back', href: '/sql', title: 'Back to SQL Browser' },
      Icon.arrow(), h('span', null, 'SQL Browser')),
    h('div', { class: 'dash-title' }, state.libraryName.value),
    favChip,
    skipNote,
    h('div', { class: 'dash-spacer', style: { flex: '1' } }),
    h('span', { class: 'dash-chip dash-src', title: app.host() },
      h('span', { class: 'dash-dot' }), app.host()),
    updated,
    refreshBtn);

  const grid = h('div', { class: 'dash-grid' });
  const empty = h('div', { class: 'dash-empty', style: { display: favorites.length ? 'none' : '' } },
    'No favorites yet — star a query in the Library to add it to the dashboard.');

  app.root.replaceChildren(header, empty, grid);

  const refresh = async () => {
    refreshBtn.disabled = true;
    grid.replaceChildren();
    let skipped = 0;
    // try/finally so the button always re-enables and the timestamp always
    // updates — even if a tile render unexpectedly throws (runTile itself is
    // total, so this is belt-and-suspenders against the Promise.all rejecting).
    try {
      const outcomes = await Promise.all(favorites.map((q) => renderTile(app, q, grid)));
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
