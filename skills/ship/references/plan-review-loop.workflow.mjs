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
if (!args || !args.planFile || !args.contextFile) {
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

const label = args.unitLabel ?? args.planFile
let session = null
let conversationUrl = null
let lastContested = { accepted: [], rejected: [] }

for (let pass = 1; pass <= 5; pass++) {
  log(`Plan review pass ${pass}/5 — ${label}`)
  const sessionFlag = session ? ` --session ${session}` : ''
  const review = await agent(
    'From the repository root, run exactly this command with Bash and wait for it to finish (it blocks for minutes):\n\n' +
    `node skills/chatgpt-review/scripts/chatgpt-review.mjs plan ${args.planFile} --question-file ${args.contextFile}${sessionFlag}\n\n` +
    'Capture stdout to a file under $TMPDIR and Read it (it is JSON). If its "status" is not "completed", retry the identical command ONCE, adding --session <handle> from the returned JSON — the script resumes the uncollected response instead of resubmitting.\n' +
    'Then map the final JSON to the output schema:\n' +
    '- completed: status === "completed" after the retry, if any;\n' +
    '- verdict: the trailing "VERDICT: <word>" line of response_text — APPROVED only for a single well-formed "VERDICT: APPROVED"; anything absent, duplicated, or malformed is REVISE (fail-closed);\n' +
    '- findings: every concrete actionable finding in the response, one entry each, claim self-contained;\n' +
    '- session and conversationUrl: from the returned JSON (fields "session" and "conversation_url").\n' +
    READ_ONLY,
    { label: `review pass ${pass}`, phase: 'Review', schema: PASS_SCHEMA, model: 'sonnet', effort: 'low' },
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
      `Finding: ${f.claim}\nTarget: ${f.where}\nPlan file: ${args.planFile}\n` +
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
    `Revise the /ship unit plan file ${args.planFile} IN PLACE — never move, rename, or copy it (its path is the review-session identity).\n` +
    `Accepted review findings — fold each into the plan (JSON): ${JSON.stringify(accepted)}\n` +
    `Rejected findings — record each under a "## Review responses" section at the end of the plan, one or two lines with its evidence (JSON): ${JSON.stringify(rejected)}\n` +
    'If both lists are empty, the reviewer asked for revision without an actionable finding surviving verification: add a "## Review responses" note saying so and asking for concrete, actionable findings.\n' +
    'Keep the plan self-contained and consistent with skills/ship/references/per-issue-cycle.md step 1 (contract, risk classification, invariant map).\n' +
    `Mutation boundary: Edit/Write on ${args.planFile} ONLY. No other files, no git or gh mutations, no task or memory writes, no chatgpt-review invocations.`,
    { label: `revise after pass ${pass}`, phase: 'Revise', agentType: 'general-purpose', model: 'sonnet' },
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
