// The one canonical deterministic JSON encoder (#280 "Canonical output
// ordering") used for export, persistence snapshots, hashing input, equality
// checks, and snapshot tests. Rules:
//   - arrays retain semantic order;
//   - schema-defined objects use one documented canonical field order (the
//     shape tables below mirror the schemas' x-altinity-order annotations);
//   - map-like keys (layout.items, variant names, column maps) sort
//     lexicographically by code unit;
//   - open config/extension objects (and any field without a declared shape)
//     are recursively key-sorted.
// Output formatting matches `JSON.stringify(value, null, 2)` byte for byte,
// but object key traversal is explicit, so integer-like map keys can never
// fall into JavaScript's numeric-first property order. Pure.

/** Canonical ordering description for one JSON node. `order` lists the
 *  schema-defined field order (unknown extras follow, key-sorted); `fields`
 *  names known fields' shapes; `map` marks a map-like object whose keys sort
 *  lexicographically and whose every value shares one shape; `items` shapes
 *  array elements. A node without a shape is open: recursively key-sorted. */
export interface CanonicalShape {
  readonly order?: readonly string[];
  readonly fields?: Readonly<Record<string, CanonicalShape>>;
  readonly map?: CanonicalShape;
  readonly items?: CanonicalShape;
}

function orderedKeys(value: Record<string, unknown>, shape?: CanonicalShape): string[] {
  const keys = Object.keys(value);
  if (shape?.order) {
    const declared = new Set<string>(shape.order);
    return [
      ...shape.order.filter((key) => Object.hasOwn(value, key)),
      ...keys.filter((key) => !declared.has(key)).sort(),
    ];
  }
  return keys.sort();
}

function encodeValue(value: unknown, shape: CanonicalShape | undefined, pad: string): string | undefined {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return JSON.stringify(value);
  if (kind !== 'object') return undefined; // undefined/function/symbol — mirror JSON.stringify
  const inner = pad + '  ';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const parts = value.map((item) => encodeValue(item, shape?.items, inner) ?? 'null');
    return `[\n${inner}${parts.join(`,\n${inner}`)}\n${pad}]`;
  }
  const object = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of orderedKeys(object, shape)) {
    const encoded = encodeValue(object[key], shape?.map ?? shape?.fields?.[key], inner);
    if (encoded !== undefined) parts.push(`${JSON.stringify(key)}: ${encoded}`);
  }
  return parts.length ? `{\n${inner}${parts.join(`,\n${inner}`)}\n${pad}}` : '{}';
}

/** Deterministically encode a JSON value. Throws only for a non-JSON root
 *  (undefined/function); non-JSON members are skipped like JSON.stringify. */
export function canonicalJson(value: unknown, shape?: CanonicalShape): string {
  const encoded = encodeValue(value, shape, '');
  if (encoded === undefined) throw new Error('Cannot canonically encode a non-JSON root value');
  return encoded;
}

/** Canonical equality: equal exactly when the canonical encodings match. */
export function canonicalEqual(a: unknown, b: unknown, shape?: CanonicalShape): boolean {
  return canonicalJson(a, shape) === canonicalJson(b, shape);
}

// --- Documented canonical field orders -------------------------------------
// These tables mirror the schemas' x-altinity-order annotations (the schema
// files are the source of truth; change both together). Style objects,
// presentation patches, layout config, and filter default values are open
// documents and stay recursively key-sorted.

const FIELD_CONFIG_VALUE_SHAPE: CanonicalShape = {
  order: ['displayName', 'description', 'unit', 'decimals', 'color', 'noValue', 'hidden', 'delta'],
  fields: { delta: { order: ['displayName', 'unit', 'decimals', 'positiveIsGood', 'show'] } },
};

const PANEL_SHAPE: CanonicalShape = {
  order: ['cfg', 'key', 'fieldConfig'],
  fields: {
    cfg: { order: ['type', 'style', 'x', 'y', 'series'] },
    fieldConfig: {
      order: ['defaults', 'columns'],
      fields: {
        defaults: FIELD_CONFIG_VALUE_SHAPE,
        columns: { map: FIELD_CONFIG_VALUE_SHAPE },
      },
    },
  },
};

export const QUERY_SPEC_SHAPE: CanonicalShape = {
  order: ['name', 'description', 'favorite', 'view', 'panel', 'dashboard', 'timeRanges'],
  fields: {
    panel: PANEL_SHAPE,
    dashboard: {
      order: ['role', 'defaultVariant', 'variants', 'sizeHints'],
      fields: {
        variants: { map: {} },
        sizeHints: { order: ['preferred', 'minimum', 'aspectRatio'] },
      },
    },
    timeRanges: { items: { order: ['from', 'to'] } },
  },
};

export const SAVED_QUERY_SHAPE: CanonicalShape = {
  order: ['id', 'sql', 'specVersion', 'spec'],
  fields: { spec: QUERY_SPEC_SHAPE },
};

const FLOW_PLACEMENT_SHAPE: CanonicalShape = { order: ['span', 'height'] };

export const FLOW_LAYOUT_SHAPE: CanonicalShape = {
  order: ['type', 'version', 'preset', 'items'],
  fields: { items: { map: FLOW_PLACEMENT_SHAPE } },
};

// Generic layout placements share the flow placement order so one placement
// object encodes identically as a primary flow@1 item and as a fallback item;
// a non-flow engine's placement fields simply fall through to key sorting.
const LAYOUT_DOCUMENT_SHAPE: CanonicalShape = {
  order: ['type', 'version', 'preset', 'config', 'items', 'fallback'],
  fields: {
    items: { map: FLOW_PLACEMENT_SHAPE },
    fallback: FLOW_LAYOUT_SHAPE,
  },
};

export const DASHBOARD_DOCUMENT_SHAPE: CanonicalShape = {
  order: ['documentVersion', 'id', 'title', 'description', 'revision', 'layout', 'filters', 'tiles'],
  fields: {
    layout: LAYOUT_DOCUMENT_SHAPE,
    filters: { items: { order: ['id', 'parameter', 'label', 'sourceQueryId', 'targets', 'defaultValue', 'defaultActive'] } },
    tiles: { items: { order: ['id', 'queryId', 'title', 'description', 'presentation'], fields: { presentation: { order: ['variant', 'override'] } } } },
  },
};

export const STORED_WORKSPACE_SHAPE: CanonicalShape = {
  order: ['storageVersion', 'id', 'name', 'queries', 'dashboard'],
  fields: {
    queries: { items: SAVED_QUERY_SHAPE },
    dashboard: DASHBOARD_DOCUMENT_SHAPE,
  },
};

export const PORTABLE_BUNDLE_SHAPE: CanonicalShape = {
  order: ['$schema', 'format', 'version', 'exportedAt', 'metadata', 'queries', 'dashboards'],
  fields: {
    metadata: { order: ['name', 'description'] },
    queries: { items: SAVED_QUERY_SHAPE },
    dashboards: { items: DASHBOARD_DOCUMENT_SHAPE },
  },
};
