import { BUNDLE_SCHEMA_ID } from './schema-manifest.mjs';

const keyFor = (schema) => `${schema['x-altinity-kind']}-v${schema['x-altinity-version']}`;

export function buildSchemaCatalog(records) {
  return {
    format: 'altinity-sql-browser/schema-catalog',
    version: 1,
    schemas: records.map(({ schema, relativePath, bundle }) => ({
      kind: schema['x-altinity-kind'],
      version: schema['x-altinity-version'],
      id: schema.$id,
      path: '../' + relativePath.split('/').at(-1),
      ...(bundle ? { bundlePath: 'library-v2.bundle.schema.json' } : {}),
    })),
  };
}

export function buildLibraryBundle(records) {
  const library = records.find((record) => record.bundle);
  if (!library) throw new Error('Schema manifest has no Library bundle root');
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: BUNDLE_SCHEMA_ID,
    $ref: library.schema.$id,
    $defs: Object.fromEntries(records.map(({ schema }) => [keyFor(schema), schema])),
  };
}
