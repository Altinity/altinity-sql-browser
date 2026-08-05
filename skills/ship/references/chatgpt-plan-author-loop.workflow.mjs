export const meta = {
  name: 'ship-chatgpt-plan-author-loop',
  description: 'Have ChatGPT author a /ship unit plan and iterate it through Fable/high approval (max 5 review passes)',
  whenToUse: 'Invoked by the /ship coordinator only when --planner chatgpt is selected',
  phases: [
    { title: 'Author', detail: 'ChatGPT writes or replaces the canonical plan privately' },
    { title: 'Review', detail: 'Fable/high reviews the plan read-only against the repository' },
    { title: 'Prepare', detail: 'fold Fable\'s raw findings into revision context for ChatGPT to verify and incorporate itself' },
  ],
}

// args: { issueUrl, planFile, contextFile, unitLabel } — absolute file paths.
const runArgs = typeof args === 'string' ? JSON.parse(args) : args
if (!runArgs || !runArgs.issueUrl || !runArgs.planFile || !runArgs.contextFile) {
  throw new Error('args {issueUrl, planFile, contextFile, unitLabel} required')
}

const AUTHOR_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['completed', 'planStatus', 'session', 'conversationUrl', 'blocker'],
  properties: {
    completed: { type: 'boolean' },
    planStatus: { type: 'string', enum: ['READY', 'BLOCKED', 'INVALID'] },
    session: { type: ['string', 'null'] },
    conversationUrl: { type: ['string', 'null'] },
    blocker: { type: ['string', 'null'] },
  },
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'blocker', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'REVISE', 'BLOCKED'] },
    blocker: { type: ['string', 'null'] },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['claim', 'where'], properties: {
      claim: { type: 'string' }, where: { type: 'string' },
    } } },
  },
}
const CONTEXT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['written'],
  properties: { written: { type: 'boolean' } },
}
const READ_ONLY = 'Strictly read-only: no Edit or Write, no git or gh mutations, no task or memory writes, no chatgpt-review invocation.'
const RUNNER_BOUNDARY = 'Do not edit repository or plan files directly, mutate git or gh, write tasks or memory, or invoke chatgpt-review except for the exact private command above.'
const label = runArgs.unitLabel ?? runArgs.issueUrl
let session = runArgs.session ?? null
let conversationUrl = runArgs.conversationUrl ?? null
let authorContextFile = runArgs.contextFile
let lastFindings = []

for (let pass = 1; pass <= 5; pass++) {
  log(`ChatGPT plan authoring / Fable review pass ${pass}/5 — ${label}`)
  const sessionFlag = session ? ` --session ${shellQuote(session)}` : ''
  const authored = await agent(
    'Run the private ChatGPT plan-author command below in Bash IN THE FOREGROUND with the Bash timeout set to 580000, redirect stdout to a JSON file under $TMPDIR, and never use run_in_background:\n\n' +
    `node skills/chatgpt-review/scripts/chatgpt-review.mjs plan-author ${shellQuote(runArgs.issueUrl)} --output-file ${shellQuote(runArgs.planFile)} --question-file ${shellQuote(authorContextFile)} --timeout 540${sessionFlag}\n\n` +
    'Read the JSON. A complete result has status=completed and plan_status=ready or blocked. For timed_out, rate_limited, invalid_response, or any other incomplete result, retry the same command with --session from the JSON for up to 4 total attempts; wait 90 seconds before a rate_limited retry using a small-increment loop. Never start a new conversation after a session handle exists. Map the last JSON to the schema: completed=true only for a complete ready/blocked protocol; planStatus from plan_status uppercased, otherwise INVALID; retain session, conversation_url, and blocker. The command is private and must never receive publication flags. ' + RUNNER_BOUNDARY,
    { label: `author plan ${pass}`, phase: 'Author', schema: AUTHOR_SCHEMA, model: 'sonnet' },
  )
  if (!authored) return { status: 'error', reason: 'plan-author runner agent died', pass, session, conversationUrl }
  session = authored.session ?? session
  conversationUrl = authored.conversationUrl ?? conversationUrl
  if (!authored.completed) return { status: 'needs_human', reason: 'plan authoring remained incomplete after retries', pass, session, conversationUrl }
  if (authored.planStatus === 'BLOCKED') {
    return { status: 'blocked', reason: authored.blocker ?? 'ChatGPT identified an unrecorded decision', pass, session, conversationUrl }
  }

  const review = await agent(
    `Review the complete plan at ${runArgs.planFile} for ${label} against the ACTUAL repository, ${runArgs.contextFile}, CLAUDE.md, and skills/ship/references/per-issue-cycle.md step 1. Read-only. Return APPROVED only when the standalone plan fully satisfies the delivery contract and repository architecture. Return BLOCKED only for a concrete missing product or architecture decision that cannot be resolved from recorded sources. Otherwise return REVISE with every substantive, actionable finding. Cite plan sections and repo file:line evidence. ${READ_ONLY}`,
    { label: `Fable review ${pass}`, phase: 'Review', schema: REVIEW_SCHEMA, model: 'fable', effort: 'high' },
  )
  if (!review) return { status: 'error', reason: 'Fable review agent died', pass, session, conversationUrl }
  if (review.verdict === 'BLOCKED') {
    return { status: 'blocked', reason: review.blocker ?? 'Fable identified an unrecorded decision', pass, session, conversationUrl }
  }
  if (review.verdict === 'APPROVED') return { status: 'approved', passes: pass, session, conversationUrl }

  lastFindings = review.findings
  if (pass === 5) break

  // Fable is read-only and does not have live access to confirm exact repository state,
  // registry contents, or line numbers — its findings are unverified claims, not settled
  // fact. ChatGPT is the plan's sole author and reviser; rather than a separate Sonnet
  // pass fact-checking Fable before handing ChatGPT a pre-filtered accept/reject list,
  // ChatGPT verifies each finding itself (it already does this kind of live check when
  // revising — e.g. looking up an exact npm package version) and decides whether to fold
  // it in or reject it, recording either outcome so nothing is silently dropped.
  const nextContext = `${runArgs.contextFile}.chatgpt-revision-${pass + 1}.md`
  const contextWrite = await agent(
    `Create ${nextContext} as a complete revision context. Copy the full original delivery contract from ${runArgs.contextFile}, then append a section "Fable review pass ${pass} — unverified findings" containing these raw findings from an independent read-only reviewer: ${JSON.stringify(review.findings)}. Precede them with this instruction verbatim: "These are UNVERIFIED claims from a reviewer with no live access to confirm exact repository state, registry contents, or line numbers. Before incorporating any finding, verify it yourself against the actual issue, the real repository, and current external sources (e.g. package registries) as needed. Fold in only what you confirm is correct and material. For any finding you determine is wrong, outdated, or already addressed, do not incorporate it — instead add a one-or-two-line entry under a '##' + ' Review responses' section at the end of the plan explaining why, citing your own verification evidence." Mutation boundary: Write ${nextContext} only; no other file, git, gh, task, memory, or chatgpt-review mutation.`,
    { label: `prepare revision context ${pass + 1}`, phase: 'Prepare', schema: CONTEXT_SCHEMA, model: 'sonnet' },
  )
  if (!contextWrite?.written) return { status: 'error', reason: 'could not prepare ChatGPT revision context', pass, session, conversationUrl }
  authorContextFile = nextContext
}

return { status: 'needs_human', reason: 'no Fable APPROVED verdict after 5 passes', passes: 5, session, conversationUrl, findings: lastFindings }

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'` }
