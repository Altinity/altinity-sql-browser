export const meta = {
  name: 'ship-decompose-and-implement-loop',
  description: 'For a High-risk, Large approved /ship unit plan: decompose the remaining work into sub-tasks, then implement each via a fresh sequential coding agent',
  whenToUse: 'Invoked by the /ship coordinator at step 2.3 only when the approved plan classifies itself High risk AND Large',
  phases: [
    { title: 'Decompose', detail: 'Fable/high proposes an ordered, dependency-respecting sub-task breakdown of the remaining plan work, grounded against what is already committed' },
    { title: 'Implement', detail: 'one fresh Sonnet coding agent per sub-task, in order, each committing locally before the next starts' },
  ],
}

// args: { planFile, branch, issueRef } — planFile is the approved plan's absolute path
// (unchanged from the plan-review loop); branch is the already-checked-out wip branch
// (main tree for a solo unit, or the unit's worktree); issueRef is a human label like
// "#447 phase 2" used in prompts and commit messages (its leading "#<n>" is reused
// verbatim in every sub-task's commit message, so pass the exact issue number here).
const runArgs = typeof args === 'string' ? JSON.parse(args) : args
if (!runArgs || !runArgs.planFile || !runArgs.branch || !runArgs.issueRef) {
  throw new Error('args {planFile, branch, issueRef} required')
}
const { planFile, branch, issueRef } = runArgs
const issueTag = (issueRef.match(/#\d+/) || ['#?'])[0]

const DECOMPOSE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['subtasks', 'alreadyDoneSummary'],
  properties: {
    alreadyDoneSummary: { type: 'string' },
    subtasks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'title', 'planSections', 'description', 'fileScope', 'dependsOn', 'doneWhen'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          planSections: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          fileScope: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'string' } },
          doneWhen: { type: 'string' },
        },
      },
    },
  },
}
const READ_ONLY = 'Strictly read-only: no Edit or Write, no git or gh mutations, no task or memory writes, no chatgpt-review invocation.'

phase('Decompose')
const decomposition = await agent(
  `Branch ${branch} is mid-implementation of the approved plan at ${planFile} (issue ${issueRef}). Inspect the ACTUAL current repository state on this checked-out branch: run \`git log --oneline origin/main..HEAD\` and \`git show --stat\` on each commit found, and read the actual files already created/modified to see exactly what's genuinely done versus merely planned. Read the full plan file. Then propose an ORDERED list of sub-tasks covering ONLY the plan's requirements NOT yet satisfied by the existing commit(s) — do not re-propose anything already done. Each sub-task must: name the specific plan section numbers it covers; declare a fileScope (paths/globs it will create or touch) that does not overlap any earlier sub-task's fileScope (list dependsOn by id if it genuinely needs another sub-task's output first, and order the list so every sub-task appears after everything in its dependsOn); and state a concrete doneWhen (a test, measurement, or gate command whose result proves it's actually complete, not just attempted). Size each sub-task so ONE fresh coding agent can plausibly complete it in one focused session (prefer more, smaller sub-tasks over few large ones) — this repository's local gate and any environment constraints (Docker/$TMPDIR, browser availability, etc.) are documented in skills/ship/references/repo-footguns.md and CLAUDE.md; read them and account for them. Also return a 2-4 sentence alreadyDoneSummary of what the existing commit(s) actually accomplished, so downstream agents don't redo it. ${READ_ONLY}`,
  { label: 'decompose remaining work', phase: 'Decompose', schema: DECOMPOSE_SCHEMA, model: 'fable', effort: 'high' },
)
if (!decomposition) return { status: 'error', reason: 'decomposition agent died' }
log(`Decomposed remaining work into ${decomposition.subtasks.length} sub-task(s): ${decomposition.subtasks.map(t => t.id).join(', ')}`)

phase('Implement')
const results = []
for (const [index, task] of decomposition.subtasks.entries()) {
  log(`Sub-task ${index + 1}/${decomposition.subtasks.length} — ${task.id}: ${task.title}`)
  const priorSummaries = results.map(r => `- ${r.task.id} (${r.task.title}): ${r.summary ?? '(agent died / no summary)'}`).join('\n')
  const result = await agent(
    `You are implementing ONE sub-task of the approved plan at ${planFile} for issue ${issueRef}, on branch ${branch} (already checked out — stay on it, do not switch branches; ${decomposition.alreadyDoneSummary}).\n\n` +
    `Your sub-task: ${task.id} — ${task.title}\n` +
    `Covers plan sections: ${task.planSections.join(', ')}\n` +
    `Description: ${task.description}\n` +
    `Your file scope (create/modify only within this — if the plan genuinely requires touching something outside it, explain why in your final report rather than silently expanding scope): ${task.fileScope.join(', ')}\n` +
    `Definition of done: ${task.doneWhen}\n\n` +
    (priorSummaries ? `Earlier sub-tasks already completed on this branch, in order:\n${priorSummaries}\n\n` : '') +
    `Read the full plan file for complete context (architecture, invariants, sabotage checks, and the exact commands/conventions it specifies) before implementing — your sub-task description is a pointer into it, not a replacement for it. Follow skills/ship/references/per-issue-cycle.md steps 2-3 and skills/ship/references/repo-footguns.md. Run the full local gate (` + '`npm run check:types && npm run check:arch && npm run check:schemas && npm run check:examples && npm test && npm run build`' + `, captured to a file, tail only on completion) before considering your sub-task done, plus whatever sub-task-specific test/measurement command your doneWhen names.\n\n` +
    `Mutation boundary: Edit/Write + local \`git commit\` on ${branch} ONLY (this working tree — no push, no PR, no other gh mutations, no issue edits, no ship-log writes, no memory writes, no CHANGELOG.md beyond your own entry if this sub-task warrants one, no TaskCreate/TaskUpdate, never invoke chatgpt-review). Commit message format: \`<type>(${issueTag}): <summary>\`, ending with the repo's standard commit footer.\n\n` +
    `Return: what you implemented, the gate's pass/fail tail, your doneWhen command's actual result, files touched, and your commit(s) (\`git log --oneline\` for just your new commits). If you get stuck or the sub-task turns out to need a decision not in the plan, stop and report exactly what's missing rather than guessing.`,
    { label: task.id, phase: 'Implement', model: 'sonnet' },
  )
  results.push({ task, summary: result })
  if (!result) return { status: 'error', reason: `sub-task ${task.id} agent died`, completedSubtasks: results.map(r => r.task.id) }
}

return { status: 'done', alreadyDoneSummary: decomposition.alreadyDoneSummary, subtasks: decomposition.subtasks, results }
