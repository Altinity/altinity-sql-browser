# Decisions and roadmap

Back to [[Home]]. Related: [[Architecture]], [[Development-Workflow]].

## Settled decisions

- Incrementally use `@preact/signals-core`; do not introduce a UI framework.
  **Reaffirmed 2026-08-03** by ADR-0004: a whole-shell-scale Preact migration
  evaluation (#577) was measured and rejected — see below.
- Keep CodeMirror 6 behind `EditorPort` and never run SQL on the keystroke path.
- Keep complex/high-frequency UI islands imperative behind injected seams.
- Extract a shared UI primitive when a second real consumer appears, not before.
- Keep the product a single esbuild artifact with zero third-party requests.
- Use comment-wrapped optional SQL blocks (`/*[ ... ]*/`) for empty-means-no-filter;
  the earlier double-square-bracket form conflicted with ClickHouse array syntax.
- The panel configuration registry is the common model for chart/table/logs/KPI/
  filter/text views and library persistence.
- **Contracts specify final-state invariants**, not frame-by-frame gesture
  behavior, unless a user-visible bug forces otherwise — the retrospective
  lesson of ADR-0004 (see below), now also a `CLAUDE.md` Working-discipline rule.

## ADR-0004: the Preact evaluation (#577) — retain vanilla, reject the migration

`#487` (left navigation) and `#488` (right inspector) both pushed on the same
pressure point: increasingly complicated lifecycle/focus coordination in the
hand-rolled `src/ui/` render layer. `#577` asked, with a decision rule fixed
*before* measuring, whether replacing it with Preact would make the shell
materially smaller and simpler. Three tagged, never-merged branches (S0
baseline, S1 vanilla control, S2 Preact treatment — tags `577/baseline`,
`577/control`, `577/treatment`; evidence archived on branch
`docs/preact-shell-evaluation-577`, closed PR #580) were measured together over
one 18-entry file manifest.

**Result (2026-08-03): RETAIN vanilla rendering, REJECT the migration.** The
treatment cost +330 shell-plumbing code lines (+26% over the control) and
+7,755 B gzip, with domain/island line counts unchanged across all three
states — a clean failure of the precommitted code-dominance rule. `#578` (the
phased migration umbrella) closed as **not planned**; the investment redirects
to shared *vanilla* shell primitives instead:

- **#586** — one `SurfaceLifecycle` primitive + a docked right-inspector slot
  (the mount/update/dispose contract #488 needs).
- **#587** — a side-panel registry, so a new navigation panel is a one-file
  change.
- **#588** — decompose the composition root (`src/ui/app.ts`, `createApp`
  spans ~3,000 lines) along four seams.
- **#589** — extract the dashboard tile gesture controller and a pure repaint
  plan out of imperative handlers.

Full method, measurements, and retrospective lessons (async DOM-vs-state
writes, a silent-dead-reactivity footgun from importing the wrong signals
package, derived state having no "gesture ended" edge, two regressions e2e
caught that 6,995 green unit tests missed): canonical source
[`docs/ADR-0004-ui-shell.md`](../docs/ADR-0004-ui-shell.md).

## The 2026-08-03 main reset — #487 phases 1–3

`#487`'s phases 1–3 — PRs **#571** (left-nav layout core), **#573** (nav-section
registry), **#574** (left-rail focused drawer) — **merged into `main`** on
2026-07-29/30 and show as MERGED on GitHub, but `main` was **reset on
2026-08-03 to a pre-#487 baseline** during the #577 evaluation window. That
code is **not on `main` today**, but it is not lost — it survives, unmerged,
on:

- `feat/left-nav-layout-core-487p1` — pure `core/left-nav-layout.ts` reducer,
  three-layout resize session.
- `feat/nav-section-registry-487p2` — registry decisions (icon-as-factory,
  separate `accessibleLabel`, pane-scoped `showSection`, load-boundary key
  bridge), now being adapted by #587.
- `feat/left-rail-focused-drawer-487p3` — rail/focused-drawer geometry, 180px
  drawer floor, per-section filters.

`#487`'s and `#488`'s issue bodies were rewritten 2026-08-03: the frame-level
focus contract was trimmed to final-state rules, and implementation is now
routed through #586/#587 rather than re-derived independently. Before
resuming #487/#488 work, salvage the branches above rather than re-deriving
proven pure-logic/geometry work; do not assume "merged PR" on GitHub means
"present on `main`" for anything from this window without checking.

## Forward work

Two roadmap tracks are current:

- **V1 roadmap — GitHub issue #68** ("Roadmap to 1.0.0") — the original
  structured feature-issue roadmap; still authoritative for V1-scoped work not
  superseded by V2. Historical Phase 7 ordering recorded here at wiki creation
  (2026-07-12) was #173 → #165 → #170 → #169 → #171/#172, with dashboard filter
  panel work tied to #166 and #160 — re-verify current state on GitHub rather
  than trusting this order today.
- **V2 roadmap — GitHub issue #582** ("Roadmap to V2 (professional UI
  redesign)") — scoped 2026-07-31; supersedes #68 for V2-scoped surfaces only
  (most V1 functionality carries over unchanged). Companion working document:
  [`docs/V2-UX-HANDOVER.md`](../docs/V2-UX-HANDOVER.md), a shipped-UX +
  committed-product-contract inventory for handoff to the redesign.
- **Refactor/umbrella track — #593** ("Umbrella: V2 architecture refactor —
  shell primitives, composition root, state reactivity, transport adapter")
  sequences the ADR-0004 follow-through into one ordered `/ship` execution
  plan, one PR per phase with a human merge gate between phases: Phase 1
  #586 (`SurfaceLifecycle` + docked right-inspector slot, unblocks #488),
  Phase 2 #587 (side-panel registry, unblocks #487, salvages
  `feat/nav-section-registry-487p2`/PR #573), Phase 3 #591 (fail-closed
  decoders for persisted domain records — independent early win), Phase 4
  #588 (composition-root decomposition), Phase 5 #589 (dashboard gesture/
  repaint extraction), Phase 6 #590 (reactive workspace aggregate, retires
  `dashboardTreeRevision`, sequenced after #588), Phase 7 #585/ADR-0005
  (`@clickhouse/client-web` transport spike — independent of the shell
  track; a "Rejected" outcome still completes the phase). #592 (extend
  `check-boundaries` to lock in the shell primitives) is a guardrail issue
  alongside the phases. All are labeled `refactor`; re-check
  `gh issue list --label refactor` for the current phase status before
  planning shell work.
- **#585 / ADR-0005** — adopt `@clickhouse/client-web` behind the SQL Browser
  transport adapter; Phase 7 of the #593 umbrella above.

Re-read GitHub before acting because issue state can change; a MERGED PR is
not proof its code is on `main` (see the reset above).

Canonical decision records: [`docs/ADR-0001-reactivity.md`](../docs/ADR-0001-reactivity.md),
[`docs/ADR-0004-ui-shell.md`](../docs/ADR-0004-ui-shell.md). Historical roadmap
context is summarized in [[Operations-Memory]].
