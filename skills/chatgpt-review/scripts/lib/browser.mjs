import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parsePlanAuthorResponse } from './plan-author.mjs';

// ChatGPT virtualizes/prunes older turns out of the DOM in long conversations, so a raw
// element COUNT of assistant messages does not grow monotonically — it can plateau or even
// drop as old turns are unmounted. Tracking "is there a new response" by content fingerprint
// of the current LAST assistant message (instead of by count) survives that pruning.
export function fingerprintText(text) {
  return text ? crypto.createHash('sha256').update(text).digest('hex') : null;
}

export const SELECTORS = Object.freeze({
  composer: ['[data-testid="prompt-textarea"]', '#prompt-textarea', 'textarea[placeholder*="Message"]', '[contenteditable="true"][role="textbox"]'],
  send: ['[data-testid="send-button"]', 'button[aria-label*="Send"]', 'button[type="submit"]'],
  fileInput: ['input[type="file"]'],
  assistant: ['[data-message-author-role="assistant"]'],
  // The assistant turn's own action row is an accessible group distinct from the user
  // turn's "Your message actions" group — scoping to it (rather than a page-wide
  // querySelector) is what keeps this from grabbing the wrong turn's copy control.
  responseActions: ['[role="group"][aria-label="Response actions" i]'],
  responseCopyButton: ['[data-testid="copy-turn-action-button"]', 'button[aria-label*="Copy" i]'],
  stop: ['[data-testid="stop-button"]', 'button[aria-label*="Stop"]'],
  continue: ['button:has-text("Continue generating")', 'button:has-text("Continue")'],
  responseActions: ['button[aria-label*="Good response"]', 'button[aria-label*="Bad response"]', 'button[aria-label*="Copy"]'],
  streamError: ['text=/^Error in message stream$/i'],
  streamRetry: ['button:has-text("Retry")'],
  login: ['a[href*="auth/login"]', 'button:has-text("Log in")', 'button:has-text("Sign up")'],
  error: ['[data-testid="conversation-turn-error"]', '[data-testid="message-error"]', '[data-testid="error-message"]'],
  alert: ['[role="alert"]'],
  permission: ['[role="dialog"]', '[data-testid*="confirm"]'],
  permissionApprove: ['button:has-text("Allow")', 'button:has-text("Confirm")', 'button:has-text("Continue")'],
  rateLimit: ['text=/rate limit|too many requests|try again later/i'],
});

export class ReviewError extends Error {
  constructor(status, message, partial = '') {
    super(message);
    this.name = 'ReviewError';
    this.status = status;
    this.partial = partial;
  }
}

export async function connectToChrome(cdpUrl, importer = () => import('playwright-core')) {
  try {
    const { chromium } = await importer();
    return await chromium.connectOverCDP(cdpUrl);
  } catch (error) {
    throw new ReviewError('chrome_unavailable', `Cannot connect to Chrome at ${cdpUrl}: ${error.message}`);
  }
}

// Sent at most once per waitForCompletion() call when generation has shown zero text
// growth for noProgressStallMs while still "generating" — a live tool call stuck mid-turn
// (observed repeatedly across issue #630, previously only recoverable by a human manually
// clicking Stop and nudging the same conversation). Kept short and explicit so it reads
// unambiguously as an automated recovery nudge, not a new question.
export const RECOVERY_NUDGE = 'Please continue without further tool calls.';

export class ChatGptBrowser {
  constructor({
    browser, stderr = process.stderr, now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    stableMs = 7000, pollMs = 1000,
    // How long generation may show zero text growth while still "generating" before one
    // automatic stop+nudge recovery attempt fires. 4 minutes is long enough that no normal
    // slow-but-progressing tool call trips it, short enough to matter inside a 9-30 minute
    // overall --timeout.
    noProgressStallMs = 240_000,
    // Throttle for onHeartbeat callbacks during waitForCompletion's poll loop — writing on
    // every 1s poll would be excessive I/O for a call that can run 30 minutes.
    heartbeatIntervalMs = 10_000,
  }) {
    this.browser = browser;
    this.stderr = stderr;
    this.now = now;
    this.sleep = sleep;
    this.stableMs = stableMs;
    this.pollMs = pollMs;
    this.noProgressStallMs = noProgressStallMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
  }

  async pageFor(session) {
    const context = this.browser.contexts()[0];
    if (!context) throw new ReviewError('chrome_unavailable', 'Chrome has no accessible browser context');
    if (session?.conversationUrl) {
      const existing = context.pages().find((page) => canonicalConversation(page.url()) === canonicalConversation(session.conversationUrl));
      if (existing) { await existing.bringToFront(); return { page: existing, reopened: false }; }
      const page = await context.newPage();
      await page.goto(session.conversationUrl, { waitUntil: 'domcontentloaded' });
      return { page, reopened: true };
    }
    const page = await context.newPage();
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    return { page, reopened: false };
  }

  async doctor() {
    const { page } = await this.pageFor(null);
    await this.assertReady(page);
    const upload = Boolean(await firstExisting(page, SELECTORS.fileInput));
    return { page, checks: { cdp: true, login: true, composer: true, fileUpload: upload, predefinedModelAndEffort: true } };
  }

  async review({ session, prompt, uploadPath, timeoutMs, target, publish, diagnosticsDir, mode, onHeartbeat }) {
    // ONE deadline for the whole call, not a separate independent worst-case allowance per
    // phase. Before this, assertReady (~15s) + upload (~30s) + fillAndSend (up to 240s via
    // its own retry) + waitForPermanentConversationUrl (~15s) were ALL uncounted
    // against the caller's own --timeout, so the real worst-case wall time was `timeoutMs +
    // ~300s` — not `timeoutMs` — and a caller budgeting its own outer process-kill ceiling
    // from `timeoutMs` alone (as this skill's own ship-integration does) could get SIGKILLed
    // mid-poll with zero output ever flushed. Confirmed live: 6 real `chatgpt-review`
    // invocations across issue #630 left nothing but their initial progress line in the
    // caller's captured output file. Each setup phase below still gets its own short,
    // reasonable per-phase ceiling (so a stuck composer fails fast rather than silently
    // eating the whole budget) — Math.min caps it at whichever is sooner.
    const deadline = this.now() + timeoutMs;
    const { page, reopened } = await this.pageFor(session);
    try {
      await this.assertReady(page, Math.min(this.now() + 15_000, deadline));
      const generationActive = await anyVisible(page, SELECTORS.stop);
      const currentTail = await this.latestAssistantText(page);
      const recordedFingerprint = session?.lastResponseFingerprint ?? null;
      const hasUncollected = generationActive || (Boolean(currentTail) && fingerprintText(currentTail) !== recordedFingerprint);
      if (session && hasUncollected) {
        this.stderr.write('Recovering an uncollected ChatGPT response...\n');
        const responseText = await this.waitForCompletion(page, { before: null, deadline, target, publish, mode, onHeartbeat });
        // Fingerprint the plain rendered tail, not responseText (which may now be the
        // upgraded Markdown from copyLatestAssistantMarkdown) — a future call's staleness
        // check compares against THIS stored value using latestAssistantText's same plain
        // representation, so fingerprinting a different representation of the identical
        // message would make every later resume spuriously look "uncollected" forever.
        return { responseText, conversationUrl: page.url(), reopened, predefinedModelAndEffort: true, recovered: true, responseFingerprint: fingerprintText(await this.latestAssistantText(page)) };
      }
      if (uploadPath) await this.upload(page, uploadPath, Math.min(this.now() + 30_000, deadline));
      const before = currentTail;
      await this.fillAndSend(page, prompt, Math.min(this.now() + 242_000, deadline));
      await this.waitForPermanentConversationUrl(page, Math.min(this.now() + 15_000, deadline));
      this.stderr.write('Waiting for ChatGPT response...\n');
      const responseText = await this.waitForCompletion(page, { before, deadline, target, publish, mode, onHeartbeat });
      return { responseText, conversationUrl: page.url(), reopened, predefinedModelAndEffort: true, recovered: false, responseFingerprint: fingerprintText(await this.latestAssistantText(page)) };
    } catch (error) {
      error.conversationUrl = page.url();
      if (diagnosticsDir) await this.captureDiagnostics(page, diagnosticsDir, error).catch(() => {});
      throw error;
    }
  }

  async assertReady(page, deadline = this.now() + 15_000) {
    await page.waitForLoadState?.('domcontentloaded').catch(() => {});
    while (this.now() < deadline) {
      if (await anyVisible(page, SELECTORS.composer)) return;
      if (await anyVisible(page, SELECTORS.login)) throw new ReviewError('login_required', 'ChatGPT is not logged in in the connected Chrome profile');
      await this.sleep(250);
    }
    throw new ReviewError('ui_incompatible', 'Could not find the ChatGPT composer; the UI may have changed');
  }

  async upload(page, uploadPath, deadline = this.now() + 30_000) {
    const input = await firstExisting(page, SELECTORS.fileInput);
    if (!input) throw new ReviewError('ui_incompatible', 'ChatGPT file upload input was not found');
    await input.setInputFiles(uploadPath);
    if (page.getByText) {
      const attachment = page.getByText(path.basename(uploadPath), { exact: false }).last();
      try { await attachment.waitFor({ state: 'visible', timeout: Math.max(1000, deadline - this.now()) }); }
      catch { throw new ReviewError('ui_incompatible', 'ChatGPT did not confirm the requested file upload'); }
    }
  }

  // Inserts `value` into `element` (a composer or similar contenteditable) via the real DOM,
  // in-page, bypassing Playwright's own actionability-checked .fill(). Measured live against
  // the production ChatGPT composer: an 80KB insertText call lands in ~50ms regardless of
  // size — .fill()'s slowness (below) is not about text volume. Returns false (never throws)
  // on anything that goes wrong, so callers can fall back rather than fail outright: no real
  // DOM (e.g. this skill's own mocked test harness), the element vanishing, or any other
  // in-page error.
  async insertNatively(element, value) {
    try {
      await element.click({ timeout: 5000 });
      await element.evaluate((el, text) => {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }, value);
      return true;
    } catch { return false; }
  }

  // insertNatively resolves as soon as the in-page evaluate() call returns, which is
  // BEFORE React has necessarily re-rendered in response to it — confirmed live: the send
  // button's own selector showed 0 matches on the very next synchronous DOM query, and 1
  // match only after yielding a render tick (requestAnimationFrame). Checking for it exactly
  // once, immediately, made this silently fall through to the composer.press('Enter')
  // fallback on what is actually a timing race, not a missing/dead selector — a few short
  // retries (bounded, cheap) removes the race instead of relying on it happening to be
  // masked by whatever incidental latency the caller's own prior awaits introduced.
  async submit(page, composer) {
    let send = null;
    for (let attempt = 0; attempt < 5 && !send; attempt += 1) {
      send = await firstVisible(page, SELECTORS.send);
      if (!send) await this.sleep(100);
    }
    if (send) await send.click();
    else await composer.press('Enter');
  }

  async fillAndSend(page, prompt, deadline = this.now() + 242_000) {
    const composer = await firstVisible(page, SELECTORS.composer);
    if (!composer) throw new ReviewError('ui_incompatible', 'ChatGPT composer disappeared before submission');
    if (!(await this.insertNatively(composer, prompt))) {
      // Fallback only: Playwright's own .fill() has been observed to still genuinely time
      // out under real load even at 120s x 2 retries (issue #630, 246.9s elapsed, both
      // attempts exhausted) — not a text-size effect (native insertion above is ~50ms
      // regardless of size), most likely CPU contention from concurrent agents during a
      // live /ship run. Bounded by whatever remains of the overall call's deadline, never an
      // unconditional extra 240s tacked on top of it.
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const remaining = Math.max(1000, deadline - this.now());
        try { await composer.fill(prompt, { timeout: Math.min(remaining, 120_000) }); lastError = null; break; }
        catch (error) { lastError = error; await this.sleep(Math.min(2000, Math.max(0, deadline - this.now()))); }
      }
      if (lastError) throw lastError;
    }
    await this.submit(page, composer);
  }

  async waitForPermanentConversationUrl(page, deadline = this.now() + 15_000) {
    while (this.now() < deadline) {
      if (/^https:\/\/chatgpt\.com\/c\/(?!WEB:)[^/?#]+/i.test(page.url())) return true;
      await this.sleep(100);
    }
    return false;
  }

  async latestAssistantText(page) {
    const messages = page.locator(SELECTORS.assistant[0]);
    const count = await messages.count();
    return count ? (await messages.nth(count - 1).innerText()).trim() : '';
  }

  // .innerText() on the rendered message strips Markdown syntax entirely (a heading
  // renders as an <h1>-<h6> with no literal '#', a code span as styled text with no
  // literal backtick), so any caller that needs the actual Markdown source — notably
  // plan-author's heading/delimiter validation — cannot use it. ChatGPT's own "Copy
  // message" control on the response's action row copies the raw Markdown to the
  // system clipboard; this reads that back. Best-effort: returns null on anything
  // that goes wrong (no such button, permission denial, or the read simply taking
  // too long) so callers can fall back to the innerText tail instead of failing or,
  // worse, hanging on an unattended native clipboard-permission prompt.
  async copyLatestAssistantMarkdown(page) {
    try {
      const group = page.locator(SELECTORS.responseActions[0]).last();
      if (!(await group.count().catch(() => 0))) return null;
      const button = group.locator(SELECTORS.responseCopyButton[0]).first();
      if (!(await button.count().catch(() => 0))) return null;
      const context = this.browser.contexts()[0];
      await context?.grantPermissions?.(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })?.catch(() => {});
      await button.click();
      await this.sleep(150);
      // Attach the fallback race in this order — read's rejection handler attached
      // before bailAfter is even constructed — so a same-tick resolution (as in tests
      // with a synchronous fake clock) resolves via the real read, not the timeout,
      // while a genuinely hung clipboard permission prompt still bails after 4s.
      const read = page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
      const bailAfter = this.sleep(4000).then(() => null);
      const text = await Promise.race([read, bailAfter]);
      return text || null;
    } catch { return null; }
  }

  // A single clipboard read can fail transiently (a permission race, one slow tick) — for
  // every OTHER mode that's a soft quality loss (extraction regexes may miss a Markdown-
  // formatted SHA/URL), but for plan-author it is FATAL: innerText can never contain the
  // literal '#' parsePlanAuthorResponse's heading check requires, so a bare fallback is
  // structurally guaranteed to fail that validation downstream in chatgpt-review.mjs's own
  // run() — confirmed live: "The delimited plan is not complete Markdown with a heading"
  // recurred 6 times across real issue #630/#585 invocations. Retrying a couple more times
  // (each internally bounded to ~4s by copyLatestAssistantMarkdown's own race) is cheap
  // insurance against surrendering to a fallback known to be doomed for this one mode.
  async copyPreferredResponseText(page, mode) {
    let markdown = await this.copyLatestAssistantMarkdown(page);
    if (!markdown && mode === 'plan-author') {
      for (let attempt = 0; attempt < 2 && !markdown; attempt += 1) {
        await this.sleep(1000);
        markdown = await this.copyLatestAssistantMarkdown(page);
      }
    }
    return markdown;
  }

  async waitForCompletion(page, { before, timeoutMs, deadline, target, publish, mode, onHeartbeat }) {
    // deadline (absolute, from review()'s unified budget) takes precedence; timeoutMs
    // (relative, from callers/tests that predate the unified-budget fix) still works.
    const started = this.now();
    const effectiveDeadline = deadline ?? (started + timeoutMs);
    let lastText = '';
    let stableSince = null;
    let streamRetries = 0;
    let recoveryAttempted = false;
    let lastHeartbeatAt = 0;
    // plan-author's protocol is a fixed-content island: once exactly one well-formed
    // PLAN_STATUS: READY/BLOCKED block appears, its content is final by construction
    // (parsePlanAuthorResponse requires exactly one delimiter pair) — anything ChatGPT
    // keeps writing afterward (more reasoning, another tool call, a citation footnote)
    // is explicitly tolerated by that same parser and never changes the extracted plan.
    // Observed live on #630 phase 7: an Extra-High-effort turn can keep the "generating"
    // indicator (stop button) visible for 20+ minutes after already emitting a complete,
    // valid plan — the ordinary !generating + 7s-stability requirement below can never
    // fire in that case, so the whole call times out despite a perfectly good answer
    // already sitting in the DOM. For plan-author only, treat a validated match as done
    // immediately, without waiting for `generating` to clear.
    let planAuthorPendingConfirm = false;
    while (this.now() < effectiveDeadline) {
      const streamError = await firstVisible(page, SELECTORS.streamError);
      const retry = streamError ? await firstVisible(page, SELECTORS.streamRetry) : null;
      if (retry) {
        if (streamRetries >= 2) throw new ReviewError('ui_incompatible', 'ChatGPT message stream failed after two automatic retries', await this.latestAssistantText(page));
        streamRetries += 1;
        this.stderr.write(`ChatGPT message stream failed; using Retry (${streamRetries}/2)...\n`);
        await retry.click();
        lastText = '';
        stableSince = null;
        await this.sleep(this.pollMs);
        continue;
      }
      const rateLimited = await firstVisible(page, SELECTORS.rateLimit);
      if (rateLimited) throw new ReviewError('rate_limited', 'ChatGPT reported a rate limit', await this.latestAssistantText(page));
      const pageError = await firstVisible(page, SELECTORS.error);
      if (pageError) {
        const message = (await pageError.innerText()).trim();
        if (/rate limit|too many requests|try again later/i.test(message)) throw new ReviewError('rate_limited', message, await this.latestAssistantText(page));
        throw new ReviewError('ui_incompatible', `ChatGPT reported an unrecoverable UI error: ${summarize(message) || 'conversation error'}`, await this.latestAssistantText(page));
      }
      const alertFailure = await visibleAlertFailure(page);
      if (alertFailure?.status === 'rate_limited') {
        throw new ReviewError('rate_limited', alertFailure.message, await this.latestAssistantText(page));
      }
      if (alertFailure?.status === 'ui_incompatible') {
        throw new ReviewError('ui_incompatible', `ChatGPT reported an unrecoverable UI error: ${summarize(alertFailure.message)}`, await this.latestAssistantText(page));
      }
      await this.handlePermission(page, target, publish);
      const continuation = await firstVisible(page, SELECTORS.continue);
      if (continuation) { await continuation.click(); stableSince = null; }
      const currentText = await this.latestAssistantText(page);
      // before === null means "recovering an uncollected response" — accept whatever is
      // already there. Otherwise before is the pre-submission baseline text (possibly '');
      // only a DIFFERENT tail counts as the new response. Content-based, not count-based,
      // so DOM pruning of older turns in a long conversation cannot spuriously suppress it.
      const text = (before === null || currentText !== before) ? currentText : '';
      const generating = await anyVisible(page, SELECTORS.stop);
      if (mode === 'plan-author' && text && hasCompletePlanAuthorProtocol(text)) {
        if (planAuthorPendingConfirm) {
          // Confirmed on two consecutive polls against the cheap innerText check — now
          // validate against the authoritative clipboard-copied Markdown (innerText can
          // strip literal '#' heading syntax the parser's heading check requires) before
          // trusting it enough to return early while still generating.
          const markdown = await this.copyPreferredResponseText(page, mode);
          if (markdown && hasCompletePlanAuthorProtocol(markdown)) return markdown;
          if (!generating) return markdown || text; // clipboard read failed, but the turn is genuinely done anyway
          // Clipboard copy disagreed while still generating (e.g. mid-stream race on a
          // still-forming second attempt) — fall through to the ordinary stability wait
          // rather than trusting an unconfirmed early exit.
          planAuthorPendingConfirm = false;
        } else {
          planAuthorPendingConfirm = true;
        }
      } else {
        planAuthorPendingConfirm = false;
      }
      if (text && text === lastText) stableSince ??= this.now();
      else { lastText = text; stableSince = text ? this.now() : null; }
      // One automatic stop+nudge recovery attempt if generation has shown ZERO text growth
      // for noProgressStallMs while still "generating" — a live tool call stuck mid-turn.
      // waitForCompletion's own DOM polling has no way to distinguish this from a slow-but-
      // progressing tool call except elapsed time; previously this required a human to
      // notice and manually intervene (documented in skills/ship/references/review-loops.md
      // as a recurring, purely manual procedure across issue #630). Capped at one attempt
      // per call so a conversation that is stuck for some other reason still times out
      // normally instead of nudging forever.
      if (!recoveryAttempted && generating && text && stableSince !== null && this.now() - stableSince >= this.noProgressStallMs) {
        recoveryAttempted = true;
        this.stderr.write(`No response growth for ${Math.round(this.noProgressStallMs / 1000)}s while ChatGPT is still "generating" — attempting one automatic stop+nudge recovery...\n`);
        const stop = await firstVisible(page, SELECTORS.stop);
        if (stop) await stop.click().catch(() => {});
        await this.sleep(1000);
        const composer = await firstVisible(page, SELECTORS.composer);
        if (composer && (await this.insertNatively(composer, RECOVERY_NUDGE))) {
          await this.submit(page, composer);
        }
        lastText = '';
        stableSince = null;
        planAuthorPendingConfirm = false;
        await this.sleep(this.pollMs);
        continue;
      }
      if (text && !generating && stableSince !== null && this.now() - stableSince >= this.stableMs) {
        const markdown = await this.copyPreferredResponseText(page, mode);
        return markdown || text;
      }
      if (onHeartbeat && this.now() - lastHeartbeatAt >= this.heartbeatIntervalMs) {
        lastHeartbeatAt = this.now();
        // Promise.resolve(...) tolerates a synchronous (non-Promise-returning) callback —
        // calling .catch() directly on its return value would throw on undefined.
        await Promise.resolve(onHeartbeat({ elapsedMs: this.now() - started, generating, textLength: text.length || lastText.length, recoveryAttempted })).catch(() => {});
      }
      await this.sleep(this.pollMs);
    }
    throw new ReviewError('timed_out', 'Timed out before ChatGPT produced a stable completed response', lastText);
  }

  async handlePermission(page, target, publish) {
    const dialog = await firstVisible(page, SELECTORS.permission);
    if (!dialog) return;
    const text = await dialog.innerText();
    if (classifyPermission(text, target, publish) !== 'allow_comment') {
      throw new ReviewError('needs_interaction', `ChatGPT requested an action that cannot be approved automatically: ${summarize(text)}`, await this.latestAssistantText(page));
    }
    const approve = await firstVisible(dialog, SELECTORS.permissionApprove);
    if (!approve) throw new ReviewError('needs_interaction', 'Scoped GitHub comment confirmation has no recognized approval control', await this.latestAssistantText(page));
    await approve.click();
  }

  async captureDiagnostics(page, directory, error) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const counts = {};
    for (const [name, selectors] of Object.entries(SELECTORS)) {
      counts[name] = 0;
      for (const selector of selectors) counts[name] += await page.locator(selector).count().catch(() => 0);
    }
    const diagnostic = { timestamp: new Date().toISOString(), url: page.url(), status: error.status ?? 'internal_error', selectorCounts: counts };
    await fs.writeFile(path.join(directory, 'diagnostic.json'), `${JSON.stringify(diagnostic, null, 2)}\n`, { mode: 0o600 });
  }
}

export function classifyPermission(text, target, publish) {
  const lower = text.toLowerCase();
  if (!publish || !target) return 'deny';
  if (/password|credential|token|secret|merge|close|delete|push|commit|approve|workflow|repository access|all repositories/.test(lower)) return 'deny';
  const repo = `${target.owner}/${target.repo}`.toLowerCase();
  const exactTarget = lower.includes(target.canonicalUrl.toLowerCase()) || (lower.includes(repo) && new RegExp(`(?:#|/)(?:pull/|issues/)?${target.number}\\b`).test(lower));
  return /comment/.test(lower) && exactTarget ? 'allow_comment' : 'deny';
}

async function firstVisible(scope, selectors) {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function firstExisting(scope, selectors) {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    if (await locator.count().catch(() => 0)) return locator;
  }
  return null;
}

async function anyVisible(scope, selectors) { return Boolean(await firstVisible(scope, selectors)); }
async function visibleAlertFailure(page) {
  const alerts = page.locator(SELECTORS.alert[0]);
  const count = await alerts.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const alert = alerts.nth(index);
    if (!await alert.isVisible().catch(() => false)) continue;
    const result = classifyAlertText(await alert.innerText().catch(() => ''));
    if (result) return result;
  }
  return null;
}
export function classifyAlertText(text) {
  const message = text.replace(/\s+/g, ' ').trim();
  if (!message) return null;
  if (/rate limit|too many requests|try again later/i.test(message)) return { status: 'rate_limited', message };
  if (/something went wrong|there was an error|an error occurred|unable to (?:load|generate|complete)|failed to (?:load|generate|send)|network error/i.test(message)) {
    return { status: 'ui_incompatible', message };
  }
  return null;
}
function canonicalConversation(url) { return url?.replace(/[?#].*$/, '').replace(/\/$/, ''); }
function summarize(text) { return text.replace(/\s+/g, ' ').trim().slice(0, 240); }
// Non-throwing peek at whether `text` already satisfies plan-author's complete
// protocol (exactly one READY delimiter pair with a real Markdown heading, or a
// well-formed BLOCKED response) — reuses the real parser so this can never drift
// from what actually gets accepted downstream.
function hasCompletePlanAuthorProtocol(text) {
  try { parsePlanAuthorResponse(text); return true; }
  catch { return false; }
}
