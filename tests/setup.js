// Global test isolation. happy-dom may provide a real localStorage and a
// persistent document between tests in a file; reset both before each test so
// state (saved queries, history, mounted DOM) never leaks across cases.
import { beforeEach } from 'vitest';

beforeEach(() => {
  try {
    if (globalThis.localStorage && typeof globalThis.localStorage.clear === 'function') {
      globalThis.localStorage.clear();
    }
  } catch {
    /* localStorage unavailable in this environment */
  }
  if (globalThis.document && globalThis.document.body) {
    globalThis.document.body.innerHTML = '';
  }
});
