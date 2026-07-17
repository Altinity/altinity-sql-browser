// #276 Phase 4C's QueryDocumentSession — the Spec-evaluation/document
// lifecycle extracted from app.ts (issue #276 §8, plan-review rulings):
// applySpecEvaluation/evaluateSpecDraft/revalidateSpecDrafts/
// revealFirstSpecError/registerSpecValidator, plus the editor-mode POLICY
// half of `setEditorMode` (`resolveEditorMode` below — whether a mode switch
// is allowed, and why not; the DOM/focus toggles that use the answer stay in
// app.ts's own `setEditorMode`). Constructible without App/AppState/DOM, like
// `workbench-parameter-session.ts`/`schema-catalog-service.ts` before it.
//
// Deliberately NOT included (plan-review ruling): `sessionParams`/
// `needsSession`/`sessionParamsFor` stay app.ts-local (Phase 5 decides their
// home) — they're `tab.chSession`/transport material, unrelated to Spec
// evaluation. `activateInvalidSpecDraft` (>80% shell: toast/batch/focus)
// stays app.ts too.
//
// Diagnostics are typed as core/spec-draft.js's own `SpecValidationDiagnostic`
// — NOT `src/editor/spec-editor.types.js`'s `SpecDiagnostic` — so this module
// never imports `src/editor/**` (check:arch enforces `src/application/**`
// never importing `src/ui/**`/`src/editor/**`). `SpecValidationDiagnostic` is
// a strict superset of every field `SpecDiagnostic` optionally declares (see
// its own doc comment in core/spec-draft.ts), so it is directly assignable
// wherever a real `SpecDiagnostic` is expected — app.ts's own
// `hooks.setDiagnostics`/`hooks.revealDiagnostic` wiring passes these
// straight to `app.specEditor.setDiagnostics`/`.revealDiagnostic` without a
// cast.
//
// Every DOM/editor touch this session used to perform directly (repainting
// the Spec editor's diagnostics gutter, revealing a diagnostic, repainting
// tabs, the Save button, the editor-mode chrome) is now a `hooks` callback —
// app.ts supplies real closures over `app.specEditor`/`app.actions`/
// `app.updateSaveBtn`/`app.updateEditorModeUi` (some of those app.ts members
// are only assigned later in `createApp`, so app.ts's own hook closures keep
// the exact same `if (app.actions) …`-style guards the pre-extraction inline
// code used — this session calls every hook unconditionally, unaware of that
// construction-order concern).

import { evaluateSpecText } from '../core/spec-draft.js';
import type { SpecValidationDiagnostic, SpecValidatorFn, QuerySpecValidationService } from '../core/spec-draft.js';
import { savedForTab } from '../state.js';
import type { QueryTab, AppState } from '../state.js';

// ── Construction deps ────────────────────────────────────────────────────────

export interface QueryDocumentSessionHooks {
  /** Repaint the Spec editor's diagnostics gutter for the tab this call cares
   *  about — `evaluateSpecDraft`/`revalidateSpecDrafts` only ever call this
   *  for the CURRENTLY active tab (mirrors the pre-extraction inline code:
   *  `applySpecEvaluation` alone never repaints anything). */
  setDiagnostics(diagnostics: SpecValidationDiagnostic[]): void;
  /** Jump the Spec editor's caret/scroll to diagnostic `index` (of the active
   *  tab's current `specDiagnostics`). */
  revealDiagnostic(index: number): void;
  rerenderTabs(): void;
  updateSaveBtn(): void;
  updateEditorModeUi(): void;
}

/** Live accessors — read fresh on every call, mirroring every other #276
 *  session's own `*SessionDeps` convention (never a snapshot). `state` is
 *  narrowed to exactly the fields this session reads: `tabs` (iterating every
 *  open document in `revalidateSpecDrafts`) and `savedQueries`
 *  (`resolveEditorMode`'s `savedForTab` check) — production passes `app.state`
 *  itself, which satisfies this directly. */
export interface QueryDocumentSessionDeps {
  state: Pick<AppState, 'tabs' | 'savedQueries'>;
  activeTab(): QueryTab;
  /** The app-owned Spec validation service (core/spec-draft.js) — canonical
   *  schema validation plus registered feature rules, with `.register` for
   *  `registerSpecValidator`. Production passes `app.specValidators`. */
  specValidators: QuerySpecValidationService;
  hooks: QueryDocumentSessionHooks;
}

/** One Spec-evaluation outcome: the parsed draft (`null` when the textual
 *  Spec isn't valid JSON — see `QueryTab.specParsed`'s own invariant) plus
 *  every diagnostic the canonical schema + registered validators produced. */
export interface SpecEvaluationResult {
  parsed: unknown;
  diagnostics: SpecValidationDiagnostic[];
}

/** `resolveEditorMode`'s verdict — `message` is present only when there's a
 *  user-facing reason to explain the block (the "spec mode needs a saved
 *  query" case); the defensive not-sql-not-spec case carries none, matching
 *  the pre-extraction inline code's own silent early return there. */
export interface EditorModeGate {
  ok: boolean;
  message?: string;
}

// ── The session ──────────────────────────────────────────────────────────────

export interface QueryDocumentSession {
  /** Parse + validate `text` against `specValidators` and write the result
   *  onto `tab` (`specText`/`specParsed`/`specDiagnostics`/`dirtySpec`) — no
   *  DOM/hooks side effect. The low-level op every other method builds on;
   *  app.ts's own `sqlEditor.onDocChange` filter-role gate calls this
   *  directly (not `evaluateSpecDraft`) so it can pair it with its own,
   *  different, tail of UI updates. */
  applySpecEvaluation(tab: QueryTab, text: string, opts?: { dirty?: boolean }): SpecEvaluationResult;
  /** `applySpecEvaluation` plus the full UI-refresh tail: repaints the Spec
   *  editor's diagnostics ONLY when `tab` is the currently active one, then
   *  unconditionally repaints tabs / the Save button / the editor-mode
   *  chrome. */
  evaluateSpecDraft(tab: QueryTab, text: string, opts?: { dirty?: boolean }): SpecEvaluationResult;
  /** Re-run `applySpecEvaluation` for every open tab (e.g. after a validator
   *  registers/unregisters, or a Save that could change what "blocking"
   *  means elsewhere). `refreshUi: false` skips the repaint tail entirely
   *  (still re-evaluates every tab's diagnostics). */
  revalidateSpecDrafts(opts?: { refreshUi?: boolean }): void;
  /** Jump to the first error-severity diagnostic on `tab` (defaults to the
   *  active tab) via `hooks.revealDiagnostic`; a no-op if there is none. */
  revealFirstSpecError(tab?: QueryTab): void;
  /** Register a validator at `path`; every open Spec draft is revalidated
   *  both on register and on the returned unregister. */
  registerSpecValidator(path: (string | number)[], validate: SpecValidatorFn): () => void;
  /** The editor-mode POLICY half of app.ts's `setEditorMode`: whether
   *  switching `tab` into `mode` is allowed right now. Entering 'spec' mode
   *  requires `tab` to already be linked to a saved query (an unsaved tab has
   *  no persisted Spec to edit as JSON) — the `message` explains that case to
   *  the user. app.ts's own `setEditorMode` performs the DOM/focus side of a
   *  successful switch (assigning `tab.editorMode`, repainting the editor-mode
   *  chrome, focusing the target editor). */
  resolveEditorMode(tab: QueryTab, mode: 'sql' | 'spec'): EditorModeGate;
}

/** Build a `QueryDocumentSession` bound to `deps`. Trivial constructor — no
 *  validation, no defaulting; the caller supplies every field exactly as it
 *  wants it used. */
export function createQueryDocumentSession(deps: QueryDocumentSessionDeps): QueryDocumentSession {
  function applySpecEvaluation(
    tab: QueryTab, text: string, { dirty = true }: { dirty?: boolean } = {},
  ): SpecEvaluationResult {
    const evaluated = evaluateSpecText(text, deps.specValidators, { sql: tab.sqlDraft, tab });
    tab.specText = text;
    tab.specParsed = evaluated.parsed as QueryTab['specParsed'];
    tab.specDiagnostics = evaluated.diagnostics;
    tab.dirtySpec = dirty;
    return evaluated;
  }

  function evaluateSpecDraft(
    tab: QueryTab, text: string, { dirty = true }: { dirty?: boolean } = {},
  ): SpecEvaluationResult {
    const evaluated = applySpecEvaluation(tab, text, { dirty });
    // `evaluated.diagnostics` (not `tab.specDiagnostics`, though
    // `applySpecEvaluation` just assigned the very same array onto it) — the
    // tab's own field is declared `SpecDiagnostic[]` (state.ts, the editor's
    // looser app-wide contract), which a real `SpecValidationDiagnostic[]`
    // assigns INTO fine but doesn't read back OUT of without narrowing; using
    // the freshly-returned value sidesteps that one-directional relationship
    // entirely instead of asserting it back down.
    if (tab === deps.activeTab()) deps.hooks.setDiagnostics(evaluated.diagnostics);
    deps.hooks.rerenderTabs();
    deps.hooks.updateSaveBtn();
    deps.hooks.updateEditorModeUi();
    return evaluated;
  }

  function revalidateSpecDrafts({ refreshUi = true }: { refreshUi?: boolean } = {}): void {
    for (const tab of deps.state.tabs.value) {
      applySpecEvaluation(tab, tab.specText, { dirty: tab.dirtySpec });
    }
    if (!refreshUi) return;
    const tab = deps.activeTab();
    // `tab.specDiagnostics` is declared `SpecDiagnostic[]` (state.ts, the
    // editor's looser app-wide contract) but was just written, in the loop
    // above, by `applySpecEvaluation` — this module's only writer of that
    // field — as a real `SpecValidationDiagnostic[]`. The one-directional
    // relationship (see this module's header comment) makes this a safe,
    // narrowing-only assertion, not a new runtime assumption; unconditional,
    // matching the pre-extraction inline code exactly (it never guarded on
    // whether the active tab happened to be freshly re-evaluated either).
    deps.hooks.setDiagnostics(tab.specDiagnostics as SpecValidationDiagnostic[]);
    deps.hooks.rerenderTabs();
    deps.hooks.updateSaveBtn();
    deps.hooks.updateEditorModeUi();
  }

  function revealFirstSpecError(tab: QueryTab = deps.activeTab()): void {
    const index = tab.specDiagnostics?.findIndex((diagnostic) => diagnostic.severity === 'error') ?? -1;
    if (index >= 0) deps.hooks.revealDiagnostic(index);
  }

  function registerSpecValidator(path: (string | number)[], validate: SpecValidatorFn): () => void {
    const unregister = deps.specValidators.register(path, validate);
    revalidateSpecDrafts();
    return () => { unregister(); revalidateSpecDrafts(); };
  }

  function resolveEditorMode(tab: QueryTab, mode: 'sql' | 'spec'): EditorModeGate {
    if (mode === 'spec' && !savedForTab(deps.state, tab)) {
      return { ok: false, message: 'Save this query to create an editable Spec.' };
    }
    if (mode !== 'sql' && mode !== 'spec') return { ok: false };
    return { ok: true };
  }

  return {
    applySpecEvaluation,
    evaluateSpecDraft,
    revalidateSpecDrafts,
    revealFirstSpecError,
    registerSpecValidator,
    resolveEditorMode,
  };
}
