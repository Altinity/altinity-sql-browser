---
name: ship
description: Ship an altinity-sql-browser roadmap issue or phase end-to-end — resolve scope, plan against an invariant map, implement code and tests, run a budgeted readiness review, open a PR, obtain one clean exact-head ChatGPT review, and merge after approval (attended) or after strict certification (unattended). Invoke as `/ship ISSUE`, `/ship ISSUE.PHASE`, `/ship ISSUE unattended`, or `/ship ISSUE1,ISSUE2 unattended`.
---

# /ship — deliver an altinity-sql-browser issue

Use only in the `altinity-sql-browser` repository. Otherwise stop and say so.

Follow `CLAUDE.md` (hard rules 1–5 and Working discipline) throughout. In attended mode,
act as coordinator and implementer. In unattended mode, act only as coordinator and use
fresh workers for implementation units.

Proceed autonomously except at points marked `STOP`. Unattended mode has no approval
stops, but it must skip ambiguous or blocked work rather than invent decisions.

## Operating rules

### GitHub and workspace

- Use the authenticated `gh` CLI directly for this repository — never the GitHub
  connector MCP (its collaborator preflight fails for this org).
- Bare `gh issue view` and `gh pr edit` error on this repo: read with `--json`, and edit
  PR/issue bodies with `gh api -X PATCH` and `-F body=@<file>`. Never build a body with
  `$(cat …)` inside a quoted heredoc — write it to a file.
- Never force-push or mutate `main` unless explicitly authorized.
- One `/ship` run owns one working directory. Parallel runs require separate worktrees
  (`claude --worktree <name>`); parallelize only dependency-independent units with
  disjoint expected file footprints.
- After any agent batch returns, verify actual state with `git diff`, `git log`, and
  `gh pr list` — never trust a self-report.

### Subagents

Planning and review agents are read-only unless explicitly assigned implementation work.
State the boundary in every prompt:

- no Edit or Write
- no git or gh mutation
- no task or memory mutation
- return analysis only

Use fresh, non-forked agents for independent review (a fork inherits this in-progress
mutating workflow). Pick the model per subtask: inherited model for planning/review and
high-risk work, a cheaper capable model for mechanical searches and edits. The
coordinator alone owns remote GitHub mutations, reconciliation, PR creation,
review-session coordination, approval handling, and merge.

### Output capture

`grep` in Bash is intercepted here — use `rg PATTERN > "$TMPDIR/out"` then Read. Capture
long command output to files (`npm test > "$TMPDIR/test.log" 2>&1`); Read only the tail
on green and the focused failure sections on red. The coverage table is the biggest
accidental context sink in a run.

## 0 — Resolve invocation

| Invocation | Mode | Scope |
|---|---|---|
| `/ship 447` | attended | next unshipped phase, or whole issue if unphased |
| `/ship 447.2` | attended | phase 2 of #447, forced |
| `/ship 447 unattended` | unattended | all remaining phases of #447 |
| `/ship 424,425 unattended` | unattended | several whole issues |

Attended is the default. **Unattended requires the literal word** — never infer it.

For unattended, Read `references/unattended.md` now and follow it; it replaces steps 1,
6, 7 and 8 below and reuses steps 2–5 as the worker contract.

## 1 — Orient and assemble the delivery contract

**Read `references/repo-footguns.md` now** — repo-specific operational knowledge that
applies across steps 2–8.

Load the issue body to a file, not into context:

```sh
gh issue view <ISSUE> --json body -q .body > "$TMPDIR/issue-<ISSUE>.md"
```

Detect phases in this order of precedence:

1. a `## Phases` checklist of `- [ ] N — title` rows;
2. `### Phase N` headings (typically under `## Delivery phases`);
3. neither → single-phase; ship the issue whole.

Find the authoritative `<!-- ship-log -->` comment — never infer phase state from PR
titles (they go stale when phase counts are re-scoped mid-flight):

```sh
gh api repos/{owner}/{repo}/issues/<ISSUE>/comments --paginate \
  --jq '.[] | select(.body | startswith("<!-- ship-log -->")) | .id' > "$TMPDIR/logid"
```

The target is the first phase not marked `shipped`, unless the invocation forces one.
If no log exists, the target is phase 1.

**Read only what this unit needs** from the issue file: the header (depends-on /
supersedes / owner decisions), the phase list, the target phase's own section, its
matching `### Phase N` subsection under `## Tests` if the issue splits tests that way,
the global `## Acceptance criteria`, and `## Non-goals`. Skip other phases' detail.

**The delivery contract** is the union of: the phase's implement list, its per-phase
`## Tests` subsection, any acceptance-gate blockquote in the phase section, the subset
of global acceptance criteria this phase claims (name that subset explicitly, so the
remainder is visibly deferred rather than silently dropped), and `## Non-goals`.
Missing the per-phase `## Tests` subsection because it lives outside the phase heading
is the most likely way to under-deliver a phase — check every time.

`STOP` — check dependencies for *this unit*, not just the issue: the `Depends on:`
header and anything the target phase's own section references. Blocked → say what
blocks it and offer the highest unblocked unit instead.

### Branch model (once per issue, recorded in the ship log)

> Can each phase land on `main` green **and** self-consistent — additive, behind a
> flag, or pure-logic-then-wire?

- **Yes → one branch and PR per phase off fresh `main`** (the default):
  `git fetch origin && git checkout main && git pull && git checkout -b <type>/<slug>-<ISSUE>p<N>`
- **No → one integration branch for the whole issue** off `origin/main`, one PR at the
  end. Say so explicitly and record it in the ship log.

Single-phase issue: branch `<type>/<slug>-<ISSUE>` off `main` — or off the dependency
branch if it builds on unmerged work. When a phase is subtractive, call out the revert
cost (backing a deletion out of `main` alone is expensive) — a reason to raise it, not
to silently switch models.

Run `npm ci` after updating `main` when dependencies may have changed or `node_modules`
is absent.

## 2–5 — The per-issue cycle

**Read `references/per-issue-cycle.md` now**, before writing any plan or code, and
follow it. It holds plan → implement → readiness review → reconcile, including the risk
classification, the invariant map, the review budgets, and the exact local gate. It is
the same contract unattended workers are held to — one source of truth, so the two
paths cannot drift.

## 6 — Create the PR

Performed by **this session only** — never delegate commit/push/PR-create.

- Commit with the repo footer convention (Co-Authored-By + Claude-Session), then
  `git push -u origin <branch>`.
- `gh pr create --base main`, title + body per `.github/PULL_REQUEST_TEMPLATE.md`.
- Title: `<type>(#<ISSUE>): <summary>`; append ` (phase <N>)` for phased work. Never a
  running count like `(2/3)` — the ship log owns the count and totals change.
- `Closes #<ISSUE>` only when this PR completes the whole issue; earlier phases use
  `Part of #<ISSUE>`.
- Body covers: contract coverage, invariant verification, sabotage cases, tests, build,
  and e2e results. Tick the template checklist. Report the PR URL.

## 7 — ChatGPT exact-head review

Performed by this session only. Read `skills/chatgpt-review/SKILL.md`, write a focused
question file to the approved temporary directory containing: the unit contract and
acceptance subset, the invariant map, compatibility requirements, tests and sabotage
cases, and the behaviors that need adversarial review. Then:

```sh
node skills/chatgpt-review/scripts/chatgpt-review.mjs pr <PR-URL> --question-file <FILE>
```

Retain the returned JSON: status, opaque `session` handle, reviewed SHA, and public
comment URL. **Verify every substantive finding against the real repository before
trusting it** — a second opinion, not a source of truth. Every finding ends in exactly
one state: accepted-and-fixed, rejected-with-reason, or unresolved. Never silently drop
one.

Fix pass: apply accepted findings, run the full local gate, commit, push, wait for
green CI at the new head, then rerun with `--session <SESSION_HANDLE>` so ChatGPT
reassesses every earlier finding in the same conversation. Each accepted-and-fixed pass
gets its own pushed commit and separately labelled public review comment.

### Certification rule

A **certified head** is a completed ChatGPT review pass at the exact current PR head
with no accepted actionable findings remaining.

- Pass 1 clean at the current head → certified; stop reviewing.
- Never exceed three total passes. Three is a **failure ceiling, not a ritual** — never
  run an extra pass over an already-certified head.
- **After certification, push nothing.** Any push voids the certification and burns
  another pass — which is why all reconcile commits (step 5) land *before* the PR and
  certification. Ship-log comment edits are fine; comments are not commits.
- **Unattended:** certification is a hard merge requirement. No certified head after
  three passes → leave the PR open and report the failed proof condition.
- **Attended:** certification is the goal, but the human at the merge gate is the
  authority. If ChatGPT is unreachable (agent Chrome down, network denied), disclose
  the skip in the gate summary and continue. If the ceiling is reached with findings
  still contested or unresolved, continue to the gate with them listed — explicit human
  approval overrides.

## 8 — `STOP` Attended merge gate

Ask for explicit approval to merge. Do not merge merely because implementation, CI, and
review are green. Summarize:

- shipped behavior, PR URL, current head SHA
- CI state
- whether the head is certified; ChatGPT comment URLs
- accepted, rejected, and **unresolved** findings — the human rules on unresolved ones
- manual testing instructions

Serve the app with `npm run local` for manual verification (see footguns for port/PID
discipline). If approval is withheld, leave the PR open and report the exact
outstanding condition.

After approval:

1. Re-read the PR head SHA — approval must not race a new push.
2. Confirm the certified SHA still matches, or restate the disclosed skip/override.
3. Confirm required checks are green at that head.
4. `gh pr merge <PR> --merge --delete-branch` (the repo's merge-commit convention).
5. Verify the PR reports `MERGED` and `origin/main` contains the merge.
6. Update the ship-log row to `shipped`.

If phases remain, end with this instruction in substance:

> Phase `<N>` was merged as PR `<url>`. Start a **fresh session** — `/clear`, then
> `/ship <ISSUE>` — for phase `<N+1>`. Don't resume this one with `--continue`/
> `--resume`; that restores this context instead of clearing it.

Context does not reset on its own; running `/ship` again in this session stacks a
second phase's plan, tests, and reviews on top of this one, which auto-compaction then
eats unpredictably. The fresh session is safe only because step 5 wrote the handoff to
the issue first — this conversation is not the record.

## 9 — Final report

Report: unit status, PR and merge URLs, final SHA, CI state, tests/build/e2e results,
sabotage verification, ChatGPT comment URLs with accepted/rejected/unresolved findings,
skipped units, and ship-log updates.

## 10 — Friction → memory

If anything needed retries or surprised you (test / env / scope), save a concise memory
so the next `/ship` doesn't repeat it. Record stable process knowledge, not transient
review chronology. This session does the saving, never a subagent.
