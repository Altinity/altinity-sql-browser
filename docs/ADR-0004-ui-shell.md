# ADR-0004: UI shell architecture — retain vanilla rendering, reject Preact

- **Status:** Accepted — Preact migration (#578) rejected; retain vanilla
  rendering; invest in shared shell primitives instead (#586, #587, #588, #589)
- **Date:** 2026-08-03 (evaluation ran 2026-07-30 – 2026-07-31)
- **Context tracking:** roadmap #68; #577 (evaluation issue this ADR closes
  out), #578 (migration umbrella, now moot), #487/#488 (the left-nav/right-
  inspector shell pressure that motivated the question)
- **Evidence:** three tagged, never-merged branches measured over one
  18-entry superset manifest — `eval-577/s0-baseline` (tag `577/baseline`,
  `d319847`), `eval-577/s1-control` (tag `577/control`, `7e7c8c4`),
  `eval-577/s2-treatment` (tag `577/treatment`, `3f611b5e`); PR #580 (closed,
  unmerged) carries the instrument and S0/S1 evidence on branch
  `docs/preact-shell-evaluation-577`, which also holds
  `docs/design/577/S2-EVIDENCE.md` and `docs/design/577/manifest-v2/`

## Context

The app is a framework-free ES-module SPA (ADR-0001): pure logic in
`src/core/`, `@preact/signals-core` for reactivity, and a hand-rolled
hyperscript render layer in `src/ui/`. #487 (left navigation) and the planned
#488 (right inspector) both hit the same pressure point: new shell features
need increasingly complicated lifecycle and focus coordination — visibility,
listener/effect/disposer ownership, mobile/rail/drawer projection, and focus
capture/restore across structural transitions that can remove the focused
element mid-gesture.

#577 asked the question directly: would replacing manually managed DOM
rendering with Preact make the composition layer *materially smaller and
simpler*, not merely reorganized? It fixed a decision principle up front —
adopt only if the completed migration reduces production UI code and lifecycle
complexity, not just relocates it — and required a representative vertical
slice (shell geometry, left-nav in all three presentations, a real fold
transition, a minimal right-inspector host, desktop/mobile projection, an
imperative CodeMirror-class boundary) rather than a toy comparison.

### The precommitted decision rule

Fixed **before** measuring, specifically to close off the failure mode where
ten unranked metrics let almost any outcome support either recommendation
(caught by both a `Plan` subagent and a ChatGPT plan-stage review):

> Adopt Preact only if S2 passes every behavioural and build gate AND shows
> clear dominance on both (a) net repo-owned production shell code, after
> counting adapters, and (b) lifecycle/focus ownership obligations *and*
> controlled change amplification — with no new unresolved browser-focus
> regression. **Any mixed result — including "smaller lifecycle surface but
> more production code" — is a RETAIN recommendation.**

## Decision

**Retain vanilla rendering. Reject the Preact migration** (#578 is closed as
moot; the umbrella never opens). Invest instead in a small set of shared
vanilla shell primitives that address the actual pressure — lifecycle,
focus-settlement, and panel-registration boilerplate — without a second
render paradigm:

- **#586** — one `SurfaceLifecycle` primitive plus a docked right-inspector
  slot (the mount/update/dispose contract #488 actually needs);
- **#587** — a side-panel registry, so adding a navigation panel is a
  one-file change instead of touching the shell in several places;
- **#588** — decompose the composition root (`src/ui/app.ts`, whose
  `createApp` spans ~3,000 lines) along four seams instead of one monolith;
- **#589** — extract the dashboard tile gesture controller and a pure
  repaint plan out of imperative event handlers.

`CLAUDE.md` hard rule 5 ("no UI framework; signals for state, imperative
adapters for islands") survives a full, adversarially-reviewed evaluation
intact. This supersedes ADR-0001's smaller `spike/preact-schema` datum
(one panel, +6.8 KB gzip, +36 LOC) with a whole-shell-scale measurement
reaching the same conclusion by a wider margin.

## Method

Three linear evaluation states, each a pushed branch plus an annotated tag,
**never merged** — S1→S2 is the only architectural comparison; S0 is the
shared ancestor and measurement instrument:

```
S0  eval-577/s0-baseline  (577/baseline,  d319847)   pristine main shell + measurement instrument
 └─ S1  eval-577/s1-control    (577/control,   7e7c8c4)    + vanilla right inspector
     └─ S2  eval-577/s2-treatment (577/treatment, 3f611b5e)   Preact owns shell presentation; app-shell.ts DELETED
```

- **S0** — baseline shell plus the measurement instrument itself (LOC
  counting, bundle-size, manifest tooling).
- **S1** — the *control*: a hand-built vanilla right-inspector (chevron,
  resize boundary, one mock tool) added the ordinary way, to establish what
  a #488-shaped feature costs under the current architecture. Deliberately
  not under-built — an anemic control biases the comparison toward "adopt."
- **S2** — the *treatment*: the same right-inspector-bearing slice
  reimplemented with Preact (`preact` + `@preact/signals`, `h()` not JSX —
  keeps files `.ts` and numbers comparable to ADR-0001's prior datum) owning
  shell presentation and lifecycle. `app-shell.ts` (905 lines), `left-rail.ts`,
  and `right-inspector.ts` are **deleted**, along with their 2,076 lines of
  tests.

All three states were re-measured together, from clean worktrees, at the
tagged SHAs, over **one 18-entry superset file manifest** (grown from an
initial 11 files specifically so the treatment's own new files are counted —
a manifest that omits a treatment's new files would report a deletion with no
matching cost). Code lines are esbuild-transformed source with comments
stripped and formatting normalized, not physical line counts: an early draft
nominated a physical-line target that a normal comment density beats while
containing *more* code, and this repository's comments carry institutional
review history that a smaller-by-omission arm would have silently discarded.

## Measurements

Lines are esbuild-transformed source (comments stripped), one shared manifest,
all three states in one run:

| | S0 | S1 | S2 | S1→S2 |
|---|---:|---:|---:|---:|
| plumbing (code lines) | 599 | 742 | **1072** | **+330** |
| domain (code lines) | 341 | 341 | 341 | **0** |
| island (code lines) | 199 | 203 | 203 | **0** |
| **total (code lines)** | **1139** | **1286** | **1616** | **+330** |
| artifact gzip (B) | 623,736 | 624,764 | 632,519 | **+7,755** |
| repo-owned bundle (B) | — | 631,633 | 635,169 | **+3,536** |

The control (S0→S1) itself already cost +147 code lines and +1.0 KB gzip for
a minimal inspector — the number S2 had to beat on the same feature. It did
not: **+330 lines is a +26% increase over the control**, not a reduction, and
repo-owned bundle bytes go *up*, not down. Domain and island line counts are
identical across all three states, so the preservation constraint (pure
reducers/registries untouched) held cleanly — the entire delta is shell
plumbing. Per-package attribution confirms exactly one `@preact/signals-core`
copy, and the S2 esbuild metafile's per-input listing proves the vanilla
shell is absent from the artifact, not shipped alongside it.

**Reading against the precommitted rule:** the code half of the rule
(dominance on net repo-owned production shell code) **fails outright**, not a
mix — +330 lines, +26% over the control, repo-owned bytes up 3,536. The rule
requires dominance on *both* halves; a clean failure on one is decisive on its
own. **Result: RETAIN.**

## Findings that must survive as lessons (condensed from `S2-EVIDENCE.md`)

- **DOM updates are asynchronous relative to state writes.** Eleven
  `app.test.ts` assertions needed an explicit flush, and one caller
  (`showHost`) needed a `flushSync` escape hatch (`options.debounceRendering`)
  because it reveals a host and then focuses inside it in the same tick.
  Any future boundary shaped like "mutate state, then act on the DOM in the
  same call" inherits this.
- **A defect class no existing gate can see.** Importing
  `@preact/signals-core` instead of `@preact/signals` leaves the reactivity
  bridge unwired: the shell renders once and never repaints again, while
  `tsc`, `check-boundaries`, and every pure-signal test stay green. Only
  rendering a real component catches it — a genuine footgun (two
  near-identically-named packages, one silently inert), not a property of the
  approach, and preventable with a lint rule if this were ever revisited.
- **Derived state has no edge.** A `computed` reports that a value *changed*,
  never that a gesture *ended*. `navMode` reaches its final value mid-drag,
  exactly where focus capture is gated off, so a completed commit produced no
  dependency change and a pointer drag-fold silently rescued no focus. Had to
  be re-attached by hand in the layout commit branch — component-model state
  didn't remove this category, it just moved where the fix lives.
- **`getSnapshotBeforeUpdate` (class components only) relocates the
  focus-capture/restore protocol rather than deleting it.** The evaluation's
  own working premise — "Preact has no before-the-DOM-changes hook" — is true
  only for function components; class components do get one
  (`preact/src/diff/index.js` calls it before `diffChildren`). The corrected
  reading is stronger evidence for RETAIN, not weaker: a capture hook exists,
  so the same recovery logic just moves into a lifecycle method under another
  name, rather than becoming unnecessary.
- **Genuine wins are real, and still small next to the cost.** A ~100-line
  paint function replacing four call sites, the rail's four effects plus one
  `dispose()`, a clean `renderActive()`, the session guard becoming plain
  data, no `untracked()` workaround, and one guard becoming structurally
  unreachable — all landed, all far outweighed by +330 lines and +7.7 KB
  gzip.
- **Two regressions were caught only by real-browser e2e, with 6,995 unit
  tests green:** a live width measurement silently became push-based and
  wrong; an intent-gated focus restore did nothing because a drag drops focus
  to `<body>` mid-gesture before any commit-time JS runs. Direct support for
  #577's insistence on exercising Chromium *and* WebKit, not unit coverage
  alone.

## Open caveats

1. **The superset manifest proves nothing was omitted; it does not prove no
   smaller Preact design exists.** `shell-host.ts` alone carries 636 of the
   1,072 plumbing lines and deliberately keeps nine bare `effect()` calls
   beside the component tree. The controlled-change experiment that would
   settle this by measurement (rather than assertion) was never run — listed
   below as future work only if the decision is ever reopened.
2. **The pinned numbers have no CI re-verification path.** The evaluation
   branches sit outside CI by design (they must never merge), so any future
   reviewer re-checking these figures has to reproduce the measurement by
   hand from the tagged SHAs.

## Historical note — #487 and the 2026-08-03 reset

#487's phases 1–3 (PRs #571, #573, #574 — left-nav layout core, the
nav-section registry, and the left-rail focused drawer) merged into `main`
during this evaluation window and were subsequently removed when `main` was
reset on 2026-08-03 to a pre-#487 baseline. The implementation is not lost:
it survives on branches `feat/left-nav-layout-core-487p1`,
`feat/nav-section-registry-487p2`, and `feat/left-rail-focused-drawer-487p3`.

**Salvage guidance:** the pure `core/left-nav-layout.ts` reducer and
resize-session model, and the `nav-sections.ts` registry decisions, are
proven — 100% covered, framework-independent, and unaffected by this ADR's
verdict. When #487 re-lands, cherry-pick/adapt those pieces rather than
re-deriving them from scratch.

## Consequences

- #578 (the phased Preact migration umbrella) is closed as moot; no
  application code migrates to Preact.
- `@preact/signals-core` remains the only reactivity primitive; no `preact`
  or `@preact/signals` dependency enters the production bundle. The bundled
  runtime dependency count stays at seven (CLAUDE.md rule 4).
- #487 and #488 proceed on vanilla rendering. Their focus-settlement
  semantics were the dominant cost driver surfaced by this evaluation (the
  capture/restore protocol, the derived-state-has-no-edge finding above), so
  the #487/#488 product contracts are being trimmed/simplified in the issue
  bodies in parallel with this ADR rather than solved by a framework.
- The forward investment is #586 (`SurfaceLifecycle` + docked right-inspector
  slot), #587 (side-panel registry), #588 (composition-root decomposition
  along four seams), and #589 (dashboard gesture/repaint extraction) — shared
  vanilla primitives targeted at the actual pain (lifecycle, focus, panel
  registration) instead of a second render paradigm.
- Re-open this decision only under the same conditions ADR-0001 already
  names (a third-party plugin ecosystem requirement, a genuine virtualized
  large-list need, or measurably rising invalidation-bug rate despite
  signals) — this evaluation adds no new trigger, it confirms the existing
  ones haven't fired.
