# Altinity SQL Browser visualization Spec authoring guide

## Purpose

This document defines a consistent authoring model for Grafana-like result panels in Altinity SQL Browser.

It is written for two audiences:

- humans editing SQL and `query.spec` in the workbench;
- agents generating or reviewing saved-query Specs.

The central rule is:

> SQL owns data. Spec owns presentation.

A result may contain scalar fields or structured ClickHouse named tuples. Named tuples group the multiple runtime values needed to render one visual object. The Spec adds labels, descriptions, units, decimals, colors, thresholds, and other presentation-only behavior.

This guide covers:

- reusable delta semantics;
- KPI;
- stat;
- gauge;
- candlestick;
- confidence interval/band;
- box plot;
- range;
- Gantt;
- histogram;
- heatmap;
- network;
- Sankey;
- health/status.

Some panel types described here are forward-looking design contracts rather than currently implemented registry arms. A saved Spec may preserve unknown future fields, but a build can render only panel types it implements.

## 1. Saved-query ownership model

A canonical saved query has this application-owned envelope:

```js
{
  id,
  sql,
  specVersion,
  spec
}
```

The Spec editor receives only `query.spec`.

The complete saved-query and Library envelopes are specified separately in the
[Library JSON Schema guide](library-json-schema.md). Authors generating an
importable file should validate the whole document against that contract, not
only the inner Spec.

Typical Spec:

```json
{
  "name": "Service overview",
  "description": "Current production health and traffic.",
  "favorite": true,
  "view": "panel",
  "panel": {
    "cfg": {
      "type": "kpi"
    },
    "fieldConfig": {
      "columns": {
        "request_rate": {
          "displayName": "Requests",
          "unit": " req/s",
          "decimals": 0
        }
      }
    }
  },
  "dashboard": {
    "role": "panel"
  }
}
```

The following never belong in the editable Spec:

- query id;
- SQL;
- Spec version;
- export-envelope fields;
- compatibility mirrors;
- transient result data;
- transport format;
- run progress;
- current filter values.

### Editing with schema-driven autocomplete

The workbench Spec editor derives its native CodeMirror completion popup from
the canonical [`query.spec` schema](../schemas/query-spec-v1.schema.json).
Typing a property or finite value opens the popup automatically; press
`Ctrl-Space` to request it explicitly. Arrow keys navigate, Enter or Tab
accepts, Escape closes the popup, and Tab inserts two spaces while the popup is
closed.

Known root/nested keys, panel variants, constants, enums, defaults, examples,
and snippets are schema-owned. Result-column names and zero-based indexes appear
only at schema-annotated positions and come from the active tab's last
successful result. No completion action executes SQL, and the absence of result
metadata is not an error. Unknown extension keys remain legal even though the
popup does not enumerate them.

## 2. Normative language

This document uses:

- **MUST** for a required interoperability rule;
- **MUST NOT** for a prohibited shape;
- **SHOULD** for the preferred form;
- **MAY** for an optional extension.

Unknown Spec fields MUST be preserved. Unknown data fields MAY be ignored by a renderer when they are not needed by the implemented panel version.

## 3. Core data model

### 3.1 Top-level result columns

A top-level result column is either:

1. a primitive field, such as a number, string, boolean, date, or timestamp;
2. a structured visual object represented by a named ClickHouse tuple;
3. an axis, category, label, or key used by one or more visual objects.

The exact role depends on the panel type.

### 3.2 Scalar fields

A scalar is appropriate when one value is enough to render the object.

Examples:

```sql
SELECT
    count() AS active_users,
    avg(duration_ms) AS mean_latency_ms
```

For a one-row KPI/stat panel, these produce two independent cards.

### 3.3 Named tuples

A named tuple is appropriate when several runtime values jointly describe one visual object.

Example:

```sql
SELECT
    (
        12.4 AS value,
        -1.7 AS delta
    ) AS cancellation_rate
```

The top-level column is `cancellation_rate`. Its runtime object is:

```json
{
  "value": 12.4,
  "delta": -1.7
}
```

ClickHouse 24.7+ supports constructing a named tuple by aliasing tuple elements:

```sql
(expr AS member_name, expr AS another_member) AS result_column
```

Only **named** tuples are used as visual-object contracts. Positional tuples such as `(12.4, -1.7)` are ambiguous and MUST NOT be interpreted by member position.

### 3.4 One-row versus row-oriented panels

There are two main result shapes.

#### One-row, many objects

Used by KPI, stat, gauge, and card-style status panels:

```text
one row
  ├─ object A
  ├─ object B
  └─ object C
```

Each top-level field becomes one visual object.

#### Many rows, one or more series/object columns

Used by candlestick, confidence, box plot, range, Gantt, histogram, heatmap, network, and Sankey:

```text
row 1 → object/event/bucket/edge
row 2 → object/event/bucket/edge
row 3 → object/event/bucket/edge
```

An axis or category column may accompany one or more named-tuple object columns.

### 3.5 Row order

Unless a panel explicitly sorts for rendering, row order is SQL order.

Authors SHOULD use `ORDER BY` whenever ordering matters.

### 3.6 Column order

For one-row multi-object panels, field order is SQL result-column order.

Spec object-key order is not a layout contract.

### 3.7 NULL

`NULL` means unavailable data.

- A missing optional tuple member and a member whose value is NULL are not always equivalent.
- Required members MUST exist in the tuple type.
- Optional runtime values SHOULD use nullable tuple members.
- The Spec may define display text such as `"noValue": "No data"`.

## 4. Data versus presentation

### 4.1 SQL-owned values

SQL SHOULD produce values whose numerical meaning is already final.

Examples:

- return `12.4` when the card should show `12.4%`;
- return `0.124` only when the intended visual formatter explicitly treats it as a ratio;
- compute comparison deltas in SQL;
- compute confidence bounds in SQL;
- compute histogram buckets in SQL;
- compute graph edge weights in SQL.

The renderer MUST NOT invent business calculations.

### 4.2 Spec-owned metadata

Common field metadata:

```js
{
  displayName?: string,
  description?: string,
  unit?: string,
  decimals?: integer,
  color?: string,
  noValue?: string,
  hidden?: boolean,
  thresholds?: Threshold[],
  links?: Link[]
}
```

`fieldConfig.columns` is keyed by exact top-level result-column name:

```json
{
  "fieldConfig": {
    "columns": {
      "mean_latency": {
        "displayName": "Mean latency",
        "unit": " ms",
        "decimals": 1
      }
    }
  }
}
```

No generic matcher is required for the initial design. Exact names are easier for humans, agents, validators, and completion engines.

### 4.3 Spec MUST NOT override data

Do not place runtime values in Spec:

```json
{
  "fieldConfig": {
    "columns": {
      "availability": {
        "value": 99.95
      }
    }
  }
}
```

A literal `value`, `delta`, `min`, `max`, `open`, `close`, or edge weight in presentation metadata is invalid unless a future panel explicitly defines it as a static visual setting.

### 4.4 Static presentation settings versus runtime tuple members

Some concepts can be either runtime data or static visual configuration. Gauge range is the main example.

Use one source, not hidden precedence:

- runtime `min`/`max` tuple members for data-dependent ranges;
- static `fieldConfig.columns.<field>.gauge.min/max` for a fixed display range.

When both are supplied, semantic validation SHOULD report an error rather than silently choosing one.

## 5. Panel-owned ClickHouse format

A query-backed panel owns its result transport format.

The panel implementation MAY choose any ClickHouse-supported output format for which it has a correct parser. The format is not user-editable and is not stored in Spec.

For typed JSON and named tuple objects, the preferred streaming format is:

```text
JSONEachRowWithProgress
```

with:

```text
output_format_json_named_tuples_as_objects = 1
```

A user-authored trailing top-level `FORMAT` clause MUST be rejected before execution when the panel requires an implementation-owned format.

Invalid:

```sql
SELECT count() AS requests
FORMAT CSV
```

Expected error:

```text
This panel owns the result format. Remove FORMAT CSV from the SQL.
```

The SQL text must remain unchanged and no request should be sent.

## 6. Common field metadata

### 6.1 Display name and description

```json
{
  "displayName": "Cancelled flights",
  "description": "Share of flights cancelled in the selected year."
}
```

`displayName` labels the field. `description` supplies supporting text or a tooltip.

The saved query's top-level `spec.name` remains the panel/tile title.

### 6.2 Units and decimals

```json
{
  "unit": "%",
  "decimals": 1
}
```

`unit` is display-only. It does not multiply or divide the value.

`decimals` controls rendering, not stored precision.

### 6.3 Color

```json
{
  "color": "warning"
}
```

A color may be a theme token, implementation-defined palette id, or supported CSS color. Agents SHOULD prefer stable theme tokens when the application defines them.

### 6.4 No-value text

```json
{
  "noValue": "No recent samples"
}
```

Used for NULL or unavailable values.

### 6.5 Hidden fields

```json
{
  "hidden": true
}
```

A hidden eligible field remains in the SQL result and Spec but is not rendered.

### 6.6 Thresholds

```json
{
  "thresholds": [
    { "value": 0, "color": "ok", "label": "Healthy" },
    { "value": 200, "color": "warning", "label": "Slow" },
    { "value": 500, "color": "critical", "label": "Critical" }
  ]
}
```

Thresholds are presentation rules over SQL values. They do not change the values.

Threshold steps SHOULD be ordered by ascending `value`.

## 7. Reusable delta pattern

Delta is a reusable member pattern, not necessarily a standalone panel type.

### SQL shape

```text
Tuple(
  value <numeric>,
  delta Nullable(<numeric>)
)
```

Example:

```sql
SELECT
    (
        current_rate AS value,
        current_rate - previous_rate AS delta
    ) AS request_rate
FROM ...
```

### Spec metadata

```json
{
  "fieldConfig": {
    "columns": {
      "request_rate": {
        "displayName": "Request rate",
        "unit": " req/s",
        "decimals": 0,
        "delta": {
          "displayName": "vs previous period",
          "unit": " req/s",
          "decimals": 0,
          "positiveIsGood": true,
          "show": true
        }
      }
    }
  }
}
```

### Semantics

- positive `delta` shows an upward direction;
- negative `delta` shows a downward direction;
- zero is neutral;
- NULL omits the delta indicator;
- `positiveIsGood` controls good/bad coloring, not arrow direction;
- the renderer MUST NOT infer the comparison period;
- SQL computes the delta.

### Percentage point versus percentage change

Authors must distinguish:

```text
current - previous
```

from:

```text
(current / previous - 1) * 100
```

Use units that communicate the calculation:

- `" pp"` for percentage points;
- `"%"` for percentage change.

## 8. KPI panel

### Purpose

Large, prominent numerical cards for a one-row result.

### Result contract

- exactly one row;
- each eligible top-level numeric scalar or named tuple is one card;
- tuple shape: `Tuple(value numeric, delta Nullable(numeric)?)`.

### Scalar example

```sql
SELECT
    12.4 AS cancellation_rate,
    87.2 AS on_time_rate
```

### Composite example

```sql
SELECT
    (
        12.4 AS value,
        -1.7 AS delta
    ) AS cancellation_rate,
    (
        87.2 AS value,
        2.3 AS delta
    ) AS on_time_rate
```

### Spec

```json
{
  "name": "Flight KPIs",
  "favorite": true,
  "view": "panel",
  "panel": {
    "cfg": {
      "type": "kpi"
    },
    "fieldConfig": {
      "columns": {
        "cancellation_rate": {
          "displayName": "Cancelled flights",
          "description": "Share of flights cancelled.",
          "unit": "%",
          "decimals": 1,
          "delta": {
            "unit": " pp",
            "decimals": 1,
            "positiveIsGood": false
          }
        },
        "on_time_rate": {
          "displayName": "On-time flights",
          "unit": "%",
          "decimals": 1,
          "delta": {
            "unit": " pp",
            "decimals": 1,
            "positiveIsGood": true
          }
        }
      }
    }
  }
}
```

### Diagnostics

- zero rows: `No data`;
- more than one row: `Expected 1 row, got N`;
- tuple missing `value`: unsupported KPI field;
- non-numeric `value`: unsupported KPI field;
- unsupported fields do not prevent supported fields from rendering;
- explicit KPI with no supported fields remains a visible warning.

## 9. Stat panel

### Purpose

Compact one-row cards for values that may be numeric, textual, boolean, date-like, or composite.

A stat panel is less opinionated than KPI:

- KPI emphasizes numeric business indicators;
- stat may show labels such as `Healthy`, `Primary`, `Running`, or a timestamp.

### Scalar example

```sql
SELECT
    'Primary' AS database_role,
    42 AS active_queries,
    now() AS last_checked
```

### Composite example

```sql
SELECT
    (
        42 AS value,
        5 AS delta,
        now() AS timestamp
    ) AS active_queries
```

Proposed tuple members:

```text
value       required; scalar JSON-compatible value
delta       optional numeric
previous    optional scalar
timestamp   optional Date/DateTime
```

### Spec

```json
{
  "panel": {
    "cfg": {
      "type": "stat",
      "layout": "grid"
    },
    "fieldConfig": {
      "columns": {
        "database_role": {
          "displayName": "Role",
          "description": "Current replication role."
        },
        "active_queries": {
          "displayName": "Active queries",
          "decimals": 0,
          "delta": {
            "positiveIsGood": false
          }
        },
        "last_checked": {
          "displayName": "Last checked"
        }
      }
    }
  }
}
```

### Diagnostics

A stat field may be any supported primitive. Composite members must still satisfy their defined types. Unsupported nested structures are ignored with a warning.

## 10. Gauge panel

### Purpose

Show a current value relative to a range, optional target, and visual thresholds.

### Scalar form with static visual range

SQL:

```sql
SELECT 68.2 AS cpu_usage
```

Spec:

```json
{
  "panel": {
    "cfg": {
      "type": "gauge"
    },
    "fieldConfig": {
      "columns": {
        "cpu_usage": {
          "displayName": "CPU",
          "unit": "%",
          "decimals": 1,
          "gauge": {
            "min": 0,
            "max": 100,
            "shape": "radial",
            "showTarget": false
          },
          "thresholds": [
            { "value": 0, "color": "ok" },
            { "value": 70, "color": "warning" },
            { "value": 90, "color": "critical" }
          ]
        }
      }
    }
  }
}
```

### Composite form with runtime range and target

SQL:

```sql
SELECT
    (
        used_bytes AS value,
        0 AS min,
        capacity_bytes AS max,
        warning_bytes AS target
    ) AS disk_usage
FROM ...
```

Tuple contract:

```text
Tuple(
  value  numeric,
  min    numeric optional,
  max    numeric optional,
  target Nullable(numeric) optional
)
```

Spec:

```json
{
  "panel": {
    "cfg": {
      "type": "gauge"
    },
    "fieldConfig": {
      "columns": {
        "disk_usage": {
          "displayName": "Disk usage",
          "unit": " B",
          "decimals": 0,
          "gauge": {
            "shape": "bar",
            "showTarget": true
          }
        }
      }
    }
  }
}
```

### Mutual-exclusion rule

Do not provide both runtime tuple `min`/`max` and static Spec `gauge.min/max`. Semantic validation should reject the ambiguity.

### Diagnostics

- missing range: use a documented panel default or report a configuration error;
- `min >= max`: error;
- value outside range: render clamped geometry but preserve/display the real value;
- target outside range: warning;
- non-numeric members: error for that field.

## 11. Candlestick panel

### Purpose

Render OHLC financial or operational ranges over time.

### Result contract

Many rows:

```text
time column
one or more named tuple series columns
```

Each series tuple:

```text
Tuple(
  open   numeric,
  high   numeric,
  low    numeric,
  close  numeric,
  volume Nullable(numeric) optional
)
```

### SQL

```sql
SELECT
    toStartOfHour(ts) AS bucket,
    (
        argMin(price, ts) AS open,
        max(price) AS high,
        min(price) AS low,
        argMax(price, ts) AS close,
        sum(volume) AS volume
    ) AS price
FROM trades
GROUP BY bucket
ORDER BY bucket
```

### Spec

```json
{
  "panel": {
    "cfg": {
      "type": "candlestick",
      "time": "bucket",
      "series": ["price"]
    },
    "fieldConfig": {
      "columns": {
        "price": {
          "displayName": "Market price",
          "unit": " USD",
          "decimals": 2,
          "candlestick": {
            "upColor": "ok",
            "downColor": "critical",
            "showVolume": true
          }
        }
      }
    }
  }
}
```

### Invariants

For each candle:

```text
low <= open <= high
low <= close <= high
```

Violation is a runtime data error or warning according to implementation policy.

### Diagnostics

- missing time column: error;
- non-time-compatible axis: error;
- missing OHLC member: error;
- non-numeric OHLC member: error;
- duplicate time points: allowed only if the renderer documents aggregation; otherwise error;
- rows should be ordered by time.

## 12. Confidence interval/band panel

### Purpose

Render a central estimate with lower and upper bounds over an X domain.

### Tuple contract

```text
Tuple(
  value numeric,
  lower numeric,
  upper numeric
)
```

### SQL

```sql
SELECT
    day,
    (
        forecast AS value,
        forecast_lower AS lower,
        forecast_upper AS upper
    ) AS demand
FROM daily_forecast
ORDER BY day
```

### Spec

```json
{
  "panel": {
    "cfg": {
      "type": "confidence",
      "x": "day",
      "series": ["demand"]
    },
    "fieldConfig": {
      "columns": {
        "demand": {
          "displayName": "Forecast demand",
          "unit": " orders",
          "decimals": 0,
          "confidence": {
            "fillOpacity": 0.2,
            "lineWidth": 2
          }
        }
      }
    }
  }
}
```

### Invariant

```text
lower <= value <= upper
```

Rows violating the invariant should produce diagnostics and should not silently swap bounds.

### Variants

A future tuple may include:

```text
median
p10
p90
```

Such a change requires an explicit versioned member contract; do not infer arbitrary percentile names.

## 13. Box plot panel

### Purpose

Render a five-number summary per category or time bucket.

### Tuple contract

```text
Tuple(
  min      numeric,
  q1       numeric,
  median   numeric,
  q3       numeric,
  max      numeric,
  outliers Array(numeric) optional
)
```

### SQL

```sql
SELECT
    region,
    (
        quantileExact(0)(latency_ms) AS min,
        quantileExact(0.25)(latency_ms) AS q1,
        quantileExact(0.5)(latency_ms) AS median,
        quantileExact(0.75)(latency_ms) AS q3,
        quantileExact(1)(latency_ms) AS max
    ) AS latency
FROM requests
GROUP BY region
ORDER BY region
```

### Spec

```json
{
  "panel": {
    "cfg": {
      "type": "box",
      "category": "region",
      "series": ["latency"]
    },
    "fieldConfig": {
      "columns": {
        "latency": {
          "displayName": "Request latency",
          "unit": " ms",
          "decimals": 1,
          "box": {
            "orientation": "vertical",
            "showOutliers": true
          }
        }
      }
    }
  }
}
```

### Invariant

```text
min <= q1 <= median <= q3 <= max
```

The renderer must not reorder invalid values silently.

### Raw-sample variant

An `Array(numeric)` raw-sample field could support client-side quartile calculation later. It is not part of the summary-tuple contract and should be a separate explicit mode because it changes computation ownership.

## 14. Range panel

### Purpose

Render time or numeric intervals, maintenance windows, reservations, availability periods, and other start/end objects.

### Tuple contract

```text
Tuple(
  start   Date/DateTime/numeric,
  end     Nullable(Date/DateTime/numeric),
  label   String optional,
  lane    String optional,
  value   numeric optional,
  status  String optional
)
```

A NULL `end` represents an open-ended range.

### SQL

```sql
SELECT
    (
        started_at AS start,
        finished_at AS end,
        deployment_name AS label,
        environment AS lane,
        status
    ) AS deployment
FROM deployments
ORDER BY started_at
```

### Spec

```json
{
  "panel": {
    "cfg": {
      "type": "range",
      "items": ["deployment"]
    },
    "fieldConfig": {
      "columns": {
        "deployment": {
          "displayName": "Deployments",
          "description": "Production and staging deployment windows.",
          "range": {
            "showDuration": true,
            "openEndedText": "running"
          }
        }
      }
    }
  }
}
```

### Diagnostics

- missing `start`: error;
- `end < start`: error;
- mixed incomparable start/end types: error;
- open-ended range: valid;
- empty label: allowed;
- lane controls grouping when present.

## 15. Gantt panel

### Purpose

Render tasks with duration, progress, hierarchy, and dependencies.

### Tuple contract

```text
Tuple(
  id           String,
  label        String,
  start        Date/DateTime,
  end          Nullable(Date/DateTime),
  progress     Nullable(numeric) optional,
  state        String optional,
  parent       Nullable(String) optional,
  dependencies Array(String) optional
)
```

Each row contains one task tuple.

### SQL

```sql
SELECT
    (
        task_id AS id,
        task_name AS label,
        started_at AS start,
        due_at AS end,
        progress_ratio AS progress,
        state,
        parent_task_id AS parent,
        dependency_ids AS dependencies
    ) AS task
FROM project_tasks
ORDER BY started_at, task_id
```

### Spec

```json
{
  "panel": {
    "cfg": {
      "type": "gantt",
      "item": "task"
    },
    "fieldConfig": {
      "columns": {
        "task": {
          "displayName": "Project plan",
          "gantt": {
            "showProgress": true,
            "showDependencies": true
          }
        }
      }
    }
  }
}
```

### Invariants

- `id` must be non-empty and unique;
- `end` must not precede `start`;
- `progress` convention must be documented: recommended range is `0..1`;
- parent ids and dependency ids may refer to rows that are filtered out; render as unresolved references with a warning;
- dependency cycles should be diagnosed.

## 16. Histogram panel

### Purpose

Render pre-aggregated numeric buckets.

SQL owns bucket construction. The renderer does not rebucket arbitrary raw values in this contract.

### Tuple contract

```text
Tuple(
  lower numeric,
  upper numeric,
  count numeric
)
```

### SQL

```sql
SELECT
    (
        bucket_lower AS lower,
        bucket_upper AS upper,
        count() AS count
    ) AS latency_bucket
FROM ...
GROUP BY bucket_lower, bucket_upper
ORDER BY bucket_lower
```

### Spec

```json
{
  "panel": {
    "cfg": {
      "type": "histogram",
      "buckets": ["latency_bucket"]
    },
    "fieldConfig": {
      "columns": {
        "latency_bucket": {
          "displayName": "Request latency",
          "unit": " ms",
          "histogram": {
            "normalization": "none",
            "gap": 0
          }
        }
      }
    }
  }
}
```

### Invariants

- `lower < upper`;
- `count >= 0`;
- buckets should be sorted by lower bound;
- overlapping buckets should produce a warning unless explicitly supported;
- gaps are valid;
- infinite outer bounds require a documented representation.

### Percent and density display

`normalization` is presentation behavior over returned counts:

- `none`: show counts;
- `percent`: divide each count by total count;
- `density`: normalize by total and bucket width.

The raw SQL counts remain unchanged.

## 17. Heatmap panel

### Purpose

Render a two-dimensional grid of pre-aggregated cells.

### Tuple contract

```text
Tuple(
  xLower numeric/time,
  xUpper numeric/time,
  yLower numeric,
  yUpper numeric,
  value  numeric
)
```

### SQL

```sql
SELECT
    (
        time_bucket AS xLower,
        time_bucket + INTERVAL 5 MINUTE AS xUpper,
        latency_lower AS yLower,
        latency_upper AS yUpper,
        count() AS value
    ) AS cell
FROM latency_cells
ORDER BY xLower, yLower
```

### Spec

```json
{
  "panel": {
    "cfg": {
      "type": "heatmap",
      "cells": ["cell"]
    },
    "fieldConfig": {
      "columns": {
        "cell": {
          "displayName": "Latency distribution",
          "unit": " requests",
          "heatmap": {
            "colorScale": "sequential",
            "reverse": false,
            "showValues": false
          }
        }
      }
    }
  }
}
```

### Invariants

- `xLower < xUpper`;
- `yLower < yUpper`;
- cell `value` must be numeric;
- overlapping cells should warn;
- sparse grids are valid;
- the renderer must not assume equal bucket widths.

## 18. Network panel

### Purpose

Render nodes connected by weighted or unweighted directed/undirected edges.

### Edge tuple contract

```text
Tuple(
  source      String,
  target      String,
  value       Nullable(numeric) optional,
  sourceLabel String optional,
  targetLabel String optional,
  state       String optional
)
```

Each row is one edge.

### SQL

```sql
SELECT
    (
        caller_service AS source,
        callee_service AS target,
        count() AS value,
        caller_service AS sourceLabel,
        callee_service AS targetLabel
    ) AS edge
FROM service_calls
GROUP BY caller_service, callee_service
```

### Spec

```json
{
  "panel": {
    "cfg": {
      "type": "network",
      "edge": "edge"
    },
    "fieldConfig": {
      "columns": {
        "edge": {
          "displayName": "Service dependencies",
          "unit": " calls",
          "network": {
            "directed": true,
            "showLabels": true
          }
        }
      }
    }
  }
}
```

### Semantics

- source/target ids define node identity;
- labels are optional display text;
- repeated identical edges may be aggregated by SQL or by a documented renderer rule;
- negative weights should be rejected unless a future signed-edge mode is defined;
- self-edges may be allowed but should be visibly distinct.

### Node metadata

A richer node table cannot be represented as a second result set in the current single-query contract. Initial implementations should derive nodes from edges. A future tuple may add node group/color information, or a separate setup/source query may supply node metadata.

## 19. Sankey panel

### Purpose

Render directional flow magnitudes between stages or categories.

### Edge tuple contract

```text
Tuple(
  source      String,
  target      String,
  value       numeric,
  sourceLabel String optional,
  targetLabel String optional
)
```

### SQL

```sql
SELECT
    (
        source_stage AS source,
        target_stage AS target,
        sum(flow_count) AS value,
        source_stage AS sourceLabel,
        target_stage AS targetLabel
    ) AS flow
FROM stage_flows
GROUP BY source_stage, target_stage
```

### Spec

```json
{
  "panel": {
    "cfg": {
      "type": "sankey",
      "edge": "flow"
    },
    "fieldConfig": {
      "columns": {
        "flow": {
          "displayName": "Request flow",
          "unit": " requests",
          "sankey": {
            "nodeWidth": 16,
            "nodeGap": 10
          }
        }
      }
    }
  }
}
```

### Invariants

- `value >= 0`;
- empty source or target: error;
- cycles require a renderer that supports them; otherwise diagnose;
- duplicate flows should be aggregated in SQL or by an explicit documented rule;
- source and target ids form the node set.

## 20. Health/status panel

### Purpose

Render one or more operational health objects with state, severity, message, and age.

### One-row multi-status form

```sql
SELECT
    (
        'healthy' AS state,
        'ok' AS severity,
        'Replication is current' AS message,
        now() - INTERVAL 2 MINUTE AS since
    ) AS replication,
    (
        'degraded' AS state,
        'warning' AS severity,
        'Two disks above 80%' AS message,
        now() - INTERVAL 15 MINUTE AS since
    ) AS storage
```

Tuple contract:

```text
Tuple(
  state     String,
  severity  String,
  message   String optional,
  since     Date/DateTime optional,
  value     scalar optional
)
```

### Spec

```json
{
  "panel": {
    "cfg": {
      "type": "status",
      "layout": "cards"
    },
    "fieldConfig": {
      "columns": {
        "replication": {
          "displayName": "Replication",
          "status": {
            "showMessage": true,
            "showSince": true,
            "severityColors": {
              "ok": "ok",
              "warning": "warning",
              "critical": "critical",
              "unknown": "muted"
            }
          }
        },
        "storage": {
          "displayName": "Storage",
          "status": {
            "showMessage": true,
            "showSince": true
          }
        }
      }
    }
  }
}
```

### Row-list form

For a variable number of checks, return one status tuple per row and configure the tuple column explicitly:

```sql
SELECT
    (
        check_id AS id,
        check_name AS label,
        state,
        severity,
        message,
        changed_at AS since
    ) AS check
FROM health_checks
ORDER BY severity DESC, check_name
```

A future row-list status contract should require `cfg.items: ["check"]` or a dedicated `item` field. It must not be inferred ambiguously from arbitrary tuples.

### Severity vocabulary

Recommended canonical severities:

```text
ok
info
warning
critical
unknown
```

Unknown severity strings should render with the unknown style and a warning rather than disappearing.

## 21. Choosing rows, columns, tuples, or arrays

### Use separate top-level columns when

- the number of visual objects is fixed and small;
- the query returns one row;
- each object is naturally named;
- the panel should preserve SQL column order.

Typical: KPI, stat, gauge, status cards.

### Use rows when

- the number of objects varies;
- each object shares the same schema;
- sorting/filtering objects in SQL is useful;
- the panel naturally consumes a sequence.

Typical: candles, ranges, tasks, buckets, cells, edges.

### Use a named tuple when

- multiple values jointly define one object;
- member names have stable semantics;
- values must travel together;
- positional interpretation would be fragile.

### Use `Array(Tuple(...))` only when

- one row must contain a variable-size nested collection;
- row-oriented output is impractical;
- the panel parser explicitly supports the nested array.

Rows are usually easier to stream, inspect in the Table view, export, limit, and diagnose.

## 22. Authoring checklist for humans and agents

Before producing a Spec:

1. Identify the panel type.
2. Decide whether it is one-row or row-oriented.
3. Keep calculations in SQL.
4. Use one top-level column per fixed visual object.
5. Use a named tuple when an object needs several runtime values.
6. Use exact documented tuple member names.
7. Keep display labels, descriptions, units, decimals, colors, and thresholds in Spec.
8. Key field metadata by exact top-level result-column name.
9. Add `ORDER BY` when row order matters.
10. Use nullable members for optional runtime values.
11. Do not add an authored trailing `FORMAT`.
12. Do not put SQL, ids, or runtime results inside Spec.
13. Preserve unknown fields.
14. Validate JSON structure before Save.
15. Run result-aware validation against actual column names/types and row shape.

## 23. Diagnostic levels

### Blocking errors

Examples:

- invalid JSON;
- unknown implemented panel cfg shape;
- wrong JSON property type;
- user-authored trailing `FORMAT` for a panel-owned transport;
- missing required tuple member;
- wrong required member type;
- invalid row count for explicit one-row panel;
- invalid cross-member invariant such as `min >= max`.

### Warnings

Examples:

- field metadata targets a column not in the current result;
- unknown tuple member;
- target outside gauge range;
- overlapping histogram buckets;
- unresolved Gantt dependency;
- unknown status severity.

### Information

Examples:

- optional presentation metadata absent;
- auto-detected field label uses raw SQL column name;
- neutral delta coloring used because `positiveIsGood` is absent.

## 24. Forward compatibility

The reader must follow this pattern:

```text
clone complete Spec
validate known fields
read known fields
preserve unknown fields
persist complete Spec
```

Do not rebuild `panel`, `fieldConfig`, or column metadata from a whitelist during Save, rename, favorite, direct panel edits, import/export, share, or merge.

A build that does not implement a future panel type should preserve it and render a clear unsupported-type diagnostic.

## 25. Reference links

- ClickHouse Tuple data type: <https://clickhouse.com/docs/sql-reference/data-types/tuple>
- ClickHouse 24.7 named-tuple aliases: <https://clickhouse.com/blog/clickhouse-release-24-07>
- JSONEachRowWithProgress: <https://clickhouse.com/docs/interfaces/formats/JSONEachRowWithProgress>
- Named tuples as JSON objects: <https://clickhouse.com/docs/operations/settings/formats#output_format_json_named_tuples_as_objects>
- JSON Schema 2020-12: <https://json-schema.org/draft/2020-12/>
- CodeMirror autocompletion reference: <https://codemirror.net/docs/ref/#autocomplete>
