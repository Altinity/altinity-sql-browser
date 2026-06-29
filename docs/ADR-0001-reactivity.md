# ADR-0001: Reactivity — incremental signals, not a framework

- **Status:** Proposed
- **Date:** 2026-06-29
- **Context tracking:** roadmap #68
- **Evidence:** branch `spike/signals` (primitive + two converted slices)

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
with zero third-party requests (CLAUDE.md rule 4 — deliberate deps only), the
per-file 100/100/100/100 coverage gate (rule 1), and the injected-seam layering
(rule 2).

## Decision

Adopt a **~70-line in-house reactive primitive** (`src/core/signal.js`:
`signal()` / `effect()` / `batch()`) and migrate state **one slice at a time**,
behind accessor helpers. **Do not** adopt a UI framework (React/Preact/Solid).

## Options considered

| Option | gzip cost | Verdict |
|---|---|---|
| **In-house `signal`/`effect`** | ~0.45 KB (measured) | **Chosen** — retires manual invalidation; zero deps; proven 100%-coverable |
| Preact + @preact/signals | ~7.3 KB (measured, `spike/preact`) | Rejected for now — only added value over the primitive is auto DOM-diffing of large lists, which we don't need |
| Solid.js | ~7 KB | Rejected — compiler/plugin + ecosystem cost; same "big-list" benefit we don't need |
| React (proper) | ~45 KB | Rejected — heaviest dep, vDOM-on-big-tables liability, mismatch with the single-file ethos |

Decisive factor: we do **not** need a virtualized / large-list renderer (no
10k-row grid requirement), which is the one thing a vDOM framework buys over the
primitive. The pain is invalidation, which the primitive solves directly.

## Evidence (spike)

Two slices converted end-to-end with the full suite + coverage gate green
(1033 tests; `signal.js` 100/100/100/100; real `npm run build` succeeds):

- **tabs** (`tabs` + `activeTabId`) — *has* an `activeTab()` accessor → 16 callers
  insulated; low mechanical churn, but one behavioral test relocation (the
  repaint responsibility moved from `tabs.js` to a `createApp()` effect).
- **sidePanel** — *no* accessor → every reader changed, but the churn was purely
  mechanical `.value` and concentrated in the panel's own test file; no assertion
  rewrites.

Cumulative spike cost: 12 files, +432/−142, most of which is the reusable
primitive (95) + its tests (178).

## Consequences

- Mutating a converted slice is just `state.x.value = …`; an `effect()` repaints.
  Manual `refresh()` lists are deleted.
- **Migration is monotonic**: a slice keeps some direct render calls until its
  co-dependent slices are also signals. No slice un-converts another.
- Per-slice cost is mostly mechanical `.value` edits in that slice's tests.
- **Rule:** give each converted slice an accessor helper (like `activeTab()`) to
  contain reader churn and localize behavior.
- Re-evaluate Preact/Solid only if the UI later grows many interdependent
  components with rich local state, or a genuine large-list render need appears.
