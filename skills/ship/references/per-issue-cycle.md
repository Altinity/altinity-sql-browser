# The per-unit cycle

The **single source of truth** for how one unit of work (a whole issue, or one phase of
one) gets built. Workers are held to it verbatim; the coordinator flow that wraps it —
worker spawning, both ChatGPT review loops, integration, and the merge gate — is
`SKILL.md`. Change it here, never in a copy.

Where this file says "the unit", read the delivery contract assembled in `SKILL.md`
step 1: the implement list, the per-phase `## Tests` subsection, the acceptance gate,
and the named subset of global acceptance criteria. `references/repo-footguns.md`
applies throughout.

## 1 — Plan

**Always write the plan — nothing skips this, however small or well-specified.**
Produce it before touching code. State:

- **criteria claimed and deferred**: which global acceptance bullets this unit claims
  and which it explicitly defers — this is what stops a phase from quietly
  under-delivering;
- **files and subsystem boundaries** — pure logic → `src/core/`, render → `src/ui/`;
  any library/DOM call behind an injected seam per hard rules 2/4/5;
- **production entrypoints and state transitions** the change flows through;
- **tests mapped to contract items**;
- **migration order** — for a subtractive unit, what gets deleted before what gets built;
- **rollback / revert concerns**;
- **risk classification** (below);
- **invariant map** for medium- and high-risk work (below).

If the unit is ambiguous, under-specified, or needs a decision not already recorded
(issue body / ADRs / CLAUDE.md), do not invent one — return the missing decision
instead of a plan; the coordinator skips the unit and reports it. This is a
settled-architecture project.

### Risk classification

**Low:** local behavior, small footprint; no persistence, compatibility, security,
lifecycle, ordering, schema, or public-contract change.

**Medium:** cooperating modules, UI state or lifecycle, accessibility, persistence
without migration, shared API/type changes, or non-trivial fixture/e2e impact.

**High:** auth or trust boundary, persistence migration, destructive replacement,
dependency/framework swap, complex ordering/concurrency/cancellation/rollback, large
cross-cutting refactor, or under-determined architecture.

### Invariant map

For medium- and high-risk work, include:

```markdown
| Invariant | Production enforcement | Test or compile-time proof | Sabotage case |
|---|---|---|---|
| ... | ... | ... | ... |
```

Cover the relevant properties:

- authority and ownership
- exhaustiveness and uniqueness
- ordering and lifecycle transitions
- construction and composition
- persistence encoding, decoding, reversibility, downgrade compatibility
- error, failure, cancellation, cleanup, disposal
- accessibility semantics

**Every claimed invariant must name its enforcement mechanism.** Never write "single
source of truth", "exhaustive", "never", or "exactly once" without showing how it is
enforced — a claim without enforcement is exactly what review rounds later discover as
a defect, one relocation at a time.

### Plan review

Every plan — regardless of risk — goes through the selected plan Workflow (`SKILL.md`
step 2.2, `references/review-loops.md`, max 5 review passes). In the default mode a
Fable/high planner writes and revises while ChatGPT reviews. With `--planner chatgpt`,
ChatGPT writes and revises while Fable/high approves. The worker's part in default mode:

- write the plan to the exact file path the coordinator assigned, and return it —
  self-contained, because the loop's revise agent (not you) folds review findings into
  that file in place;
- when told the plan is approved, **re-read the plan file before implementing** — it
  supersedes what you wrote;
- never invoke `chatgpt-review` yourself, and write no code before the coordinator
  reports the plan approved.

In ChatGPT mode the author workflow fulfills the first bullet. The fresh implementation
worker still re-reads the approved canonical plan and observes the same no-code-before-
approval and no-`chatgpt-review` boundaries.

## 2 — Implement (inner loop)

Write the code **and its tests in the same change** (hard rule 1).

- Keep pure logic in `src/core/` at 100%; DOM/rendering in `src/ui/`; external
  libraries, DOM dependencies, and high-frequency input behind injected seams.
- Update every real fixture affected by an App or module-shape change. Do not preserve
  obsolete behavior merely to keep old fixtures green — softening an explicit issue
  rule to keep fixtures passing is a defect, not a fix; re-fixture the tests.

### The local gate

`.npmrc` in this environment sets `ignore-scripts=true`, so `pretest`/`prebuild`
**never run: a green `npm test` alone is NOT the gate.** Run the full gate explicitly,
captured to a file, and loop until green:

```sh
{ npm run check:types && npm run check:arch \
  && npm run check:schemas && npm run check:examples \
  && npm test && npm run build; } > "$TMPDIR/gate.log" 2>&1
```

Use `npm test`, never raw `npx vitest` (see footguns for why, and for the single-file
variant). Never proceed on a red suite or a broken build.

Run `npm run test:e2e` for UI-visible behavior, layout/CSS, browser APIs, IndexedDB,
clipboard, raw-ESM harness changes, or dependency changes affecting e2e fixtures —
Chromium and WebKit locally; CI supplies Firefox (footguns: browsers, import maps,
`__app` fixtures). For layout-sensitive work, verify the real application — happy-dom
cannot see layout.

### Sabotage checks

For each medium- or high-risk invariant, perform at least one mutation that must fail
compilation, construction, or tests — the invariant map's fourth column. Examples:

- omit a required registration
- duplicate an identifier or persisted key
- reverse a lifecycle order
- use an unknown persisted value
- remove a host from production composition
- alter an accessibility attribute so the computed name changes
- replace a derived type with a hand-written union

A sabotage that everything survives means the invariant is unenforced — fix the
enforcement, not the test. Restore sabotaged uncommitted files from saved bytes, never
with `git checkout --` (it deletes uncommitted fixes).

## 3 — Author-side readiness review

Internal review prepares the branch for external review. It is not a ritual and must
not duplicate the ChatGPT code review.

### Readiness checklist

Before handing the unit back, verify:

1. Every contract item maps to code or a test.
2. Every invariant has enforcement and a sabotage case.
3. Tests exercise the real production path, not only injected seams.
4. Moved responsibility was removed from its former owner.
5. New responsibility is composed, registered, activated, refreshed, and disposed
   where relevant.
6. Tests do not merely compare values derived from the same source.
7. Compatibility mappings round-trip where required.
8. Accessible names and dynamic content are tested as the browser exposes them.
9. Comments explain stable reasons, not review chronology.
10. The full local gate and relevant e2e are green.

### Internal review budget

- **Low:** no review subagent.
- **Medium:** at most one targeted read-only review, only when uncertainty remains.
- **High:** exactly one targeted read-only review.
- **Security-sensitive** (auth / OAuth / `config.json`): add one focused pass with the
  `security-review` skill.

Do not run a generic code review plus a multi-agent review over the same diff.

Reviewer prompt:

```text
Review the complete branch against the delivery contract and invariant map.

Concentrate on:
1. Walk changed behavior through the real production path, not only test seams.
2. Find responsibilities moved but not removed from the previous owner.
3. Challenge claims of authority, exhaustiveness, uniqueness, ordering,
   reversibility, and exactly-once lifecycle behavior.
4. Find tests that compare values derived from the same source and cannot
   detect drift.
5. Check whether each fix removes the defect or merely relocates it.
6. Check compatibility, accessibility, cancellation, cleanup, and error paths.
7. Report only concrete actionable issues.

Read-only. Do not edit files or mutate git, GitHub, tasks, or memory.
```

Apply confirmed findings and rerun the affected gates.

### Root-cause circuit breaker

When a finding exposes a **missing invariant** rather than an isolated bug:

1. Stop local patching.
2. Add the invariant to the invariant map.
3. Identify every production location relying on it.
4. Choose structural enforcement: type, exhaustive map, constructor validation,
   runtime guard, derivation, or integration test.
5. Add a sabotage case reproducing the omission.
6. Reassess the whole branch for equivalent forms.

If two review rounds find variants of one root cause, revise the invariant map before
writing another fix. Fixes that relocate a defect are how a one-pass review becomes
four.

## 4 — Reconcile (before the PR — and before certification)

Every commit this step produces must land **before the PR is certified**: a
post-certification commit voids the exact-head review and burns another pass.

- Update `CHANGELOG.md` under `[Unreleased]` when required (the worker writes its own
  unit's entry; the coordinator dedupes across units).
- Update the relevant ADR addendum for architecture changes.
- Reconcile the issue's Goal/Acceptance text when implementation deliberately changed it.
- Close or reconcile superseded issues — when the unit that owns that result lands, not
  merely because it's the last to run.
- Out-of-scope bug or footgun spotted → a **separate** issue labelled `inbox`
  (file:line + why deferred); never fold it into this PR.

### The ship log — coordinator-owned, written before the PR

Workers never touch it. For a multi-phase issue this is the **handoff**, not
bookkeeping: later units run in fresh worker contexts that know nothing about this one
— decisions taken under ambiguity, deviations, why a test is shaped the way it is. If
that only lives in a conversation, it is lost and the next unit re-derives it wrong.

Maintain exactly one comment on the issue, in this format:

```markdown
<!-- ship-log -->
## Ship log — #<ISSUE>

| Phase | Status | PR |
|---|---|---|
| 1 — Hard removal and Variables foundation | shipped | #452 |
| 2 — Controls and batched option execution | in review | #455 |
| 3 — Assignment, examples, integration | blocked on #428 | — |

### Phase 1 — handoff
- **Landed:** …
- **Decisions taken** (not in the issue): …
- **Deviations from the spec** and why: …
- **Deferred acceptance criteria:** bullets 5, 6, 9 → phase 2
- **Follow-ups filed:** #453 (`inbox`)
- **Plan review:** approved on pass <n>, conversation <url>
- **Review outcome:** certified head <sha> / findings accepted-rejected-unresolved
```

Status vocabulary: `shipped` (PR merged and verified on `origin/main`), `in review`
(PR open), `blocked on #N`, `skipped — <reason>`, `—` (not started). The run that
opens a PR writes `in review`; only a verified merge flips it to `shipped`.

Append a handoff block per phase; keep prior blocks. Write the body to a file:

```sh
# create (no existing log)
gh api repos/{owner}/{repo}/issues/<ISSUE>/comments -F body=@"$TMPDIR/ship-log.md"

# update (id from the step-1 lookup)
gh api -X PATCH repos/{owner}/{repo}/issues/comments/<ID> -F body=@"$TMPDIR/ship-log.md"
```

If the issue also carries a `## Phases` checklist, tick this phase's row in the same
reconcile step. The checklist is a convenience view; **the log comment is the state of
record.**
