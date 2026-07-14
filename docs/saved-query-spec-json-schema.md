# Saved-query Spec JSON Schema

`query.spec` is the user-authored half of a saved query. Its canonical contract
is [`schemas/query-spec-v1.schema.json`](../schemas/query-spec-v1.schema.json), a
JSON Schema Draft 2020-12 document. The surrounding `id`, `sql`, `specVersion`,
and export envelope are deliberately outside that schema.

The schema validates known fields while keeping extension namespaces open. A
newer panel type or an unknown object member therefore remains storable and
survives edits made by an older browser. A known field with the wrong shape is
still an error.

## Validation layers

Static document correctness comes from the canonical schema. Rules that need a
query result or application context are registered as feature validators. The
shared validation service always runs them in this order:

1. JSON syntax;
2. canonical schema validation;
3. feature/runtime validation when no blocking schema error overlaps its path.

Diagnostics use exact path arrays. A dotted result-column name remains one
segment, for example `['panel', 'fieldConfig', 'columns', 'latency.p95',
'decimals']`.

## Build-time compilation

Ajv is a development dependency. It compiles the schema to self-contained ESM;
the production application does not bundle the general JSON Schema engine.

```sh
npm run generate:spec-schema
npm run check:spec-schema
```

The check runs automatically before both `npm test` and `npm run build` and
fails when either generated artifact is stale.

## Introspection API

`createSpecSchemaService()` exposes `schemaAtPath`, `propertiesAtPath`, and
`annotationsAtPath`. Schema lookup returns a `{ common, candidates }` envelope.
When `panel.cfg.type` is present, `candidates` contains only its selected branch.
While the discriminator is incomplete, candidates remain separate and common
properties—including the discriminator—stay available to completion tooling.

This is a minimal valid Spec:

```json
{
  "name": "Recent server logs",
  "favorite": true,
  "view": "panel",
  "panel": {
    "cfg": {
      "type": "logs",
      "time": "event_time",
      "msg": "message",
      "level": "level"
    }
  }
}
```

Defaults in the schema are documentation and completion hints. Validation never
rewrites a document or applies them.
