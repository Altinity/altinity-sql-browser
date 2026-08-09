import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatGptBrowser, ReviewError, RECOVERY_NUDGE, SELECTORS, classifyAlertText, classifyPermission, connectToChrome, fingerprintText } from '../scripts/lib/browser.mjs';

class Element {
  constructor({ text = '', visible = true, onClick, nested = {}, evaluate } = {}) { this.text = text; this.visible = visible; this.onClick = onClick; this.nested = nested; this._evaluate = evaluate; }
  async isVisible() { return this.visible; }
  async count() { return 1; }
  async innerText() { return this.text; }
  async click() { this.onClick?.(this); }
  async fill(value) { this.value = value; }
  async press(value) { this.pressed = value; }
  async setInputFiles(value) { this.files = value; }
  // Real Playwright's locator.evaluate(fn, arg) runs fn IN THE BROWSER PAGE, with a real
  // DOM element bound as fn's first argument. This mock has no DOM at all by default —
  // matching today's actual test environment (Node, no browser) — so it throws unless a
  // test explicitly supplies an `evaluate` override to simulate a real page.
  async evaluate(fn, arg) {
    if (this._evaluate) return this._evaluate(fn, arg);
    throw new TypeError('no DOM available in the test harness');
  }
  locator(selector) { return new Locator(this.nested[selector] ?? []); }
}
class Locator {
  constructor(elements) { this.elements = elements; }
  first() { return this.elements[0] ?? new Missing(); }
  last() { return this.elements[this.elements.length - 1] ?? new Missing(); }
  nth(index) { return this.elements[index] ?? new Missing(); }
  async count() { return this.elements.length; }
}
class Missing extends Element {
  constructor() { super({ visible: false }); }
  async count() { return 0; }
}
class Page {
  constructor(url = 'https://chatgpt.com/', map = {}, { evaluate } = {}) { this.currentUrl = url; this.map = map; this.front = false; this._evaluate = evaluate; }
  url() { return this.currentUrl; }
  locator(selector) { const value = this.map[selector]; return new Locator(typeof value === 'function' ? value() : value ?? []); }
  async goto(url) { this.currentUrl = url; }
  async bringToFront() { this.front = true; }
  async waitForLoadState() {}
  async evaluate(fn) { return this._evaluate ? this._evaluate() : fn(); }
}
class Context {
  constructor(pages = [], fresh = new Page(), { grantPermissions } = {}) { this.items = pages; this.fresh = fresh; this._grantPermissions = grantPermissions; }
  pages() { return this.items; }
  async newPage() { this.items.push(this.fresh); return this.fresh; }
  async grantPermissions(...args) { this.grantedWith = args; return this._grantPermissions ? this._grantPermissions(...args) : undefined; }
}
function driverWith(page, context = new Context([], page), clock = { value: 0 }) {
  return new ChatGptBrowser({ browser: { contexts: () => [context] }, now: () => clock.value, sleep: async (ms) => { clock.value += ms; }, stableMs: 2, pollMs: 1, stderr: { write() {} } });
}
function readyPage(extra = {}, pageOptions = {}) {
  return new Page('https://chatgpt.com/', { [SELECTORS.composer[0]]: [new Element()], [SELECTORS.fileInput[0]]: [new Element({ visible: false })], ...extra }, pageOptions);
}

test('fresh, same-tab, and reopened conversation selection work', async () => {
  const fresh = readyPage();
  assert.equal((await driverWith(fresh).pageFor(null)).page, fresh);
  const existing = readyPage(); existing.currentUrl = 'https://chatgpt.com/c/abc?x=1';
  const context = new Context([existing], readyPage());
  const same = await driverWith(existing, context).pageFor({ conversationUrl: 'https://chatgpt.com/c/abc' });
  assert.equal(same.page, existing); assert.equal(existing.front, true); assert.equal(same.reopened, false);
  const reopenedPage = readyPage();
  const reopened = await driverWith(reopenedPage, new Context([], reopenedPage)).pageFor({ conversationUrl: 'https://chatgpt.com/c/missing' });
  assert.equal(reopened.reopened, true); assert.equal(reopenedPage.url(), 'https://chatgpt.com/c/missing');
});

test('hidden upload is supported without touching model or effort controls', async () => {
  const input = new Element({ visible: false });
  const page = readyPage({
    [SELECTORS.fileInput[0]]: [input],
  });
  const driver = driverWith(page);
  await driver.upload(page, '/tmp/plan.md');
  assert.equal(input.files, '/tmp/plan.md');
});

test('streaming response must be new, non-empty, stopped, and stable', async () => {
  let sent = false;
  const assistant = new Element({ text: 'complete answer' });
  const composer = new Element();
  // ChatGPT swaps its temporary root URL for a permanent /c/<id> one within ~1-2s of a
  // real submission — simulating that here keeps waitForPermanentConversationUrl from
  // burning its own poll budget against this test's unrelated (tiny, fake-clock) timeout.
  const send = new Element({ onClick: () => { sent = true; page.currentUrl = 'https://chatgpt.com/c/test'; } });
  const page = new Page('https://chatgpt.com/', {
    [SELECTORS.composer[0]]: [composer], [SELECTORS.send[0]]: [send],
    [SELECTORS.assistant[0]]: () => sent ? [assistant] : [],
  });
  const driver = driverWith(page);
  const result = await driver.review({ prompt: 'review', timeoutMs: 20, target: null, publish: false });
  assert.equal(result.responseText, 'complete answer');
  assert.equal(composer.value, 'review');
});

test('session retry recovers an uncollected response without sending a duplicate prompt', async () => {
  let generating = true;
  let sent = false;
  const stop = new Element();
  const composer = new Element();
  const page = new Page('https://chatgpt.com/c/recover', {
    [SELECTORS.composer[0]]: [composer],
    [SELECTORS.send[0]]: [new Element({ onClick: () => { sent = true; } })],
    [SELECTORS.stop[0]]: () => generating ? [stop] : [],
    [SELECTORS.assistant[0]]: [new Element({ text: 'recovered answer' })],
  });
  const clock = { value: 0 };
  const context = new Context([page], readyPage());
  const driver = new ChatGptBrowser({
    browser: { contexts: () => [context] }, now: () => clock.value,
    sleep: async (ms) => { clock.value += ms; generating = false; },
    stableMs: 2, pollMs: 1, stderr: { write() {} },
  });
  const result = await driver.review({
    session: { conversationUrl: page.url(), passCount: 0 }, prompt: 'must not send',
    timeoutMs: 20, target: null, publish: false,
  });
  assert.equal(result.responseText, 'recovered answer');
  assert.equal(result.recovered, true);
  assert.equal(sent, false);
  assert.equal(composer.value, undefined);
});

test('fresh submission detects a new response even when DOM pruning keeps the assistant-message count flat', async () => {
  let sent = false;
  const composer = new Element();
  // ChatGPT swaps its temporary root URL for a permanent /c/<id> one within ~1-2s of a
  // real submission — simulating that here keeps waitForPermanentConversationUrl from
  // burning its own poll budget against this test's unrelated (tiny, fake-clock) timeout.
  const send = new Element({ onClick: () => { sent = true; page.currentUrl = 'https://chatgpt.com/c/test'; } });
  // Simulates ChatGPT virtualizing old turns out of the DOM: the assistant locator always
  // returns exactly one element (a fixed-size window), but its content is the STALE prior
  // answer until submit, then the NEW one — never two elements at once, so a count-based
  // before/after check could never observe growth.
  const page = new Page('https://chatgpt.com/', {
    [SELECTORS.composer[0]]: [composer], [SELECTORS.send[0]]: [send],
    [SELECTORS.assistant[0]]: () => [new Element({ text: sent ? 'brand new answer' : 'stale old answer' })],
  });
  const driver = driverWith(page);
  const result = await driver.review({ prompt: 'review', timeoutMs: 20, target: null, publish: false });
  assert.equal(result.responseText, 'brand new answer');
});

test('recovery via stored fingerprint detects an uncollected response under DOM pruning, without a generation indicator', async () => {
  let sent = false;
  const composer = new Element();
  const page = new Page('https://chatgpt.com/c/recover-pruned', {
    [SELECTORS.composer[0]]: [composer],
    [SELECTORS.send[0]]: [new Element({ onClick: () => { sent = true; } })],
    [SELECTORS.assistant[0]]: [new Element({ text: 'new uncollected answer' })],
  });
  const driver = driverWith(page);
  const result = await driver.review({
    // passCount/fingerprint reflect an earlier, DIFFERENT response never seen live on this
    // page — simulating a prior invocation that crashed after ChatGPT answered but before it
    // recorded anything. Absolute message count plays no part in this decision.
    session: { conversationUrl: page.url(), passCount: 3, lastResponseFingerprint: 'stale-fingerprint-from-a-different-answer' },
    prompt: 'must not send', timeoutMs: 20, target: null, publish: false,
  });
  assert.equal(result.responseText, 'new uncollected answer');
  assert.equal(result.recovered, true);
  assert.equal(sent, false);
});

test('submission waits for ChatGPT to replace its temporary conversation URL', async () => {
  const page = readyPage();
  page.currentUrl = 'https://chatgpt.com/c/WEB:temporary';
  const clock = { value: 0 };
  const driver = new ChatGptBrowser({
    browser: { contexts: () => [new Context([page], page)] }, now: () => clock.value,
    sleep: async (ms) => { clock.value += ms; page.currentUrl = 'https://chatgpt.com/c/permanent'; },
    stableMs: 2, pollMs: 1, stderr: { write() {} },
  });
  assert.equal(await driver.waitForPermanentConversationUrl(page), true);
  assert.equal(page.url(), 'https://chatgpt.com/c/permanent');
});

test('continue generating is clicked harmlessly', async () => {
  const button = new Element({ onClick: (self) => { self.visible = false; } });
  const page = readyPage({ [SELECTORS.continue[0]]: [button], [SELECTORS.assistant[0]]: [new Element({ text: 'done' })] });
  const driver = driverWith(page);
  assert.equal(await driver.waitForCompletion(page, { before: '', timeoutMs: 20, publish: false }), 'done');
  assert.equal(button.visible, false);
});

test('a completed response prefers the copied Markdown source over the rendered plain text', async () => {
  // .innerText() on a rendered heading never contains the literal '#' — this is what the
  // plan-author heading check needs and innerText can never supply. The response's own
  // action row (a distinct accessible group from the *user* turn's) exposes the real
  // Markdown via its copy control; this proves that path wins when available.
  const copyButton = new Element();
  const responseGroup = new Element({ nested: { [SELECTORS.responseCopyButton[0]]: [copyButton] } });
  const page = readyPage({
    [SELECTORS.assistant[0]]: [new Element({ text: 'PLAN_STATUS: READY rendered without markdown syntax' })],
    [SELECTORS.responseActions[0]]: [responseGroup],
  }, { evaluate: () => 'PLAN_STATUS: READY\n<<<CHATGPT_PLAN_BEGIN>>>\n# Heading\n<<<CHATGPT_PLAN_END>>>' });
  const context = new Context([page], readyPage());
  const driver = driverWith(page, context);
  const text = await driver.waitForCompletion(page, { before: '', timeoutMs: 20, publish: false });
  assert.equal(text, 'PLAN_STATUS: READY\n<<<CHATGPT_PLAN_BEGIN>>>\n# Heading\n<<<CHATGPT_PLAN_END>>>');
  assert.deepEqual(context.grantedWith[0], ['clipboard-read', 'clipboard-write']);
});

test('a completed response is fingerprinted by its plain rendered tail even when Markdown is returned, so a later resume is not misdetected as newly uncollected', async () => {
  // review() stores responseFingerprint for staleness detection on a LATER call, which
  // compares it against latestAssistantText() (plain, cheap) on that later call. If the
  // fingerprint were instead computed from the upgraded Markdown responseText, it could
  // never match that later plain-text comparison for the identical message — making every
  // resumed session look like it has an unread response forever.
  const copyButton = new Element();
  const responseGroup = new Element({ nested: { [SELECTORS.responseCopyButton[0]]: [copyButton] } });
  let stage = 0; // 0: nothing sent yet, 1: first reply present, 2: second reply present
  const composer = new Element();
  // ChatGPT swaps its temporary root URL for a permanent /c/<id> one within ~1-2s of a
  // real submission — simulating that here keeps waitForPermanentConversationUrl from
  // burning its own poll budget against this test's unrelated (tiny, fake-clock) timeout.
  const send = new Element({ onClick: () => { stage += 1; page.currentUrl = 'https://chatgpt.com/c/test'; } });
  const firstText = 'PLAN_STATUS: READY rendered without markdown syntax';
  const secondText = 'a later, different reply';
  const page = new Page('https://chatgpt.com/', {
    [SELECTORS.composer[0]]: [composer], [SELECTORS.send[0]]: [send],
    [SELECTORS.assistant[0]]: () => stage === 0 ? [] : [new Element({ text: stage === 1 ? firstText : secondText })],
    [SELECTORS.responseActions[0]]: [responseGroup],
  }, { evaluate: () => 'PLAN_STATUS: READY\n<<<CHATGPT_PLAN_BEGIN>>>\n# Heading\n<<<CHATGPT_PLAN_END>>>' });
  const context = new Context([], page);
  const driver = driverWith(page, context);

  const first = await driver.review({ prompt: 'author', timeoutMs: 20, target: null, publish: false });
  assert.equal(first.responseFingerprint, fingerprintText(firstText));

  const second = await driver.review({
    session: { conversationUrl: page.url(), lastResponseFingerprint: first.responseFingerprint },
    prompt: 'revise', timeoutMs: 20, target: null, publish: false,
  });
  assert.equal(second.recovered, false);
  assert.equal(stage, 2);
});

test('plan-author mode returns as soon as a complete protocol appears, without waiting for generation to stop', async () => {
  // Reproduced live on #630 phase 7: an Extra-High-effort plan-author turn kept the
  // "generating" indicator (stop button) visible for 20+ minutes of further reasoning
  // and tool calls AFTER already emitting a complete, valid PLAN_STATUS: READY block —
  // the ordinary !generating + stableMs requirement can never fire in that case, so the
  // whole call times out despite a perfectly good answer already sitting in the DOM.
  const planText = 'PLAN_STATUS: READY\n<<<CHATGPT_PLAN_BEGIN>>>\n# Heading\nbody\n<<<CHATGPT_PLAN_END>>>';
  const copyButton = new Element();
  const responseGroup = new Element({ nested: { [SELECTORS.responseCopyButton[0]]: [copyButton] } });
  const page = readyPage({
    [SELECTORS.assistant[0]]: [new Element({ text: planText })],
    [SELECTORS.responseActions[0]]: [responseGroup],
    [SELECTORS.stop[0]]: [new Element()], // never clears — ChatGPT is still "generating"
  }, { evaluate: () => planText });
  const driver = driverWith(page);
  const text = await driver.waitForCompletion(page, { before: '', timeoutMs: 20, publish: false, mode: 'plan-author' });
  assert.equal(text, planText);
});

test('non-plan-author modes still require generation to stop before returning', async () => {
  // The early-exit is scoped to plan-author's fixed-content delimiter protocol only —
  // other modes end with a VERDICT: line that could still change if more text follows,
  // so they must keep waiting for the ordinary !generating + stability requirement.
  const planText = 'PLAN_STATUS: READY\n<<<CHATGPT_PLAN_BEGIN>>>\n# Heading\nbody\n<<<CHATGPT_PLAN_END>>>';
  const page = readyPage({
    [SELECTORS.assistant[0]]: [new Element({ text: planText })],
    [SELECTORS.stop[0]]: [new Element()], // never clears
  });
  const driver = driverWith(page);
  await assert.rejects(
    () => driver.waitForCompletion(page, { before: '', timeoutMs: 20, publish: false }),
    (error) => error.status === 'timed_out',
  );
});

test('plan-author early-exit requires the clipboard-copied Markdown to confirm the match before trusting it while still generating', async () => {
  // innerText can pass the cheap protocol check (e.g. on plain text with no real Markdown
  // heading, or a transient mid-stream coincidence) while the authoritative copied Markdown
  // disagrees — must never return early on an unconfirmed match, however many times the
  // cheap check alone keeps passing.
  const copyButton = new Element();
  const responseGroup = new Element({ nested: { [SELECTORS.responseCopyButton[0]]: [copyButton] } });
  const planText = 'PLAN_STATUS: READY\n<<<CHATGPT_PLAN_BEGIN>>>\n# Heading\nbody\n<<<CHATGPT_PLAN_END>>>';
  const page = readyPage({
    [SELECTORS.assistant[0]]: [new Element({ text: planText })],
    [SELECTORS.responseActions[0]]: [responseGroup],
    [SELECTORS.stop[0]]: [new Element()], // never clears
  }, { evaluate: () => 'not a valid protocol response' });
  const driver = driverWith(page);
  await assert.rejects(
    () => driver.waitForCompletion(page, { before: '', timeoutMs: 20, publish: false, mode: 'plan-author' }),
    (error) => error.status === 'timed_out',
  );
});

test('missing copy control, denied permission, or a hung clipboard read fall back to the rendered text without hanging', async () => {
  const noGroupPage = readyPage({ [SELECTORS.assistant[0]]: [new Element({ text: 'plain answer' })] });
  assert.equal(await driverWith(noGroupPage).waitForCompletion(noGroupPage, { before: '', timeoutMs: 20 }), 'plain answer');

  const emptyGroup = new Element({ nested: {} });
  const noButtonPage = readyPage({
    [SELECTORS.assistant[0]]: [new Element({ text: 'plain answer' })],
    [SELECTORS.responseActions[0]]: [emptyGroup],
  });
  assert.equal(await driverWith(noButtonPage).waitForCompletion(noButtonPage, { before: '', timeoutMs: 20 }), 'plain answer');

  // Simulates the real failure this fixes: Chrome shows a native, out-of-page clipboard
  // permission prompt that nothing will ever click, so navigator.clipboard.readText()
  // never settles. The bounded race must still resolve the whole pass.
  const hungButton = new Element();
  const hungGroup = new Element({ nested: { [SELECTORS.responseCopyButton[0]]: [hungButton] } });
  const hungPage = readyPage({
    [SELECTORS.assistant[0]]: [new Element({ text: 'plain answer' })],
    [SELECTORS.responseActions[0]]: [hungGroup],
  }, { evaluate: () => new Promise(() => {}) });
  assert.equal(await driverWith(hungPage).waitForCompletion(hungPage, { before: '', timeoutMs: 20 }), 'plain answer');
});

test('composer fill is given real headroom and retried once through a transient failure', async () => {
  let attempts = 0;
  let lastTimeout;
  const composer = new Element();
  composer.fill = async (value, options) => {
    attempts += 1;
    lastTimeout = options?.timeout;
    if (attempts < 2) throw new Error('locator.fill: Timeout 30000ms exceeded');
    composer.value = value;
  };
  const send = new Element();
  const page = readyPage({ [SELECTORS.composer[0]]: [composer], [SELECTORS.send[0]]: [send] });
  await driverWith(page).fillAndSend(page, 'prompt text');
  assert.equal(attempts, 2);
  assert.equal(composer.value, 'prompt text');
  // The point of this fix: a large prompt reproducibly needs longer than Playwright's
  // 30s default, not just a retry at the same short timeout.
  assert.ok(lastTimeout > 30_000);
});

test('composer fill gives up and throws after exhausting its retries', async () => {
  const composer = new Element();
  composer.fill = async () => { throw new Error('locator.fill: Timeout 30000ms exceeded'); };
  const page = readyPage({ [SELECTORS.composer[0]]: [composer] });
  await assert.rejects(() => driverWith(page).fillAndSend(page, 'prompt text'), /Timeout 30000ms exceeded/);
});

test('native insertion is preferred when the composer supports it; Playwright .fill() is never called', async () => {
  // Measured live against the production ChatGPT composer: an 80KB execCommand insertText
  // call lands in ~50ms regardless of size, sidestepping Playwright's own actionability-
  // checked .fill(), which has been observed to still genuinely time out under real load
  // even at 120s x 2 retries (issue #630, 246.9s elapsed). This proves the fast path is
  // actually tried first, not merely available.
  let fillCalled = false;
  let insertedValue = null;
  const composer = new Element({ evaluate: (fn, value) => { insertedValue = value; } });
  composer.fill = async (value) => { fillCalled = true; composer.value = value; };
  const send = new Element();
  const page = readyPage({ [SELECTORS.composer[0]]: [composer], [SELECTORS.send[0]]: [send] });
  await driverWith(page).fillAndSend(page, 'a large prompt body');
  assert.equal(insertedValue, 'a large prompt body');
  assert.equal(fillCalled, false);
  assert.equal(composer.value, undefined);
});

test('a send button that only mounts a moment after native insertion is still found and clicked, not skipped for the Enter fallback', async () => {
  // insertNatively resolves as soon as the in-page evaluate() call returns, BEFORE React
  // has necessarily re-rendered in response to it — confirmed live against the production
  // ChatGPT composer: the real send-button selector showed 0 matches on the very next
  // synchronous DOM query and only 1 match after yielding a render tick
  // (requestAnimationFrame). A single, immediate, no-retry check for the send button would
  // silently fall through to composer.press('Enter') on this timing race every time, not
  // because the button is actually missing.
  let checkCount = 0;
  let clicked = false;
  let pressed = false;
  const composer = new Element({ evaluate: () => {} });
  composer.press = async (value) => { pressed = value; };
  const page = readyPage({
    [SELECTORS.composer[0]]: [composer],
    // The send selector "exists" only from the 3rd check onward — exactly like the real
    // send button only appearing after React's next render tick, not on the very first,
    // immediate, synchronous check right after insertion.
    [SELECTORS.send[0]]: () => {
      checkCount += 1;
      if (checkCount < 3) return [];
      return [new Element({ onClick: () => { clicked = true; } })];
    },
  });
  await driverWith(page).fillAndSend(page, 'prompt text');
  assert.ok(checkCount >= 3, `expected at least 3 checks before the button appeared, got ${checkCount}`);
  assert.equal(clicked, true, 'expected the send button to be found and clicked once it mounted');
  assert.equal(pressed, false, 'must not fall back to Enter when the button eventually appears');
});

test('submit() still falls back to Enter if the send button genuinely never appears', async () => {
  let pressed = false;
  const composer = new Element();
  composer.press = async (value) => { pressed = value; };
  const page = readyPage({ [SELECTORS.composer[0]]: [composer] }); // no [SELECTORS.send] at all
  await driverWith(page).submit(page, composer);
  assert.equal(pressed, 'Enter');
});

test('the whole review() call is bounded by its own timeoutMs even when a setup phase needs its own retry', async () => {
  // Before the unified-deadline fix, assertReady/upload/fillAndSend/waitForPermanentConversationUrl
  // each had their own independent, ADDITIONAL worst-case allowance on top of timeoutMs, so
  // the real total wall time could run ~300s past what a caller's own --timeout 540 assumed —
  // confirmed live: 6 real invocations across issue #630 were killed with zero output ever
  // flushed. A composer that never accepts native insertion AND whose Playwright .fill()
  // always fails, combined with a conversation URL that never becomes permanent, forces every
  // setup phase to burn its own ceiling — the whole call must still fail by (approximately)
  // the caller's timeoutMs, not additively stack every phase's ceiling on top of it.
  const composer = new Element();
  composer.fill = async () => { throw new Error('locator.fill: Timeout 30000ms exceeded'); };
  const page = readyPage({ [SELECTORS.composer[0]]: [composer] }); // no [SELECTORS.send] -> composer.press('Enter') fallback; URL never becomes /c/<id>
  const clock = { value: 0 };
  const driver = new ChatGptBrowser({
    browser: { contexts: () => [new Context([], page)] }, now: () => clock.value,
    sleep: async (ms) => { clock.value += ms; }, stableMs: 2, pollMs: 1, stderr: { write() {} },
  });
  // The composer.fill() timeout surfaces as a plain Error here (fillAndSend's fallback
  // re-throws it unwrapped, exactly as chatgpt-review.mjs's own run() does in production,
  // where it becomes an "internal_error" status) — what matters for THIS test is only that
  // the call fails promptly, not which error type carries it.
  await assert.rejects(() => driver.review({ prompt: 'review', timeoutMs: 500, target: null, publish: false }));
  // Old behavior would have let assertReady/fillAndSend/waitForPermanentConversationUrl each
  // additively consume their own full ceiling BEFORE waitForCompletion's clock even started,
  // pushing total elapsed well past 500 (into the multiple-thousands). The fix bounds the
  // whole call close to the caller's own timeoutMs.
  assert.ok(clock.value < 2000, `expected total elapsed to stay close to timeoutMs (500), got ${clock.value}`);
});

test('plan-author mode retries a failed clipboard copy before falling back to plain text', async () => {
  const copyButton = new Element();
  const responseGroup = new Element({ nested: { [SELECTORS.responseCopyButton[0]]: [copyButton] } });
  let readAttempts = 0;
  const realMarkdown = 'PLAN_STATUS: READY\n<<<CHATGPT_PLAN_BEGIN>>>\n# Heading\nbody\n<<<CHATGPT_PLAN_END>>>';
  const page = readyPage({
    [SELECTORS.assistant[0]]: [new Element({ text: 'plain rendered tail, no literal heading syntax' })],
    [SELECTORS.responseActions[0]]: [responseGroup],
  }, { evaluate: () => { readAttempts += 1; return readAttempts === 1 ? null : realMarkdown; } });
  const driver = driverWith(page);
  const text = await driver.waitForCompletion(page, { before: '', timeoutMs: 20, publish: false, mode: 'plan-author' });
  assert.equal(text, realMarkdown);
  assert.ok(readAttempts >= 2, `expected at least one retry, got ${readAttempts} attempt(s)`);
});

test('non-plan-author modes do not retry a failed clipboard copy — a single miss falls back to plain text immediately', async () => {
  const copyButton = new Element();
  const responseGroup = new Element({ nested: { [SELECTORS.responseCopyButton[0]]: [copyButton] } });
  let readAttempts = 0;
  const page = readyPage({
    [SELECTORS.assistant[0]]: [new Element({ text: 'plain rendered tail' })],
    [SELECTORS.responseActions[0]]: [responseGroup],
  }, { evaluate: () => { readAttempts += 1; return readAttempts === 1 ? null : '# would only appear on a retry'; } });
  const driver = driverWith(page);
  const text = await driver.waitForCompletion(page, { before: '', timeoutMs: 20, publish: false });
  assert.equal(text, 'plain rendered tail');
  assert.equal(readAttempts, 1);
});

test('heartbeat is emitted periodically during polling, throttled, with useful progress fields', async () => {
  const heartbeats = [];
  const page = readyPage({ [SELECTORS.assistant[0]]: [new Element({ text: 'final answer' })] });
  const clock = { value: 0 };
  const driver = new ChatGptBrowser({
    browser: { contexts: () => [new Context([], page)] }, now: () => clock.value,
    sleep: async (ms) => { clock.value += ms; }, stableMs: 2, pollMs: 1, heartbeatIntervalMs: 1,
    stderr: { write() {} },
  });
  const text = await driver.waitForCompletion(page, {
    before: '', timeoutMs: 50, publish: false,
    onHeartbeat: (state) => { heartbeats.push(state); },
  });
  assert.equal(text, 'final answer');
  assert.ok(heartbeats.length >= 1, 'expected at least one heartbeat during polling');
  assert.ok(heartbeats.every((h) => typeof h.elapsedMs === 'number' && typeof h.generating === 'boolean' && typeof h.textLength === 'number'));
});

test('a heartbeat write failure never aborts the review', async () => {
  const page = readyPage({ [SELECTORS.assistant[0]]: [new Element({ text: 'final answer' })] });
  const clock = { value: 0 };
  const driver = new ChatGptBrowser({
    browser: { contexts: () => [new Context([], page)] }, now: () => clock.value,
    sleep: async (ms) => { clock.value += ms; }, stableMs: 2, pollMs: 1, heartbeatIntervalMs: 1,
    stderr: { write() {} },
  });
  const text = await driver.waitForCompletion(page, {
    before: '', timeoutMs: 50, publish: false,
    onHeartbeat: async () => { throw new Error('disk full'); },
  });
  assert.equal(text, 'final answer');
});

test('a stalled generation with zero growth triggers one automatic stop+nudge recovery, then completes normally', async () => {
  let stopped = false;
  let nudged = false;
  let recoveredText = null;
  const stop = new Element({ onClick: () => { stopped = true; } });
  const composer = new Element({ evaluate: (fn, value) => { nudged = value === RECOVERY_NUDGE; } });
  const send = new Element({ onClick: () => { recoveredText = 'now producing real content'; } });
  const page = readyPage({
    [SELECTORS.composer[0]]: [composer],
    [SELECTORS.send[0]]: [send],
    [SELECTORS.stop[0]]: () => (stopped ? [] : [stop]),
    [SELECTORS.assistant[0]]: () => [new Element({ text: recoveredText ?? 'stalled text, never growing' })],
  });
  const clock = { value: 0 };
  const driver = new ChatGptBrowser({
    browser: { contexts: () => [new Context([], page)] }, now: () => clock.value,
    sleep: async (ms) => { clock.value += ms; }, stableMs: 2, pollMs: 1, noProgressStallMs: 5,
    stderr: { write() {} },
  });
  const text = await driver.waitForCompletion(page, { before: '', timeoutMs: 5000, publish: false });
  assert.equal(stopped, true, 'expected the stop control to be clicked');
  assert.equal(nudged, true, 'expected the recovery nudge to be inserted into the composer');
  assert.equal(text, 'now producing real content');
});

test('a conversation that stalls for a reason recovery cannot fix still times out normally, without nudging forever', async () => {
  let stopClicks = 0;
  const stop = new Element({ onClick: () => { stopClicks += 1; } });
  const page = readyPage({
    [SELECTORS.stop[0]]: [stop], // never clears, even after the one recovery attempt
    [SELECTORS.assistant[0]]: [new Element({ text: 'stalled text, never growing' })],
  });
  const clock = { value: 0 };
  const driver = new ChatGptBrowser({
    browser: { contexts: () => [new Context([], page)] }, now: () => clock.value,
    sleep: async (ms) => { clock.value += ms; }, stableMs: 2, pollMs: 1, noProgressStallMs: 5,
    stderr: { write() {} },
  });
  await assert.rejects(
    () => driver.waitForCompletion(page, { before: '', timeoutMs: 50, publish: false }),
    (error) => error.status === 'timed_out',
  );
  assert.equal(stopClicks, 1, 'expected exactly one recovery attempt, not repeated nudging');
});

test('message stream failures use Retry without completing or creating a new prompt', async () => {
  let failed = true;
  let retries = 0;
  const retry = new Element({ onClick: () => { retries += 1; failed = false; } });
  const page = readyPage({
    [SELECTORS.streamError[0]]: () => failed ? [new Element({ text: 'Error in message stream' })] : [],
    [SELECTORS.streamRetry[0]]: () => failed ? [retry] : [],
    [SELECTORS.assistant[0]]: () => [new Element({ text: failed ? 'Error in message stream\nRetry' : 'complete answer' })],
  });
  assert.equal(await driverWith(page).waitForCompletion(page, { before: '', timeoutMs: 20, publish: false }), 'complete answer');
  assert.equal(retries, 1);
});

test('persistent message stream failure is typed after two retries', async () => {
  let retries = 0;
  const retry = new Element({ onClick: () => { retries += 1; } });
  const page = readyPage({
    [SELECTORS.streamError[0]]: [new Element({ text: 'Error in message stream' })],
    [SELECTORS.streamRetry[0]]: [retry],
    [SELECTORS.assistant[0]]: [new Element({ text: 'Error in message stream\nRetry' })],
  });
  await assert.rejects(
    () => driverWith(page).waitForCompletion(page, { before: '', timeoutMs: 20, publish: false }),
    (error) => error.status === 'ui_incompatible' && /after two automatic retries/.test(error.message),
  );
  assert.equal(retries, 2);
});

test('login failure, UI drift, rate limit, and timeout are typed', async () => {
  const login = new Page('https://chatgpt.com/', { [SELECTORS.login[0]]: [new Element()] });
  await assert.rejects(() => driverWith(login).assertReady(login), (error) => error.status === 'login_required');
  const drift = new Page();
  await assert.rejects(() => driverWith(drift).assertReady(drift), (error) => error.status === 'ui_incompatible');
  const rate = readyPage({ [SELECTORS.rateLimit[0]]: [new Element()] });
  await assert.rejects(() => driverWith(rate).waitForCompletion(rate, { before: '', timeoutMs: 2 }), (error) => error.status === 'rate_limited');
  const uiError = readyPage({ [SELECTORS.error[0]]: [new Element({ text: 'Something went wrong' })] });
  await assert.rejects(() => driverWith(uiError).waitForCompletion(uiError, { before: '', timeoutMs: 2 }), (error) => error.status === 'ui_incompatible');
  const timeout = readyPage();
  await assert.rejects(() => driverWith(timeout).waitForCompletion(timeout, { before: '', timeoutMs: 2 }), (error) => error.status === 'timed_out');
});

test('empty and status live-region alerts do not abort an active review', async () => {
  const page = readyPage({
    [SELECTORS.alert[0]]: [new Element({ text: '' }), new Element({ text: 'ChatGPT is working' })],
    [SELECTORS.assistant[0]]: [new Element({ text: 'complete answer' })],
  });
  assert.equal(await driverWith(page).waitForCompletion(page, { before: '', timeoutMs: 20, publish: false }), 'complete answer');
});

test('live-region alerts are fatal only when their text identifies a real failure', async () => {
  assert.equal(classifyAlertText(''), null);
  assert.equal(classifyAlertText('ChatGPT is working'), null);
  assert.deepEqual(classifyAlertText('Too many requests; try again later'), { status: 'rate_limited', message: 'Too many requests; try again later' });
  assert.deepEqual(classifyAlertText('Something went wrong'), { status: 'ui_incompatible', message: 'Something went wrong' });
  const page = readyPage({ [SELECTORS.alert[0]]: [new Element({ text: 'There was an error generating a response' })] });
  await assert.rejects(() => driverWith(page).waitForCompletion(page, { before: '', timeoutMs: 2 }), (error) => error.status === 'ui_incompatible');
});

test('only a scoped comment permission is automatically approvable', () => {
  const target = { owner: 'o', repo: 'r', number: 5, canonicalUrl: 'https://github.com/o/r/pull/5' };
  assert.equal(classifyPermission('Allow a comment on o/r PR #5?', target, true), 'allow_comment');
  assert.equal(classifyPermission('Allow a comment on all repositories?', target, true), 'deny');
  assert.equal(classifyPermission('Allow merge on o/r PR #5?', target, true), 'deny');
  assert.equal(classifyPermission('Allow a comment on o/r PR #6?', target, true), 'deny');
  assert.equal(classifyPermission('Allow a comment on o/r PR #5?', target, false), 'deny');
});

test('scoped confirmation is clicked and unexpected prompts require interaction', async () => {
  const approve = new Element();
  const target = { owner: 'o', repo: 'r', number: 5, canonicalUrl: 'https://github.com/o/r/pull/5' };
  let clicked = false; approve.onClick = () => { clicked = true; };
  const allowedDialog = new Element({ text: 'Allow a comment on o/r PR #5?', nested: { [SELECTORS.permissionApprove[0]]: [approve] } });
  const allowedPage = readyPage({ [SELECTORS.permission[0]]: [allowedDialog] });
  await driverWith(allowedPage).handlePermission(allowedPage, target, true);
  assert.equal(clicked, true);
  const broad = new Element({ text: 'Allow repository access to all repositories?' });
  const broadPage = readyPage({ [SELECTORS.permission[0]]: [broad] });
  await assert.rejects(() => driverWith(broadPage).handlePermission(broadPage, target, true), (error) => error instanceof ReviewError && error.status === 'needs_interaction');
});

test('doctor validates all non-sending browser capabilities', async () => {
  const page = readyPage();
  const result = await driverWith(page).doctor();
  assert.deepEqual(result.checks, { cdp: true, login: true, composer: true, fileUpload: true, predefinedModelAndEffort: true });
});

test('CDP connection failures are typed as Chrome unavailable', async () => {
  await assert.rejects(() => connectToChrome('http://127.0.0.1:9222', async () => ({ chromium: { connectOverCDP: async () => { throw new Error('down'); } } })), (error) => error.status === 'chrome_unavailable');
});
