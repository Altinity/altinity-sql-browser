import { describe, it, expect, vi } from 'vitest';
import { createFocusSettler } from '../../src/ui/shell/focus-settlement.js';
import type { FocusDocument } from '../../src/ui/shell/focus-settlement.js';

// #577 S2's capture/settle protocol for focus across a structural transition
// (a sidebar fold, a drawer close, a panel swap) that can remove the element
// that currently holds focus.
//
// `FocusDocument` is deliberately narrow (`activeElement` + `body`) so a plain
// fixture object satisfies it — that lets these specs drive every branch
// (activeElement null, body, a stale element, a genuinely newer element)
// without fighting the real global `document`'s own focus/blur behaviour.
// Elements themselves are real happy-dom nodes with a real `.focus()`.

/** A `FocusDocument` whose `activeElement` this spec can set directly,
 *  standing in for whatever the browser reports at each moment. */
interface FixtureDoc extends FocusDocument {
  activeElement: Element | null;
  body: Element | null;
}

const makeDoc = (body: Element | null = document.createElement('body')): FixtureDoc => (
  { activeElement: null, body }
);

describe('capture', () => {
  it('records focus when activeElement is inside the container', () => {
    const container = document.createElement('div');
    const child = document.createElement('input');
    container.appendChild(child);
    const doc = makeDoc();
    doc.activeElement = child;
    const settler = createFocusSettler(doc);

    settler.capture(container);

    expect(settler.pending()).toBe(true);
  });

  it('captures nothing when focus is outside the container', () => {
    const container = document.createElement('div');
    const elsewhere = document.createElement('input');
    const doc = makeDoc();
    doc.activeElement = elsewhere;
    const settler = createFocusSettler(doc);

    settler.capture(container);

    // Outside the container, this transition cannot destroy that focus, so
    // there is nothing to rescue — and the matching settle must be a no-op.
    expect(settler.pending()).toBe(false);
  });

  it('captures nothing when activeElement is null', () => {
    const container = document.createElement('div');
    const doc = makeDoc();
    doc.activeElement = null;
    const settler = createFocusSettler(doc);

    settler.capture(container);

    expect(settler.pending()).toBe(false);
  });

  it('captures nothing when the container itself is null', () => {
    const child = document.createElement('input');
    const doc = makeDoc();
    doc.activeElement = child;
    const settler = createFocusSettler(doc);

    settler.capture(null);

    expect(settler.pending()).toBe(false);
  });

  it('replaces an older intent rather than queuing it', () => {
    const containerA = document.createElement('div');
    const elA = document.createElement('input');
    containerA.appendChild(elA);
    const containerB = document.createElement('div');
    const elB = document.createElement('input');
    containerB.appendChild(elB);

    const doc = makeDoc();
    const settler = createFocusSettler(doc);

    doc.activeElement = elA;
    settler.capture(containerA);
    doc.activeElement = elB;
    settler.capture(containerB);

    // Prove the FIRST intent (elA) is truly gone, not merely shadowed: put
    // focus back on elA — a stale, already-cancelled destination — and settle.
    // If the older intent had survived (queued rather than replaced), settle
    // would see activeElement === its own captured element and proceed. It
    // must instead refuse, because the live intent is elB, and elA is neither
    // that intent, `body`, nor null.
    doc.activeElement = elA;
    const resolve = vi.fn(() => document.createElement('button'));
    settler.settle(resolve);

    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('settle', () => {
  it('is a no-op when nothing was captured', () => {
    const doc = makeDoc();
    const settler = createFocusSettler(doc);
    const resolve = vi.fn(() => document.createElement('button'));

    settler.settle(resolve);

    expect(resolve).not.toHaveBeenCalled();
  });

  it('focuses the resolved destination when activeElement is null (browser already dropped focus)', () => {
    const container = document.createElement('div');
    const captured = document.createElement('input');
    container.appendChild(captured);
    const doc = makeDoc();
    doc.activeElement = captured;
    const settler = createFocusSettler(doc);
    settler.capture(container);

    doc.activeElement = null;
    const dest = document.createElement('button');
    const focusSpy = vi.spyOn(dest, 'focus');

    settler.settle(() => dest);

    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('focuses the resolved destination when activeElement is body (focus fell back to the page)', () => {
    const body = document.createElement('body');
    const container = document.createElement('div');
    const captured = document.createElement('input');
    container.appendChild(captured);
    const doc = makeDoc(body);
    doc.activeElement = captured;
    const settler = createFocusSettler(doc);
    settler.capture(container);

    doc.activeElement = body;
    const dest = document.createElement('button');
    const focusSpy = vi.spyOn(dest, 'focus');

    settler.settle(() => dest);

    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('focuses the resolved destination when activeElement is still the captured element', () => {
    const container = document.createElement('div');
    const captured = document.createElement('input');
    container.appendChild(captured);
    const doc = makeDoc();
    doc.activeElement = captured;
    const settler = createFocusSettler(doc);
    settler.capture(container);
    // Browser has not yet dropped focus out of the now-hidden subtree — still
    // reports the captured element as active, and that must still count.

    const dest = document.createElement('button');
    const focusSpy = vi.spyOn(dest, 'focus');

    settler.settle(() => dest);

    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses when some other element already holds focus — never steals a NEWER user focus', () => {
    const container = document.createElement('div');
    const captured = document.createElement('input');
    container.appendChild(captured);
    const doc = makeDoc();
    doc.activeElement = captured;
    const settler = createFocusSettler(doc);
    settler.capture(container);

    // Between capture and settle, the user focused something else entirely —
    // neither the captured element, `body`, nor null.
    const somethingElse = document.createElement('textarea');
    doc.activeElement = somethingElse;
    const resolve = vi.fn(() => document.createElement('button'));

    settler.settle(resolve);

    expect(resolve).not.toHaveBeenCalled();
  });

  it('is single-shot: a second settle after a successful one does nothing', () => {
    const container = document.createElement('div');
    const captured = document.createElement('input');
    container.appendChild(captured);
    const doc = makeDoc();
    doc.activeElement = captured;
    const settler = createFocusSettler(doc);
    settler.capture(container);

    settler.settle(() => document.createElement('button'));
    expect(settler.pending()).toBe(false);

    const secondResolve = vi.fn(() => document.createElement('button'));
    settler.settle(secondResolve);

    // A later, unrelated render must not resurrect an already-consumed intent.
    expect(secondResolve).not.toHaveBeenCalled();
  });

  it('consumes the intent and focuses nothing when the resolver returns null/undefined', () => {
    const container = document.createElement('div');
    const captured = document.createElement('input');
    container.appendChild(captured);
    const doc = makeDoc();
    doc.activeElement = captured;
    const settler = createFocusSettler(doc);
    settler.capture(container);

    const resolve = vi.fn(() => undefined);
    settler.settle(resolve);

    expect(resolve).toHaveBeenCalledTimes(1);
    // The intent is gone either way — a subsequent settle call has nothing
    // left to act on, proving this wasn't left pending for lack of a target.
    expect(settler.pending()).toBe(false);
    const laterResolve = vi.fn(() => document.createElement('button'));
    settler.settle(laterResolve);
    expect(laterResolve).not.toHaveBeenCalled();
  });
});

describe('pending', () => {
  it('reflects whether an intent is currently captured and unsettled', () => {
    const container = document.createElement('div');
    const captured = document.createElement('input');
    container.appendChild(captured);
    const doc = makeDoc();
    doc.activeElement = captured;
    const settler = createFocusSettler(doc);

    expect(settler.pending()).toBe(false);
    settler.capture(container);
    expect(settler.pending()).toBe(true);
    settler.settle(() => document.createElement('button'));
    expect(settler.pending()).toBe(false);
  });
});

describe('cancel', () => {
  it('drops a pending intent so a later settle does nothing', () => {
    const container = document.createElement('div');
    const captured = document.createElement('input');
    container.appendChild(captured);
    const doc = makeDoc();
    doc.activeElement = captured;
    const settler = createFocusSettler(doc);
    settler.capture(container);

    settler.cancel();

    expect(settler.pending()).toBe(false);
    const resolve = vi.fn(() => document.createElement('button'));
    settler.settle(resolve);
    expect(resolve).not.toHaveBeenCalled();
  });
});
