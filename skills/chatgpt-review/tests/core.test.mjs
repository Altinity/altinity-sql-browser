import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs, CliError } from '../scripts/lib/cli.mjs';
import { normalizeGithubTarget } from '../scripts/lib/target.mjs';
import { buildPrompt, extractReportedMetadata } from '../scripts/lib/prompt.mjs';
import { collectLocalDiff, isSensitivePath, stripBinaryPatches } from '../scripts/lib/diff.mjs';
import { SessionStore, defaultStateDir } from '../scripts/lib/state.mjs';
import { exitCode, renderResult, resultDocument } from '../scripts/lib/output.mjs';
import { run } from '../scripts/chatgpt-review.mjs';

const exec = promisify(execFile);

test('CLI parses documented modes, defaults, environment, and publication rules', () => {
  const parsed = parseArgs(['pr', 'https://github.com/o/r/pull/7'], {});
  assert.equal(parsed.mode, 'pr');
  assert.equal(parsed.target, 'https://github.com/o/r/pull/7');
  assert.equal(parsed.timeoutMs, 1_800_000);
  assert.equal(parsed.requestedPublication, true);
  assert.equal(parseArgs(['pr', 'https://github.com/o/r/pull/7', '--no-publish'], {}).requestedPublication, false);
  assert.equal(parseArgs(['issue', 'https://github.com/o/r/issues/7', '--publish'], {}).requestedPublication, true);
  assert.equal(parseArgs(['plan', './p.md', '--timeout', '3'], {}).target, path.resolve('./p.md'));
  assert.equal(parseArgs(['doctor'], { CHATGPT_REVIEW_CDP_URL: 'http://example:1' }).cdpUrl, 'http://example:1');
  assert.equal(parseArgs(['local', '--working-tree', '--include-untracked'], {}).workingTree, true);
});

test('CLI rejects invalid combinations', () => {
  for (const args of [[], ['wat'], ['pr'], ['doctor', 'x'], ['local', 'x'], ['issue', 'x', '--publish', '--no-publish'], ['plan', 'x', '--timeout', 'nope'], ['doctor', '--wat']]) {
    assert.throws(() => parseArgs(args), CliError);
  }
});

test('GitHub targets are canonical and kind checked', () => {
  assert.deepEqual(normalizeGithubTarget('https://github.com/Owner/repo/pull/007', 'pr'), {
    kind: 'pr', owner: 'Owner', repo: 'repo', number: 7,
    canonicalUrl: 'https://github.com/Owner/repo/pull/7', identity: 'Owner/repo#7',
  });
  assert.throws(() => normalizeGithubTarget('http://github.com/o/r/pull/1', 'pr'), CliError);
  assert.throws(() => normalizeGithubTarget('https://gitlab.com/o/r/pull/1', 'pr'), CliError);
  assert.throws(() => normalizeGithubTarget('https://github.com/o/r/issues/1', 'pr'), CliError);
  assert.throws(() => normalizeGithubTarget('https://github.com/o/r/pull/1/files', 'pr'), CliError);
});

test('prompts enforce investigation, trust, publication, and follow-up contracts', () => {
  const target = normalizeGithubTarget('https://github.com/o/r/pull/9', 'pr');
  const initial = buildPrompt({ mode: 'pr', target, publish: true, pass: 1, context: 'coverage gate' });
  assert.match(initial, /complete current PR/);
  assert.match(initial, /exact head SHA/);
  assert.match(initial, /pass 1/);
  assert.match(initial, /untrusted evidence/);
  const followup = buildPrompt({ mode: 'pr', target, publish: true, pass: 2, previousSha: 'a'.repeat(40) });
  assert.match(followup, /reassess every earlier finding/);
  assert.match(followup, /complete updated PR for regressions/);
  assert.match(followup, new RegExp('a{40}'));
  assert.match(followup, /Do not edit or replace/);
  assert.match(buildPrompt({ mode: 'issue', target: { ...target, canonicalUrl: 'https://github.com/o/r/issues/9' }, publish: false, pass: 1 }), /Do not post/);
  const plan = buildPrompt({ mode: 'plan', uploadName: 'exact-plan.md', context: 'acceptance' });
  assert.match(plan, /attached as exact-plan\.md/);
  assert.match(plan, /Do not write anything to GitHub/);
  assert.match(buildPrompt({ mode: 'local', uploadName: 'local.diff' }), /only source for local-only state/);
});

test('reported SHA and comment URL are extracted', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  assert.deepEqual(extractReportedMetadata(`Reviewed ${sha}. https://github.com/o/r/pull/1#issuecomment-22`), {
    reportedReviewedSha: sha, reportedGithubCommentUrl: 'https://github.com/o/r/pull/1#issuecomment-22',
  });
});

test('sensitive paths and binary patches are rejected or stripped', () => {
  assert.equal(isSensitivePath('.env.local'), true);
  assert.equal(isSensitivePath('keys/id_ed25519'), true);
  assert.equal(isSensitivePath('src/app.ts'), false);
  const stripped = stripBinaryPatches('diff --git a/a b/a\nGIT binary patch\nliteral 2\nabc\ndiff --git a/b b/b\n+x\n');
  assert.doesNotMatch(stripped, /literal 2/);
  assert.match(stripped, /binary patch excluded/);
  assert.match(stripped, /diff --git a\/b/);
});

test('local diff includes branch, index, working tree, and explicit untracked text but excludes binary bytes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-review-git-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await exec('git', ['init', '-q'], { cwd: dir });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
  await exec('git', ['add', 'a.txt'], { cwd: dir });
  await exec('git', ['commit', '-qm', 'base'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'a.txt'), 'two\n');
  await exec('git', ['add', 'a.txt'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'a.txt'), 'three\n');
  await fs.writeFile(path.join(dir, 'new.txt'), 'hello\n');
  await fs.writeFile(path.join(dir, 'image.bin'), Buffer.from([0, 1, 2]));
  const result = await collectLocalDiff({ repo: dir, base: 'HEAD', workingTree: true, includeUntracked: true });
  assert.match(result.text, /Index changes/);
  assert.match(result.text, /Working-tree changes/);
  assert.match(result.text, /new\.txt/);
  assert.match(result.text, /binary content excluded/);
  await fs.writeFile(path.join(dir, '.env'), 'TOKEN=x');
  await assert.rejects(() => collectLocalDiff({ repo: dir, includeUntracked: true }), /sensitive/);
});

test('state records are permission restricted, atomic, indexed, and sanitized', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-review-state-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(dir);
  let record = await store.create({ mode: 'pr', targetIdentity: 'pr:o/r#1', prompt: 'must not persist' });
  record = await store.write({ ...record, passCount: 1, conversationUrl: 'https://chatgpt.com/c/abc', response: 'must not persist' });
  assert.equal((await store.latestFor('pr:o/r#1')).handle, record.handle);
  const raw = await fs.readFile(store.sessionPath(record.handle), 'utf8');
  assert.doesNotMatch(raw, /must not persist|prompt|response/);
  assert.equal((await fs.stat(store.sessionPath(record.handle))).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(path.join(dir, 'sessions'))).filter((name) => name.endsWith('.tmp')), []);
  await assert.rejects(() => store.load('../bad'), CliError);
  assert.match(defaultStateDir({}, 'darwin', '/u'), /Library\/Application Support/);
  assert.equal(defaultStateDir({ XDG_STATE_HOME: '/state' }, 'linux', '/u'), '/state/chatgpt-review');
});

test('output schema is stable and statuses map to distinct exit codes', () => {
  const doc = resultDocument({ status: 'completed', response_text: 'ok' });
  assert.deepEqual(Object.keys(doc), ['status', 'response_text', 'session', 'conversation_url', 'elapsed_seconds', 'pass_number', 'requested_publication', 'reported_reviewed_sha', 'reported_github_comment_url', 'error']);
  assert.equal(JSON.parse(renderResult(doc)).response_text, 'ok');
  assert.match(renderResult(doc, 'text'), /Status: completed/);
  assert.equal(exitCode('completed'), 0);
  assert.equal(new Set(['timed_out', 'needs_interaction', 'login_required', 'chrome_unavailable', 'ui_incompatible'].map(exitCode)).size, 5);
});

test('run retains a session and enforces three PR passes', async () => {
  const records = new Map();
  const store = {
    async create(data) { const value = { handle: '00000000-0000-4000-8000-000000000001', passCount: 0, ...data }; records.set(value.handle, value); return value; },
    async load(handle) { return records.get(handle); },
    async write(value) { records.set(value.handle, value); return value; },
  };
  const driver = { async review() { return { responseText: `Reviewed ${'b'.repeat(40)}`, conversationUrl: 'https://chatgpt.com/c/one' }; } };
  let result = await run(['pr', 'https://github.com/o/r/pull/1', '--no-publish'], { store, driver });
  assert.equal(result.pass_number, 1);
  for (let pass = 2; pass <= 3; pass += 1) {
    result = await run(['pr', 'https://github.com/o/r/pull/1', '--session', result.session, '--no-publish'], { store, driver });
    assert.equal(result.pass_number, pass);
  }
  result = await run(['pr', 'https://github.com/o/r/pull/1', '--session', result.session], { store, driver });
  assert.equal(result.status, 'invalid_request');
  assert.match(result.error, /at most three/);
});

test('plan mode uploads exactly the supplied file and never authorizes publication', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-review-plan-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const planFile = path.join(dir, 'complete-plan.md');
  await fs.writeFile(planFile, '# Complete plan\n');
  let observed;
  const store = {
    async create(data) { return { handle: '00000000-0000-4000-8000-000000000002', passCount: 0, ...data }; },
    async write(value) { return value; },
  };
  const driver = { async review(input) { observed = input; return { responseText: 'review', conversationUrl: 'https://chatgpt.com/c/plan' }; } };
  const result = await run(['plan', planFile], { store, driver });
  assert.equal(result.status, 'completed');
  assert.equal(observed.uploadPath, planFile);
  assert.equal(observed.publish, false);
  assert.match(observed.prompt, /Do not write anything to GitHub/);
});
