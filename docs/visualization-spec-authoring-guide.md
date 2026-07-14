# Visualization Spec authoring guide

A saved query keeps SQL and visualization metadata separate. Edit only the
`query.spec` object in Spec mode; envelope fields such as `id`, `sql`, and
`specVersion` are application-owned.

`spec.name` is the Library/panel title. Per-column labels belong under
`panel.fieldConfig.columns.<column>.displayName`. `panel.cfg.type` selects the
renderer.

## Charts

Charts use zero-based result-column indexes. `x` and at least one unique `y`
index are required; `series` is another index or `null`. Pie accepts one measure.

```json
{
  "name": "Daily revenue",
  "favorite": true,
  "view": "panel",
  "panel": {
    "cfg": {
      "type": "line",
      "x": 0,
      "y": [1],
      "series": null
    },
    "fieldConfig": {
      "columns": {
        "revenue": {
          "displayName": "Revenue",
          "decimals": 2
        }
      }
    }
  }
}
```

The same positional contract applies to `bar`, `hbar`, `line`, and `area`.
Whether an index exists or has a suitable ClickHouse type is checked against the
query result at runtime.

## Table and logs

Table needs only its discriminator:

```json
{
  "name": "Query detail",
  "favorite": false,
  "panel": {
    "cfg": {
      "type": "table"
    }
  }
}
```

Logs roles are optional exact result-column names. Missing `time` or `msg` can
be detected by convention; an unresolved saved role is reported at runtime.

```json
{
  "name": "Application logs",
  "panel": {
    "cfg": {
      "type": "logs",
      "time": "ts",
      "msg": "message"
    }
  }
}
```

## Markdown text

Text panels do not require SQL. `content` is optional and defaults to an empty
string for documentation/runtime reads; validation does not insert the field.

```json
{
  "name": "Dashboard notes",
  "favorite": true,
  "view": "panel",
  "panel": {
    "cfg": {
      "type": "text",
      "content": "# Operations\n\nUse the filters above to narrow the report."
    }
  }
}
```

Unknown fields and unknown non-empty panel types remain storable for forward
compatibility. Known fields must keep their documented types.
