import { describe, it, expect, vi } from 'vitest';
import { signal, effect, batch } from '../../src/core/signal.js';

describe('signal / effect — the reactive core', () => {
  it('reads the current value outside any effect (no subscription)', () => {
    const s = signal(1);
    expect(s.value).toBe(1); // exercises the `if (activeEffect)` false branch
  });

  it('runs an effect once immediately', () => {
    const s = signal('a');
    const spy = vi.fn(() => s.value);
    effect(spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-runs the effect when a read signal changes', () => {
    const s = signal(1);
    const seen = [];
    effect(() => seen.push(s.value));
    s.value = 2;
    s.value = 3;
    expect(seen).toEqual([1, 2, 3]);
  });

  it('does NOT re-run when the value is unchanged (Object.is)', () => {
    const s = signal(1);
    const spy = vi.fn(() => s.value);
    effect(spy);
    s.value = 1; // equal → no-op
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('only notifies effects that actually read the signal', () => {
    const a = signal(0);
    const b = signal(0);
    const aSpy = vi.fn(() => a.value);
    const bSpy = vi.fn(() => b.value);
    effect(aSpy);
    effect(bSpy);
    a.value = 1;
    expect(aSpy).toHaveBeenCalledTimes(2);
    expect(bSpy).toHaveBeenCalledTimes(1); // b untouched
  });

  it('tracks conditional dependencies — a no-longer-read signal stops triggering', () => {
    const useB = signal(true);
    const b = signal('x');
    const spy = vi.fn(() => {
      if (useB.value) return b.value;
      return 'const';
    });
    effect(spy);
    expect(spy).toHaveBeenCalledTimes(1);

    b.value = 'y'; // still read → re-runs
    expect(spy).toHaveBeenCalledTimes(2);

    useB.value = false; // effect re-runs and stops reading b
    expect(spy).toHaveBeenCalledTimes(3);

    b.value = 'z'; // b no longer a dependency → no re-run
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('supports nested effects (restores the previous active effect)', () => {
    const outer = signal(0);
    const inner = signal(0);
    const innerSpy = vi.fn(() => inner.value);
    const outerSpy = vi.fn(() => {
      outer.value;
      effect(innerSpy); // nested: activeEffect must restore to outer after this
    });
    effect(outerSpy);
    expect(outerSpy).toHaveBeenCalledTimes(1);
    expect(innerSpy).toHaveBeenCalledTimes(1);

    inner.value = 1; // only the inner effect depends on inner
    expect(innerSpy).toHaveBeenCalledTimes(2);
    expect(outerSpy).toHaveBeenCalledTimes(1);
  });

  it('batch() coalesces multiple signal writes into one re-run', () => {
    const a = signal(0);
    const b = signal(0);
    const spy = vi.fn(() => a.value + b.value); // depends on both
    effect(spy);
    expect(spy).toHaveBeenCalledTimes(1);
    batch(() => {
      a.value = 1; // queued, not run
      b.value = 2; // queued (same effect → deduped by the Set)
    });
    expect(spy).toHaveBeenCalledTimes(2); // one flush, not two
    expect(a.value + b.value).toBe(3);
  });

  it('batch() returns the callback result and flushes only at the outermost level', () => {
    const s = signal(0);
    const spy = vi.fn(() => s.value);
    effect(spy);
    const out = batch(() => {
      s.value = 1;
      batch(() => { s.value = 2; }); // nested → does NOT flush here
      expect(spy).toHaveBeenCalledTimes(1); // still deferred mid-batch
      return 'done';
    });
    expect(out).toBe('done');
    expect(spy).toHaveBeenCalledTimes(2); // single flush after the outer batch
  });

  it('dispose() unsubscribes the effect', () => {
    const s = signal(1);
    const spy = vi.fn(() => s.value);
    const dispose = effect(spy);
    s.value = 2;
    expect(spy).toHaveBeenCalledTimes(2);
    dispose();
    s.value = 3; // no longer subscribed
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

// A focused demonstration: the same tab lifecycle as src/ui/tabs.js, but the
// "render" runs itself. Note there is no refresh() that has to remember to call
// renderTabs + rerenderResults + updateSaveBtn — each view subscribes to what it
// reads, and mutating state is all the caller does.
describe('demonstration: tabs.js lifecycle without manual refresh()', () => {
  function makeTabsModel() {
    const tabs = signal([{ id: 't1', name: 'Untitled' }]);
    const activeId = signal('t1');
    let nextId = 2;
    return {
      tabs,
      activeId,
      selectTab: (id) => { activeId.value = id; },
      newTab: () => {
        const id = 't' + nextId++;
        tabs.value = [...tabs.value, { id, name: 'Untitled' }];
        activeId.value = id; // both reads update; no manual repaint call
      },
      closeTab: (id) => {
        tabs.value = tabs.value.filter((t) => t.id !== id);
        if (activeId.value === id) activeId.value = tabs.value[tabs.value.length - 1].id;
      },
    };
  }

  it('repaints the strip + the active-tab-dependent views automatically', () => {
    const m = makeTabsModel();

    // Three independent "views", each declaring what it reads — exactly the
    // three things tabs.js's refresh() repaints by hand today.
    const strip = vi.fn(() => m.tabs.value.map((t) => t.id));
    const saveBtn = vi.fn(() => m.activeId.value); // "Save" cares about active tab
    const results = vi.fn(() => m.activeId.value);

    effect(strip);
    effect(saveBtn);
    effect(results);
    expect([strip, saveBtn, results].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);

    m.newTab(); // strip changes (new tab) AND active changes
    expect(strip).toHaveBeenCalledTimes(2);
    expect(saveBtn).toHaveBeenCalledTimes(2);
    expect(results).toHaveBeenCalledTimes(2);

    m.selectTab('t1'); // only active changes → strip is NOT repainted
    expect(strip).toHaveBeenCalledTimes(2); // unchanged — surgical
    expect(saveBtn).toHaveBeenCalledTimes(3);
    expect(results).toHaveBeenCalledTimes(3);

    m.closeTab('t2'); // t2 doesn't exist anymore? it's 't2' from newTab → close it
    // (newTab created 't2' and selected it; selectTab('t1') made t1 active)
    expect(m.tabs.value.map((t) => t.id)).toEqual(['t1']);
    expect(strip).toHaveBeenCalledTimes(3); // strip repainted (list shrank)
    expect(saveBtn).toHaveBeenCalledTimes(3); // active was already t1 → no change
  });
});
