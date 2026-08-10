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
import { parsePlanAuthorResponse, replaceFileAtomically } from './lib/plan-author.mjs';

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
    const prepareCleanup = prepared.cleanup ?? (async () => {});
    const uploadCleanups = [prepareCleanup];
    cleanup = async () => { for (const c of uploadCleanups) await c(); };
    if (options.session) {
      session = await store.load(options.session);
      if (session.mode !== options.mode || session.targetIdentity !== prepared.targetIdentity) throw new CliError('Session does not match this mode and target');
    } else {
      // --seed-from-session threads an EXISTING ChatGPT conversation (from a different mode,
      // e.g. this unit's own plan-author session) into a brand-new session record for this
      // mode+target, so pageFor() reopens that conversation instead of a fresh chat. Copying
      // lastResponseFingerprint too is required, not cosmetic: without it, review()'s
      // hasUncollected check would see the seed conversation's last (unrelated) assistant
      // message as an "uncollected response" and return it without ever sending this mode's
      // prompt.
      let seed = {};
      if (options.seedFromSession) {
        const seedSession = await store.load(options.seedFromSession);
        seed = { conversationUrl: seedSession.conversationUrl, lastResponseFingerprint: seedSession.lastResponseFingerprint };
      }
      session = await store.create({ mode: options.mode, targetIdentity: prepared.targetIdentity, canonicalUrl: prepared.target?.canonicalUrl, ...seed });
    }
    passNumber = (session.passCount ?? 0) + 1;
    if (options.mode === 'pr' && passNumber > 3) throw new CliError('PR review sessions permit at most three total passes');

    // Name each pass's upload distinctly (plan-590-pass4.md, not plan-590.md every time) —
    // the source file's own path must never move (it may be the plan-review-loop's own
    // session identity, or the coordinator's stable context file reused across every pass),
    // so upload a same-content, differently-named COPY. Reusing one literal filename across
    // many passes made ChatGPT's own upload UI collision-rename it (plan-590(9).md) after
    // enough retries, which is confusing and unrelated to the real pass count.
    async function renamedUploadCopy(sourcePath, label) {
      const ext = path.extname(sourcePath);
      const base = path.basename(sourcePath, ext);
      const content = await fs.readFile(sourcePath, 'utf8');
      const renamed = await writePrivateTempFile(`${base}-${label}${ext}`, content);
      uploadCleanups.push(renamed.cleanup);
      return renamed.filename;
    }

    const primaryUploadPath = prepared.uploadPath ? await renamedUploadCopy(prepared.uploadPath, `pass${passNumber}`) : null;
    // Every mode now uploads its --question-file (the coordinator's delivery contract,
    // acceptance subset, and focused questions) instead of pasting it: pasting used to
    // duplicate content already in the GitHub issue (which every mode's prompt separately
    // tells ChatGPT to browse) and, across passes, duplicate the SAME text repeatedly even
    // though the conversation already had it. A fresh, distinctly-named upload copy each
    // pass is a cheap file transfer, not retyped text, so the composer's typed prompt stays
    // short regardless of the contract's size.
    const contextUploadPath = options.questionFile ? await renamedUploadCopy(path.resolve(options.questionFile), `context-pass${passNumber}`) : null;
    // plan/local modes already have their own primary artifact (plan file / diff); pr/issue/
    // plan-author have none. ChatGPT's upload input accepts multiple files in one message
    // (confirmed live), so when both exist, upload them together; otherwise upload whichever
    // one exists, keeping the single-path shape callers/tests already expect in that case.
    const uploadTargets = [primaryUploadPath, contextUploadPath].filter(Boolean);
    const uploadPath = uploadTargets.length > 1 ? uploadTargets : (uploadTargets[0] ?? null);

    // plan-author's revision passes carry a SMALL, genuinely-new-each-time delta (this
    // round's findings) as pasted text alongside the always-uploaded contract — unlike the
    // contract itself, findings are small and not duplicative, so pasting them is fine and
    // avoids needing a dedicated second upload slot for something this cheap. Every other
    // mode's own context is now uploaded above, never pasted.
    const context = (options.mode === 'plan-author' && options.revisionNoteFile)
      ? await fs.readFile(path.resolve(options.revisionNoteFile), 'utf8')
      : '';
    const prompt = buildPrompt({
      mode: options.mode,
      target: prepared.target,
      context,
      publish: options.requestedPublication,
      pass: passNumber,
      previousSha: session.reportedReviewedSha,
      uploadName: primaryUploadPath ? path.basename(primaryUploadPath) : null,
      contextUploadName: contextUploadPath ? path.basename(contextUploadPath) : null,
    });
    // A genuinely fresh conversation (neither --session nor --seed-from-session) passes
    // null so pageFor() opens chatgpt.com from scratch. Both --session (resuming this exact
    // mode+target, even if an earlier pass never got far enough to record a conversationUrl)
    // and --seed-from-session (a brand-new session record pre-populated with a prior,
    // different-mode conversation) must pass the real session through.
    const review = await driver.review({
      session: (options.session || options.seedFromSession) ? session : null,
      prompt,
      uploadPath,
      timeoutMs: options.timeoutMs,
      target: prepared.target,
      publish: options.requestedPublication,
      diagnosticsDir: options.diagnosticsDir ? path.resolve(options.diagnosticsDir) : null,
      mode: options.mode,
      onHeartbeat: (state) => store.writeHeartbeat(session.handle, state),
    });
    const metadata = extractReportedMetadata(review.responseText);
    session = await store.write({ ...session, conversationUrl: review.conversationUrl, passCount: passNumber, lastResponseFingerprint: review.responseFingerprint ?? null, ...metadata });
    let planResult = { plan_status: null, plan_file: null, blocker: null };
    if (options.mode === 'plan-author') {
      let parsed;
      try {
        parsed = parsePlanAuthorResponse(review.responseText);
      } catch (error) {
        // parsePlanAuthorResponse only ever sees the raw text it's asked to parse, so it
        // can't attach the wider review's captured text itself. Attach it here, at the one
        // call site that has both the error and review.responseText in scope, so the outer
        // catch's `error.partial ?? ''` reflects what ChatGPT actually sent instead of going
        // diagnostically blind on every invalid_response outcome.
        error.partial = review.responseText;
        throw error;
      }
      const planFile = path.resolve(options.outputFile);
      if (parsed.planStatus === 'ready') await replaceFileAtomically(planFile, parsed.plan);
      planResult = { plan_status: parsed.planStatus, plan_file: planFile, blocker: parsed.blocker };
    }
    return resultDocument({
      status: 'completed', response_text: review.responseText, session: session.handle,
      conversation_url: review.conversationUrl, elapsed_seconds: elapsed(started), pass_number: passNumber,
      requested_publication: options.requestedPublication,
      reported_reviewed_sha: metadata.reportedReviewedSha,
      reported_github_comment_url: metadata.reportedGithubCommentUrl,
      ...planResult,
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
      reported_github_comment_url: partialMetadata.reportedGithubCommentUrl,
      plan_file: options.mode === 'plan-author' && options.outputFile ? path.resolve(options.outputFile) : null,
      error: error.message });
  } finally {
    await cleanup();
  }
}

async function prepare(options) {
  if (options.mode === 'pr' || options.mode === 'issue' || options.mode === 'plan-author') {
    const targetMode = options.mode === 'plan-author' ? 'issue' : options.mode;
    const target = normalizeGithubTarget(options.target, targetMode);
    if (options.mode === 'plan-author') {
      // The PLAN FILE (options.outputFile) is never uploaded: a revision pass is a
      // follow-up message in the SAME conversation ChatGPT just wrote the plan in, so it
      // already has the exact current text without one — re-uploading ChatGPT's own prior
      // output would be redundant. The question file IS uploaded, but uniformly with every
      // other mode below (run()'s contextUploadPath), not here.
      const planFile = path.resolve(options.outputFile);
      return { target, targetIdentity: `plan-author:${target.identity}:${planFile}` };
    }
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
