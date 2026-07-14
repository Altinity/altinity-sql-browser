# Altinity SQL Browser Library JSON Schema

Altinity SQL Browser publishes Draft 2020-12 contracts for every persisted
layer of a Library file:

```text
Library v2                schemas/library-v2.schema.json
└── saved query v2        schemas/saved-query-v2.schema.json
    └── query Spec v1     schemas/query-spec-v1.schema.json
```

Use the modular files when your schema tool can register several resources.
Use
[`schemas/generated/library-v2.bundle.schema.json`](../schemas/generated/library-v2.bundle.schema.json)
when a tool needs one self-contained, offline resource. The generated
[`schema-catalog.json`](../schemas/generated/schema-catalog.json) lists the
canonical IDs, versions, source paths, and bundle entry point.

## Complete Library document

New exports have this shape:

```json
{
  "$schema": "https://altinity.com/schemas/altinity-sql-browser/library-v2.schema.json",
  "format": "altinity-sql-browser/saved-queries",
  "version": 2,
  "exportedAt": "2026-07-14T12:00:00.000Z",
  "queries": [
    {
      "id": "service-overview",
      "sql": "SELECT service, count() AS requests FROM events GROUP BY service",
      "specVersion": 1,
      "spec": {
        "name": "Service overview",
        "favorite": true,
        "view": "panel",
        "panel": { "cfg": { "type": "bar", "x": 0, "y": [1] } }
      }
    }
  ]
}
```

`format` and `version` identify the Library envelope. `specVersion` selects the
schema for each saved-query Presentation Spec independently. Library and
saved-query roots are closed: unknown application-managed fields are rejected
because the app cannot promise to preserve them. The designated open namespaces
inside `spec` remain forward compatible and preserve unknown JSON.

Query IDs must be nonblank and unique within a Library. The schemas validate an
individual ID; the codec enforces whole-Library uniqueness. A Library may
contain at most 1,000 queries.

## Timestamp compatibility

Every new export includes a valid RFC 3339 `exportedAt` timestamp. The canonical
v2 schema accepts older v2 files that omit it, because earlier importers allowed
that shape. The compatibility decoder exposes a missing timestamp as `null` in
decoded metadata and does not rewrite the source. Encoding a new Library without
a timestamp fails.

The instance `$schema` property is also optional for compatibility, but new
exports include it by default. It is a tooling hint only: the browser never
fetches a schema over the network.

## Validation and diagnostics

The application parses JSON, identifies the Library codec, validates the full
source document, applies sequential one-version migrations, and validates the
canonical result before it changes state. Open, Replace, Append, Save JSON, and
historical local-storage ingress all use this boundary. Future Library or Spec
versions fail closed; a failed operation does not partially mutate the Library.

Diagnostics use exact path arrays, stable application codes, and the ID of the
schema that owns the failing value. For example:

```js
{
  path: ["queries", 3, "spec", "panel", "cfg", "y"],
  severity: "error",
  code: "schema-array-size",
  message: "queries[3].spec.panel.cfg.y must contain at least 1 item",
  keyword: "minItems",
  schemaId: "https://altinity.com/schemas/altinity-sql-browser/query-spec-v1.schema.json"
}
```

Duplicate IDs and other cross-document rules are semantic diagnostics rather
than JSON Schema keywords. Static schema validation never replaces
result-dependent checks such as result-column existence or renderer support.

## Offline validation

Register the bundle as a Draft 2020-12 compound schema document and validate
against its root `$ref`. No network resolver is required because each embedded
resource retains its canonical absolute `$id`. Standard `date-time` format
validation is required when `exportedAt` is present.

The repository build uses Ajv and `ajv-formats` only at build time. It emits
self-contained validator ESM under `src/generated/`; the production browser
does not instantiate or ship the general Ajv runtime. `npm test` and
`npm run build` fail if generated schemas, validators, the catalog, or the
offline bundle drift from their canonical sources.

## Versioning and migrations

Library-envelope and Spec versions have separate registries. A migration step
transforms exactly one version (`v1 -> v2`), is pure and non-mutating, and
validates both its input and output. Multi-version upgrades run each registered
step in order; downgrade and missing-step requests fail.

Existing Library v1 files remain importable and migrate to Library v2 in memory.
The persisted field names stay `specVersion` and `spec`; the descriptive term
"saved-query Presentation Spec" does not change the JSON API.

## Canonical and experimental schemas

Only the explicit manifest in `build/schema-manifest.mjs` feeds production
validators, the catalog, and the bundle. Experimental proposals live under
`docs/drafts/`, use a distinct `$id` containing `/drafts/`, and are never
selected by `specVersion`. Build tests reject duplicate IDs and any draft that
reuses a canonical ID.

For the user-authored inner document, see the
[query Spec schema notes](saved-query-spec-json-schema.md) and
[visualization Spec authoring guide](visualization-spec-authoring-guide.md).
