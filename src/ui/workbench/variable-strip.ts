// #588 W1 (phase 4, decompose the `createApp` composition root): the
// Workbench `{name:Type}` query-variable STRIP — `setRunBtn` (the Run
// button's disabled/tooltip/label sync) and `renderVarStrip` (the strip's own
// DOM view) — extracted verbatim out of app.ts into their own controller.
//
// Deliberately NOT `src/ui/variable-bar.ts`: that module is a deliberately
// ADAPTER-facing port (#478) shared by the Dashboard and the detached Data
// view, with neutral, caller-agnostic names (`activeByName` vs this strip's
// `state.filterActive`, `params.saveActive` vs `saveFilterActive`) and its own
// private combo-field type. Forcing this Workbench-specific strip's own
// concrete `AppState`/`WorkbenchParameterSession` shape into that adapter
// contract would break it for its other two callers — see
// `variable-bar.ts`'s own header comment. This is a SEPARATE, Workbench-only
// view over the same leaf field-control builders
// (`buildEnumField`/`buildRelativeTimeField`/`buildRecentField` +
// `wireComboInput`), not a second implementation of them.
//
// Bookkeeping ownership: `sig`/`rerenderPending`/`hookedStrip` used to be
// plain `app.dom.varStripSig`/`varStripRerenderPending`/`varStripDeferHooked`
// fields — free bookkeeping resets because `app.dom` itself is reset wholesale
// (`{}`) on every shell mount (a sign-out/sign-in cycle rebuilds a fresh
// `<div class="var-strip">`). This controller is a stable singleton built once
// by `createApp` and never reconstructed, so its own closure state does NOT
// reset for free the same way — without an explicit check, a sign-out/sign-in
// cycle would compare a fresh signature against a STALE `sig` left over from
// the previous strip element (wrongly skipping the first rebuild) and, worse,
// leave the OLD element's `focusout` listener as the only one ever installed
// — the new element would never get one, silently breaking the mid-typing
// focus-containment guard below. `hookedStrip` tracks the exact element
// identity this controller's bookkeeping (and its one `focusout` listener)
// currently belongs to; the top of `renderVarStrip` resets `sig`/
// `rerenderPending` and (re)installs the listener the moment `varStrip()`
// returns a DIFFERENT element than last time.

import { h } from '../dom.js';
import { Icon } from '../icons.js';
import { variableDoc } from '../../state.js';
import type { AppState, QueryTab } from '../../state.js';
import type { WorkbenchParameterSession } from '../../application/workbench-parameter-session.js';
import { analysisView, fieldControls, fieldControlKind } from '../../core/param-pipeline.js';
import { paramComparisonColumns } from '../../core/param-comparison.js';
import { recentOptions } from '../../core/recent-values.js';
import { applyFieldState, applyFieldWidth } from '../var-field.js';
import { buildRelativeTimeField } from '../relative-time-field.js';
import type { RelativeTimeField } from '../relative-time-field.js';
import { buildRecentField } from '../recent-field.js';
import type { RecentField } from '../recent-field.js';
import { buildEnumField } from '../enum-field.js';
import type { EnumField } from '../enum-field.js';
import { wireComboInput } from '../combobox.js';

/** The var-strip's combobox-based field controller — whichever of
 *  `buildEnumField`/`buildRelativeTimeField`/`buildRecentField` `ctl.kind`
 *  picks. Only `RelativeTimeField` actually declares `previewEl` (the #169
 *  live date preview `applyFieldState` points `aria-describedby` at); the
 *  intersection makes reading it a safe optional no-op for the other two
 *  control kinds, which never populate it. */
type VarStripCombo = (EnumField | RecentField | RelativeTimeField) & { previewEl?: HTMLElement };

/** The narrow slice of the real `app` controller `createVariableStrip` reads —
 *  a thunk for each DOM ref (`varStrip`/`runBtn`) rather than a direct
 *  `HTMLElement`, since neither exists yet at construction time (they're built
 *  later by `workbench-shell.ts`'s `mountWorkbenchShell`, into whatever fresh
 *  `app.dom` the current shell mount owns). */
export interface VariableStripDeps {
  document: Document;
  state: AppState;
  activeTab(): QueryTab | undefined;
  params: Pick<WorkbenchParameterSession,
    'tabAnalysis' | 'inputGate' | 'inferredEnumOptions' | 'prepareAnalyzedBatch'
    | 'prepareTabBatch' | 'saveVarValues' | 'saveFilterActive' | 'hardenVar'
    | 'hardenedVars' | 'clearVarRecent'>;
  wallNow(): number;
  varStrip(): HTMLElement | undefined;
  runBtn(): HTMLButtonElement | undefined;
}

export interface VariableStripController {
  renderVarStrip(): void;
  setRunBtn(running: boolean, gate?: { missing: string[]; invalid: string[]; errors: string[] }): void;
}

/** Build the strip's controller bound to `deps`. Trivial constructor — no
 *  validation; `createApp` supplies the real `app`-backed thunks, unit tests
 *  supply fakes directly. */
export function createVariableStrip(deps: VariableStripDeps): VariableStripController {
  // Controller-private bookkeeping — see this module's header comment for why
  // these must be reset explicitly on a strip-identity change rather than
  // relying on `app.dom` being reset wholesale, the way the pre-extraction
  // `app.dom.varStripSig`/`varStripRerenderPending`/`varStripDeferHooked`
  // fields used to.
  let sig: string | undefined;
  let rerenderPending = false;
  let hookedStrip: HTMLElement | undefined;

  // hardenVar/inputGate (#170 review bookkeeping) live on `deps.params` —
  // setRunBtn's fallback and renderVarStrip's tail call
  // `params.inputGate`/`params.hardenVar` directly.
  function setRunBtn(running: boolean, gate?: { missing: string[]; invalid: string[]; errors: string[] }): void {
    const runBtn = deps.runBtn();
    if (!runBtn) return;
    // Disabled while running, or while any detected {name:Type} query variable
    // is missing, invalid (#170), or fails to serialize (#170 review finding:
    // the button's visible disabled state must match varGateBlocked's actual
    // gate, which already blocks on missing+invalid+errors) — with a tooltip
    // so the greyed-out button explains itself. Execution paths (run/
    // runScript) enforce the same gate via varGateBlocked. A caller that
    // already has the prepared source (renderVarStrip) passes its
    // {missing, invalid, errors} to avoid re-preparing; otherwise we compute
    // it here via inputGate — a merely 'incomplete' value (#170) stays
    // display-only and doesn't grey out the button while still focused.
    const tab = deps.activeTab();
    if (gate == null) {
      // #465 review: a dashboard-variable tab's text is option SQL, not an
      // ordinary parameterised query — the {name:Type} gate never applies to
      // it (optionSqlDiagnostics, surfaced on Run, is its complete policy).
      gate = running || !tab || variableDoc(tab) !== null
        ? { missing: [], invalid: [], errors: [] }
        : deps.params.inputGate(deps.params.tabAnalysis(tab.sqlDraft));
    }
    const blockers = gate.missing.concat(gate.invalid);
    runBtn.disabled = running || blockers.length > 0 || gate.errors.length > 0;
    runBtn.title = blockers.length
      ? 'Enter a value for: ' + blockers.join(', ')
      : gate.errors.length ? gate.errors[0] : '';
    // "Run selection" while the editor has a non-empty selection (so the mode is
    // discoverable); plain "Run" otherwise. Build the children and drop the null
    // (replaceChildren would coerce a null arg into a "null" text node).
    const label = running ? 'Running…' : (deps.state.hasSelection.value ? 'Run selection' : 'Run');
    runBtn.replaceChildren(
      ...[Icon.play(), h('span', null, label),
        running ? null : h('kbd', null, '⌘↵')].filter((c): c is SVGElement | HTMLElement => c != null));
  }

  // Repaint the query-variable strip (#134) for the active tab. Values live in
  // the shared, persisted `state.varValues` (keyed by variable name), so a value
  // typed once is reused by every query that references the same variable and is
  // restored on reload. The listed set comes from the all-active analysis view
  // (#165): a param confined to /*[ ]*/ optional blocks stays listed — marked
  // optional (blank allowed; blank keeps its blocks inactive) — while a param
  // outside blocks stays required. Typing keeps `state.filterActive` in sync
  // (blank ⇒ inactive, typed ⇒ active). Inputs rebuild only when the detected
  // {name:Type} set changes (signature guard) — so typing in the SQL editor
  // doesn't thrash the row or steal focus, and switching between tabs with the
  // same variables keeps the (already-correct, shared) values in place. Always
  // re-syncs the Run button's disabled/tooltip state.
  //
  // #172 v2 (schema-cache inference — the SUGGESTION tier) lives on
  // `deps.params.inferredEnumOptions` — pure over schema + analysis, no DOM.
  function renderVarStrip(): void {
    const strip = deps.varStrip();
    if (!strip) return;
    if (strip !== hookedStrip) {
      // A fresh strip element (first render, or a shell remount) — reset
      // every piece of bookkeeping and (re-)install the ONE `focusout`
      // listener this controller keeps per element. See this module's header
      // comment: without this, a remount would compare against a stale `sig`
      // and never re-attach the listener onto the new node.
      hookedStrip = strip;
      sig = undefined;
      rerenderPending = false;
      strip.addEventListener('focusout', (e: FocusEvent) => {
        if (!rerenderPending) return;
        if (e.relatedTarget && strip.contains(e.relatedTarget as Node)) return;
        rerenderPending = false;
        renderVarStrip();
      });
    }
    const tab = deps.activeTab();
    // #465 review: a dashboard-variable tab's own text is option SQL, not an
    // ordinary parameterised query — the {name:Type} strip/gate never applies
    // to it. A `{name:Type}` inside it is optionSqlDiagnostics' story to tell
    // (surfaced in the results pane on Run), not an input field to fill in.
    if (tab && variableDoc(tab) !== null) {
      sig = '';
      strip.replaceChildren();
      strip.style.display = 'none';
      setRunBtn(deps.state.running.value);
      return;
    }
    // One analysis per repaint (review F9): fieldControls, the #172 v2
    // comparison scan, a rebuild's initial field paint, and the tail's Run-
    // button gate all feed off this single pass instead of re-analyzing the
    // same SQL a second time per editor keystroke.
    const analysis = tab ? deps.params.tabAnalysis(tab.sqlDraft) : null;
    const vars = analysis ? fieldControls(analysis) : [];
    // #172 v2 scans the tab SQL's ANALYSIS materialization (review F2): in
    // the raw text a comparison inside a /*[ ]*/ optional block is one opaque
    // comment span and could never match. `resolveComparisonColumnType`
    // resolves each match's position against this same text. (Workbench-only
    // — the Dashboard has no schema cache and gets v1 straight from the type.)
    const scanSql = tab ? analysisView(tab.sqlDraft) : '';
    const comparisonColumns = tab ? paramComparisonColumns(scanSql) : {};
    // Each field's control kind + member list (shared enum > date-like > text
    // priority; a type-conflicted field degrades to text — fieldControlKind).
    const controls = vars.map((v) => fieldControlKind(v, deps.params.inferredEnumOptions(v, scanSql, comparisonColumns)));
    // The signature folds in each var's control kind and resolved enum
    // options — not just name/type/optional — so a column landing on the
    // idle-tick loader (loadColumns calls renderVarStrip on completion)
    // upgrades a v2 field from plain input to the dropdown, and a type
    // conflict appearing or resolving restyles the field, even though the
    // {name:Type} set itself never changed.
    const sigNew = vars.map((v, i) => {
      const c = controls[i];
      return v.name + ':' + v.type + (v.optional ? '?' : '') + (v.conflict ? '!' : '')
        + ':' + c.kind + (c.enumOptions ? c.enumOptions.length : '');
    }).join(',');
    // The Run button's gate from this SAME analysis (review F9: setRunBtn's
    // gate-less fallback would re-analyze the identical SQL). Lazy so the
    // running / tab-less states (whose gate setRunBtn hard-empties anyway)
    // skip the prepare entirely.
    const runGate = () => (analysis && !deps.state.running.value ? deps.params.inputGate(analysis) : undefined);
    if (sigNew !== sig) {
      // A signature change while the user is focused INSIDE the strip would
      // replaceChildren() every field out from under them — a background
      // column load (loadColumns → renderVarStrip, the #172 v2 upgrade path)
      // completing mid-typing would steal focus, wipe the in-progress text
      // repaint, and destroy any open dropdown. Defer the rebuild until focus
      // leaves the strip: the upgrade only matters on the NEXT interaction
      // anyway. (Typing in the SQL editor also lands here on every keystroke,
      // but then focus is in the editor, not the strip — no deferral.)
      const active = deps.document.activeElement;
      if (active && strip.contains(active)) {
        rerenderPending = true;
        setRunBtn(deps.state.running.value, runGate());
        return;
      }
      rerenderPending = false;
      sig = sigNew;
      if (!vars.length) {
        strip.replaceChildren();
        strip.style.display = 'none';
      } else {
        strip.style.display = '';
        // The freshly-(re)built strip paints each field's already-committed
        // state ('execute' mode — no field is mid-typing right after a
        // rebuild, e.g. a tab switch restoring a previously-invalid value).
        const initialFields = deps.params.prepareAnalyzedBatch(analysis!, deps.wallNow(), 'execute').fields;
        strip.replaceChildren(...vars.map((v, i) => {
          // controls[i] (fieldControlKind above) picks the field's control:
          // #172 enum members (v1 declared or v2 inferred) > #169 date-like
          // preset combobox + live preview > plain text with recents (#171).
          // The field stays free-text in every case (absolute values / non-
          // members keep working); persistence/#170 validation stays exactly
          // the shared logic below — the combobox only adds its own focus/
          // keydown-nav/composition hooks, called first from the same
          // handlers (wireComboInput; see relative-time-field.js's header
          // comment on why this beats two independent listeners).
          const ctl = controls[i];
          // #173 acceptance (review F1): a type-conflicted field degrades to
          // the plain text control (ctl.kind above) and says so visibly — a
          // warning style distinct from is-invalid (the VALUE isn't wrong;
          // the declarations disagree) plus a tooltip listing them.
          const conflictNote = v.conflict
            ? 'Conflicting type declarations: ' + v.conflict.join(' vs ') : null;
          const baseTitle = v.name + ': ' + v.type
            + (v.optional ? ' — optional: blank leaves its filter block out' : '')
            + (conflictNote ? ' — ' + conflictNote : '');
          let combo: VarStripCombo;
          let input: HTMLInputElement;
          const onValueInput = (): void => {
            deps.state.varValues[v.name] = input.value;
            // Text controls sync activation with the value (#165).
            deps.state.filterActive[v.name] = input.value !== '';
            deps.params.saveVarValues();
            deps.params.saveFilterActive();
            // Editing the value un-hardens it (#170 review): back to
            // neutral, lenient behavior until it's committed again.
            deps.params.hardenedVars.delete(v.name);
            // 'input' mode (#170): a plausible prefix stays neutral while
            // the field is focused — only a value that's already certainly
            // wrong shows the inline error here.
            const inputBatch = deps.params.prepareTabBatch(tab!.sqlDraft, deps.wallNow(), 'input');
            applyFieldState(input, inputBatch.fields[v.name], baseTitle, combo?.previewEl);
            setRunBtn(deps.state.running.value, inputBatch.sources[0]);
          };
          const onCommitHard = (): void => {
            // Hardens 'incomplete' → 'invalid' on commit (#170).
            const commitBatch = deps.params.prepareTabBatch(tab!.sqlDraft, deps.wallNow(), 'execute');
            deps.params.hardenVar(v.name, commitBatch.fields[v.name]);
            applyFieldState(input, commitBatch.fields[v.name], baseTitle, combo?.previewEl);
            setRunBtn(deps.state.running.value, commitBatch.sources[0]);
          };
          // #171: live-filtered recents for this field (type + typed text),
          // called fresh on every dropdown open/keystroke — never a snapshot
          // — so a value recorded by a run that completes without changing
          // the strip's {name:Type} signature is never stale. (#160's
          // curated-param opt-out hook: nothing to check yet — no curated
          // param exists before #160 lands.)
          const getRecents = (text: string): string[] => recentOptions(deps.state.varRecent, v.name, v.type, text);
          const onClearRecent = (): void => deps.params.clearVarRecent(v.name);
          const fieldOpts = {
            document: deps.document, name: v.name, type: v.type, value: deps.state.varValues[v.name] || '',
            baseTitle, onValueInput, onCommit: onCommitHard, getRecents, onClearRecent,
          };
          if (ctl.kind === 'enum') combo = buildEnumField({ ...fieldOpts, values: ctl.enumOptions! });
          else if (ctl.kind === 'date') combo = buildRelativeTimeField({ ...fieldOpts, wallNow: deps.wallNow });
          else combo = buildRecentField(fieldOpts);
          input = combo.input;
          // #345: a stable, type-appropriate width — set once per field
          // build (never on keystroke), same rule the Dashboard/detached-view
          // variable bar uses (variable-bar.js).
          applyFieldWidth(input, v.type, ctl.kind === 'enum');
          wireComboInput(combo, { onValueInput, onCommit: onCommitHard });
          if (conflictNote) input.classList.add('is-conflict');
          deps.params.hardenVar(v.name, initialFields[v.name]);
          applyFieldState(input, initialFields[v.name], baseTitle, combo?.previewEl);
          return h('label', { class: 'var-field' + (v.optional ? ' is-optional' : '') },
            h('span', { class: 'var-name' }, v.name), combo.el);
        }));
      }
    }
    setRunBtn(deps.state.running.value, runGate());
  }

  return { renderVarStrip, setRunBtn };
}
