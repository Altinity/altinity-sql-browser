// #588 W1 — `createVariableStrip` (src/ui/workbench/variable-strip.ts), the
// Workbench `{name:Type}` query-variable strip's DOM view, extracted verbatim
// from app.ts. Unit-tested directly against a fake `VariableStripDeps` (a
// real `WorkbenchParameterSession` over a fake `AppState`-shaped state bag,
// exactly like `workbench-parameter-session.test.ts`'s own fakes) — no
// `createApp`, no full `App`. app.test.ts's own var-strip suites remain the
// end-to-end composition safety net proving `createApp`'s real wiring reaches
// this controller (`app.renderVarStrip`/`app.setRunBtn` stay flat delegates);
// this file is the controller's own unit surface, including the two pieces of
// bookkeeping behavior that have NO other test anywhere: the mid-typing
// focus-containment deferral, and resetting that bookkeeping when the strip
// ELEMENT identity changes (a shell remount — sign-out/sign-in cycle).
import { describe, it, expect, vi } from 'vitest';
import { createVariableStrip } from '../../src/ui/workbench/variable-strip.js';
import type { VariableStripDeps } from '../../src/ui/workbench/variable-strip.js';
import { createWorkbenchParameterSession } from '../../src/application/workbench-parameter-session.js';
import { newTabObj } from '../../src/state.js';
import type { QueryTab, AppState } from '../../src/state.js';
import { emptyRecentMap } from '../../src/core/recent-values.js';
import type { RecentMap } from '../../src/core/recent-values.js';
import type { SchemaDb } from '../../src/core/from-scope.js';

const qs = <T extends Element = HTMLElement>(root: ParentNode | null, selector: string): T =>
  root!.querySelector(selector) as T;
const qsa = <T extends Element = HTMLElement>(root: ParentNode | null, selector: string): T[] =>
  [...root!.querySelectorAll(selector)] as T[];

// ── Fakes ────────────────────────────────────────────────────────────────────

/** A minimal `AppState`-shaped bag — only the fields `createVariableStrip`
 *  and `createWorkbenchParameterSession` actually read/write. Plain values
 *  (not signals) for `varValues`/`filterActive`/`varRecent`, matching
 *  `workbench-parameter-session.test.ts`'s own `makeState()`; `running`/
 *  `hasSelection` need `.value` (real `AppState` signals), faked with the
 *  same shape here since `createVariableStrip` only ever reads `.value`. */
function makeState(over: { running?: boolean; hasSelection?: boolean } = {}): {
  state: Pick<AppState, 'running' | 'hasSelection' | 'varValues' | 'filterActive' | 'varRecent'>;
  setRunning(v: boolean): void;
} {
  const varValues: Record<string, string> = {};
  const filterActive: Record<string, boolean> = {};
  let varRecent = emptyRecentMap();
  let running = over.running ?? false;
  const state = {
    get running() { return { value: running } as AppState['running']; },
    hasSelection: { value: over.hasSelection ?? false } as AppState['hasSelection'],
    varValues, filterActive,
    get varRecent() { return varRecent; },
    set varRecent(v: RecentMap) { varRecent = v; },
  };
  return { state, setRunning: (v) => { running = v; } };
}

function makeDeps(over: {
  tab?: QueryTab;
  strip?: HTMLElement;
  runBtn?: HTMLButtonElement;
  running?: boolean;
  hasSelection?: boolean;
} = {}): {
  deps: VariableStripDeps;
  tab: QueryTab;
  strip: HTMLElement;
  runBtn: HTMLButtonElement;
  setRunning(v: boolean): void;
  setStrip(el: HTMLElement | undefined): void;
  setRunBtnEl(el: HTMLButtonElement | undefined): void;
} {
  const tab = over.tab || newTabObj('t1');
  let strip: HTMLElement | undefined = over.strip
    ?? document.body.appendChild(document.createElement('div'));
  let runBtn: HTMLButtonElement | undefined = over.runBtn
    ?? document.body.appendChild(document.createElement('button'));
  const { state, setRunning } = makeState({ running: over.running, hasSelection: over.hasSelection });
  const params = createWorkbenchParameterSession({
    varValues: () => state.varValues,
    filterActive: () => state.filterActive,
    varRecent: () => state.varRecent,
    setVarRecent: (map) => { state.varRecent = map; },
    varRecentDisabled: () => false,
    schema: () => null as SchemaDb[] | null,
    activeTab: () => tab,
    wallNow: () => 1700000000000,
    saveJSON: () => {},
    hooks: { onGateBlocked: () => {}, saveVarRecent: () => {} },
  });
  const deps: VariableStripDeps = {
    document,
    state: state as unknown as AppState,
    activeTab: () => tab,
    params,
    wallNow: () => 1700000000000,
    varStrip: () => strip,
    runBtn: () => runBtn,
  };
  return {
    deps, tab, strip: strip!, runBtn: runBtn!, setRunning,
    setStrip: (el) => { strip = el; },
    setRunBtnEl: (el) => { runBtn = el; },
  };
}

// ── setRunBtn ────────────────────────────────────────────────────────────────

describe('setRunBtn', () => {
  it('no-ops when the Run button ref is absent (early return)', () => {
    const { deps, setRunBtnEl } = makeDeps();
    setRunBtnEl(undefined);
    const ctl = createVariableStrip(deps);
    expect(() => ctl.setRunBtn(false)).not.toThrow();
  });

  it('"Running…" with no trailing "null"; "Run" + kbd when idle; "Run selection" with a selection', () => {
    const { deps, runBtn } = makeDeps({ hasSelection: false });
    const ctl = createVariableStrip(deps);
    ctl.setRunBtn(true);
    expect(runBtn.disabled).toBe(true);
    expect(runBtn.textContent).toBe('Running…');
    ctl.setRunBtn(false);
    expect(runBtn.disabled).toBe(false);
    expect(runBtn.textContent).toContain('Run');
    expect(qs(runBtn, 'kbd')).not.toBeNull();

    const sel = makeDeps({ hasSelection: true });
    const ctl2 = createVariableStrip(sel.deps);
    ctl2.setRunBtn(false);
    expect(sel.runBtn.textContent).toContain('Run selection');
  });

  it('gate-less fallback: blocks on an unfilled {name:Type}, with a tooltip', () => {
    const { deps, tab, runBtn } = makeDeps();
    tab.sqlDraft = 'SELECT {id:UInt32}';
    const ctl = createVariableStrip(deps);
    ctl.setRunBtn(false);
    expect(runBtn.disabled).toBe(true);
    expect(runBtn.title).toContain('id');
  });

  it('gate-less fallback never gates a dashboard-variable tab (#465)', () => {
    const { deps, tab, runBtn } = makeDeps({
      tab: { ...newTabObj('t2'), doc: { kind: 'dashboard-variable', dashboardId: 'd', variableName: 'v' } },
    });
    tab.sqlDraft = '{unfilled:UInt32}'; // would block an ordinary tab
    const ctl = createVariableStrip(deps);
    ctl.setRunBtn(false);
    expect(runBtn.disabled).toBe(false);
  });

  it('an explicit gate wins over the fallback computation (missing/invalid/errors)', () => {
    const { deps, runBtn } = makeDeps();
    const ctl = createVariableStrip(deps);
    ctl.setRunBtn(false, { missing: [], invalid: [], errors: ['boom'] });
    expect(runBtn.disabled).toBe(true);
    expect(runBtn.title).toBe('boom');
  });
});

// ── renderVarStrip ───────────────────────────────────────────────────────────

describe('renderVarStrip', () => {
  it('no-ops when the strip ref is absent (early return, first call site guard)', () => {
    const { deps, setStrip } = makeDeps();
    setStrip(undefined);
    const ctl = createVariableStrip(deps);
    expect(() => ctl.renderVarStrip()).not.toThrow();
  });

  it('renders an input per detected {name:Type}, hides when none, gates Run (tail call site)', () => {
    const { deps, tab, strip, runBtn } = makeDeps();
    tab.sqlDraft = 'SELECT {database:String}, {table:String}';
    const ctl = createVariableStrip(deps);
    ctl.renderVarStrip();
    expect(strip.style.display).not.toBe('none');
    const fields = qsa(strip, '.var-field');
    expect(fields.map((f) => qs(f, '.var-name').textContent)).toEqual(['database', 'table']);
    expect(runBtn.disabled).toBe(true);
    expect(runBtn.title).toContain('database');
    // idempotent re-render (signature guard skips the rebuild)
    const before = qs<HTMLInputElement>(strip, '.var-input');
    ctl.renderVarStrip();
    expect(qs<HTMLInputElement>(strip, '.var-input')).toBe(before);
    // no variables → strip hidden again
    tab.sqlDraft = 'SELECT 1';
    ctl.renderVarStrip();
    expect(strip.style.display).toBe('none');
    expect(runBtn.disabled).toBe(false);
  });

  it('a dashboard-variable tab hides the strip unconditionally and never gates Run (first setRunBtn call site)', () => {
    const { deps, tab, strip, runBtn } = makeDeps({
      tab: { ...newTabObj('t2'), doc: { kind: 'dashboard-variable', dashboardId: 'd', variableName: 'v' } },
    });
    tab.sqlDraft = 'SELECT {p:UInt8}'; // would otherwise render a field + block Run
    const ctl = createVariableStrip(deps);
    ctl.renderVarStrip();
    expect(strip.style.display).toBe('none');
    expect(strip.children.length).toBe(0);
    expect(runBtn.disabled).toBe(false);
  });

  it('enum field variant: a declared Enum8 renders the dropdown control', () => {
    const { deps, tab, strip } = makeDeps();
    tab.sqlDraft = "SELECT {k:Enum8('a' = 1, 'b' = 2)}";
    createVariableStrip(deps).renderVarStrip();
    const input = qs<HTMLInputElement>(strip, '.var-input');
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    expect(qsa(strip, '[role="option"]').length).toBeGreaterThan(0);
  });

  it('relative-time field variant: a DateTime var gets the preset+preview combobox', () => {
    const { deps, tab, strip } = makeDeps();
    tab.sqlDraft = 'SELECT {ts:DateTime}';
    createVariableStrip(deps).renderVarStrip();
    const input = qs<HTMLInputElement>(strip, '.var-input');
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    expect(qsa(strip, '[role="option"]').length).toBeGreaterThan(0);
  });

  it('recent field variant: a plain String var gets the recents-only combobox (no date presets)', () => {
    const { deps, tab, strip } = makeDeps();
    tab.sqlDraft = 'SELECT {name:String}';
    createVariableStrip(deps).renderVarStrip();
    const input = qs<HTMLInputElement>(strip, '.var-input');
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    expect(qs(strip, '.var-combo-preview')).toBeNull();
  });

  it('typing commits the shared store and re-syncs Run (onValueInput/onCommitHard call setRunBtn)', () => {
    const { deps, tab, strip, runBtn } = makeDeps();
    tab.sqlDraft = 'SELECT {id:UInt32}';
    createVariableStrip(deps).renderVarStrip();
    const input = qs<HTMLInputElement>(strip, '.var-input');
    input.value = '42';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(deps.state.varValues.id).toBe('42');
    expect(runBtn.disabled).toBe(false);
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    expect(runBtn.title).toBe('');
  });

  it('a type-conflicted variable (declared with disagreeing types) degrades to plain text with a visible warning (#173 acceptance)', () => {
    const { deps, tab, strip } = makeDeps();
    const ENUM_TYPE = "Enum8('active' = 1, 'deleted' = 2)";
    tab.sqlDraft = `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}; SELECT {status:String}`;
    createVariableStrip(deps).renderVarStrip();
    const input = qs<HTMLInputElement>(strip, '.var-input');
    expect(input.classList.contains('is-conflict')).toBe(true);
    expect(input.title).toContain('Conflicting type declarations');
  });

  it('an optional (/*[ ]*/-block-only) variable gets the `.is-optional` affordance', () => {
    const { deps, tab, strip } = makeDeps();
    tab.sqlDraft = 'SELECT {y:UInt16} FROM t /*[ AND d = {d:String} ]*/';
    createVariableStrip(deps).renderVarStrip();
    const fields = qsa(strip, '.var-field');
    expect(fields.map((f) => f.classList.contains('is-optional'))).toEqual([false, true]);
    expect(qs(fields[1], '.var-input').title).toContain('optional');
  });

  it('"Clear recent" (the dropdown footer) calls through to params.clearVarRecent for that field', () => {
    const { deps, tab, strip } = makeDeps();
    tab.sqlDraft = 'SELECT {tenant:String}';
    deps.state.varValues.tenant = 'acme';
    const spy = vi.spyOn(deps.params, 'clearVarRecent');
    createVariableStrip(deps).renderVarStrip();
    const input = qs<HTMLInputElement>(strip, '.var-input');
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    const clearBtn = qs(strip, 'button.var-combo-clear');
    clearBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(spy).toHaveBeenCalledWith('tenant');
  });

  it('no active tab: hides the strip, and the tail setRunBtn call gets an `undefined` gate (no analysis to prepare)', () => {
    const { deps, strip, runBtn } = makeDeps();
    deps.activeTab = () => undefined;
    createVariableStrip(deps).renderVarStrip();
    expect(strip.style.display).toBe('none');
    expect(runBtn.disabled).toBe(false); // no analysis ⇒ gate-less ⇒ never blocks
  });

  it('setRunBtn\'s own runGate ternary: a valid analysis while `running` yields an undefined (not recomputed) gate', () => {
    const { deps, tab, runBtn } = makeDeps({ running: true });
    tab.sqlDraft = 'SELECT {id:UInt32}'; // would otherwise block Run
    createVariableStrip(deps).renderVarStrip();
    expect(runBtn.disabled).toBe(true); // disabled because RUNNING, not because of the gate
    expect(runBtn.title).toBe('');
  });

  // ── Focus-containment deferral (sabotage-verified) ────────────────────────
  //
  // Mirrors the pre-extraction behavior app.test.ts's own "v2: a background
  // column load never steals focus mid-typing" case exercises end-to-end
  // through the real schema-catalog service; this is the controller's OWN
  // unit-level guarantee, independent of that composition.
  it('defers the rebuild while focus is INSIDE the strip, then applies it on focusout (relatedTarget leaves the strip)', () => {
    const { deps, tab, strip, runBtn } = makeDeps();
    tab.sqlDraft = 'SELECT {a:UInt8}';
    const ctl = createVariableStrip(deps);
    ctl.renderVarStrip();
    const firstInput = qs<HTMLInputElement>(strip, '.var-input');
    firstInput.focus();
    expect(document.activeElement).toBe(firstInput);

    // A signature change while focus is inside the strip (e.g. a background
    // schema-cache upgrade landing mid-typing) must NOT replace the children.
    tab.sqlDraft = 'SELECT {a:UInt8}, {b:UInt8}';
    ctl.renderVarStrip();
    expect(qsa(strip, '.var-field')).toHaveLength(1); // unchanged — deferred
    expect(qs<HTMLInputElement>(strip, '.var-input')).toBe(firstInput); // same node
    // setRunBtn still ran (against the OLD, single-field analysis) — the
    // deferred branch's own call site.
    expect(runBtn.title).toContain('b'); // #a is filled by nothing yet... but gate reflects new analysis via runGate()

    // Focus merely moving BETWEEN fields of the strip (relatedTarget still
    // inside it) must NOT apply the deferred rebuild. A manually-dispatched
    // `focusout` (not a real `.focus()` transfer) leaves `document.activeElement`
    // untouched, matching app.test.ts's own "moving focus BETWEEN strip fields"
    // case — only the event's `relatedTarget` is under test here.
    const outsideButStillInStrip = document.createElement('input');
    strip.appendChild(outsideButStillInStrip);
    firstInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outsideButStillInStrip }));
    expect(qsa(strip, '.var-field')).toHaveLength(1); // still deferred

    // Focus actually leaving the strip (a real `.blur()` — happy-dom fires the
    // real `focusout` with the correct `relatedTarget` and updates
    // `document.activeElement`) applies the deferred rebuild.
    firstInput.blur();
    expect(qsa(strip, '.var-field')).toHaveLength(2); // rebuilt now
  });

  it('sabotage check: without the deferral, a background rebuild mid-typing would steal focus/replace the node', () => {
    // Documents the guard this suite protects — if `renderVarStrip` rebuilt
    // unconditionally on every signature change (no focus-containment check),
    // the SAME scenario above would replace `firstInput` immediately instead
    // of waiting for focusout. This case only asserts the (correct) deferred
    // behavior again from a fresh strip, keyed on a DIFFERENT initial field
    // count, so the two tests can't pass by coincidentally sharing state.
    const { deps, tab, strip } = makeDeps();
    tab.sqlDraft = 'SELECT {x:String}';
    const ctl = createVariableStrip(deps);
    ctl.renderVarStrip();
    const input = qs<HTMLInputElement>(strip, '.var-input');
    input.focus();
    tab.sqlDraft = 'SELECT {x:String}, {y:String}, {z:String}';
    ctl.renderVarStrip();
    expect(qs<HTMLInputElement>(strip, '.var-input')).toBe(input); // NOT replaced while focused
  });

  // ── Strip-identity reset (sabotage-verified) ──────────────────────────────
  //
  // #588 W1: `sig`/`rerenderPending`/`hookedStrip` are now controller-private
  // closure state (no longer `app.dom.*`, which used to reset for free
  // because `app.dom` itself is rebuilt wholesale on every shell mount). A
  // shell remount (sign-out/sign-in) hands this SAME controller instance a
  // BRAND NEW `<div class="var-strip">` — this must not leak stale
  // bookkeeping from the old element, and the new element must get its own
  // working `focusout` listener.
  it('a fresh strip element resets `sig` — a remount rendering the SAME {name:Type} set stripA last committed must still populate the new (empty) element', () => {
    const { deps, tab, setStrip } = makeDeps();
    const stripA = document.body.appendChild(document.createElement('div'));
    setStrip(stripA);
    const ctl = createVariableStrip(deps);
    tab.sqlDraft = 'SELECT {a:UInt8}'; // stripA commits ITS `sig` to this set
    ctl.renderVarStrip();
    expect(qsa(stripA, '.var-field')).toHaveLength(1);

    // Simulate a shell remount: a brand new (EMPTY) strip element for the
    // SAME controller instance (app.dom resets wholesale, but the controller
    // is a singleton built once by createApp) — SAME {name:Type} set as
    // stripA's last commit. If `sig` were not reset on the identity change,
    // `sigNew !== sig` would be FALSE (identical signature string) and the
    // rebuild would be wrongly skipped, leaving stripB with ZERO children —
    // a fresh element that has never had anything rendered into it.
    const stripB = document.body.appendChild(document.createElement('div'));
    setStrip(stripB);
    ctl.renderVarStrip();
    expect(qsa(stripB, '.var-field')).toHaveLength(1);
    expect(stripB.style.display).not.toBe('none');
  });

  it('a fresh strip element resets `rerenderPending` and gets its own working focusout listener', () => {
    const { deps, tab, setStrip } = makeDeps();
    const stripA = document.body.appendChild(document.createElement('div'));
    setStrip(stripA);
    const ctl = createVariableStrip(deps);
    tab.sqlDraft = 'SELECT {a:UInt8}';
    ctl.renderVarStrip();
    const inputA = qs<HTMLInputElement>(stripA, '.var-input');
    inputA.focus();
    // Leave a rebuild PENDING on stripA (simulates a stale
    // `rerenderPending`/`sig` if the remount below failed to reset them).
    tab.sqlDraft = 'SELECT {a:UInt8}, {a2:UInt8}';
    ctl.renderVarStrip();
    expect(qsa(stripA, '.var-field')).toHaveLength(1); // deferred, as above

    // Simulate a shell remount: a brand new strip element for the SAME
    // controller instance.
    const stripB = document.body.appendChild(document.createElement('div'));
    setStrip(stripB);
    ctl.renderVarStrip();
    // The rebuild against stripB must reflect the CURRENT tab state, not be
    // silently skipped by a stale `sig`/`rerenderPending` carried over from
    // stripA.
    expect(qsa(stripB, '.var-field')).toHaveLength(2);

    // stripB must have gotten its OWN focusout listener — not merely inherit
    // "already hooked" bookkeeping from stripA (which would leave stripB with
    // no listener at all, and the deferred rebuild below would never apply).
    const inputB = qs<HTMLInputElement>(stripB, '.var-input');
    inputB.focus();
    tab.sqlDraft = 'SELECT {a:UInt8}, {a2:UInt8}, {a3:UInt8}';
    ctl.renderVarStrip();
    expect(qsa(stripB, '.var-field')).toHaveLength(2); // deferred again
    inputB.blur(); // real focus transfer — a real `focusout` reaches stripB's own listener
    expect(qsa(stripB, '.var-field')).toHaveLength(3); // stripB's OWN listener applied it
  });

  it('the dashboard-variable-tab branch also resets `sig` so the NEXT ordinary render always rebuilds', () => {
    const { deps, tab, strip } = makeDeps();
    tab.sqlDraft = 'SELECT {a:UInt8}';
    const ctl = createVariableStrip(deps);
    ctl.renderVarStrip();
    expect(qsa(strip, '.var-field')).toHaveLength(1);
    // Switch to a dashboard-variable tab with the SAME nominal SQL text —
    // hides the strip and must clear the signature.
    tab.doc = { kind: 'dashboard-variable', dashboardId: 'd', variableName: 'v' };
    ctl.renderVarStrip();
    expect(strip.style.display).toBe('none');
    // Switching back to an ordinary tab with the SAME {name:Type} set must
    // still rebuild (a stale non-empty `sig` would wrongly skip it, leaving
    // the strip hidden with an empty body).
    tab.doc = { kind: 'query' };
    ctl.renderVarStrip();
    expect(strip.style.display).not.toBe('none');
    expect(qsa(strip, '.var-field')).toHaveLength(1);
  });
});
