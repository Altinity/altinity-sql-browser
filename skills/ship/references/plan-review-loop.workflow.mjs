export const meta = {
  name: 'ship-plan-review-loop',
  description: 'Iterate one /ship unit plan through ChatGPT plan review to APPROVED (max 5 passes)',
  whenToUse: 'Invoked by the /ship coordinator only (SKILL.md step 2.2) — see references/review-loops.md',
  phases: [
    { title: 'Review', detail: 'one serialized chatgpt-review plan pass' },
    { title: 'Verify', detail: 'one read-only verifier per finding' },
    { title: 'Revise', detail: 'fold accepted findings into the plan file in place' },
  ],
}

// args: { planFile, contextFile, unitLabel } — absolute paths. The planFile PATH is the
// review-session identity: it must never move, be renamed, or be copied mid-loop.
// The workflow runtime has been observed delivering `args` JSON-encoded as a string rather
// than parsed, even when the caller passes a real object — normalize defensively so a
// well-formed argument is never rejected.
const runArgs = typeof args === 'string' ? JSON.parse(args) : args
if (!runArgs || !runArgs.planFile || !runArgs.contextFile) {
  throw new Error('args {planFile, contextFile, unitLabel} required')
}

const PASS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['completed', 'verdict', 'session', 'conversationUrl', 'findings'],
  properties: {
    completed: { type: 'boolean' },
    verdict: { type: 'string', enum: ['APPROVED', 'REVISE'] },
    session: { type: ['string', 'null'] },
    conversationUrl: { type: ['string', 'null'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'where'],
        properties: {
          claim: { type: 'string', description: 'the concrete actionable finding, self-contained' },
          where: { type: 'string', description: 'the plan section or repo file it targets' },
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
    reason: { type: 'string', description: 'file:line or plan-section evidence either way' },
  },
}

const READ_ONLY = 'Strictly read-only beyond your stated deliverable: no Edit or Write, no git or gh mutations, no task or memory writes, no chatgpt-review invocations beyond the one command given.'

const label = runArgs.unitLabel ?? runArgs.planFile
// Optional: resume a conversation from a prior invocation of this SAME script (e.g. after a
// needs_human/error return) instead of starting a fresh ChatGPT conversation and abandoning
// the one already in progress. runArgs.startPass lets the pass counter/cap continue correctly.
let session = runArgs.session ?? null
let conversationUrl = runArgs.conversationUrl ?? null
let lastContested = { accepted: [], rejected: [] }
const startPass = Number.isInteger(runArgs.startPass) && runArgs.startPass >= 1 ? runArgs.startPass : 1

for (let pass = startPass; pass <= 5; pass++) {
  log(`Plan review pass ${pass}/5 — ${label}`)
  const sessionFlag = session ? ` --session ${session}` : ''
  const review = await agent(
    'A repo-grounded ChatGPT review pass commonly takes 10-25 minutes. Two things you MUST NOT do: (1) run_in_background — a background wait inside this kind of agent call has been observed getting force-terminated (structured-output-enforce) under two minutes in, before any response can exist, regardless of effort; (2) omit --timeout — the script defaults to a 1800s internal wait, but the Bash tool itself hard-kills any FOREGROUND command at 10 minutes with no output flushed, so an uncapped call dies with nothing to read.\n\n' +
    'Instead, run this command with Bash IN THE FOREGROUND, with the Bash call\'s own timeout set to 580000 (its practical ceiling is 600000ms), redirecting stdout to a file under $TMPDIR (e.g. `> $TMPDIR/chatgpt-review-plan.json`):\n\n' +
    `node skills/chatgpt-review/scripts/chatgpt-review.mjs plan ${runArgs.planFile} --question-file ${runArgs.contextFile} --timeout 540${sessionFlag}\n\n` +
    '--timeout 540 caps the script\'s OWN internal wait at 9 minutes — safely inside the Bash tool\'s 10-minute ceiling — so the process exits cleanly with valid JSON instead of being killed. A "status" of "timed_out" is EXPECTED and NORMAL here, not a failure: the script persists its session handle and conversation URL even on a timeout.\n' +
'Read the output file (it is JSON). FIRST check response_text regardless of "status": if it already ends with exactly one well-formed "VERDICT: APPROVED" or "VERDICT: REVISE" line, ChatGPT had already finished generating — treat this as a complete result and stop retrying, even if "status" says "rate_limited"/"timed_out"/etc (a UI-level banner can appear over an already-finished answer; the literal status field is NOT authoritative about whether real content exists). Only if response_text has NO parseable verdict line do you need to retry: if "status" is "rate_limited", ChatGPT is throttling conversation access — hammering it immediately makes this WORSE, so wait first using a small-increment loop in ONE Bash call (a bare `sleep 90` prefix gets blocked as chaining), e.g. `end=$(( $(date +%s) + 90 )); while [ $(date +%s) -lt $end ]; do sleep 5; done; node ...`. For any other non-completed, no-verdict status, retry immediately. Either way, retry the SAME chatgpt-review command, adding/updating `--session <handle>` from the JSON (again foreground, again --timeout 540, again Bash timeout 580000) — this resumes the same conversation instead of resubmitting the prompt. Repeat for up to 4 total attempts. After 4 attempts with still no parseable verdict line, stop and treat it as incomplete.\n' +
    'Then map the final JSON to the output schema:\n' +
    '- completed: true if response_text contains a real, parseable, single well-formed trailing VERDICT line — regardless of the literal "status" field; false only if no such line exists after all attempts;\n' +
    '- verdict: the trailing "VERDICT: <word>" line of response_text — APPROVED only for a single well-formed "VERDICT: APPROVED"; anything absent, duplicated, or malformed is REVISE (fail-closed);\n' +
    '- findings: every concrete actionable finding in the response, one entry each, claim self-contained;\n' +
    '- session and conversationUrl: from the returned JSON (fields "session" and "conversation_url").\n' +
    READ_ONLY,
    // effort intentionally NOT 'low': this agent must genuinely wait out a real
    // 10-25 minute external process. 'low' effort was observed capping the agent's
    // turn/wall-clock budget so tightly that it was force-terminated (structured-output-enforce)
    // within ~45 seconds of starting the background wait, well before any response existed.
    { label: `review pass ${pass}`, phase: 'Review', schema: PASS_SCHEMA, model: 'sonnet' },
  )
  if (!review) {
    return { status: 'error', reason: 'review-runner agent died', pass, session, conversationUrl }
  }
  session = review.session ?? session
  conversationUrl = review.conversationUrl ?? conversationUrl
  if (!review.completed) {
    return { status: 'needs_human', reason: 'review pass incomplete after one retry', pass, session, conversationUrl }
  }
  if (review.verdict === 'APPROVED') {
    return { status: 'approved', passes: pass, session, conversationUrl }
  }

  const verified = (await parallel(review.findings.map((f, i) => () =>
    agent(
      'Adversarially verify this ChatGPT plan-review finding against the ACTUAL repository — read the real files; the reviewer saw only the plan file.\n' +
      `Finding: ${f.claim}\nTarget: ${f.where}\nPlan file: ${runArgs.planFile}\n` +
      'accepted=true only if repository or plan evidence supports it as a concrete defect the plan must address; reason must cite file:line or plan-section evidence either way.\n' +
      READ_ONLY,
      { label: `verify finding ${i + 1}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: 'sonnet' },
    ).then(v => ({ finding: f, accepted: v.accepted, reason: v.reason })),
  ))).filter(Boolean)
  const accepted = verified.filter(v => v.accepted)
  const rejected = verified.filter(v => !v.accepted)
  lastContested = { accepted, rejected }
  log(`Pass ${pass}: REVISE — ${accepted.length} accepted, ${rejected.length} rejected of ${review.findings.length} findings`)

  if (pass === 5) break

  await agent(
    `Revise the /ship unit plan file ${runArgs.planFile} IN PLACE — never move, rename, or copy it (its path is the review-session identity).\n` +
    `Accepted review findings — fold each into the plan (JSON): ${JSON.stringify(accepted)}\n` +
    `Rejected findings — record each under a "## Review responses" section at the end of the plan, one or two lines with its evidence (JSON): ${JSON.stringify(rejected)}\n` +
    'If both lists are empty, the reviewer asked for revision without an actionable finding surviving verification: add a "## Review responses" note saying so and asking for concrete, actionable findings.\n' +
    'Keep the plan self-contained and consistent with skills/ship/references/per-issue-cycle.md step 1 (contract, risk classification, invariant map).\n' +
    `Mutation boundary: Edit/Write on ${runArgs.planFile} ONLY. No other files, no git or gh mutations, no task or memory writes, no chatgpt-review invocations.`,
    // Revising the plan is a planning task, not coding — per this skill's model split
    // (sonnet for coding/implementation, fable at high effort for planning/plan-authoring).
    { label: `revise after pass ${pass}`, phase: 'Revise', agentType: 'general-purpose', model: 'fable', effort: 'high' },
  )
}

return {
  status: 'needs_human',
  reason: 'no APPROVED verdict after 5 passes',
  passes: 5,
  session,
  conversationUrl,
  contested: lastContested,
}
