---
name: ship
description: Ship one altinity-sql-browser roadmap issue end-to-end — plan, implement code+tests, self-review, open a PR — and stop at the human merge gate. Invoke with an issue number (e.g. `/ship 69`).
---

# /ship — drive one roadmap issue through the full cycle

You were invoked as `/ship <issue-number>`. The **issue number is the argument you were given** — call it `<ISSUE>` below. This runs the per-issue cycle for the **altinity-sql-browser** repo; if the current working directory isn't that repo, stop and say so.

Follow `CLAUDE.md` throughout (hard rules 1–5 + the Working-discipline section). Proceed autonomously on the routine path; **stop and ask only at the points marked 🛑**.

> Sandbox note: `grep` in Bash is intercepted here — use `rg PATTERN > "$TMPDIR/out" && Read`, never pipe to `grep`. Capture long command output to a file and Read it (e.g. `npm test > "$TMPDIR/test.log" 2>&1`).

> Parallel / worktree note: this skill assumes it **owns its working directory**. To run several `/ship`s at once, launch each session with `claude --worktree <name>` so they don't collide on git state or files — **never run two `/ship`s in the same dir**. Only parallelize dependency-independent issues (see #68's Parallelization section); never run an issue against an unmerged dependency.

> Subagent note: any `Agent` call this skill makes — for planning, review, or analysis — is **read-only** by default, and inherits this entire file plus CLAUDE.md just by being spawned mid-run. Inheriting these steps is not the same as being told to execute them. State the boundary explicitly in the subagent's prompt (no Edit/Write, no git/gh mutating commands, no TaskCreate/TaskUpdate, no memory writes — return only the requested output), and prefer a fresh non-fork agent over `fork` for this kind of fan-out. **Steps 5–7 — reconcile, PR, and the merge gate — are performed by this session only, never delegated to a subagent.** After any batch of subagents returns, verify with `git diff`, `git log`, and `gh pr list` before trusting a self-reported summary.

## 1 — Orient & set up the workspace
- `gh issue view <ISSUE>` — read Goal / scope / Key implementation / **Acceptance criteria** (and any "Reconciled" banner).
- Read its place in the roadmap **#68** (which phase; what it depends on; the Parallelization section). 🛑 If a hard dependency is unfinished (e.g. this needs CM6 #21 first), stop and tell me — don't build out of order.
- **Pick the right base.** If `<ISSUE>` is independent or builds only on *merged* work → branch off `main`: `git fetch && git checkout main && git pull`. If it builds on **unmerged** work (e.g. the signals foundation in PR #89), branch off **that** branch instead (`git checkout <dep-branch>`) or wait for it to merge — branching off `main` would build against stale code and conflict.
- `git checkout -b <type>/<slug>-<ISSUE>` (e.g. `feat/webkit-e2e-69`, `refactor/editor-port-21`).
- **Deps:** if `node_modules` is missing (fresh worktree), run `npm ci` before any `npm test` / `npm run build`.

## 2 — Plan
- **Always write the plan — no issue skips this, however small or well-specified.** From the Acceptance criteria, state: files to touch (pure logic → `src/core/`, render → `src/ui/`; any library/DOM call behind an **injected seam** per rules 2/4/5), the test files you'll add/extend, and the migration order. Produce this write-up unconditionally before touching code.
- 🛑 If the issue is ambiguous, under-specified, or needs a decision **not** already recorded (issue body / `docs/ADR-0001-reactivity.md` / CLAUDE.md), stop and ask. This is a settled-architecture project — don't invent decisions.
- **High-risk issues get a deeper plan review.** If this is a framework/dependency swap or a large multi-file rewrite — currently **#21** (CM6 / `EditorPort`) and **#66** (graph multi-select), or any issue you judge under-determined despite its Acceptance criteria — then **before writing code**: (1) **second opinion** — spawn a `Plan` subagent (Agent tool, `subagent_type: "Plan"`) to independently stress the approach (seams, migration order, coverage strategy, rollback) and fold its critique into the plan; (2) **🛑 post the resulting plan and wait for my approval** (I review on mobile). Skip this for the well-specified, low-risk issues.
- The plan write-up above is required either way; for well-specified, low-risk issues you proceed straight from it (no approval gate — most issues carry Acceptance criteria and need none).

## 3 — Implement (inner loop)
- Write the code **and its tests in the same change** (rule 1). Keep `src/core/` pure at 100%; keep new third-party / DOM / high-frequency-pointer code behind an injected seam so the per-file gate holds (rule 5).
- Loop until green: `npm test` (the **100/100/100/100 per-file gate**) and `npm run build`. Never proceed on a red suite or a broken build.
- **Adding a bundled runtime dep?** A bare `import … from '<pkg>'` in `src/` breaks the **unbundled** e2e harnesses (`tests/e2e/*.html` load `/src` as raw ESM) — even though `npm test` and the bundle pass, the harness's module never runs and its specs time out on `page.waitForFunction`. Add an import-map entry (or explicit `/node_modules/<pkg>/dist/*.mjs` path, like `pipeline.html` does for dagre) to every harness whose module graph imports it — e.g. CM6 (#21) needs `@codemirror/*` mapped in `editor.html`. Only e2e (CI) catches this; see memory [[e2e-harness-bare-imports]].

## 4 — Review (the cycle, before the PR)
- `/code-review` on the working diff → apply real findings → re-run `npm test`.
- `/security-review` as well if it touches auth / OAuth / `config.json`.
- For the high-risk phases (CM6 #21, schema graph #66): `claude ultrareview` on the branch for an independent multi-agent pass; address what it surfaces.
- **UI-visible change → run `npm run test:e2e`** (Playwright, all three engines). If browsers aren't installed yet: `npx playwright install chromium firefox webkit`. Fix any failures before opening the PR. Then also verify behaviour with the `verify` / `run` skill or agent Chrome.

## 5 — Reconcile (Working-discipline, same change)
- If this reshaped tracked work, reconcile it now: the **#68** checklist, the issue body's Goal/Acceptance, the relevant **ADR** addendum, and **CHANGELOG.md `[Unreleased]`**.
- An out-of-scope bug / footgun you spotted → open a **separate** issue labelled **`inbox`** (file:line + why deferred) and mention it; don't fold it into this PR.

## 6 — PR
- Performed by **this session only** (see the subagent note above) — never delegate the commit/push/PR-create sequence to a spawned agent.
- Commit using the repo's footer convention (Co-Authored-By + Claude-Session). `git push -u origin <branch>`.
- `gh pr create --base main` — title + body per `.github/PULL_REQUEST_TEMPLATE.md`; **`Closes #<ISSUE>`** if it fully satisfies the issue, else **`Part of #<ISSUE>`**. Tick the checklist (gate, layers, deps, CHANGELOG, reconcile).
- Report the **PR URL**.

## 7 — 🛑 Merge gate — STOP
Do **not** merge. Summarise what shipped and the PR link, run `npm run local`
to serve the just-built app for manual testing, and wait. If there is another
serving process on the same machine, kill the process to retake the port.
Merging to `main` is a human call.

## After — friction → memory
If anything needed retries or surprised you (test / env / scope), save a memory so the next `/ship` doesn't repeat it. This session does the saving, not a subagent it spawned.
