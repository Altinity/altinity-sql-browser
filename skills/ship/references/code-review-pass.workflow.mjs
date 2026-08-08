export const meta = {
  name: 'ship-code-review-pass',
  description: 'One ChatGPT PR review pass for /ship: review, verify findings against the repo, apply accepted fixes locally',
  whenToUse: 'Invoked by the /ship coordinator only (SKILL.md step 3.5), once per pass — the coordinator pushes, waits for CI, and re-invokes; the 3-pass cap is enforced by the chatgpt-review script',
  phases: [
    { title: 'Review', detail: 'one serialized chatgpt-review PR pass' },
    { title: 'Verify', detail: 'one read-only verifier per finding' },
    { title: 'Fix', detail: 'apply accepted findings + full local gate, local commit only' },
  ],
}

// args: { prUrl, questionFile, session, pass, integrationBranch, issueRef, seedFromSession }
// The coordinator MUST have the integration branch checked out in the main tree before invoking.
// seedFromSession (only meaningful when session is null, i.e. pass 1): the chatgpt-review
// session handle from this SAME unit's plan-authoring/plan-review loop. Passing it threads
// that existing ChatGPT conversation into this brand-new pr-mode session (--seed-from-session)
// instead of opening a fresh chat, so the whole unit — planning through code review — stays
// one conversation. Omit it only when no prior session exists for this unit (should not happen
// in normal /ship operation) or the coordinator has a specific reason not to thread it.
// The workflow runtime has been observed delivering `args` JSON-encoded as a string rather
// than parsed, even when the caller passes a real object — normalize defensively so a
// well-formed argument is never rejected.
const runArgs = typeof args === 'string' ? JSON.parse(args) : args
if (!runArgs || !runArgs.prUrl || !runArgs.questionFile || !runArgs.pass || !runArgs.integrationBranch) {
  throw new Error('args {prUrl, questionFile, session|null, pass, integrationBranch, issueRef, seedFromSession} required')
}

const PASS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['completed', 'verdict', 'session', 'conversationUrl', 'reviewedSha', 'commentUrl', 'findings'],
  properties: {
    completed: { type: 'boolean' },
    verdict: { type: 'string', enum: ['SHIP', 'REVISE'] },
    session: { type: ['string', 'null'] },
    conversationUrl: { type: ['string', 'null'] },
    reviewedSha: { type: ['string', 'null'] },
    commentUrl: { type: ['string', 'null'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'where'],
        properties: {
          claim: { type: 'string', description: 'the concrete actionable finding, self-contained' },
          where: { type: 'string', description: 'file:line or subsystem it targets' },
        },
      },
    },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['accepted', 'reason'],
  properties: {
    accepted: { type: 'boolean' },
    reason: { type: 'string', description: 'file:line evidence either way' },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gateGreen', 'gateTail', 'commits'],
  properties: {
    gateGreen: { type: 'boolean' },
    gateTail: { type: 'string', description: 'last lines of the gate log' },
    commits: { type: 'array', items: { type: 'string' }, description: 'local commit SHAs created' },
  },
}

const READ_ONLY = 'Strictly read-only beyond your stated deliverable: no Edit or Write, no git or gh mutations, no task or memory writes, no chatgpt-review invocations beyond the one command given.'

log(`Code review pass ${runArgs.pass}/3 — ${runArgs.prUrl}`)
const sessionFlag = runArgs.session
  ? ` --session ${runArgs.session}`
  : runArgs.seedFromSession ? ` --seed-from-session ${runArgs.seedFromSession}` : ''
// A generic output filename (e.g. the old literal example chatgpt-review-pr.json) is reused
// across every PR and every pass for an ENTIRE /ship run that can span many hours — observed
// live on #630 phase 6: a review-runner agent's structured-output step reported a stale file's
// content (a different PR's old, already-resolved review) as if it were this pass's real
// result, even though the real command for THIS pr/pass had already run and posted correctly.
// Naming the file after this exact PR+pass makes that class of stale-read impossible to miss.
const prNumberMatch = /\/pull\/(\d+)/.exec(runArgs.prUrl)
const outputFile = `$TMPDIR/chatgpt-review-pr-${prNumberMatch ? prNumberMatch[1] : 'unknown'}-pass${runArgs.pass}.json`
const review = await agent(
  'A repo-grounded ChatGPT review pass commonly takes 10-25 minutes. Two things you MUST NOT do: (1) run_in_background — a background wait inside this kind of agent call has been observed getting force-terminated (structured-output-enforce) under two minutes in, before any response can exist, regardless of effort; (2) omit --timeout — the script defaults to a 1800s internal wait, but the Bash tool itself hard-kills any FOREGROUND command at 10 minutes with no output flushed, so an uncapped call dies with nothing to read.\n\n' +
  `Instead, run this command with Bash IN THE FOREGROUND, with the Bash call's own timeout set to 580000 (its practical ceiling is 600000ms), redirecting stdout to EXACTLY this file — do not substitute a generic name. This filename is unique to this PR and pass on purpose: a long /ship run reuses the same $TMPDIR across many PRs and passes over many hours, and a generic filename risks a LATER pass silently reading a stale file left over from an EARLIER one instead of its own real result. It publishes a PR comment:\n\n` +
  `node skills/chatgpt-review/scripts/chatgpt-review.mjs pr ${runArgs.prUrl} --question-file ${runArgs.questionFile} --timeout 540${sessionFlag} > ${outputFile}\n\n` +
  '--timeout 540 caps the script\'s OWN internal wait at 9 minutes — safely inside the Bash tool\'s 10-minute ceiling — so the process exits cleanly with valid JSON instead of being killed. A "status" of "timed_out" is EXPECTED and NORMAL here, not a failure: the script persists its session handle and conversation URL even on a timeout.\n' +
  'Read the output file (it is JSON). FIRST check response_text regardless of "status": if it already ends with exactly one well-formed "VERDICT: SHIP" or "VERDICT: REVISE" line, ChatGPT had already finished generating — treat this as a complete result and stop retrying, even if "status" says "rate_limited"/"timed_out"/etc (a UI-level banner can appear over an already-finished answer; the literal status field is NOT authoritative about whether real content exists). Only if response_text has NO parseable verdict line do you need to retry: if "status" is "rate_limited", ChatGPT is throttling conversation access — hammering it immediately makes this WORSE, so wait first using a small-increment loop in ONE Bash call (a bare `sleep 90` prefix gets blocked as chaining), e.g. `end=$(( $(date +%s) + 90 )); while [ $(date +%s) -lt $end ]; do sleep 5; done; node ...`. For any other non-completed, no-verdict status, retry immediately. Either way, retry the SAME chatgpt-review command, but REPLACE whatever `--session`/`--seed-from-session` flag it had with `--session <handle>` using the "session" field from the JSON (never keep --seed-from-session, and never pass both flags — the CLI rejects that) (again foreground, again --timeout 540, again Bash timeout 580000) — this resumes the same conversation instead of resubmitting the prompt (it may already have published the comment). Repeat for up to 4 total attempts. After 4 attempts with still no parseable verdict line, stop and treat it as incomplete.\n' +
  'Then map the final JSON to the output schema:\n' +
  '- completed: true if response_text contains a real, parseable, single well-formed trailing VERDICT line — regardless of the literal "status" field; false only if no such line exists after all attempts;\n' +
  '- verdict: the trailing "VERDICT: <word>" line of response_text — SHIP only for a single well-formed "VERDICT: SHIP"; anything absent, duplicated, or malformed is REVISE (fail-closed);\n' +
  '- findings: every concrete actionable finding in the response, one entry each, claim self-contained;\n' +
  '- session, conversationUrl, reviewedSha, commentUrl: from the returned JSON.\n' +
  READ_ONLY,
  // effort intentionally NOT 'low': this agent must genuinely wait out a real
  // 10-25 minute external process. 'low' effort was observed capping the agent's
  // turn/wall-clock budget so tightly that it was force-terminated (structured-output-enforce)
  // within ~45 seconds of starting the background wait, well before any response existed.
  { label: `review pass ${runArgs.pass}`, phase: 'Review', schema: PASS_SCHEMA, model: 'sonnet' },
)
if (!review) return { status: 'error', reason: 'review-runner agent died', session: runArgs.session ?? null }
const session = review.session ?? runArgs.session ?? null
if (!review.completed) {
  return { status: 'needs_human', reason: 'review pass incomplete after one retry', session, conversationUrl: review.conversationUrl, commentUrl: review.commentUrl }
}

const verified = (await parallel(review.findings.map((f, i) => () =>
  agent(
    'Adversarially verify this ChatGPT PR-review finding against the ACTUAL repository at the current HEAD of branch ' + runArgs.integrationBranch + ' — read the real code, history, and tests.\n' +
    `Finding: ${f.claim}\nTarget: ${f.where}\n` +
    'accepted=true only if the evidence supports it as a concrete defect this PR must fix; reason must cite file:line evidence either way.\n' +
    READ_ONLY,
    { label: `verify finding ${i + 1}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: 'sonnet' },
  ).then(v => ({ finding: f, accepted: v.accepted, reason: v.reason })),
))).filter(Boolean)
const accepted = verified.filter(v => v.accepted)
const rejected = verified.filter(v => !v.accepted)
log(`Pass ${runArgs.pass}: verdict ${review.verdict} — ${accepted.length} accepted, ${rejected.length} rejected of ${review.findings.length} findings`)

const meta_ = { session, conversationUrl: review.conversationUrl, reviewedSha: review.reviewedSha, commentUrl: review.commentUrl, accepted, rejected }

if (review.verdict === 'SHIP' && accepted.length === 0) {
  // Certification is still the coordinator's call: SHA match, green CI, branch protection.
  return { status: 'certified-pending-proofs', ...meta_ }
}
if (accepted.length === 0) {
  // REVISE, but nothing survived verification — the coordinator adds the rebuttals to the
  // question file and decides whether to spend another pass.
  return { status: 'no-accepted-findings', ...meta_ }
}

const fix = await agent(
  `On branch ${runArgs.integrationBranch} in the main working tree (the coordinator has it checked out — verify with \`git branch --show-current\` and stop if it differs), apply these accepted ChatGPT PR-review findings, with tests in the same change (CLAUDE.md hard rule 1):\n` +
  `${JSON.stringify(accepted)}\n` +
  'Follow skills/ship/references/per-issue-cycle.md step 2 and references/repo-footguns.md. Run the FULL local gate from cycle step 2, captured to a file, and loop until green.\n' +
  `Commit locally: message "fix(#${runArgs.issueRef ?? 'ISSUE'}): address review pass ${runArgs.pass} findings" plus the repo footer convention.\n` +
  `Mutation boundary: Edit/Write + local git commit on ${runArgs.integrationBranch} only — NO push, NO gh mutations, no issue or ship-log edits, no task or memory writes, no chatgpt-review invocations.`,
  // Applying fixes is a coding task — per this skill's model split (sonnet for
  // coding/implementation, fable at high effort for planning/plan-authoring).
  { label: 'fix accepted findings', phase: 'Fix', agentType: 'general-purpose', schema: FIX_SCHEMA, model: 'sonnet' },
)
if (!fix) return { status: 'fix-failed', reason: 'fix agent died', ...meta_ }
if (!fix.gateGreen) return { status: 'fix-failed', reason: 'local gate not green', gateTail: fix.gateTail, ...meta_ }

return { status: 'fixed-await-push', commits: fix.commits, gateTail: fix.gateTail, ...meta_ }
