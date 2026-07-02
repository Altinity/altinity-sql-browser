// Shared "starting/loading" placeholder: a muted message with a spinning
// Icon. Extracted once a third caller appeared (results.js's streaming +
// schema-graph placeholders, schema-detail.js's table-detail fetch) — see
// CLAUDE.md rule 5 (a second+ consumer of a UI pattern extracts a shared
// primitive rather than copying it).
import { h } from './dom.js';
import { Icon } from './icons.js';

// `onCancel`, when given, adds a Cancel button (mirrors the `.exp-cancel`
// button in results.js's export progress banner) — used by the schema-graph
// drawer's pre-Phase-A loading state (#124), where there's nothing on screen
// yet to keep the graph's own toolbar Cancel visible instead.
export function loadingPlaceholder(msg, onCancel) {
  return h('div', { class: 'placeholder starting' },
    h('span', { class: 'spin' }, Icon.spinner()),
    h('div', null, msg),
    onCancel ? h('button', { class: 'exp-cancel', title: 'Cancel', onclick: onCancel }, Icon.close(), h('span', null, 'Cancel')) : null);
}
