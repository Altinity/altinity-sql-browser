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
import { renderGridView, GRID_VIS_CAP } from './grid-render.js';
import { renderLogs } from './logs.js';
import { parseMarkdown } from '../core/markdown-lite.js';
import {
  resolvePanel, resolveLogsShape, switchPanelType, isChartFamily, CHART_FAMILY,
} from '../core/panel-cfg.js';
import { CHART_TYPES } from '../core/chart-data.js';

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

/** A labelled <select>, same look as the chart config bar's fields. */
function panelSelect(label, value, options, onPick) {
  const sel = h('select', { class: 'chart-select', onchange: (e) => onPick(e.target.value) });
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label);
    if (o.value === value) opt.selected = true;
    sel.appendChild(opt);
  }
  return h('label', { class: 'chart-field' }, h('span', { class: 'chart-field-label' }, label), sel);
}

function panelEmpty(msg) {
  return h('div', { class: 'chart-empty' }, h('div', { class: 'chip' }, Icon.chart()), h('div', null, msg));
}

// One column-name role picker for the logs arm: '' = auto (convention).
function logsRoleSelect(label, cfgName, { result, cfg, onChange }) {
  const options = [{ value: '', label: '(auto)' },
    ...(result ? result.columns.map((c) => ({ value: c.name, label: c.name })) : [])];
  return panelSelect(label, cfg[cfgName] || '', options, (v) => {
    const next = { ...cfg };
    if (v) next[cfgName] = v; else delete next[cfgName];
    onChange(next);
  });
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

/** Type-picker options: the chart family first (Bar…Pie), then the others. */
export const PANEL_PICKER_OPTIONS = [
  ...CHART_TYPES,
  { value: 'table', label: 'Table' },
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
  const out = arm.renderPanel({ app, result, cfg: resolved.cfg, shape: resolved.shape, ...opts });
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
 * Dirty pin (#166): the preview renders resolvePanel's CLONE; `tab.panelCfg`
 * is written only here, from picker/controls changes — render never writes
 * it, so a cfg derived purely by autoPanel is never persisted or dirtying.
 *
 * `hooks`: { onCell(name,type,value), markDirty() } — supplied by results.js
 * (cell drawer + tab-dirty wiring live there; importing them here would
 * recreate the results-import cycle).
 */
export function renderPanelView(app, r, hooks) {
  const tab = app.activeTab();
  const hasGrid = !!(r && !r.error && r.rawText == null && r.rows);
  const columns = hasGrid ? r.columns : [];
  const saved = tab.panelCfg ? { cfg: tab.panelCfg, key: tab.panelKey ?? null } : null;
  const resolved = resolvePanel(saved, columns);

  const writeBack = (payload) => {
    tab.panelCfg = payload.cfg;
    tab.panelKey = payload.key ?? null;
    hooks.markDirty();
    hooks.rerender();
  };
  // The chart bar mutates the resolved clone in place (its handlers predate
  // the registry); adopting it via onCfgChange is the explicit write-back.
  const onCfgChange = (cfg) => writeBack({ cfg, key: tab.panelKey ?? null });
  const onChange = (cfg) => writeBack({ cfg, key: tab.panelKey ?? null });

  const picker = panelSelect('Panel', resolved.cfg.type, PANEL_PICKER_OPTIONS, (type) => {
    // switchPanelType starts from the user's own cfg when there is one (so a
    // round-trip through table restores the stashed chart roles), else from
    // the resolved (auto) cfg so the picker "adopts" what the preview shows.
    writeBack(switchPanelType(saved || { cfg: resolved.cfg, key: null }, type, columns));
  });

  const arm = PANEL_TYPES[resolved.cfg.type];
  const controlsNode = arm.controls({ app, result: hasGrid ? r : null, cfg: resolved.cfg, onChange });
  const bar = h('div', { class: 'panel-config' }, picker, controlsNode);

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
      readonly: false,
      cap: hasGrid ? hooks.cap : undefined,
      onCell: hooks.onCell,
      onCfgChange,
      setChart: (c) => { app.chart = c; }, // renderResults' destroy-before-rebuild slot
    });
    body.appendChild(node);
  }
  return h('div', { class: 'panel-view' }, bar, body);
}
