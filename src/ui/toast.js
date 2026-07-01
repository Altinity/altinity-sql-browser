// Transient toast notification. `flashToast` is injectable over a document +
// timer so it can be tested deterministically.

export function flashToast(text, opts = {}) {
  const doc = opts.document || document;
  const setTimer = opts.setTimeout || setTimeout;
  const clearTimer = opts.clearTimeout || clearTimeout;
  const duration = opts.duration ?? 1600;

  let el = doc.querySelector('.share-toast');
  if (!el) {
    el = doc.createElement('div');
    el.className = 'share-toast';
    doc.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  // Timer lives on the element (not the function) so a toast in one document
  // (e.g. a detached tab's own window) can't clear or clobber a pending timer
  // that belongs to a toast in a different document's realm.
  if (el._timer) clearTimer(el._timer);
  el._timer = setTimer(() => { el._timer = null; el.classList.remove('show'); }, duration);
  // Click to dismiss early / reread — rebound each call so it always clears
  // *this* call's timer (the element is reused across calls, opts may differ).
  el.onclick = () => {
    if (el._timer) { clearTimer(el._timer); el._timer = null; }
    el.classList.remove('show');
  };
  return el;
}
