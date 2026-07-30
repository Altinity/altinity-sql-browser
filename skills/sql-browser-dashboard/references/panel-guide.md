# SQL Browser panel guide

Read the sections for every panel type used.

## KPI (`kpi`)

Use for a small set of headline values returned in one row. Each top-level result column becomes a KPI unless hidden. Use named tuples for values carrying runtime delta metadata when supported by the SQL Browser renderer.

```json
{
  "cfg": { "type": "kpi" },
  "fieldConfig": {
    "defaults": { "noValue": "—" },
    "columns": {
      "revenue": { "displayName": "Revenue", "unit": " £", "decimals": 0 },
      "growth": { "displayName": "Growth", "unit": "%", "decimals": 1 }
    }
  }
}
```

Use a compact full-width tile for 3–6 KPIs.

## Table (`table`)

Use for exact values, rankings, and supporting detail. Keep result sets bounded in SQL. Put business-readable aliases in the SQL or `fieldConfig.columns`.

```json
{
  "cfg": { "type": "table" },
  "fieldConfig": {
    "columns": {
      "customer": { "displayName": "Customer" },
      "revenue": { "displayName": "Revenue", "unit": " £", "decimals": 0 }
    }
  }
}
```

## Bar (`bar`) and horizontal bar (`hbar`)

Use `bar` for a small number of short category labels. Use `hbar` for rankings and long labels.

`x` is the category-column index. `y` is one or more measure-column indexes. `series` optionally names a splitting column by index.

```json
{
  "cfg": {
    "type": "hbar",
    "x": 0,
    "y": [1],
    "series": null,
    "style": {
      "mode": "grouped",
      "density": "normal",
      "scale": "zero",
      "legend": "hide",
      "grid": "auto",
      "axes": "show"
    }
  }
}
```

## Line (`line`) and area (`area`)

Use for ordered or time-based trends. Sort the query by the X column. Use `area` when magnitude/accumulation is important; use `line` for precise trend comparison.

```json
{
  "cfg": {
    "type": "line",
    "x": 0,
    "y": [1, 2],
    "series": null,
    "style": {
      "curve": "linear",
      "points": "auto",
      "scale": "data",
      "legend": "show",
      "grid": "auto",
      "axes": "show"
    }
  }
}
```

For `area`, `style.stack` may be `overlay` or `stacked`.

## Pie (`pie`)

Use only for a small part-to-whole breakdown with one measure. Prefer bars when differences are close or there are many categories.

```json
{
  "cfg": {
    "type": "pie",
    "x": 0,
    "y": [1],
    "series": null,
    "style": {
      "shape": "donut",
      "legend": "show",
      "frame": "normal"
    }
  }
}
```

## Logs (`logs`)

Use for timestamped business events or operational messages. Name roles when the query aliases differ from defaults.

```json
{
  "cfg": {
    "type": "logs",
    "time": "event_time",
    "msg": "message",
    "level": "level"
  }
}
```

## Text (`text`)

Use for safe Markdown context, definitions, caveats, or a short executive interpretation. SQL may be an empty string for a text-only saved query.

```json
{
  "cfg": {
    "type": "text",
    "content": "## Interpretation\n\nRevenue grew while customer concentration declined."
  }
}
```

Do not use text tiles to conceal missing analysis. Keep narrative tied to the actual metrics shown.
