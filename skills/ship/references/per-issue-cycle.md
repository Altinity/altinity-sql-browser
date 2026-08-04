# The per-issue cycle — steps 2–5

Steps 2–5 of `/ship`. This is the **single source of truth** for how one unit of work
(a whole issue, or one phase of one) gets built. The attended flow follows it directly;
unattended workers are held to it verbatim. Change it here, never in a copy.

Where this file says "the unit", read the delivery contract assembled in step 1: the
implement list, the per-phase `## Tests` subsection, the acceptance gate, and the named
subset of global acceptance criteria. `references/repo-footguns.md` applies throughout.

## 2 — Plan

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

`STOP` — if the unit is ambiguous, under-specified, or needs a decision not already
recorded (issue body / ADRs / CLAUDE.md), stop and ask. This is a settled-architecture
project — don't invent decisions. (Unattended: skip the unit and report the missing
decision instead.)

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

### Plan review budget

Do not stack overlapping plan reviews.

- **Low:** none.
- **Medium:** none by default; one only when the architecture remains genuinely
  uncertain after writing the plan.
- **High:** exactly one independent plan review. Choose **one**:
  1. a read-only internal `Plan` agent (boundary stated), or
  2. `chatgpt-review` in plan mode: write the complete plan to a file under the
     approved temporary directory, the contract/acceptance subset/focused questions to
     a context file, then
     `node skills/chatgpt-review/scripts/chatgpt-review.mjs plan <plan-file> --question-file <context-file>`.
     It uploads exactly the plan file and cannot request a GitHub write, so a worker
     may run it directly even in unattended mode.

  Prefer ChatGPT plan review for especially uncertain, externally constrained, or
  unattended work; prefer the internal Plan agent when repository context suffices.
  Verify every substantive claim against the real repo before folding it in.

For attended high-risk work, `STOP`: post the revised plan and wait for approval
(reviewed on mobile — keep it self-contained).

## 3 — Implement (inner loop)

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

## 4 — Author-side readiness review

Internal review prepares the PR for external review. It is not a ritual and must not
duplicate the ChatGPT review.

### Readiness checklist

Before opening a PR, verify:

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

## 5 — Reconcile (before the PR — and before certification)

Every commit this step produces must land **now**: a post-certification commit voids
the exact-head review and burns another pass.

- Update `CHANGELOG.md` under `[Unreleased]` when required.
- Update the relevant ADR addendum for architecture changes.
- Reconcile the issue's Goal/Acceptance text when implementation deliberately changed it.
- Close or reconcile superseded issues — when the unit that owns that result lands, not
  merely because it's the last to run.
- Out-of-scope bug or footgun spotted → a **separate** issue labelled `inbox`
  (file:line + why deferred); never fold it into this PR.

### The ship log — write it BEFORE the approval/merge stage

For a multi-phase issue this is the **handoff**, not bookkeeping. The next phase runs
in a cleared session that knows nothing about this one — decisions taken under
ambiguity, deviations, why a test is shaped the way it is. If that only lives in the
conversation, `/clear` destroys it and the next phase re-derives it wrong.

Maintain exactly one comment on the issue, in this format:

```markdown
<!-- ship-log -->
## Ship log — #<ISSUE>

Branch model: one PR per phase off `main`   <!-- or: single integration branch -->

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
