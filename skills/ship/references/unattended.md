# Unattended mode — the multi-phase / multi-issue coordinator

Reached only via the literal word `unattended`:

- `/ship 447 unattended` — every remaining **phase** of one issue;
- `/ship 424,425,426 unattended` — several whole **issues**.

Both are the same machine: a **unit** is a phase or an issue, and units run in
dependency order. This file replaces `SKILL.md` steps 1, 6, 7 and 8. Steps 2–5 stay
exactly as written in `references/per-issue-cycle.md` — that is the worker contract,
quoted, not paraphrased. `references/repo-footguns.md` applies throughout.

You are the **coordinator**. You do not implement units yourself. You plan waves,
spawn workers and reviewers, verify their output with your own commands, integrate
commits, and own everything git-remote-facing.

## Why this mode exists

Attended mode resets context after each approved merge. Unattended mode cannot — there
is no approval gate and no human to `/clear`. It buys the same bound a different way:
**every unit's implementation runs inside a fresh subagent with its own context
window**, and only a summary returns. Your context grows by ~1–2k per unit, not by a
full transcript. That is the entire reason workers are mandatory here — never inline a
unit's implementation into your own turn to save a spawn.

## 0 — Policy

- **No approval gates.** Where the cycle says `STOP`, do not stop: if a unit is
  ambiguous or needs an unrecorded decision, **skip it** (leave its commits out),
  continue the rest, and list it in the final report. Never invent decisions.
- Never force-push or edit `main`'s working tree directly. The coordinator may merge
  the final PR only after the automatic-merge proof in step 3 — no approval prompt
  once it is satisfied, no merge without it.
- The coordinator alone touches: `git merge`/`push`, `gh pr *`, issue comments and the
  ship log, `CHANGELOG.md` conflicts, memory writes.
- Playwright does not run reliably here — the e2e signal comes from GitHub Actions on
  the pushed branch.

## 1 — Orient

- Resolve the unit list. Phased issue: parse the phase structure and `<!-- ship-log -->`
  comment exactly as `SKILL.md` step 1 describes; take every phase not `shipped`.
  Issue list: `gh issue view <n> --json body` each one — the bodies are the spec and
  are deliberately self-contained; never rely on chat history.
- Load each body to `$TMPDIR/issue-<n>.md` and Read phase-scoped, as in step 1.
- **Derive the wave plan.** Sequence the dependency spine. Parallelize only units
  whose planned file footprints are disjoint — when in doubt, serialize; a merge
  conflict costs more than lost parallelism. Phases of one issue are almost always a
  spine, not a wave.
- **Branch:** one integration branch for the whole run, off the remote default:
  `git fetch origin && git checkout -b <type>/<slug> origin/main`. Push immediately so
  CI runs from the start. (In a worktree, local `main` is stale — see footguns.)

  Unattended uses **one branch and one PR** even when units would be independently
  mergeable, because no human sits at an intermediate gate.

## 2 — Per unit (repeat per wave)

**Spawn a worker** — a fresh agent (`subagent_type: "general-purpose"`, **never
`fork`**; a fork inherits this in-progress mutating workflow and can conclude it
should finish the whole job). `model: "sonnet"` unless the wave plan marks the unit
high-risk, in which case omit `model` to inherit yours. Parallel workers get
`isolation: "worktree"`; a solo worker may use the main tree on `wip/<unit>-<slug>`
off the current integration HEAD.

The worker prompt must contain, explicitly:

- the issue number, the phase (if any), and the instruction to `gh issue view` it and
  treat the **assembled delivery contract** as the definition of done — implement list
  + `## Tests` subsection + acceptance gate + named subset of global criteria;
- **the mutation boundary**: Edit/Write + local `git commit` on its own branch only —
  no push, no PR, no `gh` mutations, no issue edits, no ship-log writes, no memory
  writes, no `CHANGELOG.md` beyond its own entry, no TaskCreate/TaskUpdate;
- the instruction to follow `skills/ship/references/per-issue-cycle.md` steps 2–4 and
  the CHANGELOG part of 5 — **the ship log is yours, not the worker's** — plus
  `references/repo-footguns.md`;
- commit message `<type>(#<ISSUE>): <summary>` + the repo footer convention;
- what to return: plan summary, invariant map, files touched, gate/e2e output tail,
  sabotage-case results, and the contract checklist with each item ticked or explained.

**Verify yourself** — never trust the self-report. `git log` / `git diff` the worker
branch, rerun the full local gate in that tree.

**Review budget per unit** — same risk-based budget as `per-issue-cycle.md` step 4: no
reviewer for low-risk units, one targeted read-only reviewer (`model: "sonnet"`,
boundary stated) for medium/high, prompted with the unit's contract + CLAUDE.md hard
rules. Real findings → back to the worker (`SendMessage`, but **check out its branch
first** — see footguns) or to a bounded fix agent; re-verify. Do not add generic
per-unit review passes on top.

**Integrate**: merge the worker branch into the integration branch (you resolve
conflicts — you are its only writer), rerun the gate, push. Each push is a CI signal;
key the wait on the head SHA (footguns) and check it before the next dependent wave.
Red e2e stops the line until fixed.

**Log**: append the unit's handoff block to the `<!-- ship-log -->` comment now,
status `in review` until the single PR merges.

After every batch, regardless of what agents reported: `git diff`, `git log`,
`gh pr list`. An instruction in a prompt is not an enforced tool restriction, and
review agents on this repo have edited files despite an explicit report-only boundary.

## 3 — Finish

1. **Whole-branch review** — only if the run contains high-risk work or interacting
   units: one targeted read-only pass over the full branch diff at high effort (plus
   the `security-review` skill if anything touched auth/config). Do not repeat the
   per-unit reviews. Apply real findings via a fix agent under the worker boundary;
   re-verify; push.
2. Confirm CI fully green — unit + e2e, all engines.
3. **Reconcile per `per-issue-cycle.md` step 5** — CHANGELOG entries are per-unit
   already, so dedupe and resolve conflicts only; close superseded issues; tick any
   `## Phases` checklist in one edit. All reconcile commits land **now, before the
   PR** — nothing may be pushed after certification.
4. **One PR** (`gh pr create --base main`), body per the template, one `Closes #<n>`
   per fully completed issue (`Part of #<n>` for partial or skipped), a per-unit
   summary table, and the repo PR footer.
5. **Certification** — run the ChatGPT review exactly as `SKILL.md` step 7 specifies,
   with the same rule: **stop at the first clean completed pass whose reviewed SHA
   equals the current PR head**; rerun (same `--session`) only after accepted findings
   are fixed, gated, pushed, and green in CI; never exceed three total passes. Three
   is a failure ceiling, not a ritual — never re-review an already-certified head.
6. **Automatic merge — no gate.** Merge only when ALL hold at one exact head:
   - ChatGPT status is `completed` with no accepted actionable finding remaining;
   - reviewed SHA equals the current PR head;
   - required CI checks are green at that head;
   - branch protection permits the merge.

   Then `gh pr merge <PR> --merge --delete-branch`, verify the PR reports `MERGED`,
   fetch `origin/main` and verify the merge, and flip every included ship-log row to
   `shipped`.

   If ChatGPT is unavailable, a pass is incomplete, the SHA differs, a finding remains
   after three passes, CI is red or pending, or branch protection refuses — **leave
   the PR open and report the failed proof condition.** That is a safety failure, not
   an approval gate; there is no attended-style human override in this mode.
7. **Final report**: PR and merge URLs, per-unit shipped/skipped status and why, every
   ChatGPT comment link, findings accepted/rejected/unresolved, final head SHA, CI state.
8. Friction → memory. The coordinator writes it, never a subagent.
