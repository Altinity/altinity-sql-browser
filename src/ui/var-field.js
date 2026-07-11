// Shared invalid-field affordance for `{name:Type}` variable inputs (#170):
// both the workbench var-strip (app.js) and the Dashboard's global filter bar
// (dashboard.js) render one `<input class="var-input">` per declared variable
// and need to reflect its validated field state (param-pipeline's per-param
// rollup — `{state, reason?}` from `prepareParameterizedBatch(...).fields`)
// onto that exact DOM node. `applyFieldState` is the shared primitive so a
// second consumer (#169's relative-date fields, which reuse this same
// affordance per its spec) doesn't get a copy-pasted version.
//
// Only `state === 'invalid'` gets a visible affordance: `missing`/`inactive`
// already have their own established treatment (the unfilled Run-button
// tooltip / dashboard tile placeholder — no per-field marking), and
// `incomplete` is deliberately neutral while the field is focused (#170) — it
// only becomes visible once it hardens into `invalid` on blur/Enter/execute.
// `baseTitle` is the field's normal (non-error) tooltip text — the name/type/
// optional-affordance hover text the strip already shows — restored once the
// field is corrected.
//
// `descEl` (#174 §1 review finding #4) is the optional inline element that
// already carries the field's error/preview text for screen-reader users —
// today that's `relative-time-field.js`'s `previewEl` (passed by both the
// workbench var-strip and the dashboard filter bar, the two callers that
// build fields through it); a plain scalar `<input>` has no such element and
// is called without one, so it keeps today's title-only affordance. This
// function never writes `descEl`'s text — that stays owned by whichever
// caller already fills it (`updatePreview` in relative-time-field.js) — it
// only wires/unwires `aria-describedby` to reflect whether there's currently
// something in it to describe.

/**
 * @param {HTMLInputElement} input
 * @param {{state: string, reason?: string}|undefined} field
 * @param {string} baseTitle
 * @param {HTMLElement} [descEl]
 */
export function applyFieldState(input, field, baseTitle, descEl) {
  const invalid = !!field && field.state === 'invalid';
  input.classList.toggle('is-invalid', invalid);
  if (invalid) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  input.title = invalid && field.reason ? field.reason : baseTitle;
  if (descEl) {
    if (descEl.textContent) input.setAttribute('aria-describedby', descEl.id);
    else input.removeAttribute('aria-describedby');
  }
}
