# #577 state S2 — the Preact treatment arm, measured

Evidence only. This document records what was built, what it cost, and what
broke; it does **not** state the recommendation, which ADR-0004 owns once the
parity suite and the controlled-change experiment exist.

- **Arm:** `eval-577/s2-treatment`, tag `577/treatment`, commit `3f611b5e`.
- **Control:** `eval-577/s1-control`, tag `577/control`, commit `7e7c8c4b`.
- **Baseline:** `eval-577/s0-baseline`, tag `577/baseline`, commit `d3198478`.
- Neither evaluation branch is merged. They are retained as reproducible
  evidence under acceptance criterion 7 as amended 2026-07-30.

## How to reproduce

All three states were measured in one run, from **clean worktrees at their
tagged SHAs**, over the **same 18-entry manifest**
(`manifest-v2/canonical-manifest.json`). A dirty tree changes the artifact by
exactly 6 bytes (`build/build.mjs`'s `-dirty` stamp), so a measurement from a
working tree is not reproducible from the recorded commit.

```sh
git worktree add --detach <dir> 577/treatment
ln -s <repo>/node_modules <dir>/node_modules
cd <dir>
node build/ui-complexity-report.mjs --manifest <manifest-v2> --out <out> --label s2
node build/size-report.mjs --out <out>
```

The manifest is a **superset**: the seven `src/ui/shell/*` files report `absent`
for S0 and S1, and `app-shell.ts` / `left-rail.ts` / `right-inspector.ts` report
`absent` for S2. Measuring the treatment over a manifest that omitted its own
new files would report a deletion with no matching cost, so the same file set is
run against every state.

The original 11-file reports in `s0/` and `s1/` are unchanged and still pinned;
`manifest-v2/` supersedes them only for cross-state comparison.

## Results

Code lines are esbuild-normalized — comments stripped, formatting normalized —
because this repo's comment density is institutional review history, not
complexity, and counting raw text credits it as if it were.

| | S0 baseline | S1 control | S2 treatment | S1 → S2 |
|---|---:|---:|---:|---:|
| code lines — plumbing | 599 | 742 | **1072** | **+330** |
| code lines — domain | 341 | 341 | 341 | **0** |
| code lines — island | 199 | 203 | 203 | **0** |
| **code lines — total** | **1139** | **1286** | **1616** | **+330** |
| artifact raw B | 2 126 521 | 2 130 619 | 2 149 976 | +19 357 |
| artifact gzip B | 623 736 | 624 764 | 632 519 | **+7 755** |
| artifact brotli B | 527 859 | 528 556 | 535 612 | +7 056 |
| repo-owned bytes in bundle | — | 631 633 | 635 169 | **+3 536** |

**Domain and island lines are identical across all three states.** That is the
preservation constraint holding: the treatment changed no proven non-rendering
logic, and it did not claim a reduction in code that stays imperative under any
render model.

### What the +7.8 KB gzip is made of

Per-package attribution from the esbuild metafile:

| package | S1 | S2 |
|---|---:|---:|
| `preact` | absent | 12 519 B |
| `@preact/signals` | absent | 3 140 B |
| `@preact/signals-core` | 4 713 B | 4 749 B |

**Exactly one copy of `@preact/signals-core`** — the single-copy requirement is
proven by attribution, not assumed. The Preact bindings re-export the same
primitives over that one copy.

The repo's **own** bytes in the artifact went **up** by 3 536 B. Deleting a
905-line module did not shrink the shipped application.

### The deletion is real

`manifest-v2/s2/esbuild-inputs.json` is the per-input attribution for the S2
artifact. It contains **no** `app-shell.ts`, `left-rail.ts` or
`right-inspector.ts`, and all six `src/ui/shell/*` modules. The vanilla shell
was deleted, not shipped alongside the Preact one.

### A measurement correction worth recording

S1's brotli figure here (528 556) differs from the 528 747 pinned earlier, while
its raw and gzip figures match **exactly**. Identical raw and gzip prove the
artifact bytes are identical; brotli output is not stable across Node versions.
Re-measuring all three states in one run on one Node version is what makes the
brotli column internally comparable — and is why the earlier figure should not
be differenced against this one.

## What the treatment cost

Costs the control does not pay, each found while building:

1. **DOM updates became asynchronous relative to state writes.** Eleven
   assertions in `tests/unit/app.test.ts` needed an explicit flush. Not a test
   artifact: any code that writes state and then reads the DOM is affected.
2. **`showHost` needed a synchronous escape hatch.** Callers reveal a host and
   then act inside it — `app.showQuerySurface()` immediately focuses the SQL
   editor — and a deferred render left the editor unfocusable because its host
   was still `hidden`. Fixed with a `flushSync` built on
   `options.debounceRendering`. Every future boundary of that shape must
   remember it.
3. **A defect class with no gate coverage.** Importing `@preact/signals-core`
   instead of `@preact/signals` leaves the reactivity bridge unwired: the shell
   renders once and never repaints. `tsc`, `check-boundaries` and every
   pure-signal test stayed green. Only rendering a real component caught it. The
   imperative arm cannot have this failure mode — there is no bridge.
4. **Derived state has no EDGE.** A `computed` reports that a *value* changed; it
   cannot report that a *gesture ended*. `navMode` reaches its final value
   mid-drag, while focus capture is correctly gated off — so the commit produced
   no dependency change and a pointer drag-fold silently rescued no focus. The
   commit had to be re-attached by hand. The control has no equivalent hazard:
   its rescue lives in the paint function every trigger calls.
5. **`drawer.ts`'s `attachDrawerResize` is not reusable** — it appends its handle
   into the panel, which would put two owners on one subtree. The inspector
   re-implements the drag. The control's reuse of that primitive was part of why
   it stayed small.
6. **Foreign DOM cannot carry a Preact prop.** A `.ri-tool-slot` wrapper plus a
   CSS rule per preserved-but-hidden child, and the two vanilla-repainted
   switcher rows keep their `hidden` writes as an effect.
7. **Read placement became a performance-correctness rule.** Over 200 simulated
   drag frames: the layout signal read by a leaf → root re-runs **1×**; the same
   read moved to the root → root and rail re-run **201×**.
8. **`widthRevision`.** `sidebarPx`/`leftNavDrawerPx` are plain fields, so a
   width-only commit changes nothing a `computed` observes. Kept inside a
   measured file rather than `state.ts` so the cost is counted.
9. **Stale cross-references.** Ten-plus `domain` and `island` files still name
   `app-shell.ts` in comments. They are deliberately not edited — a diff in a
   domain file is a finding against the preservation constraint — so the arm
   ships with dangling prose it is not allowed to fix.

## What the treatment genuinely improved

- `applyEffectiveLeftNavigationLayout` (~100 lines) and its four call sites are
  gone; presentation is an expression of one `computed`.
- The rail's four per-button `effect()`s and its whole `dispose()` are gone.
- The inspector's `renderActive()` is gone — "exactly one tool exposed" is
  structural.
- The `isSessionActive()` guard every non-gesture trigger had to remember
  becomes the shape of the data (`dragLayout` non-null).
- The `untracked()` workaround (12 lines of comment in the control) is
  unnecessary: a derivation with no side effects cannot widen its dependencies.
- Focus **capture** collapses from four inline sites to one effect plus the
  commit re-attachment.
- One defensive guard becomes structurally **unreachable**: a focused drawer is
  derived from a non-null section, so mode and section cannot disagree. The
  control needed a real check because its mode lived in a DOM attribute.
- The inspector's mobile projection is genuinely reactive. The control samples
  `isMobile` once at mount and is therefore **stale** after a breakpoint
  crossing — a latent control defect, left unfixed because the control is frozen,
  and explicitly **not** counted as a treatment line saving.

## The weak premise, tested

> "One owner per subtree deletes the focus-rescue category."

**Refuted.** Preact offers no before-the-DOM-changes hook — `useLayoutEffect`
cleanups run after the diff — so capture cannot happen at paint time at all. The
work survives in full; only its location moves, and finding 4 above shows the
relocation introduced a failure the control does not have.

## Deviation from the plan

The ship log's next-step wording said to delete "the geometry half of
`left-nav-separator.ts`". **Not done, deliberately.** The canonical manifest
classifies that file as an **island** because "only its thin ARIA/paint glue is
plumbing, and that is not separable at file granularity", and hard rule 5 keeps
high-frequency pointer surfaces imperative. Splitting it would have handed the
treatment a line reduction it did not earn and put two writers on the same ARIA
attributes. The island's 203 lines are identical in S1 and S2, which is the
check that this deviation cost the treatment nothing it was owed.

## Browser evidence

Chromium and WebKit, full suite: **417 passed**. Two `tile-open-workbench`
specs (`:327`, `:453`) fail on both engines, and fail **identically on
`eval-577/s1-control` from a clean worktree** — so they do not differentiate the
arms and are not scored against either.

They are **not** pre-existing, and the first version of this document was wrong
to imply it. `origin/main` passes all 21 specs in that file from a clean
worktree. The failures are introduced by the **S1 control's own inspector**: it
defaults to `inspectorPx` 420 (`state.ts`), so it occupies 420px as the last
child of `.main-row`, narrowing the Dashboard grid enough to break two tile
geometry assertions. S2 inherits the same pane and the same failures.

That makes them a cost of the evaluation **slice**, not of either architecture —
a mock pane added for the comparison perturbing unrelated layout assertions. It
is worth recording for two reasons: the slice's own side effects are exactly the
kind of thing that quietly contaminates a comparison, and #577's gate wording
("passes every behavioural gate") is not cleanly met by *either* arm here.

Checking this mattered twice over: an earlier S2 run failed a *different* subset
of the same file, so it is partly order-dependent, and reading any single run as
a verdict — without both the control and `main` as baselines — would have been
wrong in both directions.

Two genuine regressions were found by real-browser e2e **with 6 995 unit tests
green**, and both are fixed:

- a live width measurement silently became push-based, so a viewport-clamped
  420px preference rendered at its full 420 instead of 313;
- an intent-gated focus restore did nothing, because a pointer drag drops the
  focused descendant to `<body>` on an intermediate `mousemove` frame, long
  before any commit-time code runs.

This is direct support for #577's insistence that the comparison be exercised in
real browsers rather than in happy-dom alone.

## Still outstanding before ADR-0004

- the arm-agnostic parity suite (normalized subtree serialization, parametrized
  over both states, pinned assertion count);
- the controlled-change experiment;
- the whole-slice JSX sensitivity annex.

## Reading against the precommitted rule

The rule was fixed **before** any measurement and is reproduced verbatim in the
ship log. It requires, for adoption, clear dominance on **both** (a) net
repo-owned production shell code after counting adapters, and (b) lifecycle and
focus ownership obligations *and* controlled change amplification — and states
that **any** mixed result is a RETAIN recommendation.

On (a) the treatment is **+330 code lines (+26% over the control)** and **+3 536
repo-owned bytes** in the artifact. That is not a reduction, so (a) fails
outright rather than mixing. (b) is not yet complete — the controlled-change
experiment has not run — but it cannot rescue (a) under a rule that requires
dominance on both.

ADR-0004 records the recommendation. This document records only the numbers and
what produced them.
