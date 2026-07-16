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

import { h as _h } from './dom.js';
import { Icon } from './icons.js';
import { resolvePanel } from '../core/panel-cfg.js';
import type { KpiResult, ResultLike } from '../core/panel-cfg.js';
import { renderKpiCards as _renderKpiCards, KPI_STREAM_ARIA as _KPI_STREAM_ARIA } from './kpi-panel.js';
import type { Panel } from '../generated/json-schema.types.js';
import type { App } from './app.types.js';

// dom.js's `h(tag, props, ...children)` is unconverted JS (apply()'s `el`
// param is unannotated, so every call site would otherwise infer `any`) —
// this file only ever calls it with a string tag, a plain attrs object
// (class/role/aria-*/style, or `null`), and string/element children, so the
// wrapper below pins exactly that honest shape rather than letting `any`
// leak in.
type HAttrs = Record<string, string | Record<string, string>> | null;
type HChild = string | HTMLElement | SVGElement | null | undefined | false;
const h = _h as (tag: string, attrs: HAttrs, ...children: HChild[]) => HTMLElement;

// icons.js's `Icon.spinner()` is unconverted JS built via the same untyped
// `s()` SVG hyperscript — this file only ever appends its returned node as an
// `h()` child, so the wrapper pins the one shape that matters here.
const spinnerIcon = Icon.spinner as () => SVGElement;

// kpi-panel.js is unconverted JS. `KPI_STREAM_ARIA` is a plain object literal
// (no `any` risk, so a direct annotation suffices); `renderKpiCards` builds
// its `cards` via the same untyped `h()` this file wraps above, and reads/
// returns diagnostics shaped exactly like kpi.js's `diagnostic()`
// (severity/code/message/columnName?) — the shape this file's own warning
// aggregation and state-card rendering rely on.
const KPI_STREAM_ARIA: { role: string; 'aria-label': string } = _KPI_STREAM_ARIA;

/** One diagnostic as kpi.js's `readKpiFields`/kpi-panel.js's `renderKpiCards`
 *  produce it (severity/code/message, with an optional offending column). */
export interface KpiDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  columnName?: string;
}
const renderKpiCards = _renderKpiCards as (normalized: KpiResult | null | undefined) => {
  cards: HTMLElement[];
  warnings: KpiDiagnostic[];
  errors: KpiDiagnostic[];
};

/** One band warning: a source's `KpiDiagnostic` tagged with the source name
 *  that produced it (`refreshBandWarnings`'s shared rendering needs both). */
export interface KpiSourceWarning extends KpiDiagnostic {
  sourceName: string;
}

/** One KPI band's DOM handles + member sources, built by `buildKpiBand`. */
export interface KpiBand {
  el: HTMLElement;
  stream: HTMLElement;
  warningHost: HTMLElement;
  sources: KpiSourceSlot[];
}

/** One favorite's stable KPI source slot (`buildKpiSourceSlot`) — mirrors the
 *  ordinary tile slot's stable-identity/generation/abort fields exactly (see
 *  dashboard.js's `buildTileSlot`) so `runFavoriteSource`'s dispatch works
 *  unchanged over a KPI source. */
export interface KpiSourceSlot {
  kind: 'kpi-source';
  host: HTMLElement;
  band: KpiBand;
  name: string;
  explicit: Panel;
  warnings: KpiSourceWarning[];
  gen: number;
  status: 'loading' | 'unfilled' | 'error' | 'panel' | null;
  abortController: AbortController | null;
  loadLabel: HTMLElement | null;
}

/** A KPI source's completed-or-errored result, as this band applies it
 *  (`applyKpiSourceResult`) — the same `{error}` | `{columns, rows}` shape
 *  every dashboard source's request lifecycle settles into (dashboard.js). */
interface KpiSourceResult extends Pick<ResultLike, 'columns' | 'rows'> {
  /** `null` and absent both mean "no error" — the shared fetched-result shape
   *  carries `error: null` on success (the `!= null` guard below handles both). */
  error?: string | null;
}

/** One compact white state card (loading/unfilled/error) — the query name
 *  plus a message, replacing the KPI success cards in a source's stable host
 *  while it has none to show. `role` drives assistive-tech behavior: `status`
 *  (+ `aria-live=polite` for loading) or `alert` for errors. */
function kpiStateCard(
  name: string, role: 'status' | 'alert', live: boolean, ...messageChildren: (string | HTMLElement)[]
): HTMLElement {
  // Same resulting attrs either way as the original imperative
  // `if (live) attrs['aria-live'] = 'polite'` this replaces — spread-in-place
  // instead of mutate-after so the literal's type stays exact (no
  // after-construction assignment to an optional key). No behavior change.
  const attrs: HAttrs = {
    class: 'dash-kpi-state-card', role, 'aria-label': name,
    ...(live ? { 'aria-live': 'polite' } : {}),
  };
  return h('div', attrs,
    h('div', { class: 'dash-kpi-state-label' }, name),
    h('div', { class: 'dash-kpi-state-message' }, ...messageChildren));
}

/** Build one KPI band container: a full-width `.dash-kpi-band` holding the
 *  card `stream` and a `warningHost` for its shared warning area (rendered
 *  only while non-empty). `sources` accumulates this band's member slots in
 *  favorite order, read back by `refreshBandWarnings`. */
export function buildKpiBand(): KpiBand {
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
export function buildKpiSourceSlot(band: KpiBand, explicit: Panel, name: string): KpiSourceSlot {
  const host = h('div', { class: 'dash-kpi-source' });
  const slot: KpiSourceSlot = {
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
export function refreshBandWarnings(band: KpiBand): void {
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
export function setKpiSourceLoading(slot: KpiSourceSlot): HTMLElement {
  slot.status = 'loading';
  slot.warnings = [];
  const label = h('span', null, 'Loading…');
  slot.loadLabel = label;
  const row = h('div', { class: 'dash-kpi-state-loading' }, spinnerIcon(), label);
  slot.host.replaceChildren(kpiStateCard(slot.name, 'status', true, row));
  return label;
}

/** A KPI source blocked on an empty/invalid `{name:Type}` value (#170) — one
 *  filter value away from rendering, so it stays in its stable position with
 *  a neutral prompt rather than an error. */
export function setKpiSourceUnfilled(slot: KpiSourceSlot, names: string[]): void {
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
export function applyKpiSourceResult(app: App, explicit: Panel, slot: KpiSourceSlot, r: KpiSourceResult): void {
  const name = slot.name;
  if (r.error != null) {
    slot.status = 'error';
    slot.warnings = [];
    slot.host.replaceChildren(kpiStateCard(name, 'alert', false, r.error));
    refreshBandWarnings(slot.band);
    return;
  }
  const resolved = resolvePanel(explicit, {
    columns: r.columns, rows: r.rows, fieldConfig: explicit.fieldConfig, serverVersion: app.state.serverVersion ?? undefined,
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
