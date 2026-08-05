# The review loops as Workflow scripts

The selected plan loop (SKILL.md step 2.2) and each code review pass (step 3.5) run as Workflow
scripts, not as prose the coordinator follows by hand. The point is mechanical
enforcement: the pass caps are `for`-loop bounds, the verdict is schema-validated
(fail-closed to REVISE), finding verification fans out one read-only agent per finding,
and a crashed run resumes with `resumeFromRunId` instead of re-orienting.

The scripts live next to this file and are invoked by `scriptPath` — never paste their
bodies inline, and change them here so there is one copy:

- `plan-review-loop.workflow.mjs` — default mode: Fable/high authors and ChatGPT reviews.
- `chatgpt-plan-author-loop.workflow.mjs` — `--planner chatgpt`: ChatGPT authors and Fable/high approves.
- `code-review-pass.workflow.mjs` — exactly one PR review pass per run; the coordinator
  pushes, waits for CI, and re-invokes (the 3-pass cap is enforced by the
  `chatgpt-review` script itself).

These Workflow calls are part of this skill's contract — invoking `/ship` is the
explicit multi-agent opt-in. Workflows run in the background: launch one, then wait for
its task notification; do not poll and do not start other review work meanwhile.

## Hard rules (all loops)

- **Coordinator-only, one at a time.** Agent Chrome is a single session; these
  workflows contain the only permitted `chatgpt-review` invocations, and the
  coordinator never runs two review workflows concurrently — parallel units queue for
  their review loops.
- **The coordinator writes the question/context files first.** Default plan review and
  PR review contexts include their `VERDICT:` protocol. ChatGPT authoring context
  instead carries the complete delivery contract; the CLI supplies its strict
  READY/BLOCKED protocol.
- **Findings are never silently dropped.** In the default plan loop and the code
  review loop, every return carries `accepted` and `rejected` (with per-finding
  evidence) from an independent Sonnet fact-check; the coordinator records them in the
  ship log and final report, and `rejected` entries become rebuttals, not deletions. In
  the ChatGPT-author plan loop there is no separate fact-check pass — ChatGPT verifies
  Fable's findings itself while revising, and a rejected one must still land as a `##
  Review responses` entry in the plan (not a return field); a `needs_human` outcome
  there carries the last round's raw `findings` for the coordinator to present.
- **Verify the tree after every workflow** (`git diff`, `git log`, `gh pr list`) — the
  fix and revise agents carry stated mutation boundaries, but a prompt is not an
  enforced restriction.

## Default plan loop — `plan-review-loop.workflow.mjs`

```
Workflow {
  scriptPath: "skills/ship/references/plan-review-loop.workflow.mjs",
  args: { planFile: "<abs path>", contextFile: "<abs path>", unitLabel: "#447 phase 2" }
}
```

`planFile` is the review-session identity — the loop's revise agent edits it in place
and the path must never change mid-loop. Inside each pass: one serialized
`chatgpt-review plan` run — foreground Bash, `--timeout 540` per call (the Bash tool's
own foreground ceiling is 10 minutes; a review pass commonly takes 10-25 minutes, so
the runner agent resumes with `--session <handle>` for up to 4 total attempts rather
than one) — then parallel read-only verification of every finding, then a revise agent
that folds accepted findings into the plan and records rejected ones under
`## Review responses`.

Returns:

| status | meaning | coordinator action |
|---|---|---|
| `approved` | `VERDICT: APPROVED` on pass ≤ 5 | record passes + conversation URL; tell the worker to re-read the plan file and implement |
| `needs_human` | 5 passes without approval, or a pass stayed incomplete | **FULL STOP** — present `contested`, ask the human |
| `error` | a runner agent died | inspect the workflow journal; re-invoke or stop |

## ChatGPT-author plan loop — `chatgpt-plan-author-loop.workflow.mjs`

```
Workflow {
  scriptPath: "skills/ship/references/chatgpt-plan-author-loop.workflow.mjs",
  args: { issueUrl: "<canonical issue URL>", planFile: "<abs path>",
          contextFile: "<abs path>", unitLabel: "#447 phase 2" }
}
```

The canonical plan path never changes. Each pass calls private `plan-author`, has
Fable/high review the resulting complete plan read-only against the repository, and
passes Fable's raw findings — explicitly labelled unverified — straight into the next
revision's context. Unlike the default loop, there is no separate Sonnet fact-check
pass here: ChatGPT is the plan's sole author and reviser, and it verifies each finding
itself against the actual issue/repository/external sources (it already does this kind
of live check unprompted, e.g. looking up an exact npm package version) before folding
it in. A finding it determines is wrong or already addressed gets rejected the same way
the default loop's revise agent does — a one-or-two-line entry under `## Review
responses` at the end of the plan, not a silent drop; that section is where a rejected
finding's evidence lives for this loop, since there is no `rejected` return value. The
loop stops at the first Fable `APPROVED`, skips the unit on a concrete `BLOCKED`, and
returns `needs_human` (with the last round's raw `findings`, not an accepted/rejected
split) after five non-approved Fable passes or an authoring response that remains
incomplete after bounded same-session retries.

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
| `needs_human` | pass still incomplete after 4 resume attempts | **FULL STOP** at the gate |
| `error` | runner agent died | inspect the journal; the pass may have published — check the PR before re-invoking |

The workflow never pushes: `fixed-await-push` commits stay local until the coordinator
has diffed and pushed them. Certification remains the coordinator's judgment at the
gate; `certified-pending-proofs` is necessary, not sufficient.
