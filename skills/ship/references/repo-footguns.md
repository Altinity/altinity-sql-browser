# Repo footguns — operational knowledge that cost a debugging session each

Read once per `/ship` run (step 1). Every item here was learned the hard way on this
repo; when one bites anyway, update this file in the same change.

## npm, tests, and the gate

- **`ignore-scripts=true` is set in this environment's `.npmrc`** — `pretest` and
  `prebuild` never run, so a green `npm test` proves nothing about tsc, architecture
  boundaries, or schema freshness. The full gate is the explicit chain in
  `per-issue-cycle.md` step 2.
- `npm test` sets `TZ=America/New_York`; a raw `npx vitest` fails ~14 relative-time
  tests. For a single spec file use
  `npx vitest run <file> --config tests/vitest.config.ts` (without `--config` it
  errors "document is not defined") — but gate on `npm test`.
- The coverage table in test output is huge — always capture to a file and Read the
  tail, never let it into context.

## e2e and browsers

- **Adding a bundled runtime dep?** A bare `import … from '<pkg>'` in `src/` breaks
  the **unbundled** e2e harnesses (`tests/e2e/*.html` load `/src` as raw ESM): unit
  tests and the bundle stay green, but the harness module never runs and its specs
  time out on `page.waitForFunction`. Add an import-map entry (or an explicit
  `/node_modules/<pkg>/dist/*.mjs` path, as `pipeline.html` does for dagre) to every
  harness whose module graph imports it. Only e2e catches this.
- An App-shape change must update the fixture `__app` construction in
  `tests/e2e/*.html`, not just the specs.
- A `.js` → `.ts` rename breaks only `test:e2e` (`build/e2e-serve.mjs` shims it).
  Never read a Playwright `N passed` line without also checking for `failed`.
- Firefox cannot launch locally (`unshare CLONE_NEWPID` EPERM) — Chromium + WebKit are
  the local signal; CI supplies Firefox. Missing browsers:
  `npx playwright install chromium webkit`. Since #564, PR CI runs Chromium-only e2e —
  WebKit still needs the local run.
- happy-dom sees no CSS layout — grid/flex/box-model/overflow changes ship green
  through the unit suite. Verify in a real browser (the `run` skill or driven Chrome).
- Focus-restoration and repaint timing race only in real browsers under real suite
  parallelism; a green happy-dom focus test is weak evidence.

## GitHub CLI

- Never the GitHub connector MCP — its collaborator preflight fails for this org.
- Bare `gh issue view` and `gh pr edit` both error on this repo: read with `--json`,
  edit bodies with `gh api -X PATCH … -F body=@<file>`. Never `$(cat …)`/`sed` inside
  a quoted heredoc to build a body.
- **CI waits must key on the head SHA**: `gh run list --limit 1` right after a push
  reports the *previous* head's run. Match on `headSha`.
- A present-but-expired `GITHUB_TOKEN` breaks `git push` and `gh` identically — it
  looks like a network/allowlist failure but isn't; tell the user.

## Git, worktrees, and workers

- In a worktree, local `main` is stale: branch off `origin/main` and scope diffs to
  `origin/main...HEAD`.
- A **resumed worker commits on whatever branch is currently checked out**, not on its
  named branch — check out its branch before `SendMessage`.
- Worktree-isolated agents are pinned to their base commit: untracked files and
  mid-run pushes are invisible to them; `git ls-files` before handing one a relative
  script path.
- Subagents have reverted other workers' edits with `git checkout --` despite
  report-only prompts — diff the tree after every batch.
- Restore a sabotaged *uncommitted* file by writing the saved bytes back, never with
  `git checkout --` (it deletes the uncommitted fix).
- Never `git stash` mid-merge — it silently deletes `MERGE_HEAD` and the next commit
  stops being a merge.

## ChatGPT review (`chatgpt-review`)

- Agent Chrome is **one session**: the coordinator runs every `chatgpt-review`
  invocation itself and serializes them. Parallel workers must never invoke the skill —
  two concurrent runs corrupt each other's conversation.
- A plan review session's identity is the plan file's **absolute path**
  (`plan:<path>`). Revise the same file in place across passes; a moved or renamed
  plan file silently starts a new conversation and loses the reviewer's history.
- The 3-pass cap is script-enforced for `pr` mode only; the 5-pass plan cap exists
  only in the skill text — count passes yourself.

## Local server (`npm run local`)

- If the port is held, kill **your tracked PID** or the process bound to the port —
  never `pkill -f "<command>"`, which kills other sessions' servers.
- Killing the tracked npm PID can orphan `python3 build/local.py` on 8900; check
  `lsof` and kill the orphan too.
- A stale server already serving `dist/` picks up a fresh build per request — usually
  no restart is needed at all.

## Issue and phase state

- PR titles with phase counts (`(2/3)`) go stale when a phase count is re-scoped
  mid-flight (#427 shipped `(1/3)` and `(2/2)`); the `<!-- ship-log -->` comment is
  the only state of record.
- The per-phase `## Tests` subsection often lives *outside* the phase heading — missing
  it is the most common way to under-deliver a phase.
