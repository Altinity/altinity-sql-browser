// Transient toast notification. `flashToast` is injectable over a document +
// timer so it can be tested deterministically.

/** Injected seams: a real timer or a test double (`vi.fn`) — this ships to
 *  the browser only, so the timer id is the DOM lib's `number` (never Node's
 *  `NodeJS.Timeout`). */
export interface ToastOptions {
  document?: Document;
  setTimeout?: (handler: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
  duration?: number;
  /** #300: an optional recovery action rendered as a button inside the toast.
   *  When present, the toast does NOT auto-dismiss (the timer is skipped
   *  entirely) so the user has time to act; clicking the button runs
   *  `onClick` then dismisses. Absent, the toast behaves exactly as before
   *  (text-only, auto-dismisses after `duration`). */
  action?: { label: string; onClick: () => void };
}

/** The live toast element, with its own pending-timer id stashed on it (not
 *  on the function) — see the header comment on `_timer` below. */
interface ToastEl extends HTMLElement {
  _timer?: number | null;
}

export function flashToast(text: string, opts: ToastOptions = {}): HTMLElement {
  const doc = opts.document || document;
  // Explicitly typed to the injected-seam shape (rather than left to widen to
  // a union with the real global's own overload set) — the global timers'
  // signatures are still assignable through here (setTimeout's `number`
  // return narrows in; clearTimeout's `number | undefined` param widens out).
  const setTimer: (handler: () => void, ms: number) => number = opts.setTimeout || setTimeout;
  const clearTimer: (id: number) => void = opts.clearTimeout || clearTimeout;
  const duration = opts.duration ?? 1600;

  let el = doc.querySelector('.share-toast') as ToastEl | null;
  if (!el) {
    el = doc.createElement('div') as ToastEl;
    el.className = 'share-toast';
    doc.body.appendChild(el);
  }
  const toast = el;
  // Resets `textContent` (and so wipes any action button a previous call on
  // this reused element appended) before this call's own button, if any, is
  // (re-)appended below.
  toast.textContent = text;
  toast.classList.add('show');
  // Timer lives on the element (not the function) so a toast in one document
  // (e.g. a detached tab's own window) can't clear or clobber a pending timer
  // that belongs to a toast in a different document's realm.
  if (toast._timer) { clearTimer(toast._timer); toast._timer = null; }
  if (opts.action) {
    const { label, onClick } = opts.action;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'share-toast-action';
    button.textContent = label;
    // Stop propagation so the action doesn't also trigger the body's
    // click-to-dismiss handler (below) before `onClick` runs.
    button.onclick = (event) => {
      event.stopPropagation();
      toast.classList.remove('show');
      onClick();
    };
    toast.appendChild(button);
    // No auto-dismiss timer: an actionable toast waits for the user.
  } else {
    toast._timer = setTimer(() => { toast._timer = null; toast.classList.remove('show'); }, duration);
  }
  // Click to dismiss early / reread — rebound each call so it always clears
  // *this* call's timer (the element is reused across calls, opts may differ).
  toast.onclick = () => {
    if (toast._timer) { clearTimer(toast._timer); toast._timer = null; }
    toast.classList.remove('show');
  };
  return toast;
}
