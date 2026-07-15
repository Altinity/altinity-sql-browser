import { h } from './dom.js';
import { buildFilterOptionField } from './filter-option-field.js';

const message = (text, cls = '') => h('div', { class: `filter-preview-message ${cls}`.trim() }, text);

export function renderFilterPreview(app) {
  const preview = app.activeTab().filterPreview;
  if (!preview) return message('Run the query to preview Filter options.');
  if (preview.status === 'running') return message('Filter preview appears when the query completes.');
  if (preview.status === 'error') return message(preview.error || 'Filter options failed.', 'is-error');
  const out = h('div', { class: 'filter-preview' });
  for (const helper of preview.normalized.helpers) {
    let localValue = '';
    let localActive = false;
    const field = buildFilterOptionField({
      document: app.document, name: helper.name, options: helper.options,
      value: localValue, active: localActive, inactiveLabel: 'All', preview: true,
      onValueChange: (value, active) => { localValue = value; localActive = active; },
    });
    out.appendChild(h('section', { class: 'filter-preview-helper' },
      h('div', { class: 'filter-preview-head' },
        h('strong', null, helper.name),
        h('span', null, `${helper.totalOptions.toLocaleString()} options`)),
      h('div', { class: 'filter-preview-type' }, helper.sourceType),
      helper.truncated ? h('div', { class: 'filter-preview-note' }, `Showing first ${helper.options.length.toLocaleString()} options`) : null,
      field.el));
  }
  for (const diagnostic of preview.normalized.diagnostics) {
    out.appendChild(h('div', { class: `filter-preview-diagnostic is-${diagnostic.severity}` }, diagnostic.message));
  }
  return out.childNodes.length ? out : message('No options');
}
