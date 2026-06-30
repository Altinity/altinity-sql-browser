// Shared "starting/loading" placeholder: a muted message with a spinning
// Icon. Extracted once a third caller appeared (results.js's streaming +
// schema-graph placeholders, schema-detail.js's table-detail fetch) — see
// CLAUDE.md rule 5 (a second+ consumer of a UI pattern extracts a shared
// primitive rather than copying it).
import { h } from './dom.js';
import { Icon } from './icons.js';

export function loadingPlaceholder(msg) {
  return h('div', { class: 'placeholder starting' },
    h('span', { class: 'spin' }, Icon.spinner()),
    h('div', null, msg));
}
