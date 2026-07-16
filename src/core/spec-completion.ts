// Pure schema-driven completion for query.spec. CodeMirror, DOM, app state,
// persistence, and network behavior are deliberately outside this module.

/** One JSON path segment: an object key or an array index. */
export type PathSegment = string | number;

/** A JSON Schema fragment as `spec-schema.js`'s service hands it back —
 *  loosely typed (it's schema data, not a validated shape): known
 *  authoring/annotation fields are named, everything else (the `x-altinity-*`
 *  annotations) flows through the index signature. */
export interface SchemaFragment {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  default?: unknown;
  examples?: unknown[];
  title?: string;
  description?: string;
  properties?: Record<string, SchemaFragment>;
  required?: string[];
  [key: string]: unknown;
}

/** `schemaAtPath`'s result: the merged (`common`) schema at a path plus every
 *  discriminated branch (`candidates`) still in play there. */
export interface SchemaEnvelope {
  common: SchemaFragment;
  candidates: SchemaFragment[];
}

/** One property `propertiesAtPath` reports for an object schema. */
export interface SchemaProperty {
  name: string;
  required: boolean;
  schemas: SchemaFragment[];
}

/** One finite discriminator value `variantsAtPath` reports, with its owning
 *  branch's presentation annotations attached. */
export interface SchemaVariant {
  value: unknown;
  schema: SchemaFragment;
  title?: string;
  description?: string;
  status?: string;
  deprecated?: boolean;
  snippet?: unknown;
  order: number;
}

/** The subset of `core/spec-schema.js`'s service this module calls —
 *  defined locally since that module stays untyped `.js`. */
export interface SchemaService {
  schemaAtPath(args: { root: unknown; path: PathSegment[] }): SchemaEnvelope;
  propertiesAtPath(args: { root: unknown; path: PathSegment[] }): SchemaProperty[];
  variantsAtPath?(args: { root: unknown; path: PathSegment[] }): SchemaVariant[];
}

/** One item a `dynamicSources` provider returns (`resultColumns`,
 *  `queryParameters`, … — see `spec-completion-adapter.js`). */
export interface DynamicItem {
  label?: string;
  value?: unknown;
  kind?: string;
  detail?: string;
  documentation?: string;
}

/** A `dynamicSources` provider: reads already-cached app state, never fetches. */
export type DynamicProvider = (args: {
  context: unknown;
  path: PathSegment[];
  positionKind: string;
  schema: SchemaFragment;
  annotation: CompletionSourceSpec | undefined;
}) => DynamicItem[] | undefined;

/** The `dynamicSources` bag `completeSpec` is called with (`app.specCompletionSources`). */
export type DynamicSources = Record<string, DynamicProvider>;

/** An `x-altinity-key-completion` / `x-altinity-completion` schema annotation. */
export interface CompletionSourceSpec {
  source?: string;
  [key: string]: unknown;
}

/** How the adapter applies an accepted completion — either splice in a
 *  `"name": value` property, or replace a whole (single-property) object with
 *  a schema snippet. */
export type CompletionApply =
  | { type: 'property'; name: string; value: string; caretBack: number }
  | { type: 'object-snippet'; value: unknown; range: { from: number; to: number } };

/** One ranked completion candidate `completeSpec` returns. */
export interface CompletionItem {
  label: string;
  insert: string;
  kind: string;
  detail?: string;
  documentation?: string;
  value?: unknown;
  category?: number;
  sourceOrder?: number;
  dynamic?: boolean;
  required?: boolean;
  order?: number;
  apply?: CompletionApply;
  deprecated?: boolean;
  status?: string;
}

/** `completeSpec`'s params — the cursor context (see `spec-json-context.js`)
 *  plus the schema service and dynamic-source bag. */
export interface CompleteSpecArgs {
  schemaService?: SchemaService | null;
  rootValue: unknown;
  path: PathSegment[];
  positionKind: string;
  partial?: string;
  existingKeys?: string[];
  existingItems?: unknown[];
  explicit?: boolean;
  dynamicSources?: DynamicSources;
  context?: unknown;
}

/** The subset of the cursor `context` this module itself reads (the rest just
 *  flows through to `dynamicSources` providers, opaque to this module). */
interface SpecCompletionContext {
  objectIsSingleProperty?: boolean;
  objectClosed?: boolean;
  objectRange?: { from: number; to: number };
}

/** `docFor`'s extra (non-schema-derived) presentation fields. */
interface DocExtra {
  title?: string;
  description?: string;
  status?: string;
}

const own = (value: Record<string, unknown> | null | undefined, key: string): boolean => !!value && Object.hasOwn(value, key);
function asArray<T>(value: T | T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}
const encoded = (value: unknown): string => JSON.stringify(value);
const labelFor = (value: unknown): string => (typeof value === 'string' ? value : encoded(value));

function schemaTypes(schemas: SchemaFragment[]): string[] {
  const out: string[] = [];
  for (const schema of schemas) {
    for (const type of asArray(schema.type)) if (!out.includes(type)) out.push(type);
    if (own(schema, 'const')) {
      const value = schema.const;
      const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      if (!out.includes(type)) out.push(type);
    }
  }
  return out;
}

function typeLabel(schemas: SchemaFragment[]): string {
  const types = schemaTypes(schemas);
  return types.length ? types.join(' | ') : 'JSON value';
}

function documentation(schema: SchemaFragment, extra: DocExtra = {}): string {
  const lines: string[] = [];
  if (extra.title || schema.title) lines.push((extra.title || schema.title)!);
  if (extra.description || schema.description) lines.push((extra.description || schema.description)!);
  if (own(schema, 'default')) lines.push(`Default: ${encoded(schema.default)}`);
  if (Array.isArray(schema.examples) && schema.examples.length) {
    lines.push(`Examples: ${schema.examples.map(encoded).join(', ')}`);
  }
  if (extra.status) lines.push(`Status: ${extra.status}`);
  if (extra.status === 'planned') lines.push('This build may preserve this configuration without rendering it.');
  return lines.filter(Boolean).join('\n');
}

function propertySkeleton(schemas: SchemaFragment[]): { text: string; caretBack: number } | null {
  const types = schemaTypes(schemas);
  if (types.includes('string')) return { text: '""', caretBack: 1 };
  if (types.includes('boolean')) return { text: 'false', caretBack: 0 };
  if (types.includes('object')) return { text: '{}', caretBack: 1 };
  if (types.includes('array')) return { text: '[]', caretBack: 1 };
  if (types.includes('null')) return { text: 'null', caretBack: 0 };
  // A bare numeric type has no syntactically valid neutral skeleton. Use only
  // a schema-owned default/example; otherwise the property is not safely
  // insertable and the caller omits it from completion.
  if (types.includes('integer') || types.includes('number')) {
    const owner = schemas.find((schema) => own(schema, 'default'))
      || schemas.find((schema) => Array.isArray(schema.examples) && schema.examples.length);
    if (!owner) return null;
    return { text: encoded(own(owner, 'default') ? owner.default : owner.examples![0]), caretBack: 0 };
  }
  return { text: '{}', caretBack: 1 };
}

function annotation(envelope: SchemaEnvelope, key: string): unknown {
  return envelope.common[key];
}

function dynamicItems({ dynamicSources, sourceSpec, context, path, positionKind, schema }: {
  dynamicSources?: DynamicSources;
  sourceSpec?: CompletionSourceSpec;
  context: unknown;
  path: PathSegment[];
  positionKind: string;
  schema: SchemaFragment;
}): CompletionItem[] {
  const source = sourceSpec?.source;
  const provider = source && dynamicSources?.[source];
  if (typeof provider !== 'function') return [];
  const produced = provider({ context, path: [...path], positionKind, schema, annotation: sourceSpec }) || [];
  return produced.map((item, index) => ({
    label: String(item.label ?? item.value),
    insert: encoded(item.value ?? item.label),
    kind: item.kind || 'string',
    detail: item.detail,
    documentation: item.documentation,
    value: item.value ?? item.label,
    category: 40,
    sourceOrder: index,
    dynamic: true,
  }));
}

function finiteValueItems(schemas: SchemaFragment[]): { items: CompletionItem[]; seen: Set<string> } {
  const out: CompletionItem[] = [];
  const seen = new Set<string>();
  const add = (value: unknown, schema: SchemaFragment, kind: string, category: number) => {
    const key = encoded(value);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      label: labelFor(value), insert: key, value, kind, category,
      detail: typeLabel([schema]), documentation: documentation(schema),
    });
  };
  for (const schema of schemas) {
    if (own(schema, 'const')) add(schema.const, schema, 'constant', 20);
    for (const value of schema.enum || []) add(value, schema, 'enum', 22);
  }
  return { items: out, seen };
}

function defaultAndExampleItems(schemas: SchemaFragment[], seen: Set<string>): CompletionItem[] {
  const out: CompletionItem[] = [];
  const add = (value: unknown, schema: SchemaFragment, kind: string, category: number) => {
    const key = encoded(value);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      label: labelFor(value), insert: key, value, kind, category,
      detail: `${typeLabel([schema])} · ${kind}`, documentation: documentation(schema),
    });
  };
  for (const schema of schemas) {
    if (own(schema, 'default')) add(schema.default, schema, 'default', 50);
    for (const value of schema.examples || []) add(value, schema, 'example', 60);
  }
  return out;
}

function primitiveItems(schemas: SchemaFragment[], seen: Set<string>, hasMeaningful: boolean): CompletionItem[] {
  const out: CompletionItem[] = [];
  const types = schemaTypes(schemas);
  const add = (value: unknown, kind: string, category = 30) => {
    const key = encoded(value);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label: labelFor(value), insert: key, value, kind, category, detail: kind });
  };
  if (types.includes('boolean')) { add(true, 'boolean'); add(false, 'boolean'); }
  if (types.includes('null')) add(null, 'null', 35);
  if (!hasMeaningful) {
    if (types.includes('string')) add('', 'string', 70);
    if (types.includes('object')) add({}, 'object', 70);
    if (types.includes('array')) add([], 'array', 70);
  }
  return out;
}

function rank(items: CompletionItem[], partial: unknown): CompletionItem[] {
  const prefix = String(partial || '').toLocaleLowerCase();
  return items
    .filter((item) => !prefix || item.label.toLocaleLowerCase().startsWith(prefix))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const exactA = prefix && a.item.label.toLocaleLowerCase() === prefix ? 0 : 1;
      const exactB = prefix && b.item.label.toLocaleLowerCase() === prefix ? 0 : 1;
      return exactA - exactB
        || (a.item.deprecated ? 1 : 0) - (b.item.deprecated ? 1 : 0)
        || (a.item.status === 'planned' ? 1 : 0) - (b.item.status === 'planned' ? 1 : 0)
        || (a.item.category ?? 30) - (b.item.category ?? 30)
        || (a.item.order ?? a.item.sourceOrder ?? a.index) - (b.item.order ?? b.item.sourceOrder ?? b.index)
        || a.item.label.localeCompare(b.item.label)
        || a.index - b.index;
    })
    .map(({ item }) => {
      const { category: _category, sourceOrder: _sourceOrder, ...publicItem } = item;
      return publicItem;
    });
}

/** `completeSpec`'s params once `schemaService` has been confirmed non-null. */
interface ResolvedArgs extends Omit<CompleteSpecArgs, 'schemaService'> {
  schemaService: SchemaService;
}

function propertyItems(args: ResolvedArgs): CompletionItem[] {
  const {
    schemaService, rootValue, path, existingKeys = [], dynamicSources, context,
  } = args;
  const envelope = schemaService.schemaAtPath({ root: rootValue, path });
  const all = schemaService.propertiesAtPath({ root: rootValue, path });
  const discriminator = envelope.common['x-altinity-discriminator'];
  const allowed = envelope.candidates.length > 1
    ? new Set([discriminator, ...Object.keys(envelope.common.properties || {})].filter(Boolean))
    : null;
  const existing = new Set(existingKeys);
  const items = all.filter((property) => (!allowed || allowed.has(property.name)) && !existing.has(property.name))
    .flatMap((property, order) => {
      const schema = property.schemas[0] || {};
      const skeleton = propertySkeleton(property.schemas);
      if (!skeleton) return [];
      return [{
        label: property.name,
        insert: JSON.stringify(property.name),
        kind: 'property',
        detail: `${typeLabel(property.schemas)}${property.required ? ' · required' : ''}`,
        documentation: documentation(schema),
        required: property.required,
        order,
        category: property.name === discriminator ? 0 : property.required ? 5 : 10,
        apply: { type: 'property' as const, name: property.name, value: skeleton.text, caretBack: skeleton.caretBack },
      }];
    });

  const keySource = annotation(envelope, 'x-altinity-key-completion');
  const dynamic = dynamicItems({
    dynamicSources, sourceSpec: keySource as CompletionSourceSpec | undefined, context, path, positionKind: 'property-name', schema: envelope.common,
  }).filter((item) => !existing.has(String(item.value))).map((item): CompletionItem | null => {
    const child = schemaService.schemaAtPath({ root: rootValue, path: [...path, String(item.value)] });
    const skeleton = propertySkeleton(child.candidates.length ? child.candidates : [child.common]);
    if (!skeleton) return null;
    return {
      ...item,
      kind: item.kind || 'column',
      apply: { type: 'property' as const, name: String(item.value), value: skeleton.text, caretBack: skeleton.caretBack },
    };
  }).filter((item): item is CompletionItem => item !== null);
  return [...items, ...dynamic];
}

function valueItems(args: ResolvedArgs): CompletionItem[] {
  const {
    schemaService, rootValue, path, existingItems = [], dynamicSources, context,
  } = args;
  const envelope = schemaService.schemaAtPath({ root: rootValue, path });
  const schemas = envelope.candidates.length ? envelope.candidates : [envelope.common].filter((item) => Object.keys(item).length);
  if (!schemas.length) return [];
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const ctx = context as SpecCompletionContext | undefined;

  for (const variant of schemaService.variantsAtPath?.({ root: rootValue, path }) || []) {
    const key = encoded(variant.value);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      label: labelFor(variant.value), insert: key, value: variant.value,
      kind: 'variant', detail: `${variant.title || 'panel type'}${variant.status ? ` · ${variant.status}` : ''}`,
      documentation: documentation(variant.schema, variant), status: variant.status,
      deprecated: variant.deprecated, order: variant.order,
      category: variant.deprecated ? 95 : variant.status === 'planned' ? 90 : 10,
    });
    if (variant.snippet && ctx?.objectIsSingleProperty && ctx.objectClosed && ctx.objectRange) {
      items.push({
        label: `${variant.title || labelFor(variant.value)} skeleton`,
        insert: encoded(variant.snippet), kind: 'snippet', detail: 'schema snippet',
        documentation: documentation(variant.schema, variant), status: variant.status,
        deprecated: variant.deprecated, order: variant.order,
        category: variant.deprecated ? 98 : variant.status === 'planned' ? 94 : 80,
        apply: { type: 'object-snippet' as const, value: variant.snippet, range: ctx.objectRange },
      });
    }
  }

  const finite = finiteValueItems(schemas);
  for (const item of finite.items) if (!seen.has(encoded(item.value))) { seen.add(encoded(item.value)); items.push(item); }
  const sourceSpec = annotation(envelope, 'x-altinity-completion');
  const dynamic = dynamicItems({
    dynamicSources, sourceSpec: sourceSpec as CompletionSourceSpec | undefined, context, path, positionKind: args.positionKind, schema: envelope.common,
  }).filter((item) => !seen.has(encoded(item.value)) && !existingItems.some((value) => Object.is(value, item.value)));
  for (const item of dynamic) { seen.add(encoded(item.value)); items.push(item); }
  items.push(...defaultAndExampleItems(schemas, seen));
  items.push(...primitiveItems(schemas, seen, items.length > 0 || !!sourceSpec));
  return items;
}

/** Return normalized, deterministically ranked completion items. */
export function completeSpec(args?: CompleteSpecArgs): CompletionItem[] {
  if (!args?.schemaService || typeof args.schemaService.schemaAtPath !== 'function') return [];
  if (!['property-name', 'property-value', 'array-item'].includes(args.positionKind)) return [];
  const schemaService = args.schemaService;
  const items = args.positionKind === 'property-name'
    ? propertyItems({ ...args, schemaService })
    : valueItems({ ...args, schemaService });
  return rank(items, args.partial);
}
