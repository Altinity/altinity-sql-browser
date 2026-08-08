export const meta = {
  name: 'ship-decompose-and-implement-loop',
  description: 'For a High-risk, Large approved /ship unit plan: decompose the remaining work into sub-tasks, then implement each via a fresh coding agent — sequential when sub-tasks depend on each other, concurrent in isolated worktrees when a wave of sub-tasks is genuinely independent',
  whenToUse: 'Invoked by the /ship coordinator at step 2.3 only when the approved plan classifies itself High risk AND Large',
  phases: [
    { title: 'Decompose', detail: 'Fable/high proposes an ordered, dependency-respecting sub-task breakdown of the remaining plan work, grounded against what is already committed' },
    { title: 'Implement', detail: 'one fresh Sonnet coding agent per sub-task; a wave of sub-tasks with no dependency between them runs concurrently in isolated worktrees, one wave at a time' },
    { title: 'Integrate', detail: 'after a concurrent wave, merge every sub-task branch back into the unit branch in order and gate the result before the next wave starts' },
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
const unitSlug = issueRef.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'unit'

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
const PARALLEL_TASK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['branchName', 'summary', 'gateGreen'],
  properties: {
    branchName: { type: 'string', description: 'the exact wip/<unit>-<id> branch this sub-task committed to' },
    summary: { type: 'string', description: 'what was implemented, the gate tail, doneWhen result, files touched, commits' },
    gateGreen: { type: 'boolean' },
  },
}
const INTEGRATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['mergedTasks', 'conflictedTask', 'gateGreen', 'gateTail'],
  properties: {
    mergedTasks: { type: 'array', items: { type: 'string' }, description: 'sub-task ids merged cleanly, in order, before any conflict' },
    conflictedTask: { type: ['string', 'null'], description: 'the sub-task id whose merge conflicted, if any; null if all merged cleanly' },
    gateGreen: { type: 'boolean', description: 'false if a conflict stopped integration before the gate ran' },
    gateTail: { type: 'string' },
  },
}
const READ_ONLY = 'Strictly read-only: no Edit or Write, no git or gh mutations, no task or memory writes, no chatgpt-review invocation.'

phase('Decompose')
const decomposition = await agent(
  `Branch ${branch} is mid-implementation of the approved plan at ${planFile} (issue ${issueRef}). Inspect the ACTUAL current repository state on this checked-out branch: run \`git log --oneline origin/main..HEAD\` and \`git show --stat\` on each commit found, and read the actual files already created/modified to see exactly what's genuinely done versus merely planned. Read the full plan file. Then propose a list of sub-tasks covering ONLY the plan's requirements NOT yet satisfied by the existing commit(s) — do not re-propose anything already done. Each sub-task must: name the specific plan section numbers it covers; declare a fileScope (paths/globs it will create or touch) that does not overlap ANY OTHER sub-task's fileScope, not merely earlier ones; list dependsOn by id for every sub-task it genuinely needs the output of first; and state a concrete doneWhen (a test, measurement, or gate command whose result proves it's actually complete, not just attempted).\n\n` +
  `dependsOn also controls execution mode, so treat it carefully: sub-tasks that share no dependsOn relationship (directly or transitively) may run CONCURRENTLY, each in its own isolated git worktree, with no visibility into each other's edits until an automated merge afterward. Only omit a dependsOn edge between two sub-tasks when you are confident BOTH that neither needs the other's output AND that their file scopes cannot collide even if edited at the same time. If you are not fully confident two sub-tasks are safe to run concurrently, add a dependsOn edge between them even without a strict technical need — favor serializing over a risky parallel guess, exactly as this repository's own footgun guidance already does for wave-planning (a merge conflict or silent collision costs far more than the wall-clock time saved). Most plans will still end up mostly or fully sequential; only mark independence where it is genuinely, conservatively safe.\n\n` +
  `Size each sub-task so ONE fresh coding agent can plausibly complete it in one focused session (prefer more, smaller sub-tasks over few large ones) — this repository's local gate and any environment constraints (Docker/$TMPDIR, browser availability, etc.) are documented in skills/ship/references/repo-footguns.md and CLAUDE.md; read them and account for them. Also return a 2-4 sentence alreadyDoneSummary of what the existing commit(s) actually accomplished, so downstream agents don't redo it. ${READ_ONLY}`,
  { label: 'decompose remaining work', phase: 'Decompose', schema: DECOMPOSE_SCHEMA, model: 'fable', effort: 'high' },
)
if (!decomposition) return { status: 'error', reason: 'decomposition agent died' }
log(`Decomposed remaining work into ${decomposition.subtasks.length} sub-task(s): ${decomposition.subtasks.map(t => t.id).join(', ')}`)

// Group into dependency-respecting waves via a topological pass: every sub-task whose
// dependsOn are all already "done" becomes ready together and forms the next wave. A
// wave of size 1 runs directly on `branch` (today's behavior, no isolation overhead); a
// wave of size >1 runs concurrently in isolated worktrees, since fileScope/dependsOn
// disjointness is a declared claim from the decomposition agent, not a verified
// guarantee — matching this skill's standing "when in doubt, serialize" principle,
// PARALLELISM ONLY HAPPENS WHEN THE PLAN'S OWN DECOMPOSITION EXPLICITLY LEFT A
// dependsOn EDGE OUT, never inferred by this script beyond that.
function computeWaves(subtasks) {
  const ids = new Set(subtasks.map(t => t.id))
  for (const t of subtasks) for (const d of t.dependsOn) {
    if (!ids.has(d)) throw new Error(`sub-task ${t.id} declares dependsOn unknown id "${d}"`)
  }
  const done = new Set()
  const waves = []
  let remaining = subtasks.slice()
  while (remaining.length) {
    const ready = remaining.filter(t => t.dependsOn.every(d => done.has(d)))
    if (!ready.length) throw new Error('dependency cycle detected among sub-tasks: ' + remaining.map(t => t.id).join(', '))
    waves.push(ready)
    ready.forEach(t => done.add(t.id))
    remaining = remaining.filter(t => !ready.includes(t))
  }
  return waves
}
const waves = computeWaves(decomposition.subtasks)
log(`Grouped into ${waves.length} wave(s): ${waves.map(w => `[${w.map(t => t.id).join(', ')}]`).join(' -> ')}`)

phase('Implement')
const results = []
const priorSummaryText = () => results.map(r => `- ${r.task.id} (${r.task.title}): ${r.summary ?? '(agent died / no summary)'}`).join('\n')

function runSoloSubtask(task, priorSummaries, alreadyDoneSummary) {
  return agent(
    `You are implementing ONE sub-task of the approved plan at ${planFile} for issue ${issueRef}, on branch ${branch} (already checked out — stay on it, do not switch branches; ${alreadyDoneSummary}).\n\n` +
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
}

function runParallelSubtask(task, priorSummaries, alreadyDoneSummary) {
  const wipBranch = `wip/${unitSlug}-${task.id}`
  return agent(
    `You are implementing ONE sub-task of the approved plan at ${planFile} for issue ${issueRef} (${alreadyDoneSummary}). This sub-task runs CONCURRENTLY with other independent sub-tasks in this same wave, each in its OWN isolated git worktree — you will NOT see their edits and they will not see yours until an automated integration step merges every branch back together afterward, so do not assume any file outside your own declared scope has already changed, and do not touch anything outside that scope.\n\n` +
    `FIRST, before any other work: create and check out your own branch from the current HEAD: \`git checkout -b ${wipBranch}\`. Commit all your work to THIS branch and no other.\n\n` +
    `Your sub-task: ${task.id} — ${task.title}\n` +
    `Covers plan sections: ${task.planSections.join(', ')}\n` +
    `Description: ${task.description}\n` +
    `Your file scope (create/modify ONLY within this — it was declared disjoint from every other sub-task in this wave specifically so concurrent execution is safe; if the plan genuinely requires touching something outside it, STOP and report why rather than silently expanding scope, since that could silently collide with concurrent work): ${task.fileScope.join(', ')}\n` +
    `Definition of done: ${task.doneWhen}\n\n` +
    (priorSummaries ? `Sub-tasks already completed and merged onto the base branch before this wave started:\n${priorSummaries}\n\n` : '') +
    `Read the full plan file for complete context (architecture, invariants, sabotage checks, and the exact commands/conventions it specifies) before implementing — your sub-task description is a pointer into it, not a replacement for it. Follow skills/ship/references/per-issue-cycle.md steps 2-3 and skills/ship/references/repo-footguns.md. Run the full local gate (` + '`npm run check:types && npm run check:arch && npm run check:schemas && npm run check:examples && npm test && npm run build`' + `, captured to a file, tail only on completion) before considering your sub-task done, plus whatever sub-task-specific test/measurement command your doneWhen names.\n\n` +
    `Mutation boundary: Edit/Write + local \`git commit\` on YOUR OWN ${wipBranch} branch ONLY — no push, no PR, no other gh mutations, no issue edits, no ship-log writes, no memory writes, no CHANGELOG.md beyond your own entry if this sub-task warrants one, no TaskCreate/TaskUpdate, never invoke chatgpt-review. Commit message format: \`<type>(${issueTag}): <summary>\`, ending with the repo's standard commit footer.\n\n` +
    `Return: branchName (must be exactly "${wipBranch}"), gateGreen (true only if the full local gate actually passed), and summary (what you implemented, the gate's pass/fail tail, your doneWhen command's actual result, files touched, your commit(s) via \`git log --oneline\` for just your new commits). If you get stuck or the sub-task turns out to need a decision not in the plan, stop and report exactly what's missing rather than guessing.`,
    { label: task.id, phase: 'Implement', model: 'sonnet', isolation: 'worktree', schema: PARALLEL_TASK_SCHEMA },
  )
}

for (const [waveIndex, wave] of waves.entries()) {
  // Re-assert 'Implement' at the top of every wave: a previous wave's Integrate step
  // (below) leaves that as the last-set phase label otherwise, mislabeling this wave's
  // agent() calls in the progress display.
  phase('Implement')
  if (wave.length === 1) {
    const task = wave[0]
    log(`Wave ${waveIndex + 1}/${waves.length} — solo sub-task ${task.id}: ${task.title}`)
    const summary = await runSoloSubtask(task, priorSummaryText(), decomposition.alreadyDoneSummary)
    results.push({ task, summary })
    if (!summary) return { status: 'error', reason: `sub-task ${task.id} agent died`, completedSubtasks: results.map(r => r.task.id) }
    continue
  }

  log(`Wave ${waveIndex + 1}/${waves.length} — ${wave.length} independent sub-tasks running concurrently: ${wave.map(t => t.id).join(', ')}`)
  const priorText = priorSummaryText()
  const waveOutputs = await parallel(wave.map(task => () => runParallelSubtask(task, priorText, decomposition.alreadyDoneSummary)))
  wave.forEach((task, i) => results.push({ task, summary: waveOutputs[i]?.summary ?? null }))
  const diedIndex = waveOutputs.findIndex(o => !o)
  if (diedIndex !== -1) {
    return { status: 'error', reason: `sub-task ${wave[diedIndex].id} agent died`, completedSubtasks: results.map(r => r.task.id) }
  }
  const missingBranch = waveOutputs.find(o => !o.branchName)
  if (missingBranch) {
    return { status: 'error', reason: `a wave ${waveIndex + 1} sub-task did not report a branch to merge`, completedSubtasks: results.map(r => r.task.id) }
  }

  phase('Integrate')
  const toMerge = wave.map((task, i) => ({ id: task.id, branchName: waveOutputs[i].branchName }))
  const integration = await agent(
    `On branch ${branch}, already checked out in the main working tree (verify with \`git branch --show-current\` and stop if it differs), merge these independently-implemented sub-task branches IN THIS ORDER: ${JSON.stringify(toMerge)}.\n\n` +
    `For each, in order: \`git merge --no-ff <branchName> -m "merge: <id> (${issueTag})"\`. If a merge reports a conflict, run \`git merge --abort\` immediately, do NOT attempt to resolve it yourself, and stop — report which sub-task conflicted (conflictedTask) and which ones merged cleanly before it (mergedTasks). A conflict here means the sub-tasks' declared file scopes were not actually disjoint, which is a real planning defect worth surfacing precisely, not something to force through or paper over.\n\n` +
    `If every merge succeeds cleanly, run the full local gate (` + '`npm run check:types && npm run check:arch && npm run check:schemas && npm run check:examples && npm test && npm run build`' + `, captured to a file, tail only) and report gateGreen/gateTail truthfully — a clean set of individually-gated branches can still fail to gate together.\n\n` +
    `Mutation boundary: git merge + local commits on ${branch} ONLY — no push, no PR, no gh mutations, no issue/ship-log edits, no task/memory writes, no chatgpt-review invocations, and no code edits of your own (if the gate fails after a clean merge, report the failure honestly — do not attempt a fix; that is the coordinator's decision).`,
    { label: `integrate wave ${waveIndex + 1}`, phase: 'Integrate', agentType: 'general-purpose', schema: INTEGRATE_SCHEMA, model: 'sonnet' },
  )
  if (!integration) return { status: 'error', reason: `integration agent died for wave ${waveIndex + 1}`, completedSubtasks: results.map(r => r.task.id) }
  if (integration.conflictedTask) {
    return {
      status: 'error',
      reason: `merge conflict integrating "${integration.conflictedTask}" in wave ${waveIndex + 1} — sub-task file scopes were not actually disjoint`,
      mergedBeforeConflict: integration.mergedTasks,
      completedSubtasks: results.map(r => r.task.id),
    }
  }
  if (!integration.gateGreen) {
    return { status: 'error', reason: `post-merge gate failed for wave ${waveIndex + 1}`, gateTail: integration.gateTail, completedSubtasks: results.map(r => r.task.id) }
  }
  log(`Wave ${waveIndex + 1} integrated cleanly: ${integration.mergedTasks.join(', ')}`)
}

return { status: 'done', alreadyDoneSummary: decomposition.alreadyDoneSummary, subtasks: decomposition.subtasks, waves: waves.map(w => w.map(t => t.id)), results }
