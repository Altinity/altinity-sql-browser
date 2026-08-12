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
  succeed.** Once a session's 3 formal `pr`-mode passes are spent, the chatgpt-review
  skill's own current rule ("never drive ChatGPT manually... use the blocking Node
  script for all browser interaction") forbids driving the existing tab's DOM directly
  to route around the cap — do not do that, even for a one-off revision/verdict. The
  sanctioned continuations are, in order:
  1. The mandatory post-cap architecture consultation below (uncapped `issue` mode,
     `--seed-from-session` naming this exhausted session), then `SKILL.md` step 2.7's
     gate/FULL STOP.
  2. If the human's ruling at that gate directs further formal review on the SAME
     conversation, open a brand-new `pr`-mode session — `session: null`,
     `seedFromSession` naming this exhausted session's handle — for a fresh 3-pass
     budget that reopens the identical browser tab/conversation. This is not a
     route-around of the exhausted session's own cap (that session's record and pass
     count are untouched and never reused past 3); it is a new session record on the
     same conversation, exactly like any other cross-mode handoff described above. A
     genuinely fresh conversation (no `--session` and no `--seed-from-session`) is
     correct only when starting a unit that has never had one.

- **Recovering a stalled or hung generation is now automatic, inside each loop's own
  runner agent — never a manual coordinator step.** Across every phase of issue #630
  from plan authoring onward, ChatGPT's own live tool calls (GitHub/repo investigation)
  repeatedly stalled mid-turn for 5-10+ minutes — a different failure from the
  plan-author completion-detection bug fixed in PR #650 (that one is a response that
  already finished but wasn't recognized; this one is a response still actively
  "generating" with no new content appearing). Both loops' runner agents
  (`code-review-pass.workflow.mjs`'s review pass, and the plan loop's equivalent) already
  handle both cases via the script alone, never the DOM: on any non-complete result they
  re-invoke the SAME `chatgpt-review` command with `--session <handle>` (replacing
  whatever `--seed-from-session` it started with) for up to 4 total real CLI calls,
  checking `response_text` for a parseable trailing verdict line FIRST regardless of the
  literal `status` field (a well-formed verdict can be sitting in the response even when
  `status` says `timed_out`/`rate_limited` — the runner treats that as complete, not
  incomplete) before ever retrying. This is exactly the "complete response the checker
  failed to recognize" and "stalled generation, resume without resending" cases handled
  the sanctioned way — a script call, never `document.execCommand`/manual DOM reads,
  consistent with the `chatgpt-review` skill's own "never drive ChatGPT manually" rule.

  **By the time a loop returns `needs_human`, `error`, or `session-cap-exhausted` to the
  coordinator, this automatic recovery has already run its course** — there is no
  further manual recovery step left to try. Treat these returns as the real condition
  they report per the tables above; do not attempt to "rule out" a stalled generation
  yourself, and do not drive the tab directly to investigate it.

  When the COORDINATOR itself drives `chatgpt-review` directly (an ad hoc consultation
  or the post-cap architecture consultation below — no workflow-agent wrapper, no
  built-in retry loop), the same principle applies manually but still script-only: if a
  call returns incomplete, re-invoke the identical command with `--session <handle>`
  from the returned JSON (never `--seed-from-session` a second time) up to a few times,
  reading `response_text` for a parseable answer first. If it never resolves after a
  handful of attempts, that is itself the FULL STOP condition — no manual tab-driving
  fallback exists for the coordinator either.

- **Ad hoc consultation for a genuinely hard judgment call.** The two formal loops certify
  a complete artifact against a verdict protocol — not the right tool for a single mid-cycle
  question. When internal review (the risk-based budget in `per-issue-cycle.md` step 3, or
  the coordinator's own judgment) genuinely cannot resolve a concrete tradeoff between two or
  more approaches with no clear repo precedent — not a routine implementation choice, and not
  a substitute for running that internal review first — the coordinator may ask ChatGPT one
  self-contained question outside any pass-counted protocol:

  1. By step 2.3, a ChatGPT conversation already exists for this unit (at minimum the
     plan-review/plan-author session from 2.2) — always continue THAT conversation (or a
     further-along code-review session), never open a new one, per "one unit, one ChatGPT
     conversation" above.
  2. Use `chatgpt-review`'s `issue` mode (uncapped — the CLI's 3-pass check only fires for
     `pr` mode) with `--seed-from-session <handle>` naming the most recent session for this
     unit, e.g. `node skills/chatgpt-review/scripts/chatgpt-review.mjs issue <canonical
     issue URL> --question-file <path>`. This reopens the SAME browser tab/conversation
     under a brand-new, uncapped session record. No `--publish` — this stays private, not a
     public review artifact. Frame the question file explicitly as an ad hoc consultation,
     not a formal review — no `VERDICT:` line, just the concrete question, the specific
     approaches under consideration, and why internal review didn't settle it. Never drive
     the tab's DOM directly — the `chatgpt-review` skill's own rule ("never drive ChatGPT
     manually... use the blocking Node script for all browser interaction") applies here
     exactly as everywhere else.
  3. **Verify the answer yourself before acting on it** — the same standing principle as every
     formal finding, applied directly by the coordinator (read the real code/tests) since
     there is no separate fact-check pass for an ad hoc exchange.
  4. Record the question, the answer, and what was decided in the unit's ship-log entry under
     "Decisions taken" (`per-issue-cycle.md` already asks for decisions made under ambiguity
     there) — cite the conversation URL.

  Never touches a pass counter (it isn't a `chatgpt-review plan`/`pr` CLI invocation) and is
  coordinator-only, same as every other `chatgpt-review` touchpoint. One self-contained
  question at a time, not an open-ended back-and-forth.

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
diagnosis — per "Recovering a stalled or hung generation" above, this loop's own runner
already exhausted its retry attempts before returning `needs_human`, so no further
manual recovery step exists; treat it as `SKILL.md`'s FULL STOP directly.

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
| `fixed-await-push` | accepted findings fixed, gate green, local commits made | verify the diff yourself, push, wait for green CI keyed on the head SHA; if `pass < 3`, re-invoke with `pass+1` and the returned `session`; if this WAS pass 3 (the cap), run the post-cap architecture consultation below instead of re-invoking |
| `no-accepted-findings` | REVISE, but nothing survived verification | append the rebuttals to the question file; if `pass < 3`, re-invoke (spends a pass); if this WAS pass 3, run the post-cap architecture consultation below |
| `session-cap-exhausted` | the session's 3 total `pr`-mode CLI calls were already spent before this pass could get a real review (an earlier pass's own internal retry silently ate an extra slot) | **do not re-invoke this workflow with this session** — run the post-cap architecture consultation below, then proceed to the gate/FULL STOP per its outcome |
| `fix-failed` | fix agent died or could not reach a green gate | **FULL STOP** at the gate with the gate tail |
| `needs_human` | pass still incomplete after 4 resume attempts (already exhausted inside the runner — see "Recovering a stalled or hung generation" above) | **FULL STOP** at the gate directly — no further recovery step exists |
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

## Post-cap architecture consultation — mandatory, automatic

Whenever a code-review session's FINAL pass under its 3-pass cap completes WITHOUT
producing a certified head — `fixed-await-push` (after its own normal push/CI-wait
handling above completes) or `no-accepted-findings` — the coordinator asks ChatGPT one
consultation question in the SAME conversation before proceeding to `SKILL.md` step
2.7. This applies every time any session for this unit exhausts its cap this way — a
unit's first code-review session, or a later one opened after a redirect/restructuring
— not only the first time.

Applies to `fixed-await-push`/`no-accepted-findings` at the final pass (a real review
happened without certifying), and to a `session-cap-exhausted` return at what was meant
to be the final pass (the session's slots ran out before a fresh review could happen,
but the branch may still hold real, already-fixed findings from an earlier pass in this
same session worth a holistic check). Does NOT apply to `needs_human` (the pass never
delivered a real review to reconsider — nothing coherent to ask about) or to
`fix-failed`/`error` (immediate FULL STOP, per the table above).

1. Verify and push any locally-committed fixes from the exhausted pass first (the
   normal `fixed-await-push` handling), and confirm CI is green at that head — this
   consultation needs an accurate, current SHA to ask about.
2. Write a question file. The discussion stays open-ended, but this consultation carries
   a real, mechanically-actionable verdict — unlike the general ad hoc consultation
   above, which never does:

   > Architecture consultation — this session's final formal review pass completed
   > without certifying. Every accepted finding across all formal passes has been
   > fixed, verified, and pushed; the local gate and CI are green at the current head
   > `<SHA>`.
   >
   > Before this goes further, I'd like your candid, holistic opinion, stepping back
   > from the individual findings:
   >
   > 1. **Architecture/approach soundness**: looking across everything you've reviewed
   >    in this conversation, does the pattern of findings suggest the underlying
   >    approach is fundamentally sound (just needed incremental hardening), or does it
   >    suggest a deeper structural problem that should be reconsidered?
   > 2. **Plan**: does the approved implementation plan itself need to change, or was
   >    this entirely expected edge-case hardening within the plan's existing design?
   > 3. **Verdict reconsideration**: taking the whole conversation into account now that
   >    every finding has been fixed, and confirming you are still evaluating head
   >    `<SHA>` — do you have any remaining concern, however small?
   >
   > End your response with exactly one line: `VERDICT: SHIP` if you have no remaining
   > concerns at all, or `VERDICT: REVISE` if you do (state the concern above the
   > verdict line either way). A missing or malformed verdict is treated as REVISE.

3. Invoke, from the coordinator directly (not a Workflow call — same pattern as the
   general ad hoc consultation above):

   ```sh
   node skills/chatgpt-review/scripts/chatgpt-review.mjs issue <canonical issue URL> \
     --question-file <path> \
     --seed-from-session <the exhausted session's own handle>
   ```

   No `--publish` — this stays private, even though its `SHIP` outcome (below) is a
   real certification path, not merely advisory prose. If the call returns incomplete,
   retry the identical command with `--session <handle>` from the returned JSON (never
   re-seed) a few times before treating it as unresolved — per "Recovering a stalled or
   hung generation" above, this is script-only, never manual tab-driving.
4. **Parse the verdict line mechanically, fail-closed** — same discipline as every other
   verdict in this skill:
   - **`VERDICT: SHIP`** → this round IS sufficient certification. Independently
     re-confirm the current PR head SHA still matches what this round evaluated
     (cross-check the CLI's own `reported_reviewed_sha` field against the actual
     current PR head — same discipline `certified-pending-proofs` already requires),
     then proceed straight to the merge gate (`SKILL.md` 2.7: CI green, branch
     protection permits) and merge automatically — no human step, no PR comment for
     this round. Still run the standing `git diff`/`git log`/`gh pr list` verification
     before merging, same as always. Record in the ship log that this unit certified
     via the post-cap architecture consultation, not a formal `pr`-mode pass, citing the
     conversation URL.
   - **`VERDICT: REVISE`** (or unparseable) → proceed to `SKILL.md` 2.7's FULL STOP —
     carry the full response forward into the human-facing summary and the ship-log
     entry.
5. Either way, this round's SUBSTANTIVE claims (the architecture/plan discussion, not
   the verdict line) are never independently fact-checked and never trigger another fix
   pass — only the verdict line is acted on mechanically, and never treated as a bypass
   of any gate check besides the certification requirement itself. If a `REVISE` answer
   points at one root cause across multiple findings, that is exactly the signal
   `per-issue-cycle.md`'s root-cause circuit breaker describes — worth flagging to the
   human as a candidate for that response (restructure before another review session)
   rather than continuing to patch findings one at a time, but that decision is still
   the human's to make at the gate.
