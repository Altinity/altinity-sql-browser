---
name: ship
description: Ship one altinity-sql-browser roadmap issue end-to-end — plan, implement code+tests, self-review, open a PR — and stop at the human merge gate. Multi-phase issues ship one PR per phase, one session per phase. Invoke as `/ship <issue>`, `/ship <issue>.<phase>`, or `/ship <issue> unattended`.
---

# /ship — drive a roadmap issue (or one of its phases) through the full cycle

This runs the ship cycle for the **altinity-sql-browser** repo; if the current working
directory isn't that repo, stop and say so.

Be coordinator. Run subagents with a model suited to the subtask: advanced model/reasoning
for complicated work such as planning and review, a cheap model for simple operations like
searching/editing files or GitHub queries.

Follow `CLAUDE.md` throughout (hard rules 1–5 + the Working-discipline section). Proceed
autonomously on the routine path; **stop and ask only at the points marked 🛑** — except in
unattended mode, which has no gates but the last (see step 0).

> Sandbox note: `grep` in Bash is intercepted here — use `rg PATTERN > "$TMPDIR/out"` then
> Read, never pipe to `grep`. Capture long command output to a file and Read it (e.g.
> `npm test > "$TMPDIR/test.log" 2>&1`), and Read only the tail on green / only the matched
> failures on red. The coverage table is long and is the biggest accidental context sink in
> a run.

> GitHub note: **use the authenticated `gh` CLI directly; never the GitHub connector** — its
> collaborator preflight is known to fail for this Altinity organization repo. On this repo
> a bare `gh issue view` and `gh pr edit` both error: read with `--json`, and edit PR/issue
> bodies with `gh api -X PATCH`. Never build a body with `$(cat …)`/`sed` inside a quoted
> heredoc — write the body to a file and pass `-F body=@<file>`.

> Parallel / worktree note: this skill assumes it **owns its working directory**. To run
> several `/ship`s at once, launch each session with `claude --worktree <name>` — **never run
> two `/ship`s in the same dir**. Only parallelize dependency-independent work.

> Subagent note: any `Agent` call this skill makes — planning, review, analysis — is
> **read-only by default**, and inherits this entire file plus CLAUDE.md just by being spawned
> mid-run. Inheriting these steps is not the same as being told to execute them. State the
> boundary explicitly in every subagent prompt (no Edit/Write, no git/gh mutating commands, no
> TaskCreate/TaskUpdate, no memory writes — return only the requested output), and prefer a
> fresh non-`fork` agent for this kind of fan-out. **Steps 5–7 — reconcile, PR, and the merge
> gate — are performed by this session only, never delegated.** After any batch of subagents
> returns, verify with `git diff`, `git log`, and `gh pr list` before trusting a self-report.

## 0 — Resolve the argument

| Invocation | Mode | Scope |
|---|---|---|
| `/ship 447` | attended | the **next unshipped phase** of #447 (or the whole issue if it has no phases) |
| `/ship 447.2` | attended | phase 2 of #447, forced |
| `/ship 447 unattended` | coordinator | all remaining phases of #447, no gates |
| `/ship 424,425,426 unattended` | coordinator | several whole issues, no gates |

Attended is always the default. **Unattended requires the literal word** — never infer it.

For unattended, Read `references/unattended.md` now and follow it; it replaces steps 1, 6 and
7 below and reuses steps 2–5 as the worker contract.

## 1 — Orient, resolve the phase, set up the workspace

**Load the issue to a file, not into context:**

```sh
gh issue view <ISSUE> --json body -q .body > "$TMPDIR/issue-<ISSUE>.md"
```

**Detect the phase structure**, in this order of precedence:

1. a `## Phases` checklist of `- [ ] N — title` rows → those are the phases;
2. `### Phase N …` headings (e.g. `### Phase 1 / PR 1 — Hard removal…`, typically under a
   `## Delivery phases` section) → those are the phases;
3. neither → the issue is single-phase; ship it whole, exactly as before.

**Read the phase log** — the authoritative record of what has already shipped. Never infer
state from PR titles: they go stale when a phase count is re-scoped mid-flight (#427 shipped
PRs titled `(1/3)` and `(2/2)`).

```sh
gh api repos/{owner}/{repo}/issues/<ISSUE>/comments --paginate \
  --jq '.[] | select(.body | startswith("<!-- ship-log -->")) | .id' > "$TMPDIR/logid"
```

If it exists, read that comment's body; the first phase not marked `shipped` is the target
(unless `/ship <ISSUE>.<N>` forced one). If it doesn't exist, the target is phase 1.

**Read only what this phase needs.** From `$TMPDIR/issue-<ISSUE>.md`, Read: the header
(depends-on / supersedes / owner decisions), the phase list, the target phase's own section,
its matching `### Phase N` subsection under `## Tests` if the issue splits tests that way,
the global `## Acceptance criteria`, and `## Non-goals`. **Skip the other phases' detail** —
it is spec you are not implementing this run.

**Assemble the phase contract.** A phase's definition of done is the *union* of:

- the phase section's own implement list;
- the matching per-phase `## Tests` subsection, if the issue keeps tests in a separate section;
- any acceptance-gate blockquote inside the phase section;
- the subset of the global `## Acceptance criteria` this phase claims — **name that subset
  explicitly in the plan**, so the remainder is visibly deferred rather than silently dropped;
- `## Non-goals`, which always applies.

Missing the per-phase `## Tests` subsection because it lives outside the phase heading is the
most likely way to under-deliver a phase. Check for it every time.

**🛑 Check dependencies for *this phase*, not just the issue.** Phase-level blockers are real:
a later phase can depend on an issue the earlier ones don't. Check the issue's `Depends on:`
header *and* any issue referenced by the target phase's own section. Blocked → stop, say which
phase is blocked on what, and offer the highest unblocked phase instead.

**🛑 Decide the branch model** (once per issue, recorded in the phase log):

> Can each phase land on `main` green **and** self-consistent — additive, behind a flag, or
> pure-logic-then-wire?

- **Yes → one branch per phase off fresh `main`.** This is the default.
  `git fetch && git checkout main && git pull && git checkout -b <type>/<slug>-<ISSUE>p<N>`.
  Each phase gets its own PR and its own human merge gate.
- **No → one integration branch for the whole issue**, off `origin/main`, one PR at the end.
  Say so explicitly and record it in the phase log.

Call out the revert cost when a phase is subtractive: once a phase that *deletes* a subsystem
is on `main`, backing it out alone is expensive. That is a reason to raise it with me, not a
reason to silently switch models.

For a single-phase issue: branch `<type>/<slug>-<ISSUE>` (e.g. `feat/webkit-e2e-69`), off
`main` — or off the dependency branch if it builds on **unmerged** work.

**Deps:** if `node_modules` is missing (fresh worktree), run `npm ci` before any `npm test` /
`npm run build`. After a `git pull` on `main`, run `npm ci` immediately rather than waiting
for `pretest` to fail on a newly merged dependency.

## 2–5 — The per-issue cycle

**Read `references/per-issue-cycle.md` now**, before writing any plan or code, and follow it.
It holds plan → implement → review → reconcile, and it is the same contract unattended workers
are held to — one source of truth, so the two paths cannot drift.

## 6 — PR

- Performed by **this session only** — never delegate the commit/push/PR-create sequence.
- Commit using the repo's footer convention (Co-Authored-By + Claude-Session).
  `git push -u origin <branch>`.
- `gh pr create --base main` — title + body per `.github/PULL_REQUEST_TEMPLATE.md`.
- Title: `<type>(#<ISSUE>): <summary>` — for a phase, append ` (phase <N>)`. Do **not** encode
  a running count like `(2/3)`; the phase log owns the count and totals change.
- Body: **`Closes #<ISSUE>`** only when this PR completes the *whole issue* — i.e. it is the
  final phase. Every earlier phase uses **`Part of #<ISSUE>`**.
- Tick the checklist (gate, layers, deps, CHANGELOG, reconcile). Report the **PR URL**.

## 7 — 🛑 Merge gate — STOP

Do **not** merge. Merging to `main` is a human call.

1. Confirm the phase log comment from step 5 is already posted and names this PR.
2. Summarise what shipped and give the PR link.
3. `npm run local` to serve the just-built app for manual testing. If another process holds
   the port, kill **your tracked PID** or the process bound to that port — never
   `pkill -f "<launch command>"`, which kills other sessions' servers. Killing the tracked
   npm PID can leave `python3 build/local.py` orphaned on 8900; check `lsof` and kill the
   orphan too. A stale server already serving `dist/` picks up a fresh build per request, so
   usually no restart is needed at all.
4. **If phases remain, end with the session-reset instruction**, verbatim in substance:

   > Phase `<N>` is up as PR `<url>`. Once you've merged it, start a **fresh session** —
   > `/clear`, then `/ship <ISSUE>` — to pick up phase `<N+1>`. Don't resume this one with
   > `claude --continue` / `--resume`; that restores this context instead of clearing it.

   Context does not reset on its own. Running `/ship <ISSUE>` again in *this* session stacks
   the next phase's plan, implementation, test output and review on top of everything above,
   which is what auto-compaction then eats unpredictably. The fresh session is safe **only
   because step 5 wrote the handoff to the issue first** — this conversation is not the record.

## After — friction → memory

If anything needed retries or surprised you (test / env / scope), save a memory so the next
`/ship` doesn't repeat it. This session does the saving, not a subagent it spawned.
