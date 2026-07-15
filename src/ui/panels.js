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

import { h } from './dom.js';
import { Icon } from './icons.js';
import { renderChart } from './chart-render.js';
import { patchSpecDraft, setTabSpecDraft, tabPanel } from '../state.js';
import { patchQueryPanel } from '../core/saved-query.js';
import { renderGridView, GRID_VIS_CAP } from './grid-render.js';
import { renderLogs } from './logs.js';
import { parseMarkdown } from '../core/markdown-lite.js';
import {
  resolvePanel, resolveLogsShape, switchPanelType, isChartFamily, CHART_FAMILY, clonePanelCfg,
} from '../core/panel-cfg.js';
import { CHART_TYPES, schemaKey } from '../core/chart-data.js';
import { renderKpiPanel } from './kpi-panel.js';
import {
  applyResultChoice, DASHBOARD_ROLE_RESULT_CHOICES, PANEL_RESULT_CHOICES, resultChoiceForSpec,
} from '../core/result-choice.js';

// ── Markdown AST → DOM ───────────────────────────────────────────────────────

// Inline nodes. Everything is built element-by-element with textContent-style
// children (h() sets strings as text nodes) — raw HTML in the source parsed as
// literal text and can only ever BE a text node here.
function inlineNodes(children) {
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
export function renderMarkdown(blocks) {
  const box = h('div', { class: 'md-view' });
  for (const b of blocks) {
    if (b.t === 'h') box.appendChild(h('h' + b.level, null, ...inlineNodes(b.children)));
    else if (b.t === 'ul' || b.t === 'ol') {
      box.appendChild(h(b.t, null, ...b.items.map((item) => h('li', null, ...inlineNodes(item)))));
    } else box.appendChild(h('p', null, ...inlineNodes(b.children)));
  }
  return box;
}

// ── Per-arm helpers ──────────────────────────────────────────────────────────

/** A labelled <select>, same look as the chart config bar's fields.
 * `selectMeta.invalid`/`.title` expose an accessible invalid state (#196) —
 * the select itself stays enabled; only individual options may be disabled. */
function panelSelect(label, value, options, onPick, selectMeta = {}) {
  const attrs = { class: 'chart-select', onchange: (e) => onPick(e.target.value) };
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

function panelEmpty(msg) {
  return h('div', { class: 'chart-empty' }, h('div', { class: 'chip' }, Icon.chart()), h('div', null, msg));
}

// A saved Logs role's UI state, matched case-insensitively against the
// current result's columns — must mirror resolveLogsShape's matching policy
// (first match wins) so the selector never disagrees with panel resolution
// (#196). `columns` is null pre-Run (no current result to compare against
// yet); treat that as "not yet known to be stale" rather than missing.
function logsRoleState(value, columns) {
  const raw = value == null ? '' : String(value);
  if (raw === '') return { raw: '', selected: '', stale: false };
  if (!columns) return { raw, selected: raw, stale: false };
  const match = columns.find((c) => String(c.name).toLowerCase() === raw.toLowerCase());
  if (match) return { raw, selected: String(match.name), stale: false };
  return { raw, selected: raw, stale: true };
}

// One column-name role picker for the logs arm: '' = auto (convention). A
// non-empty saved name absent from the current result renders as a selected,
// disabled "<name> (missing)" option instead of silently falling back to
// `(auto)` (#196) — the select stays enabled so the user can repair it.
function logsRoleSelect(label, cfgName, { result, cfg, onChange }) {
  const state = logsRoleState(cfg[cfgName], result ? result.columns : null);
  const options = [
    { value: '', label: '(auto)' },
    ...(state.stale ? [{ value: state.raw, label: `${state.raw} (missing)`, disabled: true }] : []),
    ...(result ? result.columns.map((c) => ({ value: c.name, label: c.name })) : []),
  ];
  const meta = state.stale
    ? { invalid: true, title: `Saved column "${state.raw}" is not present in this result` }
    : {};
  return panelSelect(label, state.selected, options, (v) => {
    const next = { ...cfg };
    if (v) next[cfgName] = v; else delete next[cfgName];
    onChange(next);
  }, meta);
}

// ── The registry ─────────────────────────────────────────────────────────────

const chartArm = {
  // The chart family's field controls live inside renderChart's own config
  // bar (X/Y/Series/All-measures; its Type select is suppressed — the Panel
  // tab's picker owns type). No separate controls() row.
  controls: () => null,
  renderPanel({ app, result, cfg, surface, rerender, readonly, onCfgChange, setChart }) {
    let inst = null;
    const node = renderChart(app, result, {
      cfg,
      rerender,
      onCfgChange,
      typeControl: false,
      setChart: (c) => { inst = c; if (setChart) setChart(c); },
      controls: surface === 'workbench' && !readonly,
      hideGrid: surface === 'dashboard',
      running: false, // the caller gates on run state before dispatching
    });
    return { node, destroy: () => { if (inst) { inst.destroy(); inst = null; } } };
  },
};

const PANEL_TYPES = {
  kpi: {
    controls: () => null,
    renderPanel({ kpi }) { return { node: renderKpiPanel(kpi) }; },
  },
  table: {
    controls: () => null, // no schema-bound fields; sort/widths are surface state
    renderPanel({ result, state, rerender, cap, onCell }) {
      state.sort = state.sort || { col: null, dir: 'asc' };
      state.widths = state.widths || {};
      return {
        node: renderGridView({
          columns: result.columns,
          rows: result.rows,
          sort: state.sort,
          setSort: (next) => { state.sort = next; },
          widths: state.widths,
          rerender,
          onCell,
          cap: cap ?? GRID_VIS_CAP,
        }),
      };
    },
  },
  logs: {
    controls({ app, result, cfg, onChange }) {
      const args = { app, result, cfg, onChange };
      return h('div', { class: 'chart-config' },
        logsRoleSelect('Time', 'time', args),
        logsRoleSelect('Message', 'msg', args),
        logsRoleSelect('Level', 'level', args));
    },
    renderPanel({ result, cfg, cap, shape }) {
      // `shape` arrives pre-resolved from resolvePanel when the caller went
      // through renderResolvedPanel (it may be the re-derived convention shape
      // after a name mismatch); a direct call re-resolves from the cfg.
      const s = shape || resolveLogsShape(cfg, result.columns);
      if (!s) return { node: panelEmpty('No time + message columns in this result — pick them above or adjust the query.') };
      return { node: renderLogs({ columns: result.columns, rows: result.rows, shape: s, cap: cap ?? GRID_VIS_CAP }) };
    },
  },
  text: {
    controls({ app, cfg, onChange, readonly }) {
      if (readonly) return null;
      // Markdown lives in panel.cfg.content (Grafana's model). Editing fires
      // onChange per input; the preview below re-renders from the new cfg.
      const ta = h('textarea', {
        class: 'panel-text-input',
        'aria-label': 'Markdown content',
        placeholder: '# Markdown\n\nHeadings, **bold**, *italic*, lists, [links](https://…), `code`.',
        oninput: (e) => onChange({ ...cfg, content: e.target.value }),
      });
      ta.value = cfg.content || '';
      return h('div', { class: 'panel-text-edit' }, ta);
    },
    renderPanel({ cfg }) {
      // Needs no result at all — the one arm that renders without a Run.
      return { node: renderMarkdown(parseMarkdown(cfg.content || '')) };
    },
  },
};
for (const t of CHART_FAMILY) PANEL_TYPES[t] = chartArm;
export { PANEL_TYPES };

/** Workbench-selectable panel types. `table` remains an internal registry arm
 * for dashboards, auto fallback, and migrated entries; the ordinary Table
 * result view is its workbench surface, so offering it here would duplicate
 * the adjacent Table button. */
export const PANEL_PICKER_OPTIONS = [
  { value: 'kpi', label: 'KPI' },
  ...CHART_TYPES,
  { value: 'logs', label: 'Logs' },
  { value: 'text', label: 'Text' },
];

// ── The workbench Panel drawer tab ───────────────────────────────────────────

/**
 * Render one panel (type dispatch + fallback diagnostics) from an already-
 * resolved `resolvePanel` outcome. Shared by the drawer preview, the detached
 * pane, and the dashboard tile so the three surfaces cannot drift. Returns
 * `{ node, destroy? }`.
 */
export function renderResolvedPanel(app, resolved, result, opts) {
  const arm = PANEL_TYPES[resolved.cfg.type];
  const out = arm.renderPanel({ app, result, cfg: resolved.cfg, shape: resolved.shape, kpi: resolved.kpi, ...opts });
  if (!resolved.diagnostic && !resolved.rederived) return out;
  // Wrap with the mismatch affordance: a small hint bar above the panel.
  const note = resolved.diagnostic
    ? h('div', { class: 'panel-note is-fallback' }, resolved.diagnostic)
    : h('div', { class: 'panel-note' }, 'Roles re-detected for this result’s schema.');
  return { node: h('div', { class: 'panel-with-note' }, note, out.node), destroy: out.destroy };
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
function panelContext(app, r) {
  const tab = app.activeTab();
  const hasGrid = !!(r && !r.error && r.rawText == null && r.rows);
  const columns = hasGrid ? r.columns : [];
  const saved = tabPanel(tab);
  const resolved = resolvePanel(saved, {
    columns, rows: hasGrid ? r.rows : null,
    fieldConfig: saved?.fieldConfig, serverVersion: app.state.serverVersion,
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

function writePanel(app, hooks, payload, activate = false) {
  const tab = app.activeTab();
  const result = patchSpecDraft(tab, (spec) => patchQueryPanel(
    { id: tab.savedId, sql: tab.sqlDraft, specVersion: tab.specVersion, spec },
    { cfg: payload.cfg, key: payload.key ?? undefined },
  ).spec, { dirty: true, validationService: app.specValidators });
  if (!result.ok) {
    app.activateInvalidSpecDraft(result.invalidTab);
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
export function renderPanelTypePicker(app, r, hooks) {
  const { hasGrid, columns, saved, resolved, rescueLogs } = panelContext(app, r);
  const select = h('select', {
    class: 'result-panel-select' + (['panel', 'filter'].includes(app.state.resultView.value) ? ' active' : ''),
    'aria-label': 'Result presentation',
    title: 'Choose a panel visualization or Dashboard role',
    onchange: (e) => {
      const selectedId = e.target.value.includes(':') ? e.target.value : `panel:${e.target.value}`;
      const choice = [...PANEL_RESULT_CHOICES, ...DASHBOARD_ROLE_RESULT_CHOICES]
        .find((item) => item.id === selectedId);
      if (!choice) return;
      const tab = app.activeTab();
      const apply = (spec) => {
        let query = { id: tab.savedId, sql: tab.sqlDraft, specVersion: tab.specVersion, spec };
        if (choice.kind === 'panel') {
          const base = saved && !resolved.rederived
            ? saved
            : { cfg: resolved.cfg, key: hasGrid && isChartFamily(resolved.cfg.type) ? schemaKey(columns) : null };
          query = patchQueryPanel(query, { cfg: base.cfg, key: base.key ?? undefined });
        }
        return applyResultChoice(query, choice, columns).spec;
      };
      let result;
      if (choice.kind === 'role' && !tab.specDiagnostics?.some((item) => item.code === 'invalid-json')) {
        setTabSpecDraft(tab, apply(tab.specParsed), { dirty: true, validationService: app.specValidators });
        result = { ok: true, invalidTab: null };
      } else {
        result = patchSpecDraft(tab, apply, { dirty: true, validationService: app.specValidators });
      }
      if (!result.ok) { app.activateInvalidSpecDraft(result.invalidTab); return; }
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

export function renderPanelView(app, r, hooks) {
  const { tab, hasGrid, columns, saved, resolved, rescueLogs } = panelContext(app, r);

  const writeBack = (payload) => {
    writePanel(app, hooks, payload);
  };
  // The chart bar mutates the resolved clone in place (its handlers predate
  // the registry); adopting it via onCfgChange is the explicit write-back.
  const onCfgChange = (cfg) => writeBack({
    cfg,
    key: isChartFamily(cfg.type) && hasGrid ? schemaKey(columns) : null,
  });
  const onChange = (cfg) => writeBack({ cfg, key: saved && saved.key != null ? saved.key : null });

  // A clone, like resolved.cfg always is — controls never receive live Spec.
  const [controlsArm, controlsCfg] = rescueLogs
    ? [PANEL_TYPES.logs, clonePanelCfg(saved.cfg)]
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
      setChart: (c) => { app.chart = c; }, // renderResults' destroy-before-rebuild slot
    });
    body.appendChild(node);
  }
  return h('div', { class: 'panel-view' }, bar, body);
}
