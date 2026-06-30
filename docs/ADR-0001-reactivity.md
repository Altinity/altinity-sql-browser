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
with zero third-party requests (CLAUDE.md rule 4 — deliberate deps only), the
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
is a deliberate dependency; it is still inlined, so the artifact makes zero
third-party requests.

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
