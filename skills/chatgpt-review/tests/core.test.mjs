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
import { parsePlanAuthorResponse, PLAN_BEGIN, PLAN_END } from '../scripts/lib/plan-author.mjs';
import { ReviewError } from '../scripts/lib/browser.mjs';

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
  const authored = parseArgs(['plan-author', 'https://github.com/o/r/issues/8', '--output-file', '/tmp/plan.md', '--question-file', '/tmp/context.md'], {});
  assert.equal(authored.mode, 'plan-author');
  assert.equal(authored.outputFile, '/tmp/plan.md');
  assert.equal(authored.requestedPublication, false);
  assert.equal(parseArgs(['doctor'], { CHATGPT_REVIEW_CDP_URL: 'http://example:1' }).cdpUrl, 'http://example:1');
  assert.equal(parseArgs(['local', '--working-tree', '--include-untracked'], {}).workingTree, true);
});

test('CLI rejects invalid combinations', () => {
  for (const args of [[], ['wat'], ['pr'], ['doctor', 'x'], ['local', 'x'], ['issue', 'x', '--publish', '--no-publish'], ['plan', 'x', '--timeout', 'nope'], ['doctor', '--wat'], ['plan-author', 'https://github.com/o/r/issues/1'], ['plan-author', 'https://github.com/o/r/issues/1', '--output-file', 'relative.md', '--question-file', '/tmp/q'], ['plan-author', 'https://github.com/o/r/issues/1', '--output-file', '/tmp/p', '--question-file', '/tmp/q', '--publish'], ['pr', 'https://github.com/o/r/pull/1', '--session', 'a', '--seed-from-session', 'b']]) {
    assert.throws(() => parseArgs(args), CliError);
  }
});

test('CLI accepts --seed-from-session as a documented value flag', () => {
  const parsed = parseArgs(['pr', 'https://github.com/o/r/pull/7', '--seed-from-session', '00000000-0000-4000-8000-000000000009'], {});
  assert.equal(parsed.seedFromSession, '00000000-0000-4000-8000-000000000009');
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
  const plan = buildPrompt({ mode: 'plan', uploadName: 'exact-plan.md', context: 'acceptance', pass: 1 });
  assert.match(plan, /attached as exact-plan\.md/);
  assert.match(plan, /Do not write anything to GitHub/);
  assert.doesNotMatch(plan, /SAME conversation/);
  const planRevision = buildPrompt({ mode: 'plan', uploadName: 'exact-plan.md', context: 'acceptance', pass: 2 });
  assert.match(planRevision, /revision review pass 2 of the SAME plan, in the SAME conversation/);
  assert.match(planRevision, /"## Review responses" section/);
  assert.match(planRevision, /explicitly engage with and refute its cited evidence/);
  assert.doesNotMatch(planRevision, /Critically review whether it closes the stated acceptance gap, respects the repository architecture and seams, has a safe migration order and rollback story, and includes adequate tests\. Identify omissions/);
  const author = buildPrompt({ mode: 'plan-author', target: { canonicalUrl: 'https://github.com/o/r/issues/9' }, pass: 1, context: 'delivery contract' });
  assert.match(author, /Browse the issue, the actual repository, CLAUDE\.md/);
  assert.match(author, /PLAN_STATUS: READY/);
  assert.match(author, /Do not write anything to GitHub/);
  const revision = buildPrompt({ mode: 'plan-author', target: { canonicalUrl: 'https://github.com/o/r/issues/9' }, pass: 2 });
  assert.match(revision, /that you produced in your own most recent message above in this conversation/);
  assert.doesNotMatch(revision, /attached as/);
  assert.match(buildPrompt({ mode: 'local', uploadName: 'local.diff' }), /only source for local-only state/);
});

test('reported SHA and comment URL are extracted', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  assert.deepEqual(extractReportedMetadata(`Reviewed ${sha}. https://github.com/o/r/pull/1#issuecomment-22`), {
    reportedReviewedSha: sha, reportedGithubCommentUrl: 'https://github.com/o/r/pull/1#issuecomment-22',
  });
});

test('follow-up metadata selects the newly reviewed head instead of the earlier SHA', () => {
  const previous = 'a'.repeat(40);
  const current = 'b'.repeat(40);
  const unrelated = 'c'.repeat(40);
  const response = `Previously reviewed SHA: ${previous}
Pass-2 reviewed SHA: ${current}
Later discussion mentions commit ${unrelated}.
https://github.com/o/r/pull/1#pullrequestreview-42`;
  assert.deepEqual(extractReportedMetadata(response), {
    reportedReviewedSha: current,
    reportedGithubCommentUrl: 'https://github.com/o/r/pull/1#pullrequestreview-42',
  });
});

test('plain reviewed-head labels exclude previous-head lines', () => {
  const previous = 'd'.repeat(40);
  const current = 'e'.repeat(40);
  assert.equal(extractReportedMetadata(`Previously reviewed head: ${previous}\nReviewed head: ${current}`).reportedReviewedSha, current);
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

test('heartbeat snapshots are permission-restricted, atomic, and separate from the durable session record', async (t) => {
  // A process killed externally with zero stdout ever flushed (confirmed live 6 times
  // across issue #630 — see browser.mjs's review() comment) still leaves this behind: was
  // it alive, still generating, how much text had it seen. Written to its own directory,
  // not the session record itself, since this is transient run state, not durable identity.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-review-heartbeat-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(dir);
  const record = await store.create({ mode: 'pr', targetIdentity: 'pr:o/r#1' });
  await store.writeHeartbeat(record.handle, { elapsedMs: 12_345, generating: true, textLength: 40, recoveryAttempted: false });
  const heartbeatPath = path.join(dir, 'heartbeat', `${record.handle}.json`);
  const saved = JSON.parse(await fs.readFile(heartbeatPath, 'utf8'));
  assert.equal(saved.handle, record.handle);
  assert.equal(saved.elapsedMs, 12_345);
  assert.equal(saved.generating, true);
  assert.ok(saved.updatedAt);
  assert.equal((await fs.stat(heartbeatPath)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(path.join(dir, 'heartbeat'))).filter((name) => name.endsWith('.tmp')), []);
  // A second write overwrites in place — only the latest snapshot matters, not a growing log.
  await store.writeHeartbeat(record.handle, { elapsedMs: 99_999, generating: false, textLength: 400, recoveryAttempted: true });
  assert.equal(JSON.parse(await fs.readFile(heartbeatPath, 'utf8')).elapsedMs, 99_999);
  await assert.rejects(() => store.writeHeartbeat('../bad', {}), CliError);
});

test('output schema is stable and statuses map to distinct exit codes', () => {
  const doc = resultDocument({ status: 'completed', response_text: 'ok' });
  assert.deepEqual(Object.keys(doc), ['status', 'response_text', 'session', 'conversation_url', 'elapsed_seconds', 'pass_number', 'requested_publication', 'reported_reviewed_sha', 'reported_github_comment_url', 'plan_status', 'plan_file', 'blocker', 'error']);
  assert.equal(JSON.parse(renderResult(doc)).response_text, 'ok');
  assert.match(renderResult(doc, 'text'), /Status: completed/);
  assert.equal(exitCode('completed'), 0);
  assert.equal(new Set(['timed_out', 'needs_interaction', 'login_required', 'chrome_unavailable', 'ui_incompatible'].map(exitCode)).size, 5);
  assert.equal(exitCode('invalid_response'), 8);
});

test('plan-author response parser accepts ready and blocked protocols', () => {
  assert.deepEqual(parsePlanAuthorResponse(`PLAN_STATUS: READY\n${PLAN_BEGIN}\n# Plan\n\nBody\n${PLAN_END}`), {
    planStatus: 'ready', plan: '# Plan\n\nBody\n', blocker: null,
  });
  assert.deepEqual(parsePlanAuthorResponse('PLAN_STATUS: BLOCKED\nBLOCKER: Product owner must choose A or B.'), {
    planStatus: 'blocked', plan: null, blocker: 'Product owner must choose A or B.',
  });
});

test('plan-author response parser tolerates a trailing web-search citation footnote after PLAN_END', () => {
  // ChatGPT appends a link footnote after the delimited plan when it looked something up
  // while authoring (e.g. verifying an exact npm package version, which is exactly the
  // behavior a "check the real version" review finding asks for) — reproduced live on
  // issue #585 phase 0's revision. The delimiter-count check already guarantees no second
  // plan is hiding in that trailing text, so it must not fail the whole response.
  const withFootnote = `PLAN_STATUS: READY\n${PLAN_BEGIN}\n# Plan\n\nBody\n${PLAN_END}\n\n[1]: https://www.npmjs.com/package/%40clickhouse/client-web "client-web"`;
  assert.deepEqual(parsePlanAuthorResponse(withFootnote), { planStatus: 'ready', plan: '# Plan\n\nBody\n', blocker: null });
});

test('plan-author response parser tolerates PLAN_END landing indented at the end of a nested list item', () => {
  // Reproduced live on issue #585 phase 0's pass-3 revision: PLAN_END was the last line of
  // a nested Markdown bullet and copied with two spaces of list indentation still attached
  // ("  <<<CHATGPT_PLAN_END>>>"), which the old exact-line-start regex rejected outright.
  const indented = `PLAN_STATUS: READY\n${PLAN_BEGIN}\n# Plan\n\n* item\n  * nested, ending the plan\n  ${PLAN_END}`;
  assert.deepEqual(parsePlanAuthorResponse(indented), {
    planStatus: 'ready', plan: '# Plan\n\n* item\n  * nested, ending the plan\n', blocker: null,
  });
});

test('plan-author response parser rejects missing, duplicate, empty, and malformed protocols', () => {
  const invalid = [
    `PLAN_STATUS: READY\n# no markers`,
    `PLAN_STATUS: READY\n${PLAN_BEGIN}\n# One\n${PLAN_END}\n${PLAN_BEGIN}\n# Two\n${PLAN_END}`,
    `PLAN_STATUS: READY\n${PLAN_BEGIN}\n \n${PLAN_END}`,
    `PLAN_STATUS: READY\n${PLAN_BEGIN}\nplain text only\n${PLAN_END}`,
    'PLAN_STATUS: BLOCKED\nBLOCKER:',
    `PLAN_STATUS: BLOCKED\nBLOCKER: missing choice\n${PLAN_BEGIN}\n# Plan\n${PLAN_END}`,
    'PLAN_STATUS: READY\nPLAN_STATUS: BLOCKED\nBLOCKER: conflict',
  ];
  for (const response of invalid) assert.throws(() => parsePlanAuthorResponse(response), (error) => error.status === 'invalid_response');
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

test('--seed-from-session threads a prior, different-mode conversation into a brand-new session', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-review-seed-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new SessionStore(dir);
  // A prior plan-author session for this SAME unit, already carrying a real conversation
  // and the fingerprint of ChatGPT's last message in it (as a completed plan-author pass
  // would leave behind).
  const seed = await store.create({
    mode: 'plan-author', targetIdentity: 'plan-author:o/r#8:/tmp/plan.md',
    conversationUrl: 'https://chatgpt.com/c/seed-conversation', lastResponseFingerprint: 'seed-fingerprint',
  });
  const seenSessions = [];
  const driver = {
    async review({ session }) {
      seenSessions.push(session ? { conversationUrl: session.conversationUrl, lastResponseFingerprint: session.lastResponseFingerprint } : null);
      return { responseText: `VERDICT: SHIP\nReviewed head ${'c'.repeat(40)}`, conversationUrl: session?.conversationUrl ?? 'https://chatgpt.com/c/new' };
    },
  };
  const result = await run(['pr', 'https://github.com/o/r/pull/1', '--seed-from-session', seed.handle, '--no-publish'], { store, driver });
  assert.equal(result.status, 'completed');
  assert.equal(result.pass_number, 1);
  assert.notEqual(result.session, seed.handle);
  assert.equal(result.conversation_url, 'https://chatgpt.com/c/seed-conversation');
  // review() must have been called with a session whose conversationUrl/lastResponseFingerprint
  // were already the seed's — proving the new pr-mode session reopened that exact conversation
  // (rather than opening a fresh chat) and was seeded with the fingerprint needed so the
  // "uncollected response" recovery path does not mistake the seed's last message for this
  // mode's own answer.
  assert.deepEqual(seenSessions, [{ conversationUrl: 'https://chatgpt.com/c/seed-conversation', lastResponseFingerprint: 'seed-fingerprint' }]);
  const newSession = await store.load(result.session);
  assert.equal(newSession.mode, 'pr');
  assert.equal(newSession.passCount, 1);
  // The seed session itself is untouched — seeding copies its conversation, it does not
  // consume or mutate the original record.
  const reloadedSeed = await store.load(seed.handle);
  assert.equal(reloadedSeed.passCount, 0);
});

test('plan mode uploads a pass-numbered copy (never the literal session-identity path) and never authorizes publication', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-review-plan-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const planFile = path.join(dir, 'complete-plan.md');
  await fs.writeFile(planFile, '# Complete plan\n');
  let observed;
  const store = {
    async create(data) { return { handle: '00000000-0000-4000-8000-000000000002', passCount: 0, ...data }; },
    async write(value) { return value; },
  };
  let uploadContentAtCallTime;
  const driver = {
    async review(input) {
      observed = input;
      // Must read here: the temp copy is cleaned up in run()'s `finally` before it returns.
      uploadContentAtCallTime = await fs.readFile(input.uploadPath, 'utf8');
      return { responseText: 'review', conversationUrl: 'https://chatgpt.com/c/plan' };
    },
  };
  const result = await run(['plan', planFile], { store, driver });
  assert.equal(result.status, 'completed');
  // The plan file's own path is the review-session identity and must never be the literal
  // upload target — re-uploading one unchanging filename every pass is what caused ChatGPT's
  // own UI to collision-rename it (plan-590(9).md) after enough retries.
  assert.notEqual(observed.uploadPath, planFile);
  assert.match(path.basename(observed.uploadPath), /^complete-plan-pass1\.md$/);
  assert.equal(uploadContentAtCallTime, '# Complete plan\n');
  assert.equal(observed.publish, false);
  assert.match(observed.prompt, /Do not write anything to GitHub/);
});

test('plan-author writes ready output atomically, reports blockers, and never publishes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-plan-author-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const planFile = path.join(dir, 'plan.md');
  const questionFile = path.join(dir, 'contract.md');
  await fs.writeFile(questionFile, 'delivery contract');
  const records = new Map();
  const store = memoryStore(records, '00000000-0000-4000-8000-000000000010');
  let observed;
  const readyDriver = { async review(input) { observed = input; return { responseText: `PLAN_STATUS: READY\n${PLAN_BEGIN}\n# Complete plan\n\nSteps.\n${PLAN_END}`, conversationUrl: 'https://chatgpt.com/c/author' }; } };
  const result = await run(['plan-author', 'https://github.com/o/r/issues/8', '--output-file', planFile, '--question-file', questionFile], { store, driver: readyDriver });
  assert.equal(result.status, 'completed');
  assert.equal(result.plan_status, 'ready');
  assert.equal(result.plan_file, planFile);
  assert.equal(result.blocker, null);
  assert.equal(result.requested_publication, false);
  assert.equal(observed.publish, false);
  assert.equal(observed.uploadPath, undefined);
  assert.equal(await fs.readFile(planFile, 'utf8'), '# Complete plan\n\nSteps.\n');
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp')), []);

  const blockedFile = path.join(dir, 'blocked.md');
  await fs.writeFile(blockedFile, '# Existing\n');
  const blocked = await run(['plan-author', 'https://github.com/o/r/issues/9', '--output-file', blockedFile, '--question-file', questionFile], {
    store: memoryStore(new Map(), '00000000-0000-4000-8000-000000000011'),
    driver: { async review() { return { responseText: 'PLAN_STATUS: BLOCKED\nBLOCKER: Choose the persistence format.', conversationUrl: 'https://chatgpt.com/c/blocked' }; } },
  });
  assert.equal(blocked.plan_status, 'blocked');
  assert.equal(blocked.blocker, 'Choose the persistence format.');
  assert.equal(await fs.readFile(blockedFile, 'utf8'), '# Existing\n');
});

test('invalid plan-author revisions preserve the last valid plan and keep the session resumable', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-plan-revision-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const planFile = path.join(dir, 'canonical.md');
  const questionFile = path.join(dir, 'contract.md');
  await fs.writeFile(questionFile, 'contract');
  await fs.writeFile(planFile, '# Last valid plan\n');
  const records = new Map();
  const store = memoryStore(records, '00000000-0000-4000-8000-000000000012');
  const created = await store.create({ mode: 'plan-author', targetIdentity: `plan-author:o/r#8:${planFile}` });
  const sessions = [];
  const driver = { async review(input) {
    sessions.push(input.session);
    // No attachment: a revision is a follow-up message in the SAME conversation, not a
    // re-supplied file.
    assert.equal(input.uploadPath, undefined);
    return { responseText: `PLAN_STATUS: READY\n${PLAN_BEGIN}\n${PLAN_END}`, conversationUrl: 'https://chatgpt.com/c/revision' };
  } };
  const result = await run(['plan-author', 'https://github.com/o/r/issues/8', '--output-file', planFile, '--question-file', questionFile, '--session', created.handle], { store, driver });
  assert.equal(result.status, 'invalid_response');
  assert.equal(result.session, created.handle);
  assert.equal(result.pass_number, 1);
  assert.equal(await fs.readFile(planFile, 'utf8'), '# Last valid plan\n');
  assert.ok(sessions[0]);
});

test('plan-author revisions reuse the conversation by session handle alone, without any attachment', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-plan-passes-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const planFile = path.join(dir, 'canonical.md');
  const questionFile = path.join(dir, 'contract.md');
  await fs.writeFile(questionFile, 'contract');
  const records = new Map();
  const store = memoryStore(records, '00000000-0000-4000-8000-000000000014');
  const calls = [];
  const driver = { async review(input) {
    calls.push({ session: input.session?.handle ?? null, uploadPath: input.uploadPath ?? null });
    const heading = calls.length === 1 ? 'Initial plan' : 'Replacement plan';
    return { responseText: `PLAN_STATUS: READY\n${PLAN_BEGIN}\n# ${heading}\n${PLAN_END}`, conversationUrl: 'https://chatgpt.com/c/same' };
  } };
  let result = await run(['plan-author', 'https://github.com/o/r/issues/8', '--output-file', planFile, '--question-file', questionFile], { store, driver });
  const handle = result.session;
  result = await run(['plan-author', 'https://github.com/o/r/issues/8', '--output-file', planFile, '--question-file', questionFile, '--session', handle], { store, driver });
  assert.equal(result.session, handle);
  assert.equal(result.pass_number, 2);
  assert.deepEqual(calls, [
    { session: null, uploadPath: null },
    { session: handle, uploadPath: null },
  ]);
  assert.equal(await fs.readFile(planFile, 'utf8'), '# Replacement plan\n');
});

test('plan-author timeout resumes the same conversation on retry, without any attachment', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-plan-timeout-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const planFile = path.join(dir, 'canonical.md');
  const questionFile = path.join(dir, 'contract.md');
  await fs.writeFile(planFile, '# Existing plan\n');
  await fs.writeFile(questionFile, 'contract');
  const records = new Map();
  const store = memoryStore(records, '00000000-0000-4000-8000-000000000013');
  const timeout = new ReviewError('timed_out', 'still working', 'partial');
  timeout.conversationUrl = 'https://chatgpt.com/c/timeout';
  let calls = 0;
  const driver = { async review(input) {
    calls += 1;
    if (calls === 1) throw timeout;
    assert.ok(input.session);
    assert.equal(input.uploadPath, undefined);
    return { responseText: `PLAN_STATUS: READY\n${PLAN_BEGIN}\n# Revised plan\n${PLAN_END}`, conversationUrl: timeout.conversationUrl };
  } };
  let result = await run(['plan-author', 'https://github.com/o/r/issues/8', '--output-file', planFile, '--question-file', questionFile], { store, driver });
  assert.equal(result.status, 'timed_out');
  assert.ok(result.session);
  result = await run(['plan-author', 'https://github.com/o/r/issues/8', '--output-file', planFile, '--question-file', questionFile, '--session', result.session], { store, driver });
  assert.equal(result.plan_status, 'ready');
  assert.equal(await fs.readFile(planFile, 'utf8'), '# Revised plan\n');
});

function memoryStore(records, handle) {
  return {
    async create(data) { const value = { handle, passCount: 0, ...data }; records.set(handle, value); return value; },
    async load(key) { return records.get(key); },
    async write(value) { records.set(value.handle, value); return value; },
  };
}
