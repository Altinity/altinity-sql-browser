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

// args: { prUrl, questionFile, session, pass, integrationBranch, issueRef }
// The coordinator MUST have the integration branch checked out in the main tree before invoking.
if (!args || !args.prUrl || !args.questionFile || !args.pass || !args.integrationBranch) {
  throw new Error('args {prUrl, questionFile, session|null, pass, integrationBranch, issueRef} required')
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

log(`Code review pass ${args.pass}/3 — ${args.prUrl}`)
const sessionFlag = args.session ? ` --session ${args.session}` : ''
const review = await agent(
  'From the repository root, run exactly this command with Bash and wait for it to finish (it blocks for minutes; it publishes a PR comment):\n\n' +
  `node skills/chatgpt-review/scripts/chatgpt-review.mjs pr ${args.prUrl} --question-file ${args.questionFile}${sessionFlag}\n\n` +
  'Capture stdout to a file under $TMPDIR and Read it (it is JSON). If its "status" is not "completed", retry the identical command ONCE, adding --session <handle> from the returned JSON — the script resumes the uncollected response instead of resubmitting (it may already have published the comment).\n' +
  'Then map the final JSON to the output schema:\n' +
  '- completed: status === "completed" after the retry, if any;\n' +
  '- verdict: the trailing "VERDICT: <word>" line of response_text — SHIP only for a single well-formed "VERDICT: SHIP"; anything absent, duplicated, or malformed is REVISE (fail-closed);\n' +
  '- findings: every concrete actionable finding in the response, one entry each, claim self-contained;\n' +
  '- session, conversationUrl, reviewedSha, commentUrl: from the returned JSON.\n' +
  READ_ONLY,
  { label: `review pass ${args.pass}`, phase: 'Review', schema: PASS_SCHEMA, model: 'sonnet', effort: 'low' },
)
if (!review) return { status: 'error', reason: 'review-runner agent died', session: args.session ?? null }
const session = review.session ?? args.session ?? null
if (!review.completed) {
  return { status: 'needs_human', reason: 'review pass incomplete after one retry', session, conversationUrl: review.conversationUrl, commentUrl: review.commentUrl }
}

const verified = (await parallel(review.findings.map((f, i) => () =>
  agent(
    'Adversarially verify this ChatGPT PR-review finding against the ACTUAL repository at the current HEAD of branch ' + args.integrationBranch + ' — read the real code, history, and tests.\n' +
    `Finding: ${f.claim}\nTarget: ${f.where}\n` +
    'accepted=true only if the evidence supports it as a concrete defect this PR must fix; reason must cite file:line evidence either way.\n' +
    READ_ONLY,
    { label: `verify finding ${i + 1}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: 'sonnet' },
  ).then(v => ({ finding: f, accepted: v.accepted, reason: v.reason })),
))).filter(Boolean)
const accepted = verified.filter(v => v.accepted)
const rejected = verified.filter(v => !v.accepted)
log(`Pass ${args.pass}: verdict ${review.verdict} — ${accepted.length} accepted, ${rejected.length} rejected of ${review.findings.length} findings`)

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
  `On branch ${args.integrationBranch} in the main working tree (the coordinator has it checked out — verify with \`git branch --show-current\` and stop if it differs), apply these accepted ChatGPT PR-review findings, with tests in the same change (CLAUDE.md hard rule 1):\n` +
  `${JSON.stringify(accepted)}\n` +
  'Follow skills/ship/references/per-issue-cycle.md step 2 and references/repo-footguns.md. Run the FULL local gate from cycle step 2, captured to a file, and loop until green.\n' +
  `Commit locally: message "fix(#${args.issueRef ?? 'ISSUE'}): address review pass ${args.pass} findings" plus the repo footer convention.\n` +
  `Mutation boundary: Edit/Write + local git commit on ${args.integrationBranch} only — NO push, NO gh mutations, no issue or ship-log edits, no task or memory writes, no chatgpt-review invocations.`,
  { label: 'fix accepted findings', phase: 'Fix', agentType: 'general-purpose', schema: FIX_SCHEMA },
)
if (!fix) return { status: 'fix-failed', reason: 'fix agent died', ...meta_ }
if (!fix.gateGreen) return { status: 'fix-failed', reason: 'local gate not green', gateTail: fix.gateTail, ...meta_ }

return { status: 'fixed-await-push', commits: fix.commits, gateTail: fix.gateTail, ...meta_ }
