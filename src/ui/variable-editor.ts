// The per-variable option-SQL editor (#447 phase 1) — the drawer the Variables
// subtree opens when a variable row is activated, and the ONE writer of
// `dashboard.variableConfigs`.
//
// A Dashboard variable is not a stored object: its name and ClickHouse type come
// from the `{name:Type}` placeholders the Dashboard's panel queries declare
// (core/dashboard-variables.ts). The only thing this editor persists is the
// optional option-list SQL for one variable name — so it deliberately has:
//   - NO panel visualisation selector (a variable is not a panel);
//   - NO Dashboard role selector (a variable has no role to choose — it either
//     has option SQL or it takes direct input);
//   - no name or type FIELD at all, only a read-out: editing either of those
//     means editing the panel SQL that declares them.
// Saving BLANK SQL removes the configuration and returns the variable to direct
// input — the trim rule is `normalizeVariableSql`'s, never re-implemented here.
// An ORPHANED configuration (no panel declares its name any more) stays fully
// editable until it is deleted, because its SQL is real work the user can still
// want back.
//
// Structure mirrors `ui/doc-pane.ts` (#313): `buildDrawerChrome`'s NON-modal
// chrome under its own `varedit` class prefix, ONE instance per document (a
// second open replaces the content rather than stacking a panel), Escape while
// focus is inside it, focus restored to whatever opened it, and the mounted
// editor handle destroyed on every re-render and on close. Like doc-pane, the
// editor surface arrives as a plain FACTORY FIELD on the app object — this module
// never imports a concrete adapter from `src/editor/**`.
//
// Deliberately NOT resizable: `attachDrawerResize` persists its width through one
// of two named `AppState` keys, and adding a third is a state/preferences change
// this phase does not own. The drawer takes its width from the stylesheet.
//
// Phase 2 added Test: it validates the draft SQL locally first (statement shape,
// no FORMAT/INTO OUTFILE, no `{name:Type}` — no request is sent for anything the
// app can already see is wrong), then runs THIS variable's query alone and checks
// its result shape. That is the only place the "exactly two String columns" rule
// is checkable: in the combined refresh batch, `UNION ALL` reports one merged
// column list for every branch, which is why a batch problem is reported as a
// batch-level failure and this action is the way to find out which variable
// caused it.

import { h, withDocument } from './dom.js';
import { buildDrawerChrome } from './drawer.js';
import { Icon } from './icons.js';
import { normalizeVariableSql } from '../core/dashboard-variables.js';
import type { DashboardVariable } from '../core/dashboard-variables.js';
import {
  compileOptionProbe, optionSqlDiagnostics, validateOptionColumns,
} from '../core/variable-options.js';
import { dashboardVariables, type TreeWorkspace } from '../application/dashboard-tree-model.js';
import { findDashboard, replaceDashboard } from '../workspace/workspace-dashboards.js';
import type { DashboardDocumentV2 } from '../generated/json-schema.types.js';
import type { App } from './app.types.js';

// ── the injected editor seam ─────────────────────────────────────────────────

/** The live option-SQL surface. A narrow, editable counterpart to
 *  `CodeViewerHandle` (which is read-only) and deliberately NOT `EditorPort`
 *  (which is bound to the Workbench's active tab). */
export interface VariableEditorHandle {
  /** The current text — read once, when the user saves. */
  getText(): string;
  focus(): void;
  /** TERMINAL: drops the surface. Never read a destroyed handle. */
  destroy(): void;
}

export interface VariableEditorOptions {
  parent: HTMLElement;
  /** The document to build into — never the ambient global. */
  document: Document;
  /** The stored SQL, or `''` for a variable that has none yet. */
  text: string;
}

export type VariableEditorFactory = (opts: VariableEditorOptions) => VariableEditorHandle;

/**
 * The default option-SQL surface: a plain, styled `<textarea>`.
 *
 * Phase 1 wires no CodeMirror adapter for this seam (that needs a
 * `CreateAppEnv` field, a `src/editor/**` adapter and a `main.ts` injection —
 * see the report accompanying this change), and a read-only `CodeViewer` cannot
 * take an edit. A textarea is a real, accessible, fully styled editing surface;
 * when the adapter lands, `app.VariableEditor` overrides this with no change to
 * anything below.
 */
export const createTextareaVariableEditor: VariableEditorFactory = ({ parent, document: doc, text }) => {
  const field: HTMLTextAreaElement = withDocument(doc, () => h('textarea', {
    class: 'varedit-input', spellcheck: 'false', rows: '10',
    'aria-label': 'Option SQL',
  }));
  field.value = text;
  parent.appendChild(field);
  return {
    getText: () => field.value,
    focus: () => field.focus(),
    destroy: () => field.remove(),
  };
};

// ── the app surface this module reads ───────────────────────────────────────

/** One option-query execution, as the Test action needs it. Deliberately a plain
 *  result rather than a `StreamResult`: this module never has to know about
 *  streaming, caps or transports. */
export interface VariableOptionQueryResult {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  /** The failure message, or `null` on success. */
  error: string | null;
}

/** The injected seam Test runs through — ONE callback, wired once in `ui/app.ts`.
 *  A narrow callback rather than the `exec` + connection pair it is built from,
 *  because this module is reached through the Dashboards TREE: threading two more
 *  members through `DashboardTreeApp` (and every fixture that builds one) would
 *  buy nothing over a single function. Absent in a fixture that does not need it,
 *  in which case Test is not offered at all. */
export type VariableOptionQueryRunner = (sql: string) => Promise<VariableOptionQueryResult>;

/** The narrow app slice this module needs — not the full `App` contract
 *  (app.types.ts); a real `App` satisfies it directly, and so does the tree's
 *  own `DashboardTreeApp`. */
export interface VariableEditorApp {
  document?: Document;
  /** Read-only: the committed aggregate the variable is resolved against. */
  currentWorkspace: TreeWorkspace | null;
  /** The serialized, read-latest-at-dequeue write primitive every workspace
   *  producer commits through. */
  mutateWorkspace: App['mutateWorkspace'];
  /** The injected editor surface; the built-in textarea when absent. */
  VariableEditor?: VariableEditorFactory;
  /** The injected option-query runner. When absent, no Test button is rendered. */
  runOptionQuery?: VariableOptionQueryRunner;
  /** #447 phase 2: "re-read the committed workspace". A real `App` carries this
   *  (`ui/dashboard.ts` binds it while a Dashboard is rendered), so a successful
   *  configuration write reaches the viewer session that has to act on it. Absent
   *  when no Dashboard is on screen, and in a narrow fixture. */
  onWorkspaceExternallyChanged?: () => void;
}

/**
 * Store or remove ONE variable's configuration — the single writer of
 * `dashboard.variableConfigs`, shared by this editor's Save and the tree's
 * orphan-delete affordance.
 *
 * `config: null` removes the key entirely (both `sql` and `lastKnownType`); the
 * `variableConfigs` object itself is dropped once it would be empty, so a
 * Dashboard that never configured a variable stays byte-identical to one that
 * configured and then removed one. No panel query is ever touched: a variable's
 * name and type live in the panel SQL, and this write must not be able to change
 * them.
 *
 * The transform re-reads committed truth at dequeue time (`mutateWorkspace`) and
 * ABORTS — committing nothing — when the workspace is gone or the Dashboard id
 * names no single entry (deleted concurrently, or ambiguous, which must never be
 * "repaired" by an arbitrary pick).
 *
 * #447 phase 2: a SUCCESSFUL commit then asks any rendered Dashboard to rebuild
 * from committed truth. A viewer session reads `variableConfigs` ONCE, at
 * construction — option SQL is not something `syncDocument` adopts — so without
 * this, saving option SQL (or clearing it back to direct input, or deleting an
 * orphan) changed the stored document while the on-screen controls kept running
 * the previous configuration until the Dashboard happened to be reopened. Phase 1
 * had the same staleness but no way to notice it: a configuration had no runtime
 * consequence yet.
 */
export function commitVariableConfig(
  app: Pick<VariableEditorApp, 'mutateWorkspace' | 'onWorkspaceExternallyChanged'>,
  dashboardId: string,
  name: string,
  config: { sql: string; lastKnownType?: string } | null,
): void {
  void app.mutateWorkspace((latest) => {
    if (latest === null) return null;
    const base = findDashboard(latest, dashboardId);
    if (base === null) return null;
    const configs = { ...(base.variableConfigs ?? {}) };
    if (config === null) delete configs[name];
    else configs[name] = config;
    const next: DashboardDocumentV2 = { ...base, revision: base.revision + 1 };
    if (Object.keys(configs).length === 0) delete next.variableConfigs;
    else next.variableConfigs = configs;
    // `replaceDashboard` is the write-side guard: it answers `null` for an
    // AMBIGUOUS id (a duplicate reached committed truth), which `findDashboard`
    // above happily resolves to the first match. Committing nothing is the only
    // safe answer — one of two identical ids must never be overwritten by a guess.
    const candidate = replaceDashboard(latest, dashboardId, next);
    return candidate === null ? null : { candidate };
  }).then((result) => {
    // Only on a real commit: an aborted transform changed nothing, so there is
    // nothing for a Dashboard to re-read. The hook is the SAME one a cross-tab
    // change uses (`ui/dashboard.ts` binds it to a rebuild from committed truth,
    // which defers while commands are pending and is idempotent per render), and
    // it is absent unless a Dashboard is actually rendered.
    if (result.ok) app.onWorkspaceExternallyChanged?.();
  });
}

// ── the drawer ──────────────────────────────────────────────────────────────

interface EditorState {
  panel: HTMLElement;
  keyHandler: (event: KeyboardEvent) => void;
  initiator: Element | null;
  /** The mounted surface, destroyed before a re-target and on close so a stale
   *  editor is never left listening or painted underneath. */
  handle: VariableEditorHandle;
}

const editors = new WeakMap<Document, EditorState>();

/** The document to build into. Optional on the app surface for the same reason it
 *  is on the tree's (`ui/dashboard-tree.ts`): a narrow fixture may not carry
 *  one, and the served page's own document is then correct. */
const docOf = (app: VariableEditorApp): Document => app.document ?? document;

/** True while a variable editor is open in `app`'s document. */
export const isVariableEditorOpen = (app: VariableEditorApp): boolean => editors.has(docOf(app));

/** Close and fully tear down the open editor, if there is one; a no-op
 *  otherwise. Restores focus to whatever opened it, when that is still
 *  focusable. */
export function closeVariableEditor(app: VariableEditorApp): void {
  const doc = docOf(app);
  const state = editors.get(doc);
  if (!state) return;
  editors.delete(doc);
  state.handle.destroy();
  doc.removeEventListener('keydown', state.keyHandler, true);
  state.panel.remove();
  const initiator = state.initiator as (Element & { focus?: () => void }) | null;
  if (initiator && initiator.isConnected && typeof initiator.focus === 'function') initiator.focus();
}

/** The type read-out: the one agreed type, every disagreeing type for a
 *  conflict, the remembered type for an orphan that has one. A variable with no
 *  type at all (an orphan whose configuration never recorded one) shows the word
 *  instead of an empty chip, so the row never looks truncated. */
const typeText = (variable: DashboardVariable): string =>
  (variable.types.length === 0 ? 'type unknown' : variable.types.join(' | '));

const STATUS_NOTES: Record<DashboardVariable['status'], string | null> = {
  active: null,
  conflicted: 'Panels declare this variable with incompatible types. Fix the panel SQL — '
    + 'no control can be rendered until the types agree.',
  orphaned: 'No panel declares this variable any more. Its SQL is preserved and stays editable, '
    + 'but it is not executed.',
};

/**
 * Open (or re-target) the option-SQL editor for ONE variable, addressed by
 * Dashboard id + exact name — a variable's only identity.
 *
 * Resolves the variable through the same projection the tree rows come from
 * (`dashboardVariables`), so what opens always matches what was clicked. A name
 * that no longer resolves (a click against a repaint that has already dropped
 * it) opens nothing at all rather than an editor for a variable that does not
 * exist.
 */
export function openVariableEditor(app: VariableEditorApp, dashboardId: string, name: string): void {
  const variable = dashboardVariables(app.currentWorkspace, dashboardId)
    .find((candidate) => candidate.name === name);
  if (variable === undefined) return;

  const doc = docOf(app);
  // ONE instance per document: re-targeting tears the previous surface down
  // rather than stacking a second panel over it.
  closeVariableEditor(app);
  const initiator = doc.activeElement;
  const close = (): void => closeVariableEditor(app);

  withDocument(doc, () => {
    const { panel } = buildDrawerChrome(doc, {
      classPrefix: 'varedit',
      title: [
        h('span', { class: 'varedit-title-text' }, 'Variable'),
        h('span', { class: 'varedit-title-name' }, variable.name),
      ],
      onClose: close,
    });
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'Option SQL for ' + variable.name);

    const host = h('div', { class: 'varedit-sql' });
    const factory = app.VariableEditor ?? createTextareaVariableEditor;
    // A newly inferred variable opens EMPTY; a configured one opens on its stored
    // SQL. An orphan is configured by definition, so it opens on its SQL — and
    // stays editable until it is deleted.
    const handle = factory({ parent: host, document: doc, text: variable.sql ?? '' });

    // ── Test ────────────────────────────────────────────────────────────────
    // A polite live region: Test is an explicit user action whose whole answer is
    // text, so an assistive-tech user has to hear the verdict without re-reading
    // the panel.
    const result = h('div', {
      class: 'varedit-result', 'aria-live': 'polite', style: { display: 'none' },
    });
    const showResult = (kind: 'ok' | 'error', ...content: unknown[]): void => {
      result.className = 'varedit-result is-' + kind;
      result.style.display = '';
      // Nulls are filtered, NOT passed through: `h()` drops a null child but the
      // raw DOM `replaceChildren` stringifies it, which rendered a literal "null"
      // under the option preview whenever there was no "+N more" line.
      result.replaceChildren(...content.filter((node) => node != null) as never[]);
    };
    const runner = app.runOptionQuery;
    // The button disables itself for the duration of a run, so there is only ever
    // ONE Test in flight per panel and no generation counter is needed: the panel
    // identity check below is the whole staleness guard. What it catches is a
    // response arriving after this panel was closed or re-targeted to a different
    // variable — either of which would otherwise paint a verdict for one variable
    // into another variable's editor.
    const runTest = async (run: VariableOptionQueryRunner): Promise<void> => {
      const draft = handle.getText();
      const local = optionSqlDiagnostics(draft);
      if (local.length) {
        // Nothing is sent for a problem the app can already see. Every finding is
        // listed, not just the first, so one round of edits can fix them all.
        showResult('error', ...local.map((d) => h('div', null, d.message)));
        return;
      }
      testBtn.disabled = true;
      showResult('ok', 'Running…');
      const answer = await run(compileOptionProbe(draft));
      // Dropped if this panel is gone or now shows a different variable.
      if (editors.get(doc)?.panel !== panel) return;
      testBtn.disabled = false;
      if (answer.error !== null) {
        showResult('error', answer.error);
        return;
      }
      const shape = validateOptionColumns(answer.columns);
      if (shape !== null) {
        showResult('error', shape.message);
        return;
      }
      const count = answer.rows.length;
      // Zero rows is a legal result ("zero or more rows"), so it is reported as a
      // pass with a caveat rather than as a failure.
      showResult('ok',
        h('div', { class: 'varedit-result-head' },
          count === 0 ? 'Valid, but it returned no options.' : `Valid — ${count} option${count === 1 ? '' : 's'}.`),
        ...answer.rows.slice(0, 5).map((row) => h('div', { class: 'varedit-result-row' },
          h('code', null, String(row[0] ?? '')),
          h('span', null, String(row[1] ?? '')))),
        count > 5 ? h('div', { class: 'varedit-result-more' }, `+${count - 5} more`) : null);
    };
    const testBtn: HTMLButtonElement = h('button', {
      class: 'varedit-test', type: 'button',
      title: 'Run this variable’s option query and check its result shape',
      onclick: () => { if (runner !== undefined) void runTest(runner); },
    }, Icon.play(), 'Test');

    const note = STATUS_NOTES[variable.status];
    const body = h('div', { class: 'varedit-body' },
      // NOT `varedit-head`: that class belongs to `buildDrawerChrome`'s own header
      // (`{prefix}-head`), and reusing it here would inherit the chrome's rules.
      h('div', { class: 'varedit-ident' },
        h('span', { class: 'varedit-name' }, variable.name),
        h('span', { class: 'varedit-type' }, typeText(variable))),
      note === null ? null : h('p', { class: 'varedit-note' }, note),
      h('div', { class: 'varedit-field-label' }, 'Option SQL'),
      host,
      h('p', { class: 'varedit-hint' },
        'One read query returning two String columns: value, then label. '
        + 'Leave it blank to type values directly instead.'),
      result,
      h('div', { class: 'varedit-actions' },
        // Offered only when a runner is injected — a surface that cannot execute
        // must not show an action that would do nothing.
        runner === undefined ? null : testBtn,
        h('span', { class: 'varedit-actions-gap' }),
        h('button', { class: 'varedit-cancel', type: 'button', onclick: close }, 'Cancel'),
        h('button', {
          class: 'varedit-save', type: 'button',
          onclick: () => {
            // The trim rule belongs to the pure service: blank (or
            // whitespace-only) SQL REMOVES the configuration rather than storing
            // an empty string that would later read as configured-but-broken.
            const sql = normalizeVariableSql(handle.getText());
            commitVariableConfig(app, dashboardId, variable.name, sql === null
              ? null
              // `lastKnownType` is what lets a configuration still display a type
              // once its last declaring panel disappears. Recorded from whatever
              // type is agreed NOW; a live declaration always wins over it.
              : { sql, ...(variable.type === null ? {} : { lastKnownType: variable.type }) });
            close();
          },
        }, 'Save')));
    panel.appendChild(body);

    // Escape closes ONLY while focus is inside the panel, and must never ALSO run
    // shortcuts.ts's global Escape handling: preventDefault + stopPropagation in
    // the CAPTURE phase, exactly as doc-pane.ts does.
    const keyHandler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (!panel.contains(doc.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const state: EditorState = { panel, keyHandler, initiator, handle };
    doc.addEventListener('keydown', keyHandler, true);
    doc.body.appendChild(panel);
    editors.set(doc, state);
    handle.focus();
  });
}
