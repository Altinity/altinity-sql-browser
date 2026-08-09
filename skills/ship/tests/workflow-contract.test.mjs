import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('ChatGPT planner workflow enforces ownership, ChatGPT-self-verification, and the five-pass stop', async () => {
  const source = await fs.readFile(path.join(root, 'references/chatgpt-plan-author-loop.workflow.mjs'), 'utf8');
  assert.doesNotThrow(() => new Function(`return async function workflowSyntaxCheck() {\n${source.replace('export const meta', 'const meta')}\n}`));
  assert.match(source, /for \(let pass = 1; pass <= 5; pass\+\+\)/);
  assert.match(source, /plan-author/);
  assert.match(source, /model: 'fable', effort: 'high'/);
  assert.match(source, /model: 'sonnet'/);
  // Fable's findings go to ChatGPT unverified by a separate pass — ChatGPT (the plan's
  // sole author/reviser) checks them itself against the real repository before folding
  // any in, per the caller instruction embedded in the revision context.
  assert.match(source, /UNVERIFIED claims/);
  assert.match(source, /lastFindings = review\.findings/);
  assert.doesNotMatch(source, /verified\.filter/);
  assert.match(source, /no Fable APPROVED verdict after 5 passes/);
  assert.match(source, /status: 'blocked'/);
  assert.match(source, /status: 'needs_human'/);
});

test('the canonical plan path remains the authoring-session identity', async () => {
  const cli = await fs.readFile(path.join(root, '../chatgpt-review/scripts/chatgpt-review.mjs'), 'utf8');
  assert.match(cli, /plan-author:\$\{target\.identity\}:\$\{planFile\}/);
  const workflow = await fs.readFile(path.join(root, 'references/chatgpt-plan-author-loop.workflow.mjs'), 'utf8');
  assert.doesNotMatch(workflow, /planFile\s*=/);
  assert.match(workflow, /--output-file \$\{shellQuote\(runArgs\.planFile\)\}/);
});

test('the decompose-and-implement loop grounds decomposition in the real branch, runs waves in dependency order, parallelizing only within an explicitly-independent wave, and propagates failure', async () => {
  const source = await fs.readFile(path.join(root, 'references/decompose-and-implement-loop.workflow.mjs'), 'utf8');
  assert.doesNotThrow(() => new Function(`return async function workflowSyntaxCheck() {\n${source.replace('export const meta', 'const meta')}\n}`));
  // Decomposition must read what's ALREADY committed, not just the plan in the abstract.
  assert.match(source, /git log --oneline origin\/main\.\.HEAD/);
  assert.match(source, /model: 'fable', effort: 'high'/);
  // Waves run strictly in dependency order; a solo wave (no independent sibling) runs its
  // one sub-task directly, never via parallel() — only a wave the decomposition agent
  // explicitly declared independent (size > 1) fans out concurrently, scoped to that one
  // wave's own sub-tasks.
  assert.match(source, /for \(const \[waveIndex, wave\] of waves\.entries\(\)\)/);
  assert.match(source, /if \(wave\.length === 1\)/);
  assert.match(source, /parallel\(wave\.map\(/);
  assert.doesNotMatch(source, /pipeline\(/);
  // Each sub-task is implemented by a fresh Sonnet coding agent, on both the solo path
  // and the concurrent-wave path.
  assert.match(source, /\{ label: task\.id, phase: 'Implement', model: 'sonnet' \}/);
  assert.match(source, /\{ label: task\.id, phase: 'Implement', model: 'sonnet', isolation: 'worktree'/);
  // A dead sub-task agent must stop the loop at every call site, not silently skip the
  // rest: the solo path, the concurrent-wave path, and post-wave integration.
  assert.match(source, /if \(!summary\) return \{ status: 'error'/);
  assert.match(source, /const diedIndex = waveOutputs\.findIndex\(o => !o\)/);
  assert.match(source, /if \(!integration\) return \{ status: 'error'/);
});

test('required args are validated and the issue tag is derived for commit messages', async () => {
  const source = await fs.readFile(path.join(root, 'references/decompose-and-implement-loop.workflow.mjs'), 'utf8');
  assert.match(source, /throw new Error\('args \{planFile, branch, issueRef\} required'\)/);
  assert.match(source, /issueRef\.match\(\/#\\d\+\/\)/);
});

test('SKILL.md wires the High+Large decomposition branch into step 2.3, and per-issue-cycle.md defines the flag', async () => {
  const skill = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8');
  assert.match(skill, /High risk \+ Large unit/);
  assert.match(skill, /decompose-and-implement-loop\.workflow\.mjs/);
  const cycle = await fs.readFile(path.join(root, 'references/per-issue-cycle.md'), 'utf8');
  assert.match(cycle, /also state whether the unit is Large/);
  assert.match(cycle, /Most units are not Large/);
});
