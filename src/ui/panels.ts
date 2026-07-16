// The panel registry (#166): one place that knows how to render each panel
// type, shared verbatim by the workbench Panel drawer tab and the dashboard's
// tiles — drawer preview ≡ tile by construction. Pure logic (the cfg union,
// mismatch policy, autoPanel) lives in core/panel-cfg.js; this module is the
// DOM dispatch plus the Panel tab itself. It never imports results.js —
// repaint scope, cell-detail handling, and instance ownership are caller
// seams (same discipline as chart-render/grid-render).
//
// Registry contract (#166):
//   PANEL_TYPES[type] = {
//     controls({ app, result, cfg, onChange }) → node | null,
//     renderPanel({ app, result, cfg, surface, state, rerender, readonly,
//                   cap, onCell, setChart }) → { node, destroy? },
//   }
// `surface` is 'workbench' | 'dashboard' (the detached Data Pane renders the
// workbench shape read-only). `state` is the surface-held mutable holder for
// grid sort/widths (the workbench keeps it on the result, the dashboard on
// the slot). `onChange(cfg)` hands the caller a NEW cfg to write back —
// controls never touch tab state themselves (#166's dirty pin).

import { h as hUntyped } from './dom.js';
import { Icon } from './icons.js';
import { renderChart as renderChartUntyped } from './chart-render.js';
import { patchSpecDraft, setTabSpecDraft, tabPanel } from '../state.js';
import type { PanelSpec, QuerySpecDraft, ResultSort } from '../state.js';
import type { App, Tab } from './app.types.js';
import { patchQueryPanel } from '../core/saved-query.js';
import { renderGridView as renderGridViewUntyped, GRID_VIS_CAP } from './grid-render.js';
import { renderLogs as renderLogsUntyped } from './logs.js';
import { parseMarkdown as parseMarkdownUntyped } from '../core/markdown-lite.js';
import {
  resolvePanel, resolveLogsShape, isChartFamily, CHART_FAMILY, clonePanelCfg,
} from '../core/panel-cfg.js';
import type { Column, ChartFamilyType, LogsShape, PanelResolution, KpiResult } from '../core/panel-cfg.js';
import { CHART_TYPES as CHART_TYPES_UNTYPED, schemaKey as schemaKeyUntyped } from '../core/chart-data.js';
import { renderKpiPanel as renderKpiPanelUntyped } from './kpi-panel.js';
import {
  applyResultChoice, DASHBOARD_ROLE_RESULT_CHOICES, PANEL_RESULT_CHOICES, resultChoiceForSpec,
} from '../core/result-choice.js';
import type { ResultChoice } from '../core/result-choice.js';
import type { FieldConfig, PanelCfg } from '../generated/json-schema.types.js';

// ── Typed wrappers over still-untyped .js dependencies ──────────────────────
// Each const pins exactly the signature this module relies on; the runtime
// module stays `.js` until its own leaf-up conversion (ADR-0002) — same
// convention as state.ts / core/panel-cfg.ts / core/result-choice.ts.

type ElProps = Record<string, unknown> | null;

/** dom.js's `h` supports far more (SVG documents, function components, style
 *  objects, ...) than this render module needs; the TagNameMap overload keeps
 *  e.g. `h('select', ...)` typed as HTMLSelectElement (so `.value` needs no
 *  cast at each call site) while every other/dynamic tag still returns a
 *  plain HTMLElement. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: ElProps, ...children: unknown[]
): HTMLElementTagNameMap[K];
function h(tag: string, props: ElProps, ...children: unknown[]): HTMLElement;
function h(tag: string, props: ElProps, ...children: unknown[]): HTMLElement {
  // `as`: dom.js is unconverted — its inferred signature is looser than the
  // overloads above promise; the runtime always creates exactly the
  // requested tag (document.createElement(tag)).
  return hUntyped(tag, props, ...children) as HTMLElement;
}

// icons.js is untyped; only Icon.chart() is used here — pinned to its actual
// return shape (a detached SVG element built by the SVG hyperscript).
const iconChart: () => Element = Icon.chart;

/** The Chart.js instance shape this module ever touches — matches
 *  `App.chart` (app.types.ts). */
interface PanelChartInstance { destroy(): void }

interface RenderChartOpts {
  cfg: PanelCfg;
  rerender?: () => void;
  onCfgChange?: (cfg: PanelCfg) => void;
  typeControl?: boolean;
  setChart?: (chart: PanelChartInstance) => void;
  controls?: boolean;
  fieldConfig?: FieldConfig;
  hideGrid?: boolean;
  running?: boolean;
}
// chart-render.js is untyped; renderChart reads only `.columns`/`.rows` off
// its result argument (never rawText/error/panelState — see chart-render.js).
const renderChart: (
  app: App, r: { columns: Column[]; rows: unknown[][] }, opts: RenderChartOpts,
) => HTMLElement = renderChartUntyped;

interface RenderGridViewArgs {
  columns: Column[];
  rows: unknown[][];
  sort: ResultSort;
  setSort: (next: ResultSort) => void;
  widths: Record<string, number>;
  rerender: () => void;
  // grid-render.js's renderGridView destructures both of these with no
  // default of its own (unlike the lower renderGrid it wraps) — the one
  // caller here (the table arm) always supplies the key (onCell possibly
  // undefined as a value; cap always resolved via `cap ?? GRID_VIS_CAP`), so
  // both stay required keys rather than papering over that with `?`.
  onCell: ((name: string, type: string, value: unknown) => void) | undefined;
  cap: number;
}
const renderGridView: (args: RenderGridViewArgs) => HTMLElement = renderGridViewUntyped;

interface RenderLogsArgs {
  columns: Column[];
  rows: unknown[][];
  shape: LogsShape;
  cap: number;
}
const renderLogs: (args: RenderLogsArgs) => HTMLElement = renderLogsUntyped;

const renderKpiPanel: (normalized?: KpiResult | null) => HTMLElement = renderKpiPanelUntyped;

// chart-data.js is unconverted (checkJs:false); CHART_TYPES' `value` is
// exactly one of the five chart PanelCfg type literals — the same wrapper
// cast panel-cfg.ts/result-choice.ts already apply to this same export.
const CHART_TYPES = CHART_TYPES_UNTYPED as { value: ChartFamilyType; label: string }[];
const schemaKey: (columns: Column[] | null | undefined) => string = schemaKeyUntyped;

// ── Markdown AST → DOM ───────────────────────────────────────────────────────

// The core/markdown-lite.js AST shapes this module builds DOM from. Pinned
// here (markdown-lite.js is unconverted) rather than re-derived per call site.
interface MdTextNode { t: 'text'; text: string }
interface MdStrongNode { t: 'strong'; children: MdInlineNode[] }
interface MdEmNode { t: 'em'; children: MdInlineNode[] }
interface MdCodeNode { t: 'code'; text: string }
interface MdLinkNode { t: 'link'; href: string; children: MdInlineNode[] }
type MdInlineNode = MdTextNode | MdStrongNode | MdEmNode | MdCodeNode | MdLinkNode;

interface MdHeadingBlock { t: 'h'; level: number; children: MdInlineNode[] }
interface MdParagraphBlock { t: 'p'; children: MdInlineNode[] }
interface MdListBlock { t: 'ul' | 'ol'; items: MdInlineNode[][] }
type MdBlock = MdHeadingBlock | MdParagraphBlock | MdListBlock;

const parseMarkdown: (text: string) => MdBlock[] = parseMarkdownUntyped;

// Inline nodes. Everything is built element-by-element with textContent-style
// children (h() sets strings as text nodes) — raw HTML in the source parsed as
// literal text and can only ever BE a text node here.
function inlineNodes(children: MdInlineNode[]): (HTMLElement | string)[] {
  return children.map((n) => {
    if (n.t === 'strong') return h('strong', null, ...inlineNodes(n.children));
    if (n.t === 'em') return h('em', null, ...inlineNodes(n.children));
    if (n.t === 'code') return h('code', null, n.text);
    if (n.t === 'link') {
      // Href already restricted to http(s) by the parser; target+rel keep a
      // panel link from reaching back into the app's browsing context.
      return h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer' }, ...inlineNodes(n.children));
    }
    return n.text; // {t:'text'} — h() appends strings as text nodes
  });
}

/**
 * Render a markdown-lite AST (core/markdown-lite.js) into a `.md-view` block.
 * Exported for the detached pane and tests. DOM-building only — no innerHTML
 * anywhere, so injection cases stay inert by construction.
 */
export function renderMarkdown(blocks: MdBlock[]): HTMLDivElement {
  const box = h('div', { class: 'md-view' });
  for (const b of blocks) {
    if (b.t === 'h') box.appendChild(h('h' + b.level, null, ...inlineNodes(b.children)));
    else if (b.t === 'ul' || b.t === 'ol') {
      box.appendChild(h(b.t, null, ...b.items.map((item) => h('li', null, ...inlineNodes(item)))));
      // `else if (b.t === 'p')` (not a bare `else`): TS doesn't narrow a
      // discriminated union past a negated `||` condition into a bare final
      // `else` — the explicit check is a type-checker nudge only, MdBlock is
      // still the same closed 3-member union at runtime.
    } else if (b.t === 'p') box.appendChild(h('p', null, ...inlineNodes(b.children)));
  }
  return box;
}

// ── Per-arm helpers ──────────────────────────────────────────────────────────

interface SelectOption { value: string; label: string; disabled?: boolean }

/** A labelled <select>, same look as the chart config bar's fields.
 * `selectMeta.invalid`/`.title` expose an accessible invalid state (#196) —
 * the select itself stays enabled; only individual options may be disabled. */
function panelSelect(
  label: string, value: string, options: SelectOption[], onPick: (value: string) => void,
  selectMeta: { invalid?: boolean; title?: string } = {},
): HTMLLabelElement {
  const attrs: Record<string, unknown> = {
    class: 'chart-select', onchange: (e: Event) => onPick((e.target as HTMLSelectElement).value),
  };
  if (selectMeta.invalid) attrs['aria-invalid'] = 'true';
  if (selectMeta.title) attrs.title = selectMeta.title;
  const sel = h('select', attrs);
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label);
    if (o.disabled) opt.disabled = true;
    sel.appendChild(opt);
  }
  // Set after every option is in the DOM tree — a detached option's `selected`
  // is not reliably honored by all engines once appended (happy-dom included).
  sel.value = value;
  return h('label', { class: 'chart-field' }, h('span', { class: 'chart-field-label' }, label), sel);
}

function panelEmpty(msg: string): HTMLDivElement {
  return h('div', { class: 'chart-empty' }, h('div', { class: 'chip' }, iconChart()), h('div', null, msg));
}

// A saved Logs role's UI state, matched case-insensitively against the
// current result's columns — must mirror resolveLogsShape's matching policy
// (first match wins) so the selector never disagrees with panel resolution
// (#196). `columns` is null pre-Run (no current result to compare against
// yet); treat that as "not yet known to be stale" rather than missing.
function logsRoleState(
  value: unknown, columns: Column[] | null,
): { raw: string; selected: string; stale: boolean } {
  const raw = value == null ? '' : String(value);
  if (raw === '') return { raw: '', selected: '', stale: false };
  if (!columns) return { raw, selected: raw, stale: false };
  const match = columns.find((c) => String(c.name).toLowerCase() === raw.toLowerCase());
  if (match) return { raw, selected: String(match.name), stale: false };
  return { raw, selected: raw, stale: true };
}

type LogsRoleName = 'time' | 'msg' | 'level';

// One column-name role picker for the logs arm: '' = auto (convention). A
// non-empty saved name absent from the current result renders as a selected,
// disabled "<name> (missing)" option instead of silently falling back to
// `(auto)` (#196) — the select stays enabled so the user can repair it.
function logsRoleSelect(
  label: string, cfgName: LogsRoleName,
  { result, cfg, onChange }: { result: PanelResult | null; cfg: PanelCfg; onChange: (cfg: PanelCfg) => void },
): HTMLLabelElement {
  const state = logsRoleState(cfg[cfgName], result ? result.columns : null);
  const options: SelectOption[] = [
    { value: '', label: '(auto)' },
    ...(state.stale ? [{ value: state.raw, label: `${state.raw} (missing)`, disabled: true }] : []),
    ...(result ? result.columns.map((c) => ({ value: c.name, label: c.name })) : []),
  ];
  const meta = state.stale
    ? { invalid: true, title: `Saved column "${state.raw}" is not present in this result` }
    : {};
  return panelSelect(label, state.selected, options, (v) => {
    const next: PanelCfg = { ...cfg };
    if (v) next[cfgName] = v; else delete next[cfgName];
    onChange(next);
  }, meta);
}

// ── The registry ─────────────────────────────────────────────────────────────

/** The live run-result object this module reads from — owned/shaped by
 *  ui/results.js (`QueryTab.result` in state.ts is deliberately opaque
 *  there). Pins exactly what panels.ts dereferences: every render arm reads
 *  columns/rows; the Panel-tab dispatch additionally gates on error/rawText
 *  and lazily attaches its own panelState (grid sort/widths) here. */
interface PanelResult {
  columns: Column[];
  rows: unknown[][];
  error: unknown;
  rawText: string | null;
  panelState?: Record<string, unknown>;
}

/** Shared render-arm result shape — every `renderPanel` (and
 *  `renderResolvedPanel`) returns this. */
export interface PanelRenderResult {
  node: HTMLElement;
  destroy?: () => void;
}

interface PanelControlsArgs {
  app: App;
  result: PanelResult | null;
  cfg: PanelCfg;
  onChange: (cfg: PanelCfg) => void;
  readonly?: boolean;
}

interface PanelRenderArgs {
  app: App;
  result: PanelResult | null;
  cfg: PanelCfg;
  fieldConfig?: FieldConfig;
  shape?: LogsShape;
  kpi?: KpiResult | null;
  surface?: 'workbench' | 'dashboard';
  state?: Record<string, unknown>;
  rerender?: () => void;
  readonly?: boolean;
  cap?: number;
  onCell?: (name: string, type: string, value: unknown) => void;
  onCfgChange?: (cfg: PanelCfg) => void;
  setChart?: (chart: PanelChartInstance) => void;
}

interface PanelArm {
  controls(args: PanelControlsArgs): HTMLElement | null;
  renderPanel(args: PanelRenderArgs): PanelRenderResult;
}

/**
 * Narrow one or more `PanelRenderArgs` fields for a single arm's
 * `renderPanel` (e.g. a non-null, required `result`) while keeping every
 * other key present with its original type. TS's bivariant method-parameter
 * check — which is what lets an arm's own `renderPanel` accept a narrower
 * type than the shared `PanelArm` interface promises — only applies when the
 * arm's destructured parameter type has the SAME key set as `PanelRenderArgs`
 * (just narrower per-field types); a type that drops some keys *and* narrows
 * another falls back to strict, contravariant checking and fails to
 * compile. `Omit<..., keyof T> & T` reconstructs that full key set.
 */
type NarrowRenderArgs<T extends Partial<PanelRenderArgs>> = Omit<PanelRenderArgs, keyof T> & T;

const chartArm: PanelArm = {
  // The chart family's field controls live inside renderChart's own config
  // bar (X/Y/Series/All-measures; its Type select is suppressed — the Panel
  // tab's picker owns type). No separate controls() row.
  controls: () => null,
  renderPanel({ app, result, cfg, fieldConfig, surface, rerender, readonly, onCfgChange, setChart }: {
    app: App; result: PanelResult; cfg: PanelCfg; fieldConfig?: FieldConfig;
    surface?: 'workbench' | 'dashboard'; rerender?: () => void; readonly?: boolean;
    onCfgChange?: (cfg: PanelCfg) => void; setChart?: (chart: PanelChartInstance) => void;
  }): PanelRenderResult {
    let inst: PanelChartInstance | null = null;
    const node = renderChart(app, result, {
      cfg,
      rerender,
      onCfgChange,
      typeControl: false,
      setChart: (c: PanelChartInstance) => { inst = c; if (setChart) setChart(c); },
      controls: surface === 'workbench' && !readonly,
      fieldConfig,
      hideGrid: surface === 'dashboard',
      running: false, // the caller gates on run state before dispatching
    });
    return { node, destroy: () => { if (inst) { inst.destroy(); inst = null; } } };
  },
};

// Each arm is declared as its own `: PanelArm`-typed const (like chartArm
// above) rather than inline inside the PANEL_TYPES literal below: assigning
// an object literal straight into a `Record<string, PanelArm>` (a mapped
// type) checks each arm's `renderPanel`/`controls` CONTRAVARIANTLY against
// the shared, wider `PanelRenderArgs`/`PanelControlsArgs` — losing the
// method-shorthand bivariance that lets each arm narrow to exactly the
// fields it reads (e.g. a non-null `result`). Assigning through a named
// `PanelArm`-typed intermediate keeps that per-arm narrowing.
const kpiArm: PanelArm = {
  controls: () => null,
  renderPanel({ kpi }: { kpi?: KpiResult | null }): PanelRenderResult { return { node: renderKpiPanel(kpi) }; },
};

const tableArm: PanelArm = {
  controls: () => null, // no schema-bound fields; sort/widths are surface state
  renderPanel({ result, state, rerender, cap, onCell }: NarrowRenderArgs<{
    result: PanelResult; state: Record<string, unknown>; rerender: () => void;
  }>): PanelRenderResult {
    // `as`: only the grid-family arms ever populate `state.sort`/`.widths`,
    // always in this exact shape (the workbench's per-result holder and the
    // dashboard's per-slot holder both start empty and are filled here).
    const sort: ResultSort = (state.sort as ResultSort | undefined) || { col: null, dir: 'asc' };
    const widths: Record<string, number> = (state.widths as Record<string, number> | undefined) || {};
    state.sort = sort;
    state.widths = widths;
    return {
      node: renderGridView({
        columns: result.columns,
        rows: result.rows,
        sort,
        setSort: (next: ResultSort) => { state.sort = next; },
        widths,
        rerender,
        onCell,
        cap: cap ?? GRID_VIS_CAP,
      }),
    };
  },
};

const logsArm: PanelArm = {
  controls({ app, result, cfg, onChange }: PanelControlsArgs): HTMLElement {
    const args = { app, result, cfg, onChange };
    return h('div', { class: 'chart-config' },
      logsRoleSelect('Time', 'time', args),
      logsRoleSelect('Message', 'msg', args),
      logsRoleSelect('Level', 'level', args));
  },
  renderPanel({ result, cfg, cap, shape }: NarrowRenderArgs<{
    result: PanelResult; cfg: PanelCfg;
  }>): PanelRenderResult {
    // `shape` arrives pre-resolved from resolvePanel when the caller went
    // through renderResolvedPanel (it may be the re-derived convention shape
    // after a name mismatch); a direct call re-resolves from the cfg.
    const s = shape || resolveLogsShape(cfg, result.columns);
    if (!s) return { node: panelEmpty('No time + message columns in this result — pick them above or adjust the query.') };
    return { node: renderLogs({ columns: result.columns, rows: result.rows, shape: s, cap: cap ?? GRID_VIS_CAP }) };
  },
};

const textArm: PanelArm = {
  controls({ app, cfg, onChange, readonly }: {
    app: App; cfg: PanelCfg; onChange: (cfg: PanelCfg) => void; readonly?: boolean;
  }): HTMLElement | null {
    if (readonly) return null;
    // Markdown lives in panel.cfg.content (Grafana's model). Editing fires
    // onChange per input; the preview below re-renders from the new cfg.
    const ta = h('textarea', {
      class: 'panel-text-input',
      'aria-label': 'Markdown content',
      placeholder: '# Markdown\n\nHeadings, **bold**, *italic*, lists, [links](https://…), `code`.',
      oninput: (e: Event) => onChange({ ...cfg, content: (e.target as HTMLTextAreaElement).value }),
    });
    // `as`: `content` is typed `string` only on TextPanelCfg; every other
    // PanelCfg branch (and FuturePanelCfg) carries it only through its
    // index signature. This arm is only ever dispatched for
    // `cfg.type === 'text'`, and query-spec-v1.schema.json's TextPanelCfg
    // only allows a string here.
    ta.value = (cfg.content as string | undefined) || '';
    return h('div', { class: 'panel-text-edit' }, ta);
  },
  renderPanel({ cfg }: { cfg: PanelCfg }): PanelRenderResult {
    // Needs no result at all — the one arm that renders without a Run.
    // `as`: same ingress note as the controls arm above.
    return { node: renderMarkdown(parseMarkdown((cfg.content as string | undefined) || '')) };
  },
};

const PANEL_TYPES: Record<string, PanelArm> = {
  kpi: kpiArm,
  table: tableArm,
  logs: logsArm,
  text: textArm,
};
for (const t of CHART_FAMILY) PANEL_TYPES[t] = chartArm;
export { PANEL_TYPES };

/** Workbench-selectable panel types. `table` remains an internal registry arm
 * for dashboards, auto fallback, and migrated entries; the ordinary Table
 * result view is its workbench surface, so offering it here would duplicate
 * the adjacent Table button. */
export const PANEL_PICKER_OPTIONS: { value: string; label: string }[] = [
  { value: 'kpi', label: 'KPI' },
  ...CHART_TYPES,
  { value: 'logs', label: 'Logs' },
  { value: 'text', label: 'Text' },
];

// ── The workbench Panel drawer tab ───────────────────────────────────────────

interface RenderResolvedPanelOpts {
  surface: 'workbench' | 'dashboard';
  state: Record<string, unknown>;
  rerender: () => void;
  readonly?: boolean;
  cap?: number;
  onCell?: (name: string, type: string, value: unknown) => void;
  onCfgChange?: (cfg: PanelCfg) => void;
  setChart?: (chart: PanelChartInstance) => void;
}

/**
 * Render one panel (type dispatch + fallback diagnostics) from an already-
 * resolved `resolvePanel` outcome. Shared by the drawer preview, the detached
 * pane, and the dashboard tile so the three surfaces cannot drift. Returns
 * `{ node, destroy? }`.
 */
export function renderResolvedPanel(
  app: App, resolved: PanelResolution, result: PanelResult | null, opts: RenderResolvedPanelOpts,
): PanelRenderResult {
  const arm = PANEL_TYPES[resolved.cfg.type];
  const out = arm.renderPanel({
    app, result, cfg: resolved.cfg, fieldConfig: resolved.fieldConfig,
    shape: resolved.shape, kpi: resolved.kpi, ...opts,
  });
  if (!resolved.diagnostic && !resolved.rederived) return out;
  // Wrap with the mismatch affordance: a small hint bar above the panel.
  const note = resolved.diagnostic
    ? h('div', { class: 'panel-note is-fallback' }, resolved.diagnostic)
    : h('div', { class: 'panel-note' }, 'Roles re-detected for this result’s schema.');
  return { node: h('div', { class: 'panel-with-note' }, note, out.node), destroy: out.destroy };
}

/** The Panel-tab caller seams (results.js's panelHooks): the repaint scope,
 *  the cell drawer, the tab-dirty wiring, and the display cap. */
interface PanelHooks {
  rerender: () => void;
  onCell: (name: string, type: string, value: unknown) => void;
  cap?: number;
  markDirty: () => void;
}

interface PanelContext {
  tab: Tab;
  hasGrid: boolean;
  columns: Column[];
  saved: PanelSpec | null;
  resolved: PanelResolution;
  rescueLogs: boolean;
}

/**
 * The results-pane Panel tab (#166): a Type picker + the per-type config row
 * + a preview rendered ONLY from the tab's last explicit Run result — no
 * preview ever executes SQL; switching type or editing cfg fires nothing but
 * a local repaint. The text arm needs no result at all; query-backed arms
 * show an empty-preview hint until a Run has happened.
 *
 * Dirty pin (#166): the preview renders resolvePanel's CLONE; `tab.specParsed.panel`
 * is written only here from picker/controls changes. Render never writes it,
 * so auto-derived cfg stays transient. Unknown panel siblings are retained.
 *
 * `hooks`: { onCell(name,type,value), markDirty() } — supplied by results.js
 * (cell drawer + tab-dirty wiring live there; importing them here would
 * recreate the results-import cycle).
 */
function panelContext(app: App, r: PanelResult | null): PanelContext {
  const tab = app.activeTab();
  const hasGrid = !!(r && !r.error && r.rawText == null && r.rows);
  const columns = hasGrid ? r.columns : [];
  const saved = tabPanel(tab);
  const resolved = resolvePanel(saved, {
    columns, rows: hasGrid ? r.rows : null,
    fieldConfig: saved?.fieldConfig, serverVersion: app.state.serverVersion ?? undefined,
  });
  // Rescue (#192/#195): a saved Logs panel that falls back (its Time/Message
  // roles no longer resolve) still needs its Logs controls so the user can
  // repair the roles, but the fallback preview (Table OR a derived chart) is
  // a temporary stand-in — not the saved config — so it must render and be
  // presented as read-only. Scoped strictly to saved.cfg.type === 'logs'
  // (never a generic saved-type dispatch): unknown saved types must keep
  // falling back safely. Shared by the picker and the view so neither can
  // drift from the other's rescue condition.
  const rescueLogs = hasGrid && saved?.cfg?.type === 'logs' && resolved.fallback;
  return { tab, hasGrid, columns, saved, resolved, rescueLogs };
}

interface PanelWritePayload { cfg: PanelCfg; key?: string | null }

function writePanel(app: App, hooks: PanelHooks, payload: PanelWritePayload, activate = false): void {
  const tab = app.activeTab();
  const result = patchSpecDraft(tab, (spec: QuerySpecDraft | null): QuerySpecDraft => patchQueryPanel(
    { id: tab.savedId, sql: tab.sqlDraft, specVersion: tab.specVersion, spec },
    { cfg: payload.cfg, key: payload.key ?? undefined },
  ).spec, { dirty: true, validationService: app.specValidators });
  if (!result.ok) {
    // `!`: invalidTab is always this same `tab` here — patchSpecDraft only
    // nulls it when the tab argument itself was null, which app.activeTab()
    // never returns.
    app.activateInvalidSpecDraft(result.invalidTab!);
    return;
  }
  app.revalidateSpecDrafts();
  app.specEditor.syncFromState();
  if (activate) app.state.resultView.value = 'panel';
  hooks.markDirty();
  hooks.rerender();
}

/** Compact panel-type selector for the main results toolbar. When Table/JSON
 * is active it shows a neutral `Panel…` prompt; choosing a type both configures
 * the panel and activates its view. This keeps Table/JSON one-click views while
 * removing the redundant fixed Panel button and the old full-width picker row. */
export function renderPanelTypePicker(app: App, r: PanelResult | null, hooks: PanelHooks): HTMLSelectElement {
  const { hasGrid, columns, saved, resolved, rescueLogs } = panelContext(app, r);
  const select = h('select', {
    class: 'result-panel-select' + (['panel', 'filter'].includes(app.state.resultView.value) ? ' active' : ''),
    'aria-label': 'Result presentation',
    title: 'Choose a panel visualization or Dashboard role',
    onchange: (e: Event) => {
      const target = e.target as HTMLSelectElement;
      const selectedId = target.value.includes(':') ? target.value : `panel:${target.value}`;
      const choice = [...PANEL_RESULT_CHOICES, ...DASHBOARD_ROLE_RESULT_CHOICES]
        .find((item) => item.id === selectedId);
      if (!choice) return;
      const tab = app.activeTab();
      const apply = (spec: QuerySpecDraft | null): QuerySpecDraft => {
        let query: unknown = { id: tab.savedId, sql: tab.sqlDraft, specVersion: tab.specVersion, spec };
        if (choice.kind === 'panel') {
          const base = saved && !resolved.rederived
            ? saved
            : { cfg: resolved.cfg, key: hasGrid && isChartFamily(resolved.cfg.type) ? schemaKey(columns) : null };
          query = patchQueryPanel(query, { cfg: base.cfg, key: base.key ?? undefined });
        }
        return applyResultChoice(query, choice, columns).spec;
      };
      let result: { ok: boolean; invalidTab: Tab | null };
      if (choice.kind === 'role' && !tab.specDiagnostics?.some((item) => item.code === 'invalid-json')) {
        setTabSpecDraft(tab, apply(tab.specParsed), { dirty: true, validationService: app.specValidators });
        result = { ok: true, invalidTab: null };
      } else {
        result = patchSpecDraft(tab, apply, { dirty: true, validationService: app.specValidators });
      }
      if (!result.ok) {
        // `!`: same invariant as writePanel above — invalidTab is always this `tab`.
        app.activateInvalidSpecDraft(result.invalidTab!);
        return;
      }
      app.revalidateSpecDrafts();
      app.specEditor.syncFromState();
      app.state.resultView.value = choice.kind === 'role' ? 'filter' : 'panel';
      hooks.markDirty();
      hooks.rerender();
    },
  });
  // A disabled placeholder shown whenever the drawer is on Table/JSON (not a
  // preview). Selecting it is impossible, so picking ANY real entry — even the
  // query's current type/role — is a genuine `change` that switches the view to
  // that preview. Without it, `select.value` would already equal the current
  // choice and re-picking it would fire no event (the view would never switch).
  const prompt = h('option', { value: '' }, 'Preview…');
  prompt.disabled = true;
  select.appendChild(prompt);
  const panelGroup = h('optgroup', { label: 'Panel' });
  if (resultChoiceForSpec(app.activeTab().specParsed) === 'panel:auto') {
    const auto = h('option', { value: 'panel:auto' }, '(auto)');
    auto.disabled = true;
    panelGroup.appendChild(auto);
  }
  for (const option of PANEL_RESULT_CHOICES) panelGroup.appendChild(h('option', { value: option.id }, option.label));
  const roleGroup = h('optgroup', { label: 'Dashboard role' });
  for (const option of DASHBOARD_ROLE_RESULT_CHOICES) roleGroup.appendChild(h('option', { value: option.id }, option.label));
  select.append(panelGroup, roleGroup);
  // Reflect the current choice only while a preview is showing; on Table/JSON
  // the placeholder is selected so any pick is a real change (see above).
  select.value = ['panel', 'filter'].includes(app.state.resultView.value)
    ? resultChoiceForSpec(app.activeTab().specParsed)
    : '';
  return select;
}

export function renderPanelView(app: App, r: PanelResult | null, hooks: PanelHooks): HTMLElement {
  const { hasGrid, columns, saved, resolved, rescueLogs } = panelContext(app, r);

  const writeBack = (payload: PanelWritePayload): void => {
    writePanel(app, hooks, payload);
  };
  // The chart bar mutates the resolved clone in place (its handlers predate
  // the registry); adopting it via onCfgChange is the explicit write-back.
  const onCfgChange = (cfg: PanelCfg): void => writeBack({
    cfg,
    key: isChartFamily(cfg.type) && hasGrid ? schemaKey(columns) : null,
  });
  const onChange = (cfg: PanelCfg): void => writeBack({ cfg, key: saved && saved.key != null ? saved.key : null });

  // A clone, like resolved.cfg always is — controls never receive live Spec.
  const [controlsArm, controlsCfg]: [PanelArm, PanelCfg] = rescueLogs
    // `!`: rescueLogs is true only when `saved?.cfg?.type === 'logs'` (checked
    // in panelContext), so `saved` and `saved.cfg` are both non-null here;
    // clonePanelCfg only ever returns null for a falsy/non-object input (see
    // its own doc comment in panel-cfg.ts).
    ? [PANEL_TYPES.logs, clonePanelCfg(saved!.cfg)!]
    : [PANEL_TYPES[resolved.cfg.type], resolved.cfg];
  const controlsNode = controlsArm.controls({ app, result: hasGrid ? r : null, cfg: controlsCfg, onChange });
  const kpiHint = resolved.cfg.type === 'kpi'
    ? h('div', { class: 'panel-authoring-hint' }, 'Labels, units, decimals, colors, and delta semantics are authored in Spec → panel.fieldConfig.')
    : null;
  const bar = controlsNode || kpiHint ? h('div', { class: 'panel-config' }, controlsNode, kpiHint) : null;

  const body = h('div', { class: 'panel-body' });
  const isText = resolved.cfg.type === 'text';
  // Query-backed arms need a completed Run: no result yet OR a live run (its
  // half-streamed rows must not paint a half chart — same gate the old chart
  // view had). The text arm renders regardless — it needs no result at all.
  if ((!hasGrid || app.state.running.value) && !isText) {
    body.appendChild(panelEmpty(app.state.running.value
      ? 'Panel renders when the query completes.'
      : 'Run the query (⌘↵) to preview this panel.'));
  } else {
    const { node } = renderResolvedPanel(app, resolved, hasGrid ? r : null, {
      surface: 'workbench',
      state: r ? (r.panelState = r.panelState || {}) : {},
      rerender: hooks.rerender,
      readonly: rescueLogs,
      cap: hasGrid ? hooks.cap : undefined,
      onCell: hooks.onCell,
      // Defense in depth (#195): even a future fallback renderer that ignores
      // `readonly` still has no write-back callback to call during rescue —
      // the fallback preview must never be able to replace the saved Logs cfg.
      onCfgChange: rescueLogs ? undefined : onCfgChange,
      setChart: (c: PanelChartInstance) => { app.chart = c; }, // renderResults' destroy-before-rebuild slot
    });
    body.appendChild(node);
  }
  return h('div', { class: 'panel-view' }, bar, body);
}
