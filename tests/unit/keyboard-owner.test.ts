// #588 W2 — `keyboardOwnerChannel` (src/ui/keyboard-owner.ts), hoisted out of
// three byte-identical private copies (file-menu.ts, library-assign-menu.ts,
// dashboard.ts). Unit-tested directly against a fake `KeyboardOwnerHost` — no
// `createApp`. file-menu.test.ts/library-assign-menu.test.ts/dashboard.test.ts
// remain the composition safety net proving each real call site still wires
// its menu's `onKeyboardOwnerChange` through this shared adapter and that
// `app.keyboardOwner` observably updates end-to-end; this file is the
// adapter's own unit surface.
import { describe, it, expect, vi } from 'vitest';
import { keyboardOwnerChannel } from '../../src/ui/keyboard-owner.js';
import type { KeyboardOwnerHost } from '../../src/ui/keyboard-owner.js';
import type { KeyboardOwner, KeyboardOwnerRelease } from '../../src/ui/app.types.js';

/** A fake host tracking every acquire call and the release each one hands
 *  back, so a test can assert exactly which release fired and when. */
function makeHost(): { host: KeyboardOwnerHost; releases: Array<ReturnType<typeof vi.fn>> } {
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const host: KeyboardOwnerHost = {
    acquireKeyboardOwner: (kind: KeyboardOwner['kind']): KeyboardOwnerRelease => {
      const release = vi.fn();
      releases.push(release);
      return release;
    },
  };
  return { host, releases };
}

describe('keyboardOwnerChannel', () => {
  it('acquires the given kind on the first owner and returns nothing to release yet', () => {
    const { host, releases } = makeHost();
    const channel = keyboardOwnerChannel(host);
    channel({ kind: 'menu' });
    expect(releases).toHaveLength(1);
    expect(releases[0]).not.toHaveBeenCalled();
  });

  it('an owner swap releases the PREVIOUS acquisition before acquiring the new one', () => {
    const { host, releases } = makeHost();
    const channel = keyboardOwnerChannel(host);
    channel({ kind: 'menu' });
    channel({ kind: 'modal' }); // swap while still "open"
    expect(releases).toHaveLength(2);
    expect(releases[0]).toHaveBeenCalledTimes(1); // the menu's acquisition released
    expect(releases[1]).not.toHaveBeenCalled(); // the modal's is still held
  });

  it('null releases the current owner and acquires nothing new', () => {
    const { host, releases } = makeHost();
    const channel = keyboardOwnerChannel(host);
    channel({ kind: 'popover' });
    channel(null);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toHaveBeenCalledTimes(1);
  });

  it('null with no prior owner is a safe no-op (never acquires, never throws)', () => {
    const { host, releases } = makeHost();
    const channel = keyboardOwnerChannel(host);
    expect(() => channel(null)).not.toThrow();
    expect(releases).toHaveLength(0);
  });

  it('a fresh channel per call site: two independent channels never share their release state', () => {
    const { host, releases } = makeHost();
    const channelA = keyboardOwnerChannel(host);
    const channelB = keyboardOwnerChannel(host);
    channelA({ kind: 'menu' });
    channelB({ kind: 'menu' });
    channelA(null);
    expect(releases[0]).toHaveBeenCalledTimes(1); // A's own release fired
    expect(releases[1]).not.toHaveBeenCalled(); // B's is untouched by A's close
  });

  it('repeated null calls only release once each (each call reads the current `release`, already cleared to null)', () => {
    const { host, releases } = makeHost();
    const channel = keyboardOwnerChannel(host);
    channel({ kind: 'menu' });
    channel(null);
    channel(null); // nothing acquired now — no-op, no new release
    expect(releases).toHaveLength(1);
    expect(releases[0]).toHaveBeenCalledTimes(1);
  });
});
