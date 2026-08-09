# The review loops as Workflow scripts

The selected plan loop (SKILL.md step 2.2) and each code review pass (step 2.6) run as Workflow
scripts, not as prose the coordinator follows by hand. The point is mechanical
enforcement: the pass caps are `for`-loop bounds, the verdict is schema-validated
(fail-closed to REVISE), finding verification fans out one read-only agent per finding,
and a crashed run resumes with `resumeFromRunId` instead of re-orienting.

The scripts live next to this file and are invoked by `scriptPath` — never paste their
bodies inline, and change them here so there is one copy:

- `chatgpt-plan-author-loop.workflow.mjs` — default mode: ChatGPT authors and Fable/high approves.
- `plan-review-loop.workflow.mjs` — `--planner fable`: Fable/high authors and ChatGPT reviews.
- `code-review-pass.workflow.mjs` — exactly one PR review pass per call, scoped to one
  unit's own PR (SKILL.md step 2.6). `pass`/`session` reset to `1`/`null` for every
  unit — never carried over from a previous unit's loop, even on the same spine.
  Pass 1's `session: null` should still carry `seedFromSession` set to this unit's own
  plan-loop session handle (see "one ChatGPT conversation" below) so it reopens that
  conversation instead of starting a disconnected one. The coordinator pushes, waits
  for CI, and re-invokes with the returned `session` handle (the 3-pass cap is
  enforced by the `chatgpt-review` script itself).

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
- **One unit, one ChatGPT *conversation*, start to finish.** `chatgpt-review.mjs`
  scopes each *session record* (handle, pass counter) to one CLI mode + target — a
  `plan-author`-mode session and a `pr`-mode session are always separate records, and
  `--session <handle>` hard-rejects a handle whose recorded mode doesn't match
  (`"Session does not match this mode and target"`). That is a real, permanent
  constraint, not a bug to route around: within ONE mode (repeatedly resuming the same
  `pr`-mode PR review, or the same `plan`/`plan-author` authoring/revision loop),
  always reuse that mode's own session handle — never `session: null` a second time
  for work already in progress under that handle. This holds even when a formal loop
  is exhausted without certification (5 plan-review passes, or 3 code-review passes
  with no certified head): do not call `chatgpt-review`/invoke a review workflow with
  `session: null` to route around an exhausted cap or a `needs_human` outcome — that
  abandons everything ChatGPT already reviewed and found in that mode's conversation.
  Continue the EXISTING session instead (see the pass-cap paragraph below for what to
  do once a mode's own cap is truly spent).

  **Across modes** (plan authoring → plan review → PR code review → any ad hoc
  advisory question outside a formal pass-counted loop), the CLI cannot literally
  share one session RECORD, but it can and should share one underlying ChatGPT
  *conversation*: pass `--seed-from-session <handle>` (instead of `--session`) the
  FIRST time a new mode starts for this unit, naming the most recent session handle
  from whichever mode/loop just finished. This creates a brand-new session record for
  the new mode (its own pass counter, so a `pr`-mode cap counts only `pr`-mode passes)
  but reopens the SAME browser tab/conversation rather than starting a fresh chat —
  `SKILL.md` step 2.6 wires this from the plan loop's returned session into
  `code-review-pass.workflow.mjs`'s `seedFromSession` argument on that PR's first pass.
  Once that new mode's own session exists, resume IT with `--session` for every
  further pass in that mode, per the paragraph above — `--seed-from-session` is only
  for the one-time handoff into a new mode, never for continuing within one.

  **The `chatgpt-review.mjs pr` CLI itself hard-rejects a 4th call tied to one
  `pr`-mode session (`"PR review sessions permit at most three total passes"`,
  `status: invalid_request`, exit before any prompt reaches ChatGPT) — this is
  enforced by the tool, not just the workflow script's loop bound, so re-invoking the
  workflow with that session's handle past pass 3 will fail outright, not silently
  succeed.** Once a session's 3 formal `pr`-mode passes are spent, continue the SAME
  conversation by driving the existing tab directly instead of the capped CLI: read
  the DOM, submit a revision/advisory/final-verdict message via
  `document.execCommand('insertText', ...)` + a real click on the send button (same
  technique as the Chrome-crash recovery path in `SKILL.md` step 2.2), ask explicitly
  for the standard `VERDICT: SHIP`/`VERDICT: REVISE` protocol if you need a formal
  certification out of it, and post the result as a PR comment yourself (`gh pr
  comment`) since no CLI publish step ran. A fresh conversation (no `--session` and no
  `--seed-from-session`) is correct only when starting a genuinely new unit that has
  never had one.

- **Recovering a stalled or hung generation.** Across every phase of issue #630 from
  plan authoring onward, ChatGPT's own live tool calls (GitHub/repo investigation)
  repeatedly stalled mid-turn for 5-10+ minutes — a different failure from the
  plan-author completion-detection bug fixed in PR #650 (that one is a response that
  already finished but wasn't recognized; this one is a response still actively
  "generating" with no new content appearing). **Before treating any loop's
  `needs_human`/`error`/incomplete return as `SKILL.md`'s FULL STOP, rule out these two
  usually-recoverable causes first** — most `needs_human` returns observed across
  #630 were one of these, not a genuine plan/review impasse requiring the human's
  judgment:
  1. **A stalled generation.** Symptom: the tab shows a still-"generating" state (a
     stop control present, e.g. `document.querySelector('[data-testid="stop-button"]')`
     truthy) with no growth in the last assistant turn's content for several minutes.
     Recovery: drive the existing tab directly (same technique as the pass-cap
     paragraph above) — click the stop control, then send a short nudge in the SAME
     conversation ("continue without further tool calls" or similarly specific), and
     wait again. Never open a new session for this; it is not a conversation problem.
  2. **A complete response already sitting in the DOM that a scripted runner's
     completion check failed to recognize.** Read the last assistant turn's full text
     directly from the tab before concluding nothing usable exists — a well-formed
     verdict/plan-status line can be present even when the runner reported
     incomplete.

  Only after ruling out both (or after they fail to actually resolve it) does
  `SKILL.md`'s FULL STOP apply.

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
incomplete after bounded same-session retries — the latter case also carries
`lastResponsePreview` (the final attempt's last ~500 raw characters) purely for
diagnosis; before treating either as `SKILL.md`'s FULL STOP, check the two recoverable
causes in "Recovering a stalled or hung generation" above.

## Code review pass — `code-review-pass.workflow.mjs`

Coordinator loop per pass (max 3; the CLI errors on pass 4):

1. Check out this unit's own branch in the main tree; update the question file
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
| `certified-pending-proofs` | `VERDICT: SHIP`, no accepted findings | proceed to the gate (step 2.7) — still check SHA match, green CI, branch protection yourself |
| `fixed-await-push` | accepted findings fixed, gate green, local commits made | verify the diff yourself, push, wait for green CI keyed on the head SHA, re-invoke with `pass+1` and the returned `session` |
| `no-accepted-findings` | REVISE, but nothing survived verification | append the rebuttals to the question file; re-invoke (spends a pass) — or go to the gate's FULL STOP if this repeats |
| `session-cap-exhausted` | the session's 3 total `pr`-mode CLI calls were already spent before this pass could get a real review (an earlier pass's own internal retry silently ate an extra slot) | **do not re-invoke this workflow with this session** — switch immediately to the manual continuation below |
| `fix-failed` | fix agent died or could not reach a green gate | **FULL STOP** at the gate with the gate tail |
| `needs_human` | pass still incomplete after 4 resume attempts | rule out the two recoverable causes in "Recovering a stalled or hung generation" below FIRST; only **FULL STOP** at the gate if neither applies |
| `error` | runner agent died | inspect the journal; the pass may have published — check the PR before re-invoking |

The workflow never pushes: `fixed-await-push` commits stay local until the coordinator
has diffed and pushed them. Certification remains the coordinator's judgment at the
gate; `certified-pending-proofs` is necessary, not sufficient.

**A `/ship`-labelled pass can consume more than one of the session's 3 total `pr`-mode
slots**, since the review-runner's own up-to-4-attempt retry logic (for a stalled or
incomplete generation) makes real CLI calls that count against the same cap the
workflow's `pass` argument does not track. Do not assume 3 successful `/ship pass`
invocations are guaranteed — `session-cap-exhausted` (or a plain CLI `invalid_request`
rejection, if driving `chatgpt-review` directly) is an expected possible outcome of
*any* pass, not only a literal 4th call. `attemptsUsed` in every return tells you how
many real slots that pass actually spent, for the ship-log record.
