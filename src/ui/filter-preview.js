import { h } from './dom.js';
import { buildFilterOptionField } from './filter-option-field.js';

const message = (text, cls = '') => h('div', { class: `filter-preview-message ${cls}`.trim() }, text);

// The Filter drawer preview: a read-only description of the option bundles a
// Filter source produces, laid out with the SAME grid classes as the Table view
// (`.res-table`) so it reads as a consistent result view rather than a bespoke
// panel. One row per helper — `name · options · type · example` — where the
// `example` cell hosts a live (local-only) combobox so the shape can be tried
// out without touching shared Dashboard filter state. The interactive control
// is `buildFilterOptionField` in its `preview` mode (no clear × — this is a demo
// cell, not a live filter). The table is built by hand rather than via
// `renderGrid` because that renderer stringifies every cell and can't host the
// live element.
const HEADERS = ['name', 'options', 'type', 'example'];

export function renderFilterPreview(app) {
  const preview = app.activeTab().filterPreview;
  if (!preview) return message('Run the query to preview Filter options.');
  if (preview.status === 'running') return message('Filter preview appears when the query completes.');
  if (preview.status === 'error') return message(preview.error || 'Filter options failed.', 'is-error');
  const { helpers, diagnostics } = preview.normalized;
  const out = h('div', { class: 'filter-preview' });
  if (helpers.length) {
    const headRow = h('tr', null,
      h('th', { style: { textAlign: 'center', color: 'var(--fg-faint)', minWidth: '36px' } }, '#'),
      ...HEADERS.map((label) => h('th', null, h('div', { class: 'h-inner' }, h('span', { class: 'h-name' }, label)))));
    const tbody = h('tbody', null);
    helpers.forEach((helper, i) => {
      const field = buildFilterOptionField({
        document: app.document, name: helper.name, options: helper.options,
        inactiveLabel: 'All', preview: true, onValueChange: () => {},
      });
      tbody.appendChild(h('tr', null,
        h('td', { class: 'idx' }, String(i + 1)),
        h('td', { class: 'cell' }, h('div', { class: 'cell-val' }, helper.name)),
        h('td', { class: 'cell num' }, h('div', { class: 'cell-val' }, helper.totalOptions.toLocaleString())),
        h('td', { class: 'cell' }, h('div', { class: 'cell-val' }, helper.sourceType)),
        h('td', { class: 'cell filter-example' }, field.el)));
    });
    out.appendChild(h('div', { class: 'res-table-wrap' },
      h('table', { class: 'res-table' }, h('thead', null, headRow), tbody)));
  }
  for (const diagnostic of diagnostics) {
    out.appendChild(h('div', { class: `filter-preview-diagnostic is-${diagnostic.severity}` }, diagnostic.message));
  }
  return out.childNodes.length ? out : message('No options');
}
