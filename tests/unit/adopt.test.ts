import { describe, it, expect, vi } from 'vitest';
import { adopt, adoptOne } from '../../src/ui/shell/adopt.js';

// #577 S2's ONE seam between Preact-rendered elements and pre-built,
// imperatively-owned DOM. `adopt` and `adoptOne` are ref callbacks: Preact
// hands them the element they are attached to (or `null` on unmount) and
// nothing else, so these specs build a bare `div` to stand in for that
// element rather than rendering anything with Preact itself.

describe('adopt', () => {
  it('appends every node into the ref\'d element, in the order given', () => {
    const host = document.createElement('div');
    const a = document.createElement('span');
    const b = document.createElement('span');
    const c = document.createElement('span');

    adopt(a, b, c)(host);

    expect([...host.childNodes]).toEqual([a, b, c]);
  });

  it('skips null and undefined entries so a caller can pass a conditional node without a branch', () => {
    const host = document.createElement('div');
    const a = document.createElement('span');
    const c = document.createElement('span');

    adopt(a, null, undefined, c)(host);

    expect([...host.childNodes]).toEqual([a, c]);
  });

  it('is idempotent: firing the same ref again does not duplicate or reorder', () => {
    const host = document.createElement('div');
    const a = document.createElement('span');
    const b = document.createElement('span');
    const ref = adopt(a, b);

    ref(host);
    ref(host);
    ref(host);

    expect([...host.childNodes]).toEqual([a, b]);
  });

  it('called with null — Preact\'s unmount signal — is a no-op that leaves the adopted nodes parented', () => {
    const host = document.createElement('div');
    const a = document.createElement('span');
    const ref = adopt(a);

    ref(host);
    expect(a.parentNode).toBe(host);

    // The unmount call must not detach what was adopted: the whole point of a
    // persistent host is that its children outlive the element's own ref life-
    // cycle (`ui/nav-sections.ts`'s section hosts survive every nav mode change).
    ref(null);

    expect(a.parentNode).toBe(host);
    expect([...host.childNodes]).toEqual([a]);
  });

  it('moves a node currently parented elsewhere, rather than leaving a second copy behind', () => {
    const oldHost = document.createElement('div');
    const newHost = document.createElement('div');
    const node = document.createElement('span');
    oldHost.appendChild(node);

    adopt(node)(newHost);

    expect(node.parentNode).toBe(newHost);
    expect(oldHost.childNodes.length).toBe(0);
    expect([...newHost.childNodes]).toEqual([node]);
  });
});

describe('adoptOne', () => {
  it('replaces the element\'s children with the node', () => {
    const host = document.createElement('div');
    host.appendChild(document.createElement('span')); // stale prior content
    const node = document.createElement('svg');

    adoptOne(node)(host);

    expect([...host.childNodes]).toEqual([node]);
  });

  it('is a no-op when the node is already the sole child — no detach/reattach', () => {
    const host = document.createElement('div');
    const node = document.createElement('svg');
    host.appendChild(node);
    // Spying on replaceChildren distinguishes the no-op branch from the
    // replace branch directly, rather than re-asserting `host.childNodes`
    // still contains `node` (which would be true either way: a replace with
    // the same single node produces an identical result).
    const replaceSpy = vi.spyOn(host, 'replaceChildren');

    adoptOne(node)(host);

    expect(replaceSpy).not.toHaveBeenCalled();
    expect([...host.childNodes]).toEqual([node]);
  });

  it('still replaces when the node IS the first child but a stray sibling snuck in beside it', () => {
    // The no-op guard checks both "is it the first child" AND "is it the ONLY
    // child" — a re-render that leaves the right node in place but with an
    // extra sibling must still be cleaned up, not waved through as a no-op.
    const host = document.createElement('div');
    const node = document.createElement('svg');
    const stray = document.createComment('stray');
    host.appendChild(node);
    host.appendChild(stray);

    adoptOne(node)(host);

    expect([...host.childNodes]).toEqual([node]);
  });

  it('replaces (rather than skips) when the node differs from what is already there', () => {
    const host = document.createElement('div');
    const oldNode = document.createElement('svg');
    host.appendChild(oldNode);
    const newNode = document.createElement('svg');

    adoptOne(newNode)(host);

    // Proves the identity check really is by identity, not by tag/shape: two
    // same-tag SVGs still trigger a real replace when they are different nodes.
    expect([...host.childNodes]).toEqual([newNode]);
    expect(oldNode.parentNode).toBe(null);
  });

  it('handles a null node as a no-op', () => {
    const host = document.createElement('div');
    const existing = document.createElement('span');
    host.appendChild(existing);

    adoptOne(null)(host);
    adoptOne(undefined)(host);

    expect([...host.childNodes]).toEqual([existing]);
  });

  it('handles a null element (Preact\'s unmount signal) as a no-op', () => {
    const node = document.createElement('svg');
    // Must not throw, and must not somehow attach the node anywhere.
    expect(() => adoptOne(node)(null)).not.toThrow();
    expect(node.parentNode).toBe(null);
  });
});
