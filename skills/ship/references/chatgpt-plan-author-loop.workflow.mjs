export const meta = {
  name: 'ship-chatgpt-plan-author-loop',
  description: 'Have ChatGPT author a /ship unit plan and iterate it through Fable/high approval (max 5 review passes)',
  whenToUse: 'Invoked by the /ship coordinator only when --planner chatgpt is selected',
  phases: [
    { title: 'Author', detail: 'ChatGPT writes or replaces the canonical plan privately' },
    { title: 'Review', detail: 'Fable/high reviews the plan read-only against the repository' },
    { title: 'Prepare', detail: 'write this pass\'s findings-only revision note for ChatGPT to verify and incorporate itself' },
  ],
}

// args: { issueUrl, planFile, contextFile, unitLabel } — absolute file paths.
const runArgs = typeof args === 'string' ? JSON.parse(args) : args
if (!runArgs || !runArgs.issueUrl || !runArgs.planFile || !runArgs.contextFile) {
  throw new Error('args {issueUrl, planFile, contextFile, unitLabel} required')
}

const AUTHOR_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['completed', 'planStatus', 'session', 'conversationUrl', 'blocker', 'lastResponsePreviewFile'],
  properties: {
    completed: { type: 'boolean' },
    planStatus: { type: 'string', enum: ['READY', 'BLOCKED', 'INVALID'] },
    session: { type: ['string', 'null'] },
    conversationUrl: { type: ['string', 'null'] },
    blocker: { type: ['string', 'null'] },
    lastResponsePreviewFile: { type: ['string', 'null'], description: 'if completed=false, the file path (no embedded newlines/quotes) the runner wrote via the mandated mechanical Bash command containing the last ~500 chars of the FINAL attempt\'s response_text (even if empty/partial) — diagnostic only, so a future incomplete-with-real-content-present case (observed once on #630 phase 8, never root-caused) is easier to tell apart from a genuinely empty/stuck generation without re-deriving it from scratch. The runner must never hand-transcribe response_text into this or any other tool-call argument — only a file path is ever schema data. null when completed=true (no file written).' },
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
// The delivery contract at runArgs.contextFile never changes and is never re-copied — it is
// uploaded fresh (not pasted) on every pass by chatgpt-review.mjs's own --question-file
// handling. Only a genuinely new, small, findings-only note is generated per revision pass
// and pasted alongside it.
let revisionNoteFile = null
let lastFindings = []

for (let pass = 1; pass <= 5; pass++) {
  log(`ChatGPT plan authoring / Fable review pass ${pass}/5 — ${label}`)
  const sessionFlag = session ? ` --session ${shellQuote(session)}` : ''
  const revisionNoteFlag = revisionNoteFile ? ` --revision-note-file ${shellQuote(revisionNoteFile)}` : ''
  // Fixed by the workflow, not the runner agent, so the diagnostic path is deterministic
  // and the agent never has to invent or transcribe anything into it.
  const previewFile = `${runArgs.contextFile}.author-pass-${pass}-response-preview.txt`
  const authored = await agent(
    'Run the private ChatGPT plan-author command below in Bash IN THE FOREGROUND with the Bash timeout set to 580000, redirect stdout to a JSON file under $TMPDIR, and never use run_in_background:\n\n' +
    `node skills/chatgpt-review/scripts/chatgpt-review.mjs plan-author ${shellQuote(runArgs.issueUrl)} --output-file ${shellQuote(runArgs.planFile)} --question-file ${shellQuote(runArgs.contextFile)}${revisionNoteFlag} --timeout 540${sessionFlag}\n\n` +
    'Read the JSON. A complete result has status=completed and plan_status=ready or blocked. For timed_out, rate_limited, invalid_response, or any other incomplete result, retry the same command with --session from the JSON for up to 4 total attempts; wait 90 seconds before a rate_limited retry using a small-increment loop. Never start a new conversation after a session handle exists. Map the last JSON to the schema: completed=true only for a complete ready/blocked protocol; planStatus from plan_status uppercased, otherwise INVALID; retain session, conversation_url, and blocker. ' +
    `If completed=false (the FINAL attempt, retried or not, never reached a complete ready/blocked protocol), run exactly this Bash command, substituting the FINAL attempt's own JSON output file path for FINAL_JSON_FILE: node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));fs.writeFileSync(process.argv[2], String(j.response_text||'').slice(-500))" FINAL_JSON_FILE ${shellQuote(previewFile)} — then set lastResponsePreviewFile to exactly this path string: ${previewFile} . This is purely mechanical file-to-file copying; never read response_text yourself, never paste or paraphrase any part of it into this message or any tool-call argument, and never use it to compose completed/planStatus/blocker. If completed=true, do not run that command and set lastResponsePreviewFile to null. ` +
    'The command is private and must never receive publication flags. ' + RUNNER_BOUNDARY,
    { label: `author plan ${pass}`, phase: 'Author', schema: AUTHOR_SCHEMA, model: 'sonnet' },
  )
  if (!authored) return { status: 'error', reason: 'plan-author runner agent died', pass, session, conversationUrl }
  session = authored.session ?? session
  conversationUrl = authored.conversationUrl ?? conversationUrl
  if (!authored.completed) return { status: 'needs_human', reason: 'plan authoring remained incomplete after retries', pass, session, conversationUrl, lastResponsePreviewFile: authored.lastResponsePreviewFile }
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
  // it in or reject it, recording either outcome so nothing is silently dropped. The note
  // is ONLY this pass's new findings — never a copy of the delivery contract, which is
  // already re-attached in full, unchanged, every pass via --question-file above.
  const nextNote = `${runArgs.contextFile}.chatgpt-revision-${pass + 1}-findings.md`
  const noteWrite = await agent(
    `Create ${nextNote} containing ONLY this revision pass's findings note — do not copy, restate, or summarize the delivery contract at ${runArgs.contextFile}; it is a separate attachment ChatGPT already has and always will on every pass, so repeating any of its content here is a duplication bug, not a safety margin. Write exactly: a heading "## Fable review pass ${pass} — unverified findings", then this instruction verbatim: "These are UNVERIFIED claims from a reviewer with no live access to confirm exact repository state, registry contents, or line numbers. Before incorporating any finding, verify it yourself against the actual issue, the real repository, and current external sources (e.g. package registries) as needed. Fold in only what you confirm is correct and material. For any finding you determine is wrong, outdated, or already addressed, do not incorporate it — instead add a one-or-two-line entry under a '##' + ' Review responses' section at the end of the plan explaining why, citing your own verification evidence.", then these raw findings from an independent read-only reviewer: ${JSON.stringify(review.findings)}. Mutation boundary: Write ${nextNote} only; no other file, git, gh, task, memory, or chatgpt-review mutation.`,
    { label: `prepare revision note ${pass + 1}`, phase: 'Prepare', schema: CONTEXT_SCHEMA, model: 'sonnet' },
  )
  if (!noteWrite?.written) return { status: 'error', reason: 'could not prepare ChatGPT revision note', pass, session, conversationUrl }
  revisionNoteFile = nextNote
}

return { status: 'needs_human', reason: 'no Fable APPROVED verdict after 5 passes', passes: 5, session, conversationUrl, findings: lastFindings }

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'` }
