# Unattended mode — the multi-phase / multi-issue coordinator

Reached only via the literal word `unattended`:

- `/ship 447 unattended` — every remaining **phase** of one issue;
- `/ship 424,425,426 unattended` — several whole **issues**.

Both are the same machine: a **unit** is a phase or an issue, and units run in dependency
order. This file replaces `SKILL.md` steps 1, 6, 7 and 8. Steps 2–5 stay exactly as written in
`references/per-issue-cycle.md` — that is the worker contract, quoted, not paraphrased.

You are the **coordinator**. You do not implement units yourself. You plan waves, spawn
workers and reviewers, verify their output with your own commands, integrate commits, and own
everything git-remote-facing.

## Why this mode exists

Attended mode resets context by ending the session at each merge gate. Unattended mode can't
do that — there is no gate and no human to `/clear`. It buys the same bound a different way:
**every unit's implementation runs inside a fresh subagent with its own context window**, and
only a summary returns. Your context grows by ~1–2k per unit, not by a full transcript. That
is the entire reason workers are mandatory here, so never inline a unit's implementation into
your own turn to save a spawn.

## 0 — Policy

- **No approval gates.** Where the cycle says 🛑, do not stop: if a unit is ambiguous or needs
  an unrecorded decision, **skip it** (leave its commits out), continue the rest, and list it
  in the final report. Never invent architectural decisions.
- Never merge to `main`, never force-push, never edit `main`'s working tree directly.
- The coordinator alone touches: `git merge`/`push`, `gh pr *`, issue comments and the phase
  log, `CHANGELOG.md` conflicts, memory writes.
- Sandbox notes from `SKILL.md` apply. Playwright does not run reliably here — the e2e signal
  comes from GitHub Actions on the pushed branch.

## 1 — Orient

- Resolve the unit list. For a phased issue: parse the phase structure and the `<!-- ship-log -->`
  comment exactly as `SKILL.md` step 1 describes, and take every phase not already `shipped`.
  For an issue list: `gh issue view <n> --json body` each one — the bodies are the spec, and
  are deliberately self-contained; do not rely on chat history.
- Load each body to `$TMPDIR/issue-<n>.md` and Read phase-scoped, as in step 1.
- **Derive the wave plan.** Sequence the dependency spine. Parallelize only units whose planned
  file footprints are disjoint (judge from their Files/implement sections — when in doubt,
  serialize; a merge conflict costs more than lost parallelism). Phases of one issue are almost
  always a spine, not a wave — a phase that deletes a subsystem must land before the phase that
  rebuilds it.
- **Branch:** one integration branch for the whole run, off the remote default branch:
  `git fetch origin && git checkout -b <type>/<slug> origin/main`. Push immediately so CI runs
  from the start. In a worktree, local `main` is stale — branch off `origin/main` and scope
  diffs to `git diff HEAD` / `origin/main...HEAD`.

  Unattended mode uses **one branch and one PR** even when the units would each be
  independently mergeable, because there is no human at an intermediate gate to merge them.

## 2 — Per unit (repeat per wave)

**Spawn a worker** — a fresh agent (`subagent_type: "general-purpose"`, **never `fork`**; a
fork inherits this in-progress mutating workflow and can conclude it should finish the whole
job — push, PR and all). `model: "sonnet"` unless the wave plan marks the unit high-risk, in
which case omit `model` to inherit yours. Parallel workers get `isolation: "worktree"`; a solo
worker may work in the main tree on `wip/<unit>-<slug>` off the current integration HEAD.

The worker prompt must contain, explicitly:

- the issue number, the phase (if any), and the instruction to `gh issue view` it and treat the
  **assembled phase contract** as the definition of done — implement list + its `## Tests`
  subsection + its acceptance gate + the named subset of global acceptance criteria;
- **the mutation boundary**: Edit/Write + local `git commit` on its own branch only — **no
  push, no PR, no `gh` mutations, no issue edits, no phase-log writes, no memory writes, no
  `CHANGELOG.md` beyond its own entry, no TaskCreate/TaskUpdate**;
- the instruction to follow `skills/ship/references/per-issue-cycle.md` steps 2–4 and
  the CHANGELOG part of 5 — **the phase log is yours, not the worker's**;
- commit message `<type>(#<ISSUE>): <summary>` + the repo footer convention;
- what to return: plan summary, files touched, test/build output tail, and the contract
  checklist with each item ticked or explained.

**Verify yourself** — never trust the self-report. `git log` / `git diff` the worker branch,
re-run `npm test` and `npm run build` in that tree.

**Small review**: a **read-only** reviewer agent (`model: "sonnet"`, boundary stated: no
Edit/Write, no git/gh, no memory) over the unit's diff against the integration base, prompted
with the unit's acceptance criteria + CLAUDE.md hard rules. Real findings → back to the worker
(`SendMessage`) or to a fix agent under the same boundary; re-verify. If you resume a worker,
**check out its branch first** — a resumed worker commits on whatever is currently checked out,
not on its named branch.

**Integrate**: merge the worker branch into the integration branch (you resolve conflicts — you
are its only writer), re-run `npm test`, push. Each push is a CI e2e signal; check it before
the next wave (`gh run list --branch <branch>`). Red e2e stops the line until fixed.

**Log**: append the unit's handoff block to the `<!-- ship-log -->` comment now, while it's
fresh — same format as `per-issue-cycle.md`, status `in review` until the single PR merges.

After every batch, regardless of what the agents reported: `git diff`, `git log`,
`gh pr list`. An instruction in a prompt is not an enforced tool restriction, and review
agents on this repo have edited files despite an explicit report-only boundary.

## 3 — Finish

1. **Whole-branch high review** at high effort over the full branch diff (plus
   `/security-review` if anything touched auth/config). Apply real findings via a fix agent
   under the worker boundary; re-verify; push.
2. Confirm CI fully green — unit + e2e, all engines.
3. **Reconcile**: CHANGELOG entries are already per-unit — dedupe and resolve conflicts only.
   Close or reconcile superseded issues. Tick any `## Phases` checklist in one edit.
4. **One PR** (`gh pr create --base main`), body per the PR template, with one `Closes #<n>`
   line per fully completed issue (partially completed or skipped: `Part of #<n>`), a per-unit
   summary table, and the repo PR footer.
5. **Third-party review**: invoke the `chatgpt-review` skill on the PR just opened, per
   `SKILL.md` step 7. A negative or contested verdict doesn't stop the line, but apply every
   claim you verify as real, `npm test`, and push before continuing — this is coordinator work,
   never delegated to a worker. If ChatGPT is unreachable, note the skip in the final report and
   continue.
6. 🛑 **Merge gate — the only stop.** Report: PR URL, per-unit status (shipped / skipped +
   why), review findings applied (including the ChatGPT pass), CI status. Do not merge.
7. Friction → memory. The coordinator writes it, not a subagent.
