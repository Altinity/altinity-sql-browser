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

test('the decompose-and-implement loop grounds decomposition in the real branch, runs sub-tasks sequentially, and propagates failure', async () => {
  const source = await fs.readFile(path.join(root, 'references/decompose-and-implement-loop.workflow.mjs'), 'utf8');
  assert.doesNotThrow(() => new Function(`return async function workflowSyntaxCheck() {\n${source.replace('export const meta', 'const meta')}\n}`));
  // Decomposition must read what's ALREADY committed, not just the plan in the abstract.
  assert.match(source, /git log --oneline origin\/main\.\.HEAD/);
  assert.match(source, /model: 'fable', effort: 'high'/);
  // Sequential, not parallel — a for-loop with one agent() awaited per iteration, no
  // parallel()/pipeline() call fanning sub-tasks out concurrently.
  assert.match(source, /for \(const \[index, task\] of decomposition\.subtasks\.entries\(\)\)/);
  assert.doesNotMatch(source, /parallel\(/);
  assert.doesNotMatch(source, /pipeline\(/);
  assert.match(source, /model: 'sonnet'/);
  // A dead sub-task agent must stop the loop, not silently skip the rest.
  assert.match(source, /if \(!result\) return \{ status: 'error'/);
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
