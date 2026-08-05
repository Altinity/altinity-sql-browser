---
name: ship
description: Ship altinity-sql-browser roadmap issues or phases end-to-end, autonomously — resolve scope, spawn a fresh worker per unit, iterate each unit's plan through a ChatGPT review loop to approval (max 5 passes), implement code and tests, open one PR, iterate a ChatGPT code review loop to certification (max 3 passes), and merge automatically when every proof condition holds. Stops for a human only when a review loop exhausts its passes or a merge proof fails. Invoke as `/ship ISSUE`, `/ship ISSUE.PHASE`, or `/ship ISSUE1,ISSUE2`.
---

# /ship — deliver altinity-sql-browser issues autonomously

Use only in the `altinity-sql-browser` repository. Otherwise stop and say so.

Follow `CLAUDE.md` (hard rules 1–5 and Working discipline) throughout.

You are the **coordinator**. You do not implement units yourself. You plan waves, spawn
workers and reviewers, verify their output with your own commands, run every ChatGPT
review loop, integrate commits, and own everything git-remote-facing. A **unit** is a
phase or a whole issue; units run in dependency order.

**Why workers are mandatory:** there is no human to `/clear` between units, so the
context bound comes from structure — every unit's implementation runs inside a fresh
subagent with its own context window, and only a summary returns. Your context grows by
~1–2k per unit, not by a full transcript. Never inline a unit's implementation into your
own turn to save a spawn.

Proceed autonomously. There are exactly two human stops, both failure stops:

1. a unit's plan is not approved after **5** review passes (step 2.2);
2. a merge proof condition fails at the gate — including no certified head after **3**
   code review passes (step 3.6).

Everywhere else, an ambiguous or blocked unit is **skipped and reported**, never guessed
at — this is a settled-architecture project; don't invent decisions.

## Operating rules

### GitHub and workspace

- Use the authenticated `gh` CLI directly for this repository — never the GitHub
  connector MCP (its collaborator preflight fails for this org).
- Bare `gh issue view` and `gh pr edit` error on this repo: read with `--json`, and edit
  PR/issue bodies with `gh api -X PATCH` and `-F body=@<file>`. Never build a body with
  `$(cat …)` inside a quoted heredoc — write it to a file.
- Never force-push or mutate `main` directly.
- One `/ship` run owns one working directory. Parallel runs require separate worktrees
  (`claude --worktree <name>`).
- After any agent batch returns, verify actual state with `git diff`, `git log`, and
  `gh pr list` — never trust a self-report.

### Subagents

Planning and review agents are read-only unless explicitly assigned implementation work.
State the boundary in every prompt:

- no Edit or Write
- no git or gh mutation
- no task or memory mutation
- no `chatgpt-review` invocation
- return analysis only

Use fresh, non-forked agents (a fork inherits this in-progress mutating workflow). Pick
the model per subtask: inherited model for high-risk work, `sonnet` for ordinary units
and reviews. The coordinator alone owns remote GitHub mutations, reconciliation, PR
creation, every `chatgpt-review` invocation, and the merge.

### ChatGPT review loops

- Agent Chrome is a **single session**: the coordinator runs every `chatgpt-review`
  invocation itself and serializes them — workers and reviewers never invoke the skill,
  and parallel units take their review passes one at a time.
- Both loops use a **verdict protocol**: the question file instructs the reviewer to end
  with exactly one line — `VERDICT: APPROVED` or `VERDICT: REVISE` for a plan,
  `VERDICT: SHIP` or `VERDICT: REVISE` for a PR. A missing or malformed verdict counts
  as REVISE (fail-closed), and the pass still counts against the cap.
- **Verify every substantive finding against the real repository before trusting it** —
  a second opinion, not a source of truth. Every finding ends in exactly one state:
  accepted-and-fixed, rejected-with-reason, or unresolved. Never silently drop one.

### Output capture

`grep` in Bash is intercepted here — use `rg PATTERN > "$TMPDIR/out"` then Read. Capture
long command output to files (`npm test > "$TMPDIR/test.log" 2>&1`); Read only the tail
on green and the focused failure sections on red. The coverage table is the biggest
accidental context sink in a run.

## 0 — Resolve invocation

| Invocation | Scope |
|---|---|
| `/ship 447` | all remaining phases of #447, or the whole issue if unphased |
| `/ship 447.2` | phase 2 of #447 only, forced |
| `/ship 424,425` | several whole issues |

The legacy word `unattended` is accepted and ignored — this is the only mode.

## 1 — Orient and assemble the delivery contracts

**Read `references/repo-footguns.md` and `references/per-issue-cycle.md` now.** The
footguns apply across every step; the cycle is the worker contract you will hold every
unit to — one source of truth, quoted, never paraphrased.

Load each issue body to a file, not into context:

```sh
gh issue view <ISSUE> --json body -q .body > "$TMPDIR/issue-<ISSUE>.md"
```

The bodies are the spec and are deliberately self-contained; never rely on chat history.

Detect phases in this order of precedence:

1. a `## Phases` checklist of `- [ ] N — title` rows;
2. `### Phase N` headings (typically under `## Delivery phases`);
3. neither → single-phase; the issue is one unit.

Find the authoritative `<!-- ship-log -->` comment — never infer phase state from PR
titles (they go stale when phase counts are re-scoped mid-flight):

```sh
gh api repos/{owner}/{repo}/issues/<ISSUE>/comments --paginate \
  --jq '.[] | select(.body | startswith("<!-- ship-log -->")) | .id' > "$TMPDIR/logid"
```

The units are every phase not marked `shipped` (or the one phase the invocation forces).
If no log exists, start at phase 1.

**Read only what each unit needs** from the issue file: the header (depends-on /
supersedes / owner decisions), the phase list, the target phase's own section, its
matching `### Phase N` subsection under `## Tests` if the issue splits tests that way,
the global `## Acceptance criteria`, and `## Non-goals`. Skip other phases' detail.

**The delivery contract** is the union of: the phase's implement list, its per-phase
`## Tests` subsection, any acceptance-gate blockquote in the phase section, the subset
of global acceptance criteria the phase claims (name that subset explicitly, so the
remainder is visibly deferred rather than silently dropped), and `## Non-goals`.
Missing the per-phase `## Tests` subsection because it lives outside the phase heading
is the most likely way to under-deliver a phase — check every time.

**Dependencies:** check the `Depends on:` header and anything each unit's own section
references. A blocked unit → skip it (leave its commits out), continue the rest, and
list it in the final report — the same policy as for units needing an unrecorded
decision.

### Wave plan and integration branch

- Sequence the dependency spine. Parallelize only units whose planned file footprints
  are disjoint — when in doubt, serialize; a merge conflict costs more than lost
  parallelism. Phases of one issue are almost always a spine, not a wave.
- **One integration branch for the whole run, one PR at the end**, off the remote
  default: `git fetch origin && git checkout -b <type>/<slug> origin/main`. Push
  immediately so CI runs from the start. (In a worktree, local `main` is stale — see
  footguns.)
- Run `npm ci` when dependencies may have changed or `node_modules` is absent.

## 2 — Per unit (repeat per wave)

### 2.1 Spawn the worker — plan first, no code

Fresh agent (`subagent_type: "general-purpose"`, **never `fork`** — a fork inherits
this in-progress mutating workflow and can conclude it should finish the whole job).
`model: "sonnet"` unless the wave plan marks the unit high-risk, in which case omit
`model` to inherit yours. Parallel workers get `isolation: "worktree"`; a solo worker
may use the main tree on `wip/<unit>-<slug>` off the current integration HEAD.

The worker prompt must contain, explicitly:

- the issue number, the phase (if any), and the instruction to load the body with
  `gh issue view <n> --json body -q .body` and treat the **assembled delivery
  contract** as the definition of done — implement list + `## Tests` subsection +
  acceptance gate + named subset of global criteria;
- **the mutation boundary**: Edit/Write + local `git commit` on its own branch only —
  no push, no PR, no `gh` mutations, no issue edits, no ship-log writes, no memory
  writes, no `CHANGELOG.md` beyond its own entry, no TaskCreate/TaskUpdate, and never
  invoke `chatgpt-review` (the coordinator owns all review sessions);
- the instruction to follow `skills/ship/references/per-issue-cycle.md` steps 1–3 and
  the CHANGELOG part of step 4 — **the ship log is yours, not the worker's** — plus
  `references/repo-footguns.md`;
- **its first deliverable is the plan only**: write the plan (cycle step 1) to the
  exact path `$TMPDIR/plan-<ISSUE>p<N>.md` (or `$TMPDIR/plan-<ISSUE>.md` unphased),
  return the plan summary and that path **without writing any code**, then wait for
  plan approval via `SendMessage`;
- commit message `<type>(#<ISSUE>): <summary>` + the repo footer convention;
- what to return after implementing: invariant map, files touched, gate/e2e output
  tail, sabotage-case results, and the contract checklist with each item ticked or
  explained.

A worker that reports the unit ambiguous or dependent on an unrecorded decision →
skip the unit, report the missing decision in the final report, move on.

### 2.2 Plan review loop — coordinator-run, every unit, max 5 passes

The plan file **path** is the review-session identity — the worker revises the same
file in place; never move or rename it mid-loop (footguns).

1. Write a context file to `$TMPDIR`: the unit contract and acceptance subset, focused
   questions, and the verdict protocol — "End your review with exactly one line:
   `VERDICT: APPROVED` or `VERDICT: REVISE`."
2. Run (plan mode never publishes):

   ```sh
   node skills/chatgpt-review/scripts/chatgpt-review.mjs plan <plan-file> --question-file <context-file>
   ```

   Later passes: the same command plus `--session <handle>` so the reviewer reassesses
   in the same conversation.
3. `VERDICT: REVISE` → verify each finding against the repo; send the accepted ones to
   the worker (`SendMessage` — **check out its branch first**, footguns); the worker
   revises the plan file in place; rerun.
4. `VERDICT: APPROVED` → record the pass count and conversation URL for the ship log;
   proceed to 2.3.

**Cap: 5 total passes per unit** (skill-enforced; the script caps only `pr` mode).
Not approved after 5 → **FULL STOP — human decision needed.** Present the latest plan,
the contested points, and the conversation URL, and ask the human: approve the latest
plan, redirect, or skip the unit. Write no code for this unit before that decision.

### 2.3 Implement

`SendMessage` the worker: plan approved — implement now (cycle steps 2–3 plus its
CHANGELOG entry).

### 2.4 Verify, review, integrate, log

- **Verify yourself** — never trust the self-report. `git log` / `git diff` the worker
  branch, rerun the full local gate in that tree.
- **Internal review budget** — the risk-based budget of cycle step 3: no reviewer for
  low-risk units; one targeted read-only reviewer (`model: "sonnet"`, boundary stated)
  for medium/high, prompted with the unit's contract + CLAUDE.md hard rules. Real
  findings → back to the worker (`SendMessage`, branch checked out first) or a bounded
  fix agent; re-verify. Do not add generic per-unit review passes on top.
- **Integrate**: merge the worker branch into the integration branch (you resolve
  conflicts — you are its only writer), rerun the gate, push. Key every CI wait on the
  head SHA (footguns) and check it before the next dependent wave. Red CI stops the
  line until fixed.
- **Log**: append the unit's handoff block to the `<!-- ship-log -->` comment now,
  status `in review` until the single PR merges. Include the plan-review outcome
  (passes, conversation URL).

After every batch, regardless of what agents reported: `git diff`, `git log`,
`gh pr list`. An instruction in a prompt is not an enforced tool restriction, and
review agents on this repo have edited files despite an explicit report-only boundary.

## 3 — Finish: PR, code review loop, gate

1. **Whole-branch review** — only if the run contains high-risk work or interacting
   units: one targeted read-only pass over the full branch diff at high effort (plus
   the `security-review` skill if anything touched auth/config). Do not repeat the
   per-unit reviews. Apply real findings via a fix agent under the worker boundary;
   re-verify; push.
2. Confirm required CI checks are green at the head. The e2e signal is layered:
   workers ran Chromium + WebKit locally per the cycle; PR CI adds its Chromium e2e
   run (#564); Firefox comes only from the CI jobs that provide it.
3. **Reconcile per cycle step 4** — CHANGELOG entries are per-unit already, so dedupe
   and resolve conflicts only; close superseded issues; tick any `## Phases` checklist
   in one edit. All reconcile commits land **now, before the PR** — nothing may be
   pushed after certification.
4. **One PR** (`gh pr create --base main`), title `<type>(#<ISSUE>): <summary>`, body
   per `.github/PULL_REQUEST_TEMPLATE.md` covering contract coverage, invariant
   verification, sabotage cases, tests, build, and e2e results; a per-unit summary
   table; `Closes #<n>` per fully completed issue (`Part of #<n>` for partial or
   skipped); the repo PR footer.
5. **Code review loop — max 3 passes.** Write a question file to `$TMPDIR`: the unit
   contracts and acceptance subsets, the invariant maps, compatibility requirements,
   tests and sabotage cases, the behaviors that need adversarial review, and the
   verdict protocol — "End your review with exactly one line: `VERDICT: SHIP` or
   `VERDICT: REVISE`." Then:

   ```sh
   node skills/chatgpt-review/scripts/chatgpt-review.mjs pr <PR-URL> --question-file <FILE>
   ```

   Retain the returned JSON: status, opaque `session` handle, reviewed SHA, and public
   comment URL.

   Fix pass: apply accepted findings, run the full local gate, commit, push, wait for
   green CI at the new head, then rerun with `--session <handle>` so ChatGPT reassesses
   every earlier finding in the same conversation. Each fix pass gets its own pushed
   commit and separately labelled public review comment.

   A **certified head** is a completed pass whose reviewed SHA equals the current PR
   head, verdict `SHIP`, and no accepted actionable findings remaining.

   - First clean pass at the current head → certified; stop reviewing. Never re-review
     an already-certified head — three is a failure ceiling, not a ritual (and the
     script enforces the cap for `pr` mode).
   - **After certification, push nothing.** Any push voids the certification and burns
     another pass — which is why all reconcile commits landed in step 3.3. Ship-log
     comment edits are fine; comments are not commits.
6. **The gate.** Merge automatically — no prompt — only when ALL hold at one exact head:

   - certified head (step 3.5);
   - reviewed SHA equals the current PR head;
   - required CI checks green at that head;
   - branch protection permits the merge.

   Then `gh pr merge <PR> --merge --delete-branch` (the repo's merge-commit
   convention), verify the PR reports `MERGED`, fetch `origin/main` and verify the
   merge, and flip every included ship-log row to `shipped`.

   **Any condition fails** — no certified head after 3 passes, ChatGPT unreachable or
   a pass incomplete, SHA drift, CI red or pending, branch protection refusal —
   → **FULL STOP — human decision needed.** Do not merge. Summarize the PR URL, head
   SHA, CI state, certification state, and every accepted, rejected, and **unresolved**
   finding with its comment URL, then ask the human to rule: merge anyway, leave the
   PR open, or direct further work. Their decision governs.

## 4 — Final report

Report: PR and merge URLs, per-unit shipped/skipped status and why, plan-loop pass
counts, every ChatGPT conversation/comment link, findings
accepted/rejected/unresolved, final head SHA, CI state, and ship-log updates.

## 5 — Friction → memory

If anything needed retries or surprised you (test / env / scope), save a concise memory
so the next `/ship` doesn't repeat it. Record stable process knowledge, not transient
review chronology. The coordinator writes it, never a subagent.
