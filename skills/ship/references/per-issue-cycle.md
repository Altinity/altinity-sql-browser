# The per-issue cycle — steps 2–5

Steps 2–5 of `/ship`. This is the **single source of truth** for how one unit of work
(a whole issue, or one phase of one) gets built. The attended flow follows it directly;
unattended workers are held to it verbatim. Change it here, never in a copy.

Where this file says "the phase", read "the issue" for a single-phase issue. Its scope is the
**phase contract** assembled in step 1 — the phase's implement list, its `## Tests`
subsection, its acceptance gate, and the named subset of global acceptance criteria.

## 2 — Plan

**Always write the plan — nothing skips this, however small or well-specified.** Produce it
before touching code. State:

- **the acceptance subset**: which global `## Acceptance criteria` bullets this phase claims,
  and which it explicitly defers to a later phase. This is what stops a phase from quietly
  under-delivering;
- **files to touch** — pure logic → `src/core/`, render → `src/ui/`; any library/DOM call
  behind an **injected seam** per hard rules 2/4/5;
- **the test files** you'll add or extend, mapped to the phase's test list;
- **the migration order**, and for a subtractive phase, what gets deleted before what gets
  built.

🛑 If the phase is ambiguous, under-specified, or needs a decision **not** already recorded
(issue body / `docs/ADR-0001-reactivity.md` / CLAUDE.md), stop and ask. This is a
settled-architecture project — don't invent decisions. (Unattended: skip the phase instead,
per `references/unattended.md`.)

**High-risk work gets a deeper plan review.** A framework/dependency swap, a large multi-file
rewrite, a schema/document-version change, a phase that deletes a subsystem, or anything you
judge under-determined despite its acceptance criteria:

1. **second opinion** — spawn a `Plan` subagent (`subagent_type: "Plan"`, read-only boundary
   stated) to independently stress the approach: seams, migration order, coverage strategy,
   rollback. Fold its critique into the plan;
2. **third-party opinion** — write the complete plan under the approved temporary directory,
   write the phase contract / acceptance subset / focused questions to a separate context file,
   then run `node skills/chatgpt-review/scripts/chatgpt-review.mjs plan <plan-file>
   --question-file <context-file>`. This uploads exactly the plan file, opens a fresh ChatGPT
   conversation when no session is supplied, and cannot request a GitHub write. Preserve the
   returned JSON while verifying every substantive claim against the real repo before folding
   it in — a second opinion, not a source of truth, exactly like the post-PR case;
3. 🛑 **post the resulting plan and wait for approval** (I review on mobile).

Low-risk, well-specified work proceeds straight from the written plan with no approval gate.

## 3 — Implement (inner loop)

- Write the code **and its tests in the same change** (hard rule 1). Keep `src/core/` pure at
  100%; keep new third-party / DOM / high-frequency-pointer code behind an injected seam so the
  per-file gate holds (hard rule 5).
- Loop until green: `npm test` (the **100/100/100/100 per-file gate**) and `npm run build`.
  Never proceed on a red suite or a broken build. Capture output to a file; Read the tail on
  green, `rg` the failures on red.
- `npm test` sets `TZ`; a raw `npx vitest` fails ~14 relative-time tests. Gate on `npm test`.
- A `.js` → `.ts` rename breaks only `test:e2e` (`build/e2e-serve.mjs` shims it). Never read a
  Playwright `N passed` line without also checking for `failed`.
- **Adding a bundled runtime dep?** A bare `import … from '<pkg>'` in `src/` breaks the
  **unbundled** e2e harnesses (`tests/e2e/*.html` load `/src` as raw ESM) — `npm test` and the
  bundle still pass, but the harness's module never runs and its specs time out on
  `page.waitForFunction`. Add an import-map entry (or an explicit
  `/node_modules/<pkg>/dist/*.mjs` path, as `pipeline.html` does for dagre) to every harness
  whose module graph imports it. Only e2e catches this.
- An App-shape change must update the fixture `__app` construction in `tests/e2e/*.html`, not
  just the specs.
- happy-dom cannot see CSS layout. A grid/flex/box-model change is invisible to the unit suite
  and needs a real Chromium check in step 4.

## 4 — Review (before the PR)

- `/code-review` on the working diff → apply real findings → re-run `npm test`.
  (`/code-review` is not model-invocable as a skill; fall back to read-only review subagents
  over the branch diff, with the boundary stated in each prompt.)
- `/security-review` too if it touches auth / OAuth / `config.json`.
- For high-risk phases, an independent multi-agent pass on the branch; address what it surfaces.
- **UI-visible change → `npm run test:e2e`** (Playwright). Firefox can't launch here
  (`unshare CLONE_NEWPID` EPERM) — chromium + webkit are the real local signal; Firefox comes
  from CI. If browsers are missing: `npx playwright install chromium webkit`.
- Then verify behaviour for real with the `run` skill or a driven Chrome — especially anything
  layout-, IndexedDB-, or clipboard-related.
- Fix every failure before opening the PR.

Two review findings worth catching by name, both seen on this repo:

- a worker **softening an explicit issue rule to keep old fixture tests passing** is a finding,
  not a fix — re-fixture the tests instead;
- a **bulk fixture rename** leaves the new contract unfalsifiable; sabotage-check the
  preservation tests. Restore a sabotaged *uncommitted* fix by writing the saved bytes back,
  never with `git checkout --`, which deletes it.

## 5 — Reconcile (same change, before the gate)

- If this reshaped tracked work, reconcile it now: the issue body's Goal/Acceptance, the
  relevant **ADR** addendum, and **CHANGELOG.md `[Unreleased]`**.
- Close or reconcile issues this phase supersedes — **when the phase that owns them lands**,
  not merely because it's the last phase to run.
- An out-of-scope bug or footgun you spotted → open a **separate** issue labelled **`inbox`**
  (file:line + why deferred) and mention it; don't fold it into this PR.

### The phase log — write it BEFORE the approval/merge stage

For a multi-phase issue this is not bookkeeping, it is the **handoff**. The next phase runs in
a cleared session that knows nothing about this one: not the decisions taken under ambiguity,
not the deviations, not why a test is shaped the way it is. If that only ever lived in the
conversation, `/clear` destroys it and the next phase re-derives it wrong.

Maintain exactly one comment on the issue, marked so it can be found and rewritten:

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
```

Status vocabulary: `shipped` (PR merged), `in review` (PR open), `blocked on #N`, `skipped —
<reason>`, `—` (not started). Only mark `shipped` once the PR is actually merged; the phase
that opens a PR writes `in review`, and the *next* run flips it.

Append a handoff block per phase; keep prior blocks. Write the body to a file and post it with
`-F body=@<file>`.

```sh
# create (no existing log)
gh api repos/{owner}/{repo}/issues/<ISSUE>/comments -F body=@"$TMPDIR/ship-log.md"

# update (id from the step-1 lookup)
gh api -X PATCH repos/{owner}/{repo}/issues/comments/<ID> -F body=@"$TMPDIR/ship-log.md"
```

If the issue also carries a `## Phases` checklist in its body, tick the row for this phase in
the same reconcile step (`gh api -X PATCH repos/{owner}/{repo}/issues/<ISSUE> -F body=@<file>`).
The checklist is a convenience view; **the log comment is the state of record.**
