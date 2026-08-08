---
name: ship
description: Ship altinity-sql-browser roadmap issues or phases end-to-end, autonomously — resolve scope into dependency-ordered units (a phase or a whole issue), then for each unit in turn author and approve its plan with the selected Fable or ChatGPT planner workflow (max 5 review passes), implement code and tests, open that unit's own PR, iterate a ChatGPT code review loop to certification (max 3 passes), and merge automatically when every proof condition holds — auto-chaining to the next unit off the just-merged origin/main with no re-prompting. Stops the whole run only when a unit's plan or merge proof exhausts its review passes; stops only a gated unit's own spine — every other independent unit or spine still ships in the same run — when the issue explicitly gates further phases on a new decision. Invoke as `/ship ISSUE [--planner fable|chatgpt]`, `/ship ISSUE.PHASE`, or `/ship ISSUE1,ISSUE2`.
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

Every unit ships through its own branch, its own PR, its own review loop, and its own
merge — never combined with another unit's diff — and the run auto-chains from one unit
to the next without re-prompting, until a gate, a block, or a failure stop ends that
unit's own dependency spine.

Proceed autonomously, one unit at a time, in dependency order. Each unit gets its own
branch, its own PR, its own code review loop, and its own merge — never squashed into
another unit's diff, whether the units come from one issue's phases or from a
comma-separated issue list. When a unit merges cleanly and step 2.8's gate check finds
nothing blocking the next unit on its spine, the run auto-chains straight into that next
unit off the freshly-fetched `origin/main` — no re-prompting.

There are exactly three stop reasons:

1. a unit's plan is not approved after **5** review passes (step 2.2);
2. a unit's merge proof condition fails at its own gate — including no certified head
   after **3** code review passes (step 2.7);
3. an explicit phase/issue **gate** is reached before starting the next unit on a spine
   (gate detection: step 1, re-checked at step 2.8 for every subsequent unit).

Reasons 1 and 2 are failure stops: they end the **whole run** immediately, right there —
ask the human to rule before attempting anything further, exactly as before. Reason 3 is
different in kind: a gate is a known, *meant* decision point the issue's author already
recorded, not a defect — it stops only that unit's own dependency spine, and the
coordinator keeps going through every other unit and every other independent spine (a
different phase spine that doesn't depend on the gated one, or another issue in a
comma-list) in the same run, reporting the gate distinctly (step 3), never worded as a
generic block.

Everywhere else, an ambiguous or blocked unit (a missing or unmet dependency) is
**skipped and reported**, never guessed at — this is a settled-architecture project;
don't invent decisions.

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

**Coding vs. planning model split.** Within a unit, coding/implementation work
(the worker's implement step, the plan-review loop's finding-verification agents, the
code-review loop's fix-accepted-findings agent) uses `sonnet`. Planning/plan-authoring
work uses `fable` at `effort: "high"` in the default planner mode. With
`--planner chatgpt`, ChatGPT owns every plan draft and revision while Fable/high owns
the read-only approval decision. ChatGPT verifies Fable's own findings itself while
revising — it is the plan's sole author and reviser, and it already performs this kind
of live check unprompted (e.g. confirming an exact npm package version) — so this loop
has no separate Sonnet fact-check pass on Fable's findings the way the default plan
loop and the code review loop do on theirs.
This split is wired into `references/plan-review-loop.workflow.mjs`,
`references/chatgpt-plan-author-loop.workflow.mjs`, and
`references/code-review-pass.workflow.mjs`; keep it there when editing those scripts.

### ChatGPT review loops

- The selected plan loop and the code loop run as **Workflow scripts** —
  `references/plan-review-loop.workflow.mjs` or
  `references/chatgpt-plan-author-loop.workflow.mjs`, then
  `references/code-review-pass.workflow.mjs`, invoked by `scriptPath` per
  `references/review-loops.md`. Invoking `/ship` is the explicit multi-agent opt-in for
  these calls. The caps and the fail-closed verdict parsing are enforced by script and
  schema, not by prose.
- Agent Chrome is a **single session**: the review workflows contain the only permitted
  `chatgpt-review` invocations, the coordinator launches them itself, and never runs
  two review workflows at once — workers and reviewers never invoke the skill, and
  parallel units queue for their review loops.
- The default plan loop and code loop use a **verdict protocol**: the question file
  instructs ChatGPT to end with exactly one `VERDICT:` line and malformed verdicts
  fail closed. The ChatGPT-author loop instead uses the CLI's strict READY/BLOCKED
  authoring protocol plus schema-constrained Fable verdicts. Every loop's pass still
  counts against its cap.
- **Every substantive finding is verified against the real repository before it is
  trusted, by whichever party owns the plan/PR being revised** — never the critic who
  raised it. In the default plan loop and the code review loop that's a separate
  read-only Sonnet verifier per finding, since Fable there is the reviewer of ChatGPT's
  own PR/plan review; in the ChatGPT-author loop, ChatGPT itself (the plan's sole
  author/reviser) verifies each Fable finding while revising, since Fable is read-only
  and cannot confirm exact repository state. Either way, every finding ends in exactly
  one state — accepted-and-fixed, rejected-with-reason, or unresolved — never silently
  dropped: the default/code loops return `accepted` and `rejected` lists to record; the
  ChatGPT-author loop's rejections land as `## Review responses` entries in the plan
  itself, and a `needs_human` outcome there carries the round's raw `findings`.

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
| `/ship 447 --planner chatgpt` | same scope, with ChatGPT authoring/revising and Fable/high approving the plan |

Parse the invocation with `references/parse-invocation.mjs`. `--planner` accepts
`fable` or `chatgpt` and defaults to `fable`, so every existing invocation remains
behavior-compatible. The legacy word `unattended` is accepted and ignored.

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

### Gate detection

Run this once here for the whole wave plan, and again at step 2.8 before every
subsequent unit, always against a **freshly re-fetched** issue body — never reuse a
cached read from a previous unit. A **gate** is a known, authored decision point —
distinct from a block (a missing or unmet dependency, handled above).

Look for, in this order:

1. **The authoring convention (primary signal).** A blockquote directly under the
   affected `## Phases` checklist row(s), e.g.:

   ```markdown
   - [ ] 2 — official transport implementation
   > **Gate:** Phases 2-4 do not proceed without a new decision.
   ```

   Parse exactly which unit(s) it names — a single phase, a range, or the blanket form
   below — never guess a narrower or wider scope than stated.
2. **Fallback prose scan, for issues written before this convention existed.** Scan the
   issue body — the global lead-in prose above `## Phases` and each phase's own
   section — case-insensitively for stop language, including at least: "do not proceed
   without a new decision", "does not proceed without", "requires a new decision", and
   the blanket form "human merge gate between every phase" (covers *every* remaining
   phase boundary in that issue, not just a named range).

A prior unit's own recorded outcome (an ADR marked Accepted or Rejected, a decision
logged in the ship log) is context worth reporting alongside a gate — it explains *why*
the gate is active — but it never self-clears a gate by the coordinator's own
inference; only a visible edit to the live issue text does.

An explicitly forced single-unit invocation (`/ship 447.2`) is the human's own override
for that one named unit — it proceeds even if a gate nominally covers it, but surface
the gate text in the plan-assembly summary so the override is visible in the record.
Any unit the run later auto-chains to is still subject to normal gate detection.

A gate found here stops **that unit's own dependency spine only**, from the gated unit
onward, and is reported as a gate (step 3), never folded into the generic "blocked"
wording; every other unit and every other independent spine in the same invocation
still proceeds.

### Wave plan and per-unit branch

- Sequence the dependency spine. Parallelize only units whose planned file footprints
  are disjoint — when in doubt, serialize; a merge conflict costs more than lost
  parallelism. Phases of one issue are almost always a spine, not a wave; separate
  issues in a comma-list are usually independent spines unless one's `Depends on:`
  header names another.
- **One branch, one PR, per unit — never a shared integration branch for the whole
  run.** Each unit's cycle (step 2) cuts its own branch off the freshly-fetched remote
  default: `git fetch origin && git checkout -b <type>/<slug> origin/main`. Push
  immediately so CI runs from the start. (In a worktree, local `main` is stale — see
  footguns.) A unit always branches off `origin/main`, never off another unit's still-
  open branch or PR, so it starts from whatever the previous unit on its spine already
  merged.
- Independent spines (disjoint footprints, no dependency between them) may implement
  concurrently in separate worktrees, but the single Agent Chrome session still means
  their code review loops and merges serialize — queue them, and if a queued unit's
  branch base has moved since it branched, re-fetch `origin/main` into it immediately
  before its own review loop starts (should be conflict-free given disjoint footprints;
  treat any conflict as a red flag, not something to force through).
- Run `npm ci` when dependencies may have changed or `node_modules` is absent.

## 2 — Per unit (auto-chained through the spine, one PR each)

### 2.1 Establish the canonical plan path

For every planner mode, assign the exact path `$TMPDIR/plan-<ISSUE>p<N>.md` (or
`$TMPDIR/plan-<ISSUE>.md` unphased). The path is part of the review-session identity;
never move, rename, or substitute it during the loop.

**Default `fable` planner:** spawn the plan-only agent below. **ChatGPT planner:** do
not spawn this initial planner; step 2.2's dedicated workflow owns every draft and
revision.

Fresh agent (`subagent_type: "general-purpose"`, **never `fork`** — a fork inherits
this in-progress mutating workflow and can conclude it should finish the whole job).
`model: "fable"`, `effort: "high"` — planning is a distinct role from implementation
(see "Coding vs. planning model split" above) and this agent's only deliverable is the
plan; it is never resumed for implementation (2.3 spawns a separate, fresh coding
agent instead). Parallel planners still get `isolation: "worktree"` if the unit's
later implementation will need it; a solo unit may target the main tree on
`wip/<unit>-<slug>` off this unit's own branch HEAD (the coding agent in 2.3 checks
out the same branch).

The planner prompt must contain, explicitly:

- the issue number, the phase (if any), and the instruction to load the body with
  `gh issue view <n> --json body -q .body` and treat the **assembled delivery
  contract** as the definition of done — implement list + `## Tests` subsection +
  acceptance gate + named subset of global criteria;
- **the mutation boundary**: this agent only ever writes the plan file below — no
  Edit/Write to any repo file, no git or `gh` mutations, no issue edits, no ship-log
  writes, no memory writes, no TaskCreate/TaskUpdate, and never invoke
  `chatgpt-review` (the coordinator owns all review sessions);
- the instruction to follow `skills/ship/references/per-issue-cycle.md` step 1 plus
  `references/repo-footguns.md`;
- **its only deliverable is the plan**: write it (cycle step 1) to the exact path
  `$TMPDIR/plan-<ISSUE>p<N>.md` (or `$TMPDIR/plan-<ISSUE>.md` unphased), return the
  plan summary and that path **without writing any code**. This agent is not resumed
  afterward — 2.3 spawns a separate, fresh coding agent once the plan is approved.

A planner that reports the unit ambiguous or dependent on an unrecorded decision →
skip the unit, report the missing decision in the final report, move on.

### 2.2 Plan author/review loop — one Workflow run, every unit, max 5 review passes

**Read `references/review-loops.md`** (once per run) — it is the contract for both
loops. The plan file **path** is the review-session identity; never move or rename it
mid-loop (footguns).

1. Write a context file to `$TMPDIR`: the issue URL, unit contract and acceptance
   subset, and focused questions. For the default planner, also include the verdict
   protocol — "End your review with exactly one line: `VERDICT: APPROVED` or
   `VERDICT: REVISE`."
2. Launch exactly one selected loop as a Workflow and wait for its task notification.
   For the default `fable` planner:

   ```
   Workflow {
     scriptPath: "skills/ship/references/plan-review-loop.workflow.mjs",
     args: { planFile: "<abs>", contextFile: "<abs>", unitLabel: "#<ISSUE> phase <N>" }
   }
   ```

   Inside, each pass runs one serialized `chatgpt-review plan` call, verifies every
   finding with parallel read-only agents, and folds accepted findings into the plan
   file in place (rejected ones become `## Review responses` rebuttals). The 5-pass
   cap is a loop bound in the script, not an instruction.
   For `--planner chatgpt`:

   ```
   Workflow {
     scriptPath: "skills/ship/references/chatgpt-plan-author-loop.workflow.mjs",
     args: { issueUrl: "<canonical issue URL>", planFile: "<abs>",
             contextFile: "<abs>", unitLabel: "#<ISSUE> phase <N>" }
   }
   ```

   ChatGPT privately authors a complete standalone plan through `plan-author`; Fable
   at high effort reviews it read-only against the actual repository. Fable's raw
   findings — labelled unverified, since Fable cannot confirm exact repository state —
   are passed straight back to ChatGPT, which verifies each one itself (it already does
   this kind of live check unprompted) and atomically replaces the canonical plan with
   a complete revision in the same conversation, recording anything it rejects under
   `## Review responses`. The workflow performs at most five Fable review passes.
   ChatGPT alone owns drafts, revisions, and verifying findings against them; Fable/high
   alone owns approval.
3. `status: "approved"` → record the pass count and conversation URL for the ship log;
   proceed to 2.3.
4. `status: "blocked"` → skip the unit and report the concrete missing decision; do
   not guess and do not treat this as a review-loop exhaustion.
5. `status: "needs_human"` → **FULL STOP — human decision needed.** Present the latest
   plan, the last pass's returned findings (`contested` from the default loop,
   `findings` from the ChatGPT-author loop), and the conversation URL, and ask the
   human: approve the latest plan, redirect, or skip the unit. Write no code for this
   unit before that decision. (`status: "error"` → read the workflow journal, then
   re-invoke or stop.)

### 2.3 Implement

**High risk + Large unit → decompose instead of one implementer.** If the approved
plan's own risk classification (`per-issue-cycle.md`) states High risk **and** Large,
do not spawn a single implementation agent for the whole plan — a unit that size
reliably exhausts one agent's context before finishing (observed live: a ~30-file,
Docker/live-server/browser-matrix unit hit ~65% context after its first commit). Run:

```
Workflow {
  scriptPath: "skills/ship/references/decompose-and-implement-loop.workflow.mjs",
  args: { planFile: "<abs>", branch: "<wip branch>", issueRef: "#<ISSUE> phase <N>" }
}
```

Fable/high reads the plan **and the actual repository state already on the branch**
(so it excludes whatever a prior partial attempt already committed) and proposes an
ordered, dependency-respecting sub-task breakdown, sized so one coding agent can
plausibly finish each in one session. The script then runs one fresh Sonnet agent per
sub-task, strictly **sequentially** on the same branch (not parallel worktrees —
sub-task file-scope disjointness is a declared claim, not a verified guarantee, and
the point is giving each chunk fresh context, not wall-clock speed). Each sub-task
commits before the next starts. If a running single-agent attempt already exists and
is approaching its own limit, stop it at a clean commit boundary (`TaskStop`, verify
`git status` is clean first) before invoking this loop — its committed work becomes
what the decomposition step reads as already-done. Treat the loop's `error` status
(a sub-task's agent died) the same as any implementation failure: inspect, fix or
resume, re-verify — do not silently skip the remaining sub-tasks.

**Otherwise** (the common case), spawn a **fresh** coding agent (`subagent_type:
"general-purpose"`, never `fork`, `model: "sonnet"` unless the wave plan marks the unit
high-risk, in which case omit `model` to inherit yours) — do not resume any planner;
the canonical plan file, not planner memory or ChatGPT chat text, is the handoff.
Parallel units get `isolation: "worktree"`; a solo unit uses the main tree on
`wip/<unit>-<slug>` off this unit's own branch HEAD.

The coding-agent prompt must contain, explicitly:

- the issue number, the phase (if any), and the instruction to read the approved plan
  file at its exact path and implement it verbatim — the plan is the definition of
  done, not the issue body (the approved plan already reconciled the two);
- **the mutation boundary**: Edit/Write + local `git commit` on its own branch only —
  no push, no PR, no `gh` mutations, no issue edits, no ship-log writes, no memory
  writes, no `CHANGELOG.md` beyond its own entry, no TaskCreate/TaskUpdate, and never
  invoke `chatgpt-review` (the coordinator owns all review sessions);
- the instruction to follow `skills/ship/references/per-issue-cycle.md` steps 2–3 and
  the CHANGELOG part of step 4 — **the ship log is yours, not the worker's** — plus
  `references/repo-footguns.md`;
- commit message `<type>(#<ISSUE>): <summary>` + the repo footer convention;
- what to return: invariant map, files touched, gate/e2e output tail, sabotage-case
  results, and the contract checklist with each item ticked or explained.

### 2.4 Verify, review, integrate, log

- **Verify yourself** — never trust the self-report. `git log` / `git diff` the worker
  branch, rerun the full local gate in that tree.
- **Internal review budget** — the risk-based budget of cycle step 3: no reviewer for
  low-risk units; one targeted read-only reviewer (`model: "sonnet"`, boundary stated)
  for medium/high, prompted with the unit's contract + CLAUDE.md hard rules. Real
  findings → back to the worker (`SendMessage`, branch checked out first) or a bounded
  fix agent; re-verify. Do not add generic per-unit review passes on top.
- **High-risk pre-PR pass, in place of the old whole-run review.** With one unit per PR
  there is no whole-run accumulated diff left to review at the end — if this unit
  itself is classified High risk (`per-issue-cycle.md`), or its implementation ran
  through the decompose-and-implement loop (2.3) with more than one sub-task, add one
  additional targeted read-only pass over this unit's *complete* branch diff at high
  effort before opening its PR (plus the `security-review` skill if anything touched
  auth/config). Do not stack this on top of the Medium/High budget above if that review
  already covered the whole diff at high effort.
- **Integrate**: merge the worker branch into this unit's own branch (you resolve
  conflicts — you are its only writer), rerun the gate, push. Key every CI wait on the
  head SHA (footguns) and check it before the next unit on this spine. Red CI stops the
  line until fixed.
- **Log**: append the unit's handoff block to the `<!-- ship-log -->` comment now,
  status `in review` until this unit's own PR merges. Include the plan-review outcome
  (passes, conversation URL).

After every batch, regardless of what agents reported: `git diff`, `git log`,
`gh pr list`. An instruction in a prompt is not an enforced tool restriction, and
review agents on this repo have edited files despite an explicit report-only boundary.

### 2.5 Reconcile and open this unit's PR

1. Confirm required CI checks are green at this unit's current head. The e2e signal is
   layered: workers ran Chromium + WebKit locally per the cycle; PR CI adds its
   Chromium e2e run (#564); Firefox comes only from the CI jobs that provide it.
2. **Reconcile per cycle step 4 — this unit's own entry only.** One unit per PR means
   there is no other unit's CHANGELOG entry sharing this diff to dedupe against: update
   `CHANGELOG.md` under `[Unreleased]` for this unit alone, close or reconcile any issue
   this unit itself supersedes, and tick only this unit's own `## Phases` row (if the
   issue carries that checklist). All of this lands **now, before the PR** — nothing may
   be pushed after certification (2.6).
3. **Open this unit's PR** (`gh pr create --base main`), title `<type>(#<ISSUE>):
   <summary>` — a phase marker like `(phase N)` is a convenience for a human skimming
   the issue's PR list, never the state of record (footguns: PR titles go stale); body
   per `.github/PULL_REQUEST_TEMPLATE.md` covering this unit's contract coverage,
   invariant verification, sabotage cases, tests, build, and e2e results; `Closes #<n>`
   only if this unit completes the whole issue, `Part of #<n>` otherwise; the repo PR
   footer.

### 2.6 Code review loop — max 3 passes, this unit's PR only

Exactly the mechanics of the single-PR loop, scoped per unit: `pass` and `session`
start over at 1 / `null` for every unit's PR — never carry a pass count or a `session`
handle over from a previous unit's loop, even on the same spine.

Write a question file to `$TMPDIR`: this unit's contract and acceptance subset, its
invariant map, compatibility requirements, tests and sabotage cases, the behaviors that
need adversarial review, and the verdict protocol — "End your review with exactly one
line: `VERDICT: SHIP` or `VERDICT: REVISE`." Then, with this unit's branch checked out
in the main tree, per pass:

```
Workflow {
  scriptPath: "skills/ship/references/code-review-pass.workflow.mjs",
  args: { prUrl, questionFile, session: <handle|null>, pass: <n>,
          integrationBranch: "<this unit's branch>", issueRef: "<issue>",
          seedFromSession: <this unit's plan-loop session handle, pass-1 only> }
}
```

(`integrationBranch` is the script's existing argument name — pass this unit's own
branch into it; no script edit is required.) **On pass 1 only** (`session: null`), pass
`seedFromSession` as the session handle returned by this unit's plan loop (step 2.2) —
`chatgpt-review.mjs pr`'s own `--seed-from-session` flag threads that existing ChatGPT
conversation into the brand-new pr-mode session instead of opening a fresh chat, so
planning and code review land in the one conversation `references/review-loops.md`'s
"one unit, one ChatGPT session" rule requires. On pass 2/3 (`session` is now the
code-review loop's own returned handle from pass 1), omit `seedFromSession` — `session`
alone resumes that conversation.

The pass reviews (publishing a PR comment), verifies every finding with parallel
read-only agents, and — when findings are accepted — applies the fixes with tests,
loops the full local gate to green, and commits **locally only**. Act on the return
per the table in `references/review-loops.md`:

- `fixed-await-push` → diff the commits yourself, push, wait for green CI keyed on the
  head SHA, re-invoke with `pass+1` and the returned `session` handle so ChatGPT
  reassesses every earlier finding in the same conversation. Each fix pass gets its own
  pushed commit and separately labelled public review comment.
- `no-accepted-findings` → append the rebuttals to the question file and re-invoke
  (spends a pass).
- `fix-failed`, `needs_human`, `error` → treat as a failed proof condition at the gate
  (2.7).

A **certified head** is a `certified-pending-proofs` return (completed pass, verdict
`SHIP`, no accepted findings) whose reviewed SHA equals this unit's current PR head.

- First clean pass at the current head → certified; stop reviewing. Never re-review an
  already-certified head — three is a failure ceiling, not a ritual (and the
  `chatgpt-review` script enforces the cap for `pr` mode).
- **After certification, push nothing.** Any push voids the certification and burns
  another pass — which is why all reconcile commits landed in 2.5. Ship-log comment
  edits are fine; comments are not commits.

### 2.7 The gate — merge this unit

Merge automatically — no prompt — only when ALL hold at one exact head:

- certified head (2.6);
- reviewed SHA equals this unit's current PR head;
- required CI checks green at that head;
- branch protection permits the merge.

Then `gh pr merge <PR> --merge --delete-branch` (the repo's merge-commit convention),
verify the PR reports `MERGED`, fetch `origin/main` and verify the merge, and flip this
unit's own ship-log row to `shipped`.

**Any condition fails** — no certified head after 3 passes, ChatGPT unreachable or a
pass incomplete, SHA drift, CI red or pending, branch protection refusal — → **FULL
STOP, right now, for the whole run.** Do not merge, and do not attempt any further unit
or spine. Summarize the PR URL, head SHA, CI state, certification state, and every
accepted, rejected, and **unresolved** finding with its comment URL, then ask the human
to rule: merge anyway, leave the PR open, or direct further work. Their decision
governs. **Even after the human rules and a real fix lands, do not open a fresh
ChatGPT session to re-certify it** — continue the SAME session this unit has used since
its plan was authored (see `references/review-loops.md`'s "one unit, one ChatGPT
session" rule); a fresh session throws away everything already reviewed.

### 2.8 Before the next unit: re-check the gate, then auto-chain or stop

This unit just merged. Before cutting the next unit's branch:

1. Re-fetch the issue body (and the ship-log comment) fresh — never reuse step 1's
   cached read. Re-run gate detection (step 1) against the *specific* next unit on this
   spine.
2. **No gate applies** → auto-chain immediately: `git fetch origin`, cut the next
   unit's branch off `origin/main` (as in step 1's wave plan), and continue at 2.1. No
   re-prompting, no human confirmation needed.
3. **A gate applies** → stop this spine here. Report it as a gate (step 3), quoting the
   exact trigger text/blockquote, its scope, and the just-landed unit's own recorded
   outcome as context. Move on to the next unit on any *other* independent spine in
   this run (a different phase spine, or another issue in a comma-list) — a gate never
   halts the whole run, only the spine it names.
4. If this spine has no more units and no other spine is pending either, proceed to
   the final report (step 3).

## 3 — Final report

Report per unit — a run can now produce several PRs and several merges:

- **Shipped units**: PR URL, merge URL, merged head SHA, CI state, plan-loop pass count
  + conversation URL, code-review pass count + every ChatGPT conversation/comment link,
  findings accepted/rejected/unresolved, and confirmation the ship-log row now reads
  `shipped`.
- **Gated units**: the exact trigger text (blockquote or matched prose, quoted
  verbatim) and its source, which unit(s) it covers, and — when it follows a unit that
  just landed — that unit's own recorded outcome as context. State plainly this is a
  known, authored decision point, distinct from a block.
- **Blocked units**: the concrete missing dependency or unrecorded decision, exactly as
  before.
- **The unit that triggered a failure stop, if the run ended in one** (step 2.2's
  5-pass plan exhaustion, or step 2.7's 3-pass merge-gate exhaustion): PR URL if one
  exists, head SHA, CI state, certification state, every accepted/rejected/unresolved
  finding with its comment URL, and every unit and spine the run did not reach because
  of it.

A failure stop (not a gate, not a block) ends the run immediately at that unit — ask the
human to rule (merge anyway, redirect, or skip) before anything past that point is
attempted, exactly as today. A gate or a block never halts the run this way: the
coordinator keeps going through every other unit and spine it still can, and only lists
gated/blocked units in this same report at the end.

## 4 — Friction → memory

If anything needed retries or surprised you (test / env / scope), save a concise memory
so the next `/ship` doesn't repeat it. Record stable process knowledge, not transient
review chronology. The coordinator writes it, never a subagent.
