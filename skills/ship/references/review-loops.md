# The review loops as Workflow scripts

The plan loop (SKILL.md step 2.2) and each code review pass (step 3.5) run as Workflow
scripts, not as prose the coordinator follows by hand. The point is mechanical
enforcement: the pass caps are `for`-loop bounds, the verdict is schema-validated
(fail-closed to REVISE), finding verification fans out one read-only agent per finding,
and a crashed run resumes with `resumeFromRunId` instead of re-orienting.

The scripts live next to this file and are invoked by `scriptPath` — never paste their
bodies inline, and change them here so there is one copy:

- `plan-review-loop.workflow.mjs` — the whole 5-pass plan loop in one run.
- `code-review-pass.workflow.mjs` — exactly one PR review pass per run; the coordinator
  pushes, waits for CI, and re-invokes (the 3-pass cap is enforced by the
  `chatgpt-review` script itself).

These Workflow calls are part of this skill's contract — invoking `/ship` is the
explicit multi-agent opt-in. Workflows run in the background: launch one, then wait for
its task notification; do not poll and do not start other review work meanwhile.

## Hard rules (both loops)

- **Coordinator-only, one at a time.** Agent Chrome is a single session; these
  workflows contain the only permitted `chatgpt-review` invocations, and the
  coordinator never runs two review workflows concurrently — parallel units queue for
  their review loops.
- **The coordinator writes the question/context files first**, including the verdict
  protocol line ("End your review with exactly one line: `VERDICT: …`"). The scripts
  assume it is there; without it every pass fail-closes to REVISE.
- **Findings are never silently dropped.** Every return carries `accepted` and
  `rejected` (with per-finding evidence); the coordinator records them in the ship log
  and final report. `rejected` entries become rebuttals, not deletions.
- **Verify the tree after every workflow** (`git diff`, `git log`, `gh pr list`) — the
  fix and revise agents carry stated mutation boundaries, but a prompt is not an
  enforced restriction.

## Plan loop — `plan-review-loop.workflow.mjs`

```
Workflow {
  scriptPath: "skills/ship/references/plan-review-loop.workflow.mjs",
  args: { planFile: "<abs path>", contextFile: "<abs path>", unitLabel: "#447 phase 2" }
}
```

`planFile` is the review-session identity — the loop's revise agent edits it in place
and the path must never change mid-loop. Inside each pass: one serialized
`chatgpt-review plan` run (with one resume-retry on an incomplete status), parallel
read-only verification of every finding, then a revise agent that folds accepted
findings into the plan and records rejected ones under `## Review responses`.

Returns:

| status | meaning | coordinator action |
|---|---|---|
| `approved` | `VERDICT: APPROVED` on pass ≤ 5 | record passes + conversation URL; tell the worker to re-read the plan file and implement |
| `needs_human` | 5 passes without approval, or a pass stayed incomplete | **FULL STOP** — present `contested`, ask the human |
| `error` | a runner agent died | inspect the workflow journal; re-invoke or stop |

## Code review pass — `code-review-pass.workflow.mjs`

Coordinator loop per pass (max 3; the CLI errors on pass 4):

1. Check out the integration branch in the main tree; update the question file
   (append rebuttals for previously rejected findings).
2. ```
   Workflow {
     scriptPath: "skills/ship/references/code-review-pass.workflow.mjs",
     args: { prUrl, questionFile, session: <handle|null>, pass: <n>,
             integrationBranch: "<branch>", issueRef: "<issue>" }
   }
   ```
3. Act on the return:

| status | meaning | coordinator action |
|---|---|---|
| `certified-pending-proofs` | `VERDICT: SHIP`, no accepted findings | proceed to the gate (step 3.6) — still check SHA match, green CI, branch protection yourself |
| `fixed-await-push` | accepted findings fixed, gate green, local commits made | verify the diff yourself, push, wait for green CI keyed on the head SHA, re-invoke with `pass+1` and the returned `session` |
| `no-accepted-findings` | REVISE, but nothing survived verification | append the rebuttals to the question file; re-invoke (spends a pass) — or go to the gate's FULL STOP if this repeats |
| `fix-failed` | fix agent died or could not reach a green gate | **FULL STOP** at the gate with the gate tail |
| `needs_human` | pass incomplete after the resume-retry | **FULL STOP** at the gate |
| `error` | runner agent died | inspect the journal; the pass may have published — check the PR before re-invoking |

The workflow never pushes: `fixed-await-push` commits stay local until the coordinator
has diffed and pushed them. Certification remains the coordinator's judgment at the
gate; `certified-pending-proofs` is necessary, not sufficient.
