// Schema-derived Spec completion.  This module is deliberately pure: it has
// no CodeMirror, DOM, state, or network dependency.

const own = (value, key) => !!value && Object.hasOwn(value, key);
const unique = (values) => [...new Set(values)];
const annotations = (envelope) => [envelope.common || {}, ...(envelope.candidates || [])];
const schemaTypes = (schema) => Array.isArray(schema.type) ? schema.type : [schema.type].filter(Boolean);
const literal = JSON.stringify;

function documentation(schema = {}) {
  const parts = [schema.description].filter(Boolean);
  if (own(schema, 'default')) parts.push(`Default: ${literal(schema.default)}`);
  if (schema.examples?.length) parts.push(`Example: ${literal(schema.examples[0])}`);
  return parts.join('\n\n') || undefined;
}

function valueForProperty(name, schemas) {
  const schema = schemas[0] || {};
  if (own(schema, 'x-altinity-snippet')) return literal(schema['x-altinity-snippet']);
  if (own(schema, 'default')) return literal(schema.default);
  if (own(schema, 'const')) return literal(schema.const);
  if (schema.enum?.length) return literal(schema.enum[0]);
  if (schemaTypes(schema).includes('boolean')) return 'false';
  if (schemaTypes(schema).includes('array')) return '[]';
  if (schemaTypes(schema).includes('object')) return '{}';
  if (schemaTypes(schema).includes('string')) return '""';
  return 'null';
}

function filter(items, partial) {
  const needle = String(partial || '').toLowerCase();
  return items.filter((item) => !needle || item.label.toLowerCase().includes(needle));
}

function stable(items) {
  return items.map((item, index) => ({ ...item, _index: index }))
    .sort((a, b) => (b.boost || 0) - (a.boost || 0) || a._index - b._index)
    .map(({ _index, ...item }) => item);
}

function sourceNames(envelope, key) {
  return unique(annotations(envelope).map((item) => item[key]?.source).filter(Boolean));
}

function dynamicItems(names, dynamicSources, context, asKey = false) {
  const items = [];
  for (const name of names) {
    try {
      const source = dynamicSources?.[name];
      const candidates = typeof source === 'function' ? source(context) : [];
      for (const candidate of candidates || []) {
        const value = own(candidate, 'value') ? candidate.value : candidate.label;
        const label = String(candidate.label ?? value);
        items.push({
          label,
          type: candidate.type || (name === 'queryParameters' ? 'parameter' : name.includes('Index') ? 'value' : 'column'),
          detail: candidate.detail,
          documentation: candidate.documentation,
          apply: asKey ? `${JSON.stringify(String(value))}: {}` : literal(value),
          boost: candidate.boost,
        });
      }
    } catch { /* Dynamic completion must fail soft. */ }
  }
  return items;
}

function typeCandidates(schemaService, rootValue, path) {
  const parent = schemaService.schemaAtPath({ root: rootValue, path: path.slice(0, -1) });
  const choices = [];
  for (const candidate of parent.candidates || []) {
    const prop = candidate.properties?.type;
    if (!prop || !own(prop, 'const')) continue;
    if (candidate['x-altinity-status'] && candidate['x-altinity-status'] !== 'implemented') continue;
    choices.push({
      label: String(prop.const), type: 'enum', detail: candidate.title,
      documentation: documentation(candidate), apply: literal(prop.const), boost: 40,
    });
  }
  return choices;
}

/** Return normalized completion candidates for a JSON path/context. */
export function completeSpec({ schemaService, rootValue = {}, path = [], positionKind, partial = '', existingKeys = [], dynamicSources = {} }) {
  if (!schemaService || !positionKind) return [];
  const context = { rootValue, path, positionKind, partial, existingKeys };
  let items = [];
  if (positionKind === 'property-name') {
    const envelope = schemaService.schemaAtPath({ root: rootValue, path });
    const order = annotations(envelope).flatMap((schema) => schema['x-altinity-order'] || []);
    const discriminator = annotations(envelope).map((schema) => schema['x-altinity-discriminator']).find(Boolean);
    items = schemaService.propertiesAtPath({ root: rootValue, path })
      .filter((property) => !existingKeys.includes(property.name))
      .map((property) => {
        const schema = property.schemas[0] || {};
        const orderBoost = order.length ? Math.max(0, 20 - order.indexOf(property.name)) : 0;
        return {
          label: property.name, type: 'property', detail: schema.title || schemaTypes(schema).join(' | ') || undefined,
          documentation: documentation(schema),
          apply: `${JSON.stringify(property.name)}: ${valueForProperty(property.name, property.schemas)}`,
          boost: (property.required ? 100 : 0) + (property.name === discriminator ? 80 : 0) + orderBoost,
          deprecated: !!schema['x-altinity-deprecated'],
        };
      });
    items.push(...dynamicItems(sourceNames(envelope, 'x-altinity-key-completion'), dynamicSources, context, true)
      .filter((item) => !existingKeys.includes(item.label)));
  } else {
    const envelope = schemaService.schemaAtPath({ root: rootValue, path });
    const schemas = annotations(envelope);
    if (path.at(-1) === 'type') items.push(...typeCandidates(schemaService, rootValue, path));
    for (const schema of schemas) {
      if (own(schema, 'const')) items.push({ label: String(schema.const), type: 'enum', detail: schema.title, documentation: documentation(schema), apply: literal(schema.const), boost: 50 });
      for (const value of schema.enum || []) items.push({ label: String(value), type: 'enum', detail: schema.title, documentation: documentation(schema), apply: literal(value), boost: 30 });
      if (schemaTypes(schema).includes('boolean')) {
        for (const value of [true, false]) items.push({ label: String(value), type: 'value', documentation: documentation(schema), apply: literal(value) });
      }
      if (schemaTypes(schema).includes('null')) items.push({ label: 'null', type: 'value', documentation: documentation(schema), apply: 'null' });
      if (own(schema, 'default')) items.push({ label: String(schema.default), type: 'value', detail: 'default', documentation: documentation(schema), apply: literal(schema.default), boost: 10 });
      for (const value of schema.examples || []) items.push({ label: String(value), type: 'value', detail: 'example', documentation: documentation(schema), apply: literal(value) });
      if (schemaTypes(schema).includes('object') && schema['x-altinity-snippet']) items.push({ label: schema.title || 'Object', type: 'object', documentation: documentation(schema), apply: literal(schema['x-altinity-snippet']) });
      if (schemaTypes(schema).includes('array')) items.push({ label: '[]', type: 'array', apply: '[]' });
    }
    items.push(...dynamicItems(sourceNames(envelope, 'x-altinity-completion'), dynamicSources, context));
  }
  const seen = new Set();
  return stable(filter(items, partial).filter((item) => {
    const key = `${item.label}\0${item.apply}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}
