import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatGptBrowser, ReviewError, SELECTORS, classifyAlertText, classifyPermission, connectToChrome } from '../scripts/lib/browser.mjs';

class Element {
  constructor({ text = '', visible = true, onClick, nested = {} } = {}) { this.text = text; this.visible = visible; this.onClick = onClick; this.nested = nested; }
  async isVisible() { return this.visible; }
  async count() { return 1; }
  async innerText() { return this.text; }
  async click() { this.onClick?.(this); }
  async fill(value) { this.value = value; }
  async press(value) { this.pressed = value; }
  async setInputFiles(value) { this.files = value; }
  locator(selector) { return new Locator(this.nested[selector] ?? []); }
}
class Locator {
  constructor(elements) { this.elements = elements; }
  first() { return this.elements[0] ?? new Missing(); }
  nth(index) { return this.elements[index] ?? new Missing(); }
  async count() { return this.elements.length; }
}
class Missing extends Element {
  constructor() { super({ visible: false }); }
  async count() { return 0; }
}
class Page {
  constructor(url = 'https://chatgpt.com/', map = {}) { this.currentUrl = url; this.map = map; this.front = false; }
  url() { return this.currentUrl; }
  locator(selector) { const value = this.map[selector]; return new Locator(typeof value === 'function' ? value() : value ?? []); }
  async goto(url) { this.currentUrl = url; }
  async bringToFront() { this.front = true; }
  async waitForLoadState() {}
}
class Context {
  constructor(pages = [], fresh = new Page()) { this.items = pages; this.fresh = fresh; }
  pages() { return this.items; }
  async newPage() { this.items.push(this.fresh); return this.fresh; }
}
function driverWith(page, context = new Context([], page), clock = { value: 0 }) {
  return new ChatGptBrowser({ browser: { contexts: () => [context] }, now: () => clock.value, sleep: async (ms) => { clock.value += ms; }, stableMs: 2, pollMs: 1, stderr: { write() {} } });
}
function readyPage(extra = {}) {
  return new Page('https://chatgpt.com/', { [SELECTORS.composer[0]]: [new Element()], [SELECTORS.fileInput[0]]: [new Element({ visible: false })], ...extra });
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
  const send = new Element({ onClick: () => { sent = true; } });
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
  assert.equal(await driver.waitForCompletion(page, { before: 0, timeoutMs: 20, publish: false }), 'done');
  assert.equal(button.visible, false);
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
  assert.equal(await driverWith(page).waitForCompletion(page, { before: 0, timeoutMs: 20, publish: false }), 'complete answer');
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
    () => driverWith(page).waitForCompletion(page, { before: 0, timeoutMs: 20, publish: false }),
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
  await assert.rejects(() => driverWith(rate).waitForCompletion(rate, { before: 0, timeoutMs: 2 }), (error) => error.status === 'rate_limited');
  const uiError = readyPage({ [SELECTORS.error[0]]: [new Element({ text: 'Something went wrong' })] });
  await assert.rejects(() => driverWith(uiError).waitForCompletion(uiError, { before: 0, timeoutMs: 2 }), (error) => error.status === 'ui_incompatible');
  const timeout = readyPage();
  await assert.rejects(() => driverWith(timeout).waitForCompletion(timeout, { before: 0, timeoutMs: 2 }), (error) => error.status === 'timed_out');
});

test('empty and status live-region alerts do not abort an active review', async () => {
  const page = readyPage({
    [SELECTORS.alert[0]]: [new Element({ text: '' }), new Element({ text: 'ChatGPT is working' })],
    [SELECTORS.assistant[0]]: [new Element({ text: 'complete answer' })],
  });
  assert.equal(await driverWith(page).waitForCompletion(page, { before: 0, timeoutMs: 20, publish: false }), 'complete answer');
});

test('live-region alerts are fatal only when their text identifies a real failure', async () => {
  assert.equal(classifyAlertText(''), null);
  assert.equal(classifyAlertText('ChatGPT is working'), null);
  assert.deepEqual(classifyAlertText('Too many requests; try again later'), { status: 'rate_limited', message: 'Too many requests; try again later' });
  assert.deepEqual(classifyAlertText('Something went wrong'), { status: 'ui_incompatible', message: 'Something went wrong' });
  const page = readyPage({ [SELECTORS.alert[0]]: [new Element({ text: 'There was an error generating a response' })] });
  await assert.rejects(() => driverWith(page).waitForCompletion(page, { before: 0, timeoutMs: 2 }), (error) => error.status === 'ui_incompatible');
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
