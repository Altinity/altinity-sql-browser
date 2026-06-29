// A ~50-line reactive core. `signal()` holds a value and remembers which effects
// read it; `effect()` runs a function and re-runs it whenever a signal it read
// changes. This is the whole mechanism behind "the UI repaints itself" — enough
// to retire manual `renderX(app)` invalidation without adopting a framework.
//
// Pure by construction: no DOM, no globals beyond the module-local tracking
// pointer, so it lives in core/ and tests with plain stubs.

// The effect currently running — set while an effect's body executes so that any
// signal read during it knows who to subscribe. null when no effect is active
// (e.g. a read from ordinary code), in which case the read just returns a value.
let activeEffect = null;
// While > 0, signal writes queue their subscribers instead of running them, so a
// multi-signal update (e.g. set the tab list AND the active id) repaints once.
let batchDepth = 0;
const queued = new Set();

/**
 * A reactive box around `initial`. Reading `.value` *inside* an effect subscribes
 * that effect to this signal; assigning a different `.value` re-runs every
 * subscribed effect. Assigning an equal value is a no-op (no needless re-render).
 */
export function signal(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get value() {
      if (activeEffect) {
        subs.add(activeEffect);
        activeEffect.deps.add(subs);
      }
      return value;
    },
    set value(next) {
      if (Object.is(next, value)) return;
      value = next;
      // Copy first: an effect re-subscribes as it re-runs, mutating `subs`
      // mid-iteration. Inside a batch, queue instead (deduped by the Set).
      if (batchDepth > 0) {
        for (const eff of subs) queued.add(eff);
        return;
      }
      for (const eff of [...subs]) eff.run();
    },
  };
}

/**
 * Run `fn` immediately, and again whenever any signal it read changes. Each run
 * re-derives the dependency set from what `fn` actually reads, so conditional
 * dependencies are tracked correctly (a signal no longer read stops triggering
 * re-runs). Returns a `dispose()` that unsubscribes the effect.
 */
export function effect(fn) {
  const eff = {
    deps: new Set(),
    run() {
      cleanup(eff);
      const prev = activeEffect;
      activeEffect = eff;
      try {
        fn();
      } finally {
        activeEffect = prev;
      }
    },
  };
  eff.run();
  return () => cleanup(eff);
}

/**
 * Run `fn`, deferring every effect triggered by signal writes inside it until
 * `fn` returns, then run each affected effect once. Nesting is depth-counted, so
 * only the outermost batch flushes. Returns `fn`'s result.
 */
export function batch(fn) {
  batchDepth++;
  try {
    return fn();
  } finally {
    if (--batchDepth === 0) {
      const run = [...queued];
      queued.clear();
      for (const eff of run) eff.run();
    }
  }
}

// Drop this effect from every signal it was subscribed to, and forget them, so
// the next run (or a dispose) starts from a clean dependency set.
function cleanup(eff) {
  for (const subs of eff.deps) subs.delete(eff);
  eff.deps.clear();
}
