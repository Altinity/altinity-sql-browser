# ADR-0001: Reactivity — incremental signals, not a framework

- **Status:** Accepted — adopted on `spike/signals-core` (#88)
- **Date:** 2026-06-29 (adopted 2026-06-30)
- **Context tracking:** roadmap #68; adoption #88
- **Evidence:** `spike/signals` (hand-rolled primitive + two converted slices),
  `spike/signals-core` (the chosen primitive; tabs/sidePanel, then the
  `resultView`+`running` and `libraryName`+`libraryDirty` scalar slices)

## Context

The app is a framework-free ES-module SPA: pure logic in `src/core/` (100%
covered), an injected-seam controller (`createApp(env)`), and a hand-rolled
hyperscript render layer in `src/ui/`. As feature count grows (16+ open issues),
the recurring pain is **manual render invalidation**: state is mutated and then
the dependent views are repainted by hand (e.g. `tabs.js`'s old `refresh()`
called `renderTabs` + editorSync + `renderResults` + `updateSaveBtn`). Forgetting
a dependent → stale UI. This is an *absence-of-reactivity* problem, distinct from
a *component-model* problem.

Three hard constraints frame any solution: a single self-contained HTML artifact
with no third-party asset loads (CLAUDE.md rule 4 — deliberate deps only), the
per-file 100/100/100/100 coverage gate (rule 1), and the injected-seam layering
(rule 2).

## Decision

Adopt **`@preact/signals-core`** (`signal()` / `effect()` / `computed()` /
`batch()` / `untracked()`) and migrate state **one slice at a time**, reading
and writing through `.value`. An accessor helper (like `activeTab()`) is
*optional* — used where it usefully contains reader churn, skipped where the
churn is trivially mechanical (see the Consequences guideline). **Do not** adopt
a UI framework (React/Preact/Solid).

A hand-rolled ~70-line primitive was prototyped first and works (`spike/signals`),
but `@preact/signals-core` was chosen over it: same `.value` API (so the
migration code is identical and the choice is reversible in ~5 lines), but
maintained, glitch-free (correct topological/diamond updates), and with a lazy
memoized `computed()` — none of which the naive synchronous prototype provides.
It costs one small, zero-transitive-dependency package and **+1.4 KB gzip** to
the artifact (vs +0.45 KB hand-rolled), in exchange for not owning ~70 lines +
~180 test lines of correctness-critical reactive code. Per CLAUDE.md rule 4 this
is a deliberate dependency; it is still inlined, so the artifact makes no
third-party asset request for it.

## Options considered (all measured)

| Option | artifact Δ (gzip) | Verdict |
|---|---|---|
| **@preact/signals-core** | **+1.4 KB** | **Chosen** — maintained, glitch-free, `computed`; same `.value` API; we own no reactive code |
| Hand-rolled `signal.js` | +0.45 KB | Viable (`spike/signals`) — zero deps, but we own + 100%-cover it; naive (not glitch-free), no `computed` |
| Preact + @preact/signals | +7.3 KB (`spike/preact`) | Rejected — its only edge over signals-core is auto DOM-diffing of large lists, which we don't need |
| Solid.js | ~+7 KB | Rejected — compiler/plugin + ecosystem cost; same unneeded big-list benefit |
| React (proper) | ~+45 KB | Rejected — heaviest dep, vDOM-on-big-tables liability, mismatch with the single-file ethos |

Decisive factor: we do **not** need a virtualized / large-list renderer (no
10k-row grid requirement), which is the one thing a vDOM framework buys over a
bare signals core. The pain is invalidation, which signals solve directly — and
between the two signals options, a maintained, glitch-free core beats owning the
primitive for ~1 KB.

## Evidence (spike)

Two slices converted end-to-end with the full suite + per-file coverage gate
green and a real `npm run build` (1033 tests on the hand-rolled branch; 1022 on
`spike/signals-core`, which drops the 11 primitive-internal tests):

- **tabs** (`tabs` + `activeTabId`) — *has* an `activeTab()` accessor → 16 callers
  insulated; low mechanical churn, but one behavioral test relocation (the
  repaint responsibility moved from `tabs.js` to a `createApp()` effect).
- **sidePanel** — *no* accessor → every reader changed, but the churn was purely
  mechanical `.value` and concentrated in the panel's own test file; no assertion
  rewrites.

Both branches share the slice conversions verbatim. Moving from the hand-rolled
primitive to `@preact/signals-core` was a 5-line diff (import swaps + deleting
`src/core/signal.js` and its test), demonstrating the API parity and that the
choice is reversible.

## Consequences

- Mutating a converted slice is just `state.x.value = …`; an `effect()` repaints.
  Manual `refresh()` lists are deleted.
- **Migration is monotonic**: a slice keeps some direct render calls until its
  co-dependent slices are also signals. No slice un-converts another.
- Per-slice cost is mostly mechanical `.value` edits in that slice's tests.
- **Guideline (not a rule):** add an accessor helper (like `activeTab()`) for a
  slice with many scattered readers to contain churn; slices with few or
  localized readers convert fine with bare `.value`. Validated by the
  `sidePanel` slice (no helper — "worst case") and the `resultView`/`running`
  and `libraryName`/`libraryDirty` scalar slices, all helper-free.
- Adding `@preact/signals-core` makes **three** bundled runtime deps. On adoption
  the dependency count was updated in CLAUDE.md rule 4, THIRD-PARTY-NOTICES.md,
  and `build/build.mjs` comments (all done).
- Re-evaluate Preact/Solid only if the UI later grows many interdependent
  components with rich local state, or a genuine large-list render need appears.

## Addendum — Preact spike on the schema panel (#88, branch `spike/preact-schema`)

The scalar slices (`resultView`/`running`, `libraryName`/`libraryDirty`) fit
signals-core cleanly. The **schema panel** does not: `state.schema` was a nested
array mutated *in place* (`db.expanded`, an `expandedTables` Set, `tb.columns`
flipping null→'loading'→array), and signals only react to reference changes — so
a signals-core conversion would just relocate the manual-invalidation pain into
`schema.value = [...]` bumps. That makes it the fair test of whether a
component+vDOM model earns adoption. We built it as Preact components
(`SchemaTree → DbRow → TableRow → ColumnRow`) to gather evidence — explicitly
re-opening this ADR's "no framework" line for *complex panels only*.

**What the spike proved (the thesis holds):**
- The in-place-mutation anti-pattern is **gone**. Per-row expand state and lazy
  columns are component-local `useState`; the `expandedTables` Set and
  `db.expanded` were deleted; `loadColumns` became `fetchColumns` (returns the
  columns for local state, still caches to `tb.columns` for autocomplete — a data
  cache now decoupled from rendering). `state.schema`/`schemaError`/`schemaFilter`
  are signals the tree reads via `@preact/signals` auto-tracking; no manual
  `renderSchema()` calls remain.
- **The 100/100/100/100 per-file coverage gate is achievable** on the component
  file (`src/ui/schema.js`) with tests ported to preact's `render` + `act()`.
- Signal→component auto-tracking works under happy-dom (load and filter repaint
  the mounted tree).

**What it cost (measured / observed):**
- **Bundle: +6.8 KB gzip** (148,044 → 154,873 B; raw 457,892 → 474,440) — close
  to this ADR's +5.9 KB estimate. ~+4.6% of the artifact, still with no
  third-party asset loads (inlined).
- **A second paradigm.** signals-core `effect()`s drive the rest of `createApp`
  (tabs/results/title); the schema tree is Preact. Two render models coexist —
  the main ongoing cost.
- **Integration seams with the imperative layer:** `Icon.*()` returns live SVG
  DOM nodes that Preact can't embed, so a `ref`-mounter bridges them; preact's
  `h` vs the project's hand-rolled `h`; `loadColumns` had to be reshaped.
- **Test friction:** scenarios staged by poking global state (`expandedTables`,
  `tb.columns`) now require driving interactions; every interaction needs `act()`;
  the double-click detector forced a fake-timer gap between open/collapse clicks.
  Coverage still reaches 100%, but assertions shifted from state to DOM/behaviour.
- **LOC:** `src/ui/schema.js` 149 → 185 (+36), plus `preact` + `@preact/signals`
  deps (would make **five** bundled runtime deps; CLAUDE.md rule 4 +
  THIRD-PARTY-NOTICES would need updating *iff* adopted — not done on the spike).
- Used preact's `h()` (zero build/test config); JSX would improve ergonomics
  further but needs esbuild + vitest jsx config — not required to evaluate the
  component model.

**Recommendation: do not adopt Preact now; stay signals-core.** The component
model genuinely removes the anti-pattern and is fully testable, but the costs
(a second render paradigm app-wide, +6.8 KB, the icon/`h`/columns integration
seams) are paid across the whole app to benefit **one** panel. That matches this
ADR's original reasoning — the need is invalidation, not a component model, and
there is no large-list requirement. Keep the schema panel as a **documented
imperative exception** (or, if its `tb.columns`/expand churn becomes a real
maintenance drag, convert it with signals-core using *replaced* Set/Map-valued
signals rather than in-place mutation). The `spike/preact-schema` branch stands
as the evidence; re-open the decision only when several complex, interdependent,
rich-local-state panels are actually on the roadmap (per the trigger above).

## Addendum — schema slice landed via signals-core (#91, completes #88)

The schema slice was converted with signals-core exactly as the fallback above
prescribed — **no Preact**. `schema`/`schemaError`/`schemaFilter` are now
`signal(...)`; the in-place anti-pattern is gone two ways: per-row expand state
moved from the mutated `db.expanded` bool + `expandedTables` Set into a single
**Set-valued `expanded` signal** (keys `db:`/`tb:`), updated copy-on-write; and
lazy column loads **replace the `schema` reference** (`{...tb, columns}`) instead
of mutating `tb.columns` in place — `tb.columns` stays the completion cache
`buildCompletions` reads, so `completions.js` was untouched (lower churn than a
separate Map-valued signal; the gate held). Two `effect()`s in `createApp`
(schema tree + error banner) replaced every scattered `renderSchema()` call; the
expand+first-fetch is wrapped in `batch()` so the row opens with its spinner in
one repaint. This was the last slice — **#88 is complete**. The
re-evaluation trigger in #91 still applies: if reference-replacement proves as
forgettable as the old manual `renderSchema` calls, revisit via a fresh ADR.

## Addendum — three session-only UI flags converted (#102)

`state.shortcutsOpen`, `state.editingSavedId`, and `state.bannerDismissedFor`
(previously bare fields — the latter two lived on `app` directly, not
`app.state`) were converted to `signal(...)` and consolidated into `state.js`
alongside the other session-only, non-persisted fields (`libraryFilter`,
`resultSort`). None had a reactive reader before or after — each site that sets
one already calls its own repaint (`renderSavedHistory`, `updateBanner`,
`openShortcuts`'s own mount/unmount) — so this is a pure `.value` mechanical
edit, not a new `effect()`. Housing them in `state.js` rather than on `app`
matches every other slice in this file; #88's "last slice" note above refers to
the schema panel specifically, not every remaining plain field in the
codebase — this is a smaller, unrelated follow-up tidying three of those.

## Addendum — the editor is CodeMirror 6 behind the EditorPort seam (#143/#21)

The decision's "imperative adapters behind injected seams for the hard,
third-party, or high-frequency-pointer surfaces" clause is now realized for the
editor: #143 extracted the `EditorPort` interface (mount / getValue /
getSelection / insertAtCursor / replaceDocument / revealOffset / syncFromState /
refreshReference / onDocChange, injected as `env.Editor`), and #21 swapped the
adapter from the hand-rolled textarea to **CodeMirror 6** — the fourth bundled
runtime dependency. Signals still coordinate the state (`hasSelection`,
tab/effect wiring, the app-level `onDocChange` subscriber owns the
`tab.sqlDraft`/`dirtySql` writes); CM6 owns every keystroke, selection, undo, and
measurement inside the port. Per-tab `EditorState`s give per-tab undo — a
capability the shared-textarea design structurally lacked — and the adapter is
unit-tested against the real CM6 under happy-dom (the coverage gate holds
without a fake-editor seam). String-based application analysis (completion
context, FROM/JOIN scope, statement splitting, parameter inference) runs on the
shared core scanner `core/sql-spans.js` and the structural lexer
`core/sql-lex.js` (#182, which retired the old highlighter tokenizer
`core/sql-highlight.js`); CM6 owns editor highlighting and gets the same server
keyword/function sets via a `Compartment` reconfigure. Nothing about the state model changed — this
addendum records that the editor island now has its intended long-term
implementation, and that #84 (schema-aware autocomplete) plugs into the CM6
completion source rather than growing new overlay machinery.

## Addendum — read-only CodeMirror viewer behind a separate seam (#213)

Read-only source surfaces now use a smaller injected `env.CodeViewer` factory,
not the editable `EditorPort`. The two adapters share only CodeMirror
presentation/search extensions and the established `.sql-*` token-class map in
`editor/codemirror-base.js`; the viewer cannot inherit editor history,
completion, hover, schema loading, drag/drop insertion, tab parking, or app-state
subscriptions. Its language registry is explicit (text, JSON, SQL, XML,
XML-style HTML, and plain Markdown source), adding only the CodeMirror JSON/XML
language packages. Wrapping and language changes reconfigure compartments
without reconstructing the view, and the adapter supplies the target parent and
document root before CM6 initializes its realm-bound observers. This is the same imperative-island rule
applied at a smaller boundary, and gives later cell/detail consumers a stub-able
`app.CodeViewer` seam without coupling them to CodeMirror imports.

## Addendum — independent SQL and Spec JSON editor seams (#212)

Saved-query authoring now owns two explicit imperative islands:
`app.sqlEditor` and `app.specEditor`, injected by `env.Editor` and
`env.SpecEditor`. The former `app.editor` ambiguity is intentionally gone.
Execution, schema insertion, SQL formatting, and Export always address the SQL
adapter; changing which document is visible cannot redirect a SQL operation to
JSON. Each tab holds independent `sqlDraft` and `specText` documents, parsed
Spec state, diagnostics, mode, and dirty flags, while each adapter parks its own
CodeMirror state so undo, selection, scroll, and search remain local.

Spec parsing, normalization, and synchronous semantic validation live in pure
`core/spec-draft.js`. Validator paths are arrays of string/number segments, not
dotted strings, so array indices and object keys containing dots are exact.
The app owns the registry and feature code owns individual rules. Direct Spec
writers use one state-level patch helper. Panel controls patch the active valid
draft and leave it dirty. Immediately persisted Library pencil/favorite changes
patch every valid open draft while preserving both unrelated unsaved fields and
each draft's existing dirty state: clean stays clean; dirty stays dirty. A
syntactically invalid JSON draft reports that tab; #220 extends the same staged
guard to every blocking schema or feature diagnostic before mutation. Linked Save validates and persists SQL plus
Spec once, atomically; a failed Save writes nothing.

Spec is intentionally a lightweight editing mode rather than a second
workbench. Its toolbar owns Format, Save, and the SQL | Spec switch. Run,
Explain, SQL formatting, Export, Share, and Share’s global shortcut are owned by
SQL mode. Validation is continuous through diagnostics and status; there are no
manual Validate or Revert commands. The adapter shares only the generic
CodeMirror presentation/search base and JSON language package that had already
landed with #213, so #212 adds no runtime dependency.

## Addendum — canonical saved-query Spec schema service (#220)

The small path-validator registry introduced by #212 is now the feature layer
of one canonical validation service rather than a parallel source of static
truth. `schemas/query-spec-v1.schema.json` owns known `query.spec` structure,
panel discriminators, authoring annotations, and forward-compatible extension
policy. Pure `core/spec-schema.js` normalizes compiled errors into stable exact
path arrays and resolves local schema branches for editor tooling; it imports no
DOM, editor, application state, fetch, or SQL code.

Ajv runs only at development/build time. A deterministic generator validates
the Draft 2020-12 document in strict mode and emits a self-contained validator
plus schema-data module; tests and builds fail if either generated artifact is
stale. The browser bundle contains no general JSON Schema evaluator.

The app constructs one validation service and injects it through Spec editor
diagnostics, linked Save, Library import, and external Spec writers. Static
schema errors run first; app-owned feature validators run only when no blocking
schema error overlaps their path and receive optional result/application
context. External writers stage the persisted entry and every linked draft,
validate them all, and only then mutate once. Renderer-level bounds, result
column resolution, schema-key mismatch handling, and fallback defenses remain
authoritative for runtime data.

## Addendum — canonical whole-Library codec and schema registry (#224)

The canonical boundary now covers all three persisted layers without merging
their ownership: Library v2, saved-query v2, and query Spec v1 remain separate
Draft 2020-12 resources and evolve independently. Library and saved-query
envelopes are closed because their canonicalizers cannot preserve arbitrary
fields; the Spec retains its explicit forward-compatible namespaces. The
production manifest is an allowlist, so documentation drafts can never become
runtime contracts through filename discovery.

Pure `core/library-codec.js` owns parsing, complete-document validation,
encoding, and dispatch through independent Library and Spec version registries.
Migrations are sequential one-version pure functions that validate before and
after each step. File Open/Replace/Append, Save JSON, examples, and the dedicated
historical local-storage decoder share this boundary. Future versions and
corrupt storage fail closed without partially changing state or rewriting the
original bytes. Missing `exportedAt` remains accepted for historical v2 input
and decodes as metadata `null`; every new export requires a valid timestamp and
includes the canonical instance `$schema` hint by default.

Ajv plus `ajv-formats` remain build-time-only. One strict registry compiles the
canonical graph and emits self-contained named validators and ID maps. The same
manifest deterministically generates an offline compound Library bundle and
schema catalog. Generic exact-path diagnostic normalization is shared across
the whole Library and the focused Spec introspection service, while duplicate
IDs and runtime/result rules remain explicit semantic validation.

## Addendum — re-evaluated at the dashboard milestone (2026-07): decision stands, trigger sharpened

The project's stated ambition grew to full-scale ClickHouse-only dashboarding
comparable to Superset/Grafana, which prompted a fresh look at the "no
framework" line. The decision **stands**. The dashboard surface (#149 tracks:
layout modes, filter bar, KPI band, panel execution, chart presets, mobile
presentation) shipped entirely under signals + imperative islands — the
strongest evidence yet that the need was invalidation, not a component model.
Three further observations:

- A framework would not own the hard parts anyway: CodeMirror, Chart.js, the
  dagre graphs, and grid resize/sort stay imperative islands under any render
  model. It would only own the chrome *between* islands, while forcing a
  rewrite of ~9 k LOC of `src/ui/` and its 100%-covered tests.
- Grafana/Superset use React for reasons this project does not have — a
  third-party plugin ecosystem and a very large contributor surface. This
  project's differentiator is the opposite: one self-contained file with no
  third-party asset loads.
- ADR-0002 (incremental strict TypeScript) further reduces the framework pull:
  a typed `h()` hyperscript and a typed `app` controller surface recover much
  of the edit-time DX people reach for a framework to get.

The original vague trigger ("several complex, interdependent, rich-local-state
panels") is **replaced** by three concrete conditions, any one of which
re-opens the decision via a fresh spike:

1. a third-party panel/plugin ecosystem becomes a real requirement;
2. a genuine virtualized large-list render need appears;
3. the invalidation-bug rate in dashboard edit mode measurably rises despite
   signals.

If re-opened, the candidate is **Preact** (`spike/preact-schema` stands as
evidence, +6.8 KB gzip), never React (+45 KB).

## Addendum — the workspace aggregate is the saved-query source of truth (#287, Dashboard v1 Phase 5)

Phase 5 made the persisted `StoredWorkspaceV1` aggregate (via the atomic
`WorkspaceRepository`, IndexedDB) the single source of truth for the saved-query
collection, retiring the flat `asb:saved` localStorage write path (read once only
as the legacy-migration source). This is a state-flow change worth recording
against this ADR because it re-shapes how `state.savedQueries` relates to
reactivity:

`StoredWorkspaceV2` and the collection repository introduced by #406 preserve
this projection/commit model per workspace; they replace only the fixed-current
record and V1 identity contract.

- `state.savedQueries` is now a **projection** of the committed workspace, not a
  directly-mutated array. Boot loads the aggregate and projects it (queries,
  Dashboard, workspace id/name); every file operation commits and re-projects
  through one shared `app.applyCommittedWorkspace` helper.
- All query CRUD is **strict async, validate-before-publish** (#280): each op
  computes a candidate, `await`s `WorkspaceRepository.commit` (which validates the
  whole candidate, then atomically replaces the record), and only then mutates
  in-memory state + tabs. A failed commit mutates nothing and keeps the draft
  dirty. The array is not a signal (it never was — see #276); the render surfaces
  repaint explicitly after a commit, exactly as the pre-#287 synchronous code did.
- Because commits are async, saved-query writes are **serialized** per app
  (`app.serializeWrite`) so two overlapping ops can't each build a candidate from
  the same stale snapshot and have the later commit resurrect a just-deleted query
  or clobber a concurrent edit. This is last-commit-wins within one tab; #280's
  multi-tab "last successful commit wins, no compare-and-swap" policy is unchanged.

No framework pull here: the change is about persistence atomicity and validation,
not a render model. The imperative-islands + signals-for-invalidation decision
stands.
