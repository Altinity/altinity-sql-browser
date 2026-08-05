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
