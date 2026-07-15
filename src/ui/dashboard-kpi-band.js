// The Dashboard KPI band (#240): consecutive explicit `panel.cfg.type==='kpi'`
// favorites render as one full-width, flat card stream instead of each being
// its own gray tile with a nested KPI grid. Isolated from `src/ui/dashboard.js`
// so its own branches (state cards, warning aggregation) get independent test
// coverage rather than inflating that file's already-100%-covered functions.
//
// A band owns `{ el, stream, warningHost, sources }`: `stream` is the flex-wrap
// `.dash-kpi-stream` card row (spans every Dashboard grid column via CSS,
// independent of the selected tile layout); `warningHost` is the band's shared
// `.dash-kpi-warnings` area below it. Each member favorite gets one stable
// `.dash-kpi-source` slot (`display:contents` — its children participate
// directly in the stream's flex-wrap without adding a visible box) appended to
// `stream` in favorite order at band-build time and never reordered; a source's
// own request lifecycle only ever replaces ITS host's children in place
// (loading → success cards | state card), mirroring the ordinary tile slot's
// "never remove/reappend" discipline (dashboard.js's buildTileSlot) so the
// #193 stable-slot-identity/generation/abort guarantees extend unchanged to
// KPI sources.

import { h } from './dom.js';
import { Icon } from './icons.js';
import { resolvePanel } from '../core/panel-cfg.js';
import { renderKpiCards, KPI_STREAM_ARIA } from './kpi-panel.js';

/** One compact white state card (loading/unfilled/error) — the query name
 *  plus a message, replacing the KPI success cards in a source's stable host
 *  while it has none to show. `role` drives assistive-tech behavior: `status`
 *  (+ `aria-live=polite` for loading) or `alert` for errors. */
function kpiStateCard(name, role, live, ...messageChildren) {
  const attrs = { class: 'dash-kpi-state-card', role, 'aria-label': name };
  if (live) attrs['aria-live'] = 'polite';
  return h('div', attrs,
    h('div', { class: 'dash-kpi-state-label' }, name),
    h('div', { class: 'dash-kpi-state-message' }, ...messageChildren));
}

/** Build one KPI band container: a full-width `.dash-kpi-band` holding the
 *  card `stream` and a `warningHost` for its shared warning area (rendered
 *  only while non-empty). `sources` accumulates this band's member slots in
 *  favorite order, read back by `refreshBandWarnings`. */
export function buildKpiBand() {
  const stream = h('div', { class: 'dash-kpi-stream', ...KPI_STREAM_ARIA });
  const warningHost = h('div', { class: 'dash-kpi-warnings', style: { display: 'none' } });
  const el = h('div', { class: 'dash-kpi-band' }, stream, warningHost);
  return { el, stream, warningHost, sources: [] };
}

/** Build one favorite's stable KPI source slot, append its host into the
 *  band's stream (favorite order), and register it on the band for warning
 *  aggregation. `explicit` (the favorite's saved `cfg.type==='kpi'` panel) is
 *  cached on the slot once, here, at the same structural build time
 *  `partitionKpiBands` already establishes eligibility — so a later wave's
 *  dispatch (dashboard.js's runPlan) reads `slot.explicit` instead of
 *  re-deriving it every Refresh/filter-affected run. `abortController` mirrors
 *  buildTileSlot's field exactly, so runFavoriteSource's existing generation-
 *  guard/abort dispatch works unchanged over a KPI source. */
export function buildKpiSourceSlot(band, explicit, name) {
  const host = h('div', { class: 'dash-kpi-source' });
  const slot = {
    kind: 'kpi-source', host, band, name, explicit, warnings: [],
    gen: 0, status: null, abortController: null, loadLabel: null,
  };
  band.sources.push(slot);
  band.stream.appendChild(host);
  return slot;
}

/** Rebuild a band's shared warning area from every member source's current
 *  `warnings`, in source order (favorite order, set at band-build time) then
 *  diagnostic order — a stale rerun replaces it wholesale, never appends.
 *  Every entry is always `severity:'warning'` (renderKpiCards's `warnings`
 *  output is pre-filtered to that severity) so the role/class are fixed,
 *  not diagnostic-driven — a blocking (`error`) diagnostic is a state card,
 *  never a band warning. */
export function refreshBandWarnings(band) {
  const all = band.sources.flatMap((slot) => slot.warnings);
  band.warningHost.style.display = all.length ? '' : 'none';
  band.warningHost.replaceChildren(...all.map((w) => h('div', {
    class: 'dash-kpi-warning', role: 'status',
  }, `${w.sourceName}: ${w.message}`)));
}

/** One compact loading state card, in the source's stable position. Returns
 *  the live message text node so streamed row progress (onChunk, #193) can
 *  update just its text, exactly like the ordinary tile's loading label.
 *  Does NOT itself call `refreshBandWarnings` — a Refresh wave marks every
 *  affected source loading in one synchronous pass (dashboard.js's runPlan),
 *  and rebuilding the shared band DOM once per source in that pass would be
 *  N redundant O(N) rebuilds before the first ever paints; the caller
 *  refreshes each distinct touched band exactly once after the pass instead. */
export function setKpiSourceLoading(slot) {
  slot.status = 'loading';
  slot.warnings = [];
  const label = h('span', null, 'Loading…');
  slot.loadLabel = label;
  const row = h('div', { class: 'dash-kpi-state-loading' }, Icon.spinner(), label);
  slot.host.replaceChildren(kpiStateCard(slot.name, 'status', true, row));
  return label;
}

/** A KPI source blocked on an empty/invalid `{name:Type}` value (#170) — one
 *  filter value away from rendering, so it stays in its stable position with
 *  a neutral prompt rather than an error. */
export function setKpiSourceUnfilled(slot, names) {
  slot.status = 'unfilled';
  slot.warnings = [];
  slot.host.replaceChildren(kpiStateCard(slot.name, 'status', false, 'Enter a value for: ' + names.join(', ')));
  refreshBandWarnings(slot.band);
}

/** Apply a completed (or errored) result to one KPI source: a transport/SQL
 *  error or a blocking KPI diagnostic (zero rows, wrong row count, no
 *  eligible fields) renders as one state card; otherwise the normalized KPI
 *  cards replace the source's host contents and its warnings feed the band's
 *  shared area. `explicit` is always a `cfg.type==='kpi'` panel here — band
 *  membership is gated on exactly that at partition time (core/dashboard.js's
 *  `partitionKpiBands`), so `resolvePanel`'s kpi branch is unconditional and
 *  its non-kpi fallback path can't be reached from a KPI source. Streamed row
 *  progress during the fetch updates `label.textContent` directly (see
 *  dashboard.js), never re-entering this function mid-stream. */
export function applyKpiSourceResult(app, explicit, slot, r) {
  const name = slot.name;
  if (r.error != null) {
    slot.status = 'error';
    slot.warnings = [];
    slot.host.replaceChildren(kpiStateCard(name, 'alert', false, r.error));
    refreshBandWarnings(slot.band);
    return;
  }
  const resolved = resolvePanel(explicit, {
    columns: r.columns, rows: r.rows, fieldConfig: explicit.fieldConfig, serverVersion: app.state.serverVersion,
  });
  const { cards, warnings, errors } = renderKpiCards(resolved.kpi);
  if (errors.length) {
    slot.status = 'error';
    slot.warnings = [];
    // Every blocking diagnostic stacks as its own line in the ONE state card
    // (never dropped) — the workbench's renderKpiPanel renders the same
    // `errors` list in full (kpi-panel.js), so the two surfaces show
    // identical diagnostic detail for identical data.
    const role = errors.some((d) => d.severity === 'error') ? 'alert' : 'status';
    const lines = errors.map((d) => h('div', null, d.message));
    slot.host.replaceChildren(kpiStateCard(name, role, false, ...lines));
    refreshBandWarnings(slot.band);
    return;
  }
  slot.status = 'panel';
  slot.warnings = warnings.map((w) => ({ ...w, sourceName: name }));
  slot.host.replaceChildren(...cards);
  refreshBandWarnings(slot.band);
}
