#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, CliError, usage } from './lib/cli.mjs';
import { normalizeGithubTarget } from './lib/target.mjs';
import { buildPrompt, extractReportedMetadata } from './lib/prompt.mjs';
import { SessionStore } from './lib/state.mjs';
import { collectLocalDiff, writePrivateTempFile } from './lib/diff.mjs';
import { ChatGptBrowser, ReviewError, connectToChrome } from './lib/browser.mjs';
import { exitCode, renderResult, resultDocument } from './lib/output.mjs';

export async function run(argv, dependencies = {}) {
  const started = Date.now();
  let options = { format: 'json', requestedPublication: false };
  let session;
  let store;
  let passNumber = null;
  let cleanup = async () => {};
  try {
    assertNodeVersion();
    options = parseArgs(argv, dependencies.env);
    store = dependencies.store ?? new SessionStore(dependencies.stateDir);
    let driver = dependencies.driver;
    if (!driver) {
      const browser = dependencies.browser ?? await connectToChrome(options.cdpUrl, dependencies.importer);
      driver = new ChatGptBrowser({ browser, stderr: dependencies.stderr });
    }
    if (options.mode === 'doctor') {
      const { checks } = await driver.doctor();
      const missing = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
      if (missing.length) throw new ReviewError('ui_incompatible', `Doctor checks failed: ${missing.join(', ')}`);
      return resultDocument({ status: 'completed', response_text: 'Doctor checks passed.', elapsed_seconds: elapsed(started) });
    }

    const prepared = await prepare(options);
    cleanup = prepared.cleanup ?? cleanup;
    if (options.session) {
      session = await store.load(options.session);
      if (session.mode !== options.mode || session.targetIdentity !== prepared.targetIdentity) throw new CliError('Session does not match this mode and target');
    } else {
      session = await store.create({ mode: options.mode, targetIdentity: prepared.targetIdentity, canonicalUrl: prepared.target?.canonicalUrl });
    }
    passNumber = (session.passCount ?? 0) + 1;
    if (options.mode === 'pr' && passNumber > 3) throw new CliError('PR review sessions permit at most three total passes');
    const context = options.questionFile ? await fs.readFile(path.resolve(options.questionFile), 'utf8') : '';
    const prompt = buildPrompt({
      mode: options.mode,
      target: prepared.target,
      context,
      publish: options.requestedPublication,
      pass: passNumber,
      previousSha: session.reportedReviewedSha,
      uploadName: prepared.uploadPath ? path.basename(prepared.uploadPath) : null,
    });
    const review = await driver.review({
      session: options.session ? session : null,
      prompt,
      uploadPath: prepared.uploadPath,
      timeoutMs: options.timeoutMs,
      target: prepared.target,
      publish: options.requestedPublication,
      diagnosticsDir: options.diagnosticsDir ? path.resolve(options.diagnosticsDir) : null,
    });
    const metadata = extractReportedMetadata(review.responseText);
    session = await store.write({ ...session, conversationUrl: review.conversationUrl, passCount: passNumber, ...metadata });
    return resultDocument({
      status: 'completed', response_text: review.responseText, session: session.handle,
      conversation_url: review.conversationUrl, elapsed_seconds: elapsed(started), pass_number: passNumber,
      requested_publication: options.requestedPublication,
      reported_reviewed_sha: metadata.reportedReviewedSha,
      reported_github_comment_url: metadata.reportedGithubCommentUrl,
    });
  } catch (error) {
    const status = error.status ?? (error.code === 'ENOENT' ? 'invalid_request' : 'internal_error');
    const partialMetadata = extractReportedMetadata(error.partial ?? '');
    const conversationUrl = error.conversationUrl ?? session?.conversationUrl ?? null;
    if (store && session && conversationUrl) {
      try { session = await store.write({ ...session, conversationUrl, ...partialMetadata }); } catch {}
    }
    return resultDocument({ status, response_text: error.partial ?? '', session: session?.handle ?? null,
      conversation_url: conversationUrl, elapsed_seconds: elapsed(started), pass_number: passNumber,
      requested_publication: options.requestedPublication, reported_reviewed_sha: partialMetadata.reportedReviewedSha,
      reported_github_comment_url: partialMetadata.reportedGithubCommentUrl, error: error.message });
  } finally {
    await cleanup();
  }
}

async function prepare(options) {
  if (options.mode === 'pr' || options.mode === 'issue') {
    const target = normalizeGithubTarget(options.target, options.mode);
    return { target, targetIdentity: `${options.mode}:${target.identity}` };
  }
  if (options.mode === 'plan') {
    await fs.access(options.target);
    return { targetIdentity: `plan:${path.resolve(options.target)}`, uploadPath: options.target };
  }
  const local = await collectLocalDiff({ repo: options.repo ? path.resolve(options.repo) : process.cwd(), base: options.base, workingTree: options.workingTree, includeUntracked: options.includeUntracked });
  const temporary = await writePrivateTempFile('local-review.diff.md', local.text);
  return { targetIdentity: `local:${local.root}`, uploadPath: temporary.filename, cleanup: temporary.cleanup };
}

function assertNodeVersion() {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new CliError('Node.js 20 or newer is required');
}
function elapsed(started) { return Math.round((Date.now() - started) / 100) / 10; }

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  run(argv).then((result) => {
    let format = 'json';
    try { format = parseArgs(argv).format; } catch {}
    if (result.status === 'invalid_request') process.stderr.write(`${result.error}\n\n${usage()}\n`);
    const code = exitCode(result.status);
    process.stdout.write(renderResult(result, format), () => process.exit(code));
  });
}
