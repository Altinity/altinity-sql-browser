# Altinity SQL Browser query Spec JSON Schema

## Purpose

This document provides:

1. a JSON Schema for the user-editable `query.spec` document;
2. validation-layer guidance;
3. a CodeMirror 6 completion/lint integration design;
4. runtime checks that intentionally remain outside JSON Schema.

The machine-readable schema is embedded below and is also distributed as a separate `.schema.json` file.

## Schema dialect

The schema uses JSON Schema Draft 2020-12:

```text
https://json-schema.org/draft/2020-12/schema
```

The schema validates `query.spec` only.

It does not validate:

```js
{
  id,
  sql,
  specVersion
}
```

or the saved-query and Library envelopes. Those application-managed contracts
are separate canonical schemas; see the
[complete Library schema guide](library-json-schema.md).

## Design goals

### Validate known structure

The schema validates:

- core Spec fields;
- panel container shape;
- known panel cfg branches;
- field presentation metadata;
- dashboard role;
- enums, number ranges, and required structural properties.

### Preserve extensions

The saved-query model requires unknown fields to survive all read/write paths. For that reason, known objects generally use:

```json
{
  "additionalProperties": true
}
```

Completion can suggest known fields without rejecting fields written by a newer build or extension.

Known panel types use discriminated strict branches. A final fallback branch accepts a non-empty unknown `type` string only when it is not one of the known ids. This prevents malformed known cfg objects from escaping validation while preserving future panel types.

### Support completion

The schema provides:

- `description`;
- `default`;
- `examples`;
- `enum`;
- `const`;
- reusable `$defs`;
- a `type` discriminator for panel cfg branches;
- custom `x-altinity-*` annotations for dynamic result-column completion.

### Separate structural and runtime validation

JSON Schema cannot inspect the SQL result. It cannot prove that:

- a named result column exists;
- a ClickHouse result type is numeric;
- a tuple contains the required named members;
- a query returns exactly one row;
- a user wrote a trailing SQL `FORMAT`;
- two result columns have compatible lengths or axes;
- bounds and values satisfy domain invariants.

Those checks remain in feature validators and result readers.

## Validation layers

Use three layers.

### Layer 1 — JSON syntax

The Spec editor already retains invalid text and reports a syntax diagnostic.

Examples:

- missing comma;
- unclosed string;
- trailing content;
- invalid number.

Syntax failure blocks semantic/schema validation and Save.

### Layer 2 — JSON Schema

Run Draft 2020-12 validation after successful parsing.

Schema errors include:

- `favorite` is not boolean;
- `view` is not `table`, `json`, or `panel`;
- a known `panel.cfg.type` branch is incomplete or malformed;
- `decimals` is negative;
- a candlestick cfg has no `time`;
- a network cfg has no `edge`;
- a threshold lacks `value` or `color`.

Convert each validator error's JSON Pointer or instance path to the application's exact path-array form:

```js
['panel', 'fieldConfig', 'columns', 'latency', 'decimals']
```

This matches the existing diagnostic navigation model.

### Layer 3 — feature/runtime semantics

Feature validators and result readers check:

- SQL/result column existence;
- ClickHouse types;
- named tuple member names;
- row-count contracts;
- panel-owned result format;
- cross-member invariants;
- unsupported server version;
- metadata pointing at missing result fields.

These diagnostics should use stable error codes.

Examples:

```text
kpi-row-count
kpi-nonnumeric-value
kpi-missing-tuple-value
panel-owned-format
gauge-invalid-range
candlestick-invalid-ohlc
box-invalid-order
gantt-cycle
```

## CodeMirror completion architecture

The Spec editor installs an explicit native CodeMirror completion source through
`@codemirror/autocomplete`. The implementation keeps three boundaries:

```text
src/core/spec-schema.js
src/core/spec-completion.js
src/editor/spec-json-context.js
src/editor/spec-completion-adapter.js
```

The schema service resolves local refs, composition, and discriminated branches.
The pure completion engine normalizes candidates and deterministic ranking. The
tolerant Lezer context resolver supplies the current path, replacement range,
completed siblings, and a best-effort root value without requiring the whole
document to parse. The thin editor adapter owns CodeMirror objects, insertion
transactions, the information pane, and last-successful active-tab dynamic
sources.

The best-effort value is completion-only. It is never passed to validation,
Save, or persistence.

### Pure schema service

Implemented schema lookup interface:

```js
createSpecSchemaService({ schema, validateCompiled }) -> {
  validate(value),
  schemaAtPath({ root, path }),
  propertiesAtPath({ root, path }),
  annotationsAtPath({ root, path }),
  variantsAtPath({ root, path })
}
```

`positionKind` can be:

```text
property-name
property-value
array-item
```

### Completion behavior

#### Property names

At:

```jsonc
{
  "panel": {
    |
  }
}
```

offer:

```text
cfg
key
fieldConfig
```

Do not offer a property already present in the same object unless duplicates are intentionally supported.

#### Discriminated panel cfg

At:

```jsonc
{
  "panel": {
    "cfg": {
      "type": "line",
      |
    }
  }
}
```

resolve the `line` branch and offer:

```text
x
y
series
```

Do not merge unrelated cfg fields from every panel branch.

When `type` is absent, offer `type` first and offer its enum values.

#### Enum and const values

At:

```jsonc
{
  "view": |
}
```

offer:

```text
"table"
"json"
"panel"
```

At `panel.cfg.type`, offer every explicit finite canonical branch. The generic
forward-compatible branch uses a negative enum constraint and is never exposed
as a fake finite value.

#### Snippets

Object-valued completions should insert useful skeletons.

Example line-chart skeleton:

```json
{
  "type": "line",
  "x": 0,
  "y": [1],
  "series": null
}
```

Example logs skeleton:

```json
{
  "type": "logs",
  "time": "event_time",
  "msg": "message",
  "level": "level"
}
```

Example field metadata skeleton:

```json
{
  "displayName": "",
  "decimals": 1
}
```

The completion engine may use schema `examples`, `default`, and custom snippets maintained alongside the schema. Avoid encoding executable code inside the schema.

#### Dynamic result-column values

The schema annotates exact column-name strings with:

```json
{
  "x-altinity-completion": {
    "source": "resultColumns"
  }
}
```

At a column-name value, offer the active tab's last successful result columns:

```text
bucket
price
latency
```

Use the last explicit Run result for the active tab. Completion must never execute SQL.

#### Dynamic `fieldConfig.columns` keys

The schema annotates the `columns` object with:

```json
{
  "x-altinity-key-completion": {
    "source": "resultColumns"
  }
}
```

At:

```jsonc
{
  "fieldConfig": {
    "columns": {
      |
    }
  }
}
```

offer result-column names as JSON property keys.

Do not offer keys already configured.

When no result exists, dynamic completion returns no candidates and no
diagnostic. It never issues a query or infers result columns from unexecuted SQL.

#### Completion details

Use schema annotations to populate:

- completion label;
- type/detail;
- documentation/info panel;
- default value;
- enum descriptions;
- deprecation status if added later.

Property descriptions should be short enough for the completion popup and complete enough for a hover/help pane.

### Cursor path resolution

The editor already maps parsed JSON nodes to exact path arrays for diagnostics. Reuse the same path model for completion.

The completion layer must distinguish:

- cursor inside a property name;
- cursor after a colon;
- cursor inside an array;
- cursor inside an incomplete object;
- syntactically incomplete JSON during typing.

For incomplete JSON, use the Lezer syntax tree and a tolerant local context resolver rather than requiring `JSON.parse` to succeed on every keystroke.

### Validation scheduling

Recommended behavior:

- syntax diagnostics: continuous;
- schema diagnostics: continuous after successful parse;
- runtime/result diagnostics: after Run and on relevant Spec changes;
- Save: rerun all blocking validation synchronously.

Debounce expensive schema validation if necessary, but Save must not rely on a stale result.

### Diagnostic mapping

Normalize validator output to:

```js
{
  path: Array<string | number>,
  severity: 'error' | 'warning' | 'info',
  code: string,
  message: string
}
```

Schema keyword mapping examples:

```text
required              missing-required-property
type                  invalid-type
enum                  invalid-enum-value
const                 invalid-constant
minimum/maximum       number-out-of-range
minItems              too-few-items
uniqueItems           duplicate-array-item
oneOf                 invalid-panel-config
```

A `required` error should point to the containing object or to a synthetic child path for the missing property if the editor can render it.

## Schema/version lifecycle

### Spec version

The schema `$id` identifies query Spec version 1.

When Spec semantics change incompatibly:

- increment `query.specVersion`;
- publish a new schema id;
- keep old schema available for import/migration;
- do not silently reinterpret old documents.

### Panel additions

Adding a new panel type is additive when:

- the existing schema is updated with a new discriminated branch;
- older builds continue preserving the unknown cfg;
- the runtime reports unsupported panel type clearly;
- unknown field metadata remains intact.

### Property additions

Adding optional presentation fields is additive.

Changing the meaning or type of an existing property may require a new Spec version.

## Runtime checks not expressible in this schema

The implementation must add semantic checks for the following.

### SQL format ownership

No schema property represents the ClickHouse output format.

Before executing a panel-owned format, inspect SQL and reject a trailing top-level `FORMAT`.

### KPI/stat/gauge

- exactly one row where required;
- eligible scalar types;
- named tuple member names;
- numeric member types;
- optional member NULL handling;
- tuple and scalar coexistence;
- static gauge range versus tuple range conflict.

### Candlestick

- time-column existence/type;
- OHLC members and numeric types;
- `low <= open/close <= high`;
- time ordering.

### Confidence

- lower/value/upper members;
- `lower <= value <= upper`.

### Box

- required five-number members;
- `min <= q1 <= median <= q3 <= max`;
- outlier array type.

### Range/Gantt

- start/end type compatibility;
- `end >= start`;
- unique ids;
- parent/dependency references;
- dependency cycles.

### Histogram/heatmap

- valid bucket/cell bounds;
- non-negative counts where required;
- overlaps/gaps;
- sorted order.

### Network/Sankey

- non-empty source/target;
- non-negative Sankey flow;
- duplicate edge policy;
- cycle support.

### Status

- required state/severity members;
- accepted severity vocabulary;
- timestamp compatibility.

## Machine-readable JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://altinity.com/schemas/altinity-sql-browser/query-spec-v1.schema.json",
  "title": "Altinity SQL Browser saved-query Spec v1",
  "description": "Schema for the user-editable query.spec document. SQL, query id, specVersion, export envelopes, and runtime state are intentionally outside this document. Known fields are validated while unknown extension fields remain allowed.",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "pattern": "\\S",
      "description": "Human-readable saved-query title. When present, it must contain a non-whitespace character.",
      "examples": [
        "Cancellation rate"
      ]
    },
    "description": {
      "type": "string",
      "description": "Human-readable explanation of the query or panel.",
      "examples": [
        "Current year compared with the prior year."
      ]
    },
    "favorite": {
      "type": "boolean",
      "default": false,
      "description": "Whether the saved query participates in the dashboard favorite set."
    },
    "view": {
      "type": "string",
      "enum": [
        "table",
        "json",
        "panel"
      ],
      "description": "Remembered workbench result view."
    },
    "panel": {
      "$ref": "#/$defs/panel"
    },
    "dashboard": {
      "$ref": "#/$defs/dashboard"
    }
  },
  "additionalProperties": true,
  "$defs": {
    "columnName": {
      "type": "string",
      "minLength": 1,
      "description": "Exact top-level ClickHouse result-column name.",
      "x-altinity-completion": {
        "source": "resultColumns"
      }
    },
    "columnNameList": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/columnName"
      },
      "minItems": 1,
      "uniqueItems": true
    },
    "threshold": {
      "type": "object",
      "required": [
        "value",
        "color"
      ],
      "properties": {
        "value": {
          "type": "number",
          "description": "Inclusive lower bound for this visual threshold step."
        },
        "color": {
          "type": "string",
          "minLength": 1,
          "description": "Theme token, CSS color, or implementation-defined color id."
        },
        "label": {
          "type": "string",
          "description": "Optional human-readable threshold label."
        }
      },
      "additionalProperties": true
    },
    "deltaPresentation": {
      "type": "object",
      "properties": {
        "displayName": {
          "type": "string"
        },
        "unit": {
          "type": "string",
          "description": "Display-only unit or suffix for the delta value."
        },
        "decimals": {
          "type": "integer",
          "minimum": 0,
          "maximum": 20
        },
        "positiveIsGood": {
          "type": "boolean",
          "description": "When true, positive delta is good; when false, negative delta is good."
        },
        "show": {
          "type": "boolean",
          "default": true
        }
      },
      "additionalProperties": true
    },
    "gaugePresentation": {
      "type": "object",
      "properties": {
        "min": {
          "type": "number",
          "description": "Static visual minimum. Do not combine with a runtime tuple member named min."
        },
        "max": {
          "type": "number",
          "description": "Static visual maximum. Do not combine with a runtime tuple member named max."
        },
        "shape": {
          "type": "string",
          "enum": [
            "radial",
            "bar"
          ],
          "default": "radial"
        },
        "showTarget": {
          "type": "boolean",
          "default": true
        }
      },
      "additionalProperties": true
    },
    "candlestickPresentation": {
      "type": "object",
      "properties": {
        "upColor": {
          "type": "string"
        },
        "downColor": {
          "type": "string"
        },
        "showVolume": {
          "type": "boolean",
          "default": true
        }
      },
      "additionalProperties": true
    },
    "confidencePresentation": {
      "type": "object",
      "properties": {
        "fillOpacity": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "lineWidth": {
          "type": "number",
          "minimum": 0
        }
      },
      "additionalProperties": true
    },
    "boxPresentation": {
      "type": "object",
      "properties": {
        "orientation": {
          "type": "string",
          "enum": [
            "vertical",
            "horizontal"
          ],
          "default": "vertical"
        },
        "showOutliers": {
          "type": "boolean",
          "default": true
        }
      },
      "additionalProperties": true
    },
    "rangePresentation": {
      "type": "object",
      "properties": {
        "showDuration": {
          "type": "boolean",
          "default": false
        },
        "openEndedText": {
          "type": "string",
          "default": "ongoing"
        }
      },
      "additionalProperties": true
    },
    "ganttPresentation": {
      "type": "object",
      "properties": {
        "showProgress": {
          "type": "boolean",
          "default": true
        },
        "showDependencies": {
          "type": "boolean",
          "default": true
        }
      },
      "additionalProperties": true
    },
    "histogramPresentation": {
      "type": "object",
      "properties": {
        "normalization": {
          "type": "string",
          "enum": [
            "none",
            "percent",
            "density"
          ],
          "default": "none"
        },
        "gap": {
          "type": "number",
          "minimum": 0
        }
      },
      "additionalProperties": true
    },
    "heatmapPresentation": {
      "type": "object",
      "properties": {
        "colorScale": {
          "type": "string",
          "enum": [
            "sequential",
            "diverging"
          ],
          "default": "sequential"
        },
        "reverse": {
          "type": "boolean",
          "default": false
        },
        "showValues": {
          "type": "boolean",
          "default": false
        }
      },
      "additionalProperties": true
    },
    "networkPresentation": {
      "type": "object",
      "properties": {
        "directed": {
          "type": "boolean",
          "default": true
        },
        "showLabels": {
          "type": "boolean",
          "default": true
        }
      },
      "additionalProperties": true
    },
    "sankeyPresentation": {
      "type": "object",
      "properties": {
        "nodeWidth": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "nodeGap": {
          "type": "number",
          "minimum": 0
        }
      },
      "additionalProperties": true
    },
    "statusPresentation": {
      "type": "object",
      "properties": {
        "showMessage": {
          "type": "boolean",
          "default": true
        },
        "showSince": {
          "type": "boolean",
          "default": true
        },
        "severityColors": {
          "type": "object",
          "properties": {
            "ok": {
              "type": "string"
            },
            "info": {
              "type": "string"
            },
            "warning": {
              "type": "string"
            },
            "critical": {
              "type": "string"
            },
            "unknown": {
              "type": "string"
            }
          },
          "additionalProperties": true
        }
      },
      "additionalProperties": true
    },
    "link": {
      "type": "object",
      "required": [
        "title",
        "url"
      ],
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1
        },
        "url": {
          "type": "string",
          "minLength": 1
        },
        "target": {
          "type": "string",
          "enum": [
            "same",
            "new"
          ],
          "default": "new"
        }
      },
      "additionalProperties": true
    },
    "fieldPresentation": {
      "type": "object",
      "properties": {
        "displayName": {
          "type": "string",
          "description": "Display label for this result field; it never changes the SQL column name."
        },
        "description": {
          "type": "string",
          "description": "Display-only supporting text for this field."
        },
        "unit": {
          "type": "string",
          "description": "Display-only unit or suffix. It does not replace data returned by SQL."
        },
        "decimals": {
          "type": "integer",
          "minimum": 0,
          "maximum": 20
        },
        "color": {
          "type": "string"
        },
        "noValue": {
          "type": "string",
          "description": "Text shown for NULL or unavailable values."
        },
        "hidden": {
          "type": "boolean",
          "default": false
        },
        "delta": {
          "$ref": "#/$defs/deltaPresentation"
        },
        "thresholds": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/threshold"
          }
        },
        "gauge": {
          "$ref": "#/$defs/gaugePresentation"
        },
        "candlestick": {
          "$ref": "#/$defs/candlestickPresentation"
        },
        "confidence": {
          "$ref": "#/$defs/confidencePresentation"
        },
        "box": {
          "$ref": "#/$defs/boxPresentation"
        },
        "range": {
          "$ref": "#/$defs/rangePresentation"
        },
        "gantt": {
          "$ref": "#/$defs/ganttPresentation"
        },
        "histogram": {
          "$ref": "#/$defs/histogramPresentation"
        },
        "heatmap": {
          "$ref": "#/$defs/heatmapPresentation"
        },
        "network": {
          "$ref": "#/$defs/networkPresentation"
        },
        "sankey": {
          "$ref": "#/$defs/sankeyPresentation"
        },
        "status": {
          "$ref": "#/$defs/statusPresentation"
        },
        "links": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/link"
          }
        }
      },
      "additionalProperties": true
    },
    "fieldConfig": {
      "type": "object",
      "properties": {
        "columns": {
          "type": "object",
          "description": "Display metadata keyed by exact top-level result-column name.",
          "additionalProperties": {
            "$ref": "#/$defs/fieldPresentation"
          },
          "x-altinity-key-completion": {
            "source": "resultColumns"
          }
        }
      },
      "additionalProperties": true
    },
    "panelCfg": {
      "oneOf": [
        {
          "type": "object",
          "required": [
            "type",
            "x",
            "y"
          ],
          "properties": {
            "type": {
              "const": "bar"
            },
            "x": {
              "type": "integer",
              "minimum": 0,
              "description": "Zero-based X-axis column index."
            },
            "y": {
              "type": "array",
              "items": {
                "type": "integer",
                "minimum": 0
              },
              "minItems": 1,
              "uniqueItems": true,
              "description": "Zero-based measure-column indexes."
            },
            "series": {
              "type": [
                "integer",
                "null"
              ],
              "minimum": 0,
              "description": "Optional zero-based series/group column index."
            }
          },
          "additionalProperties": true,
          "description": "Existing chart-family bar configuration."
        },
        {
          "type": "object",
          "required": [
            "type",
            "x",
            "y"
          ],
          "properties": {
            "type": {
              "const": "hbar"
            },
            "x": {
              "type": "integer",
              "minimum": 0,
              "description": "Zero-based X-axis column index."
            },
            "y": {
              "type": "array",
              "items": {
                "type": "integer",
                "minimum": 0
              },
              "minItems": 1,
              "uniqueItems": true,
              "description": "Zero-based measure-column indexes."
            },
            "series": {
              "type": [
                "integer",
                "null"
              ],
              "minimum": 0,
              "description": "Optional zero-based series/group column index."
            }
          },
          "additionalProperties": true,
          "description": "Existing chart-family hbar configuration."
        },
        {
          "type": "object",
          "required": [
            "type",
            "x",
            "y"
          ],
          "properties": {
            "type": {
              "const": "line"
            },
            "x": {
              "type": "integer",
              "minimum": 0,
              "description": "Zero-based X-axis column index."
            },
            "y": {
              "type": "array",
              "items": {
                "type": "integer",
                "minimum": 0
              },
              "minItems": 1,
              "uniqueItems": true,
              "description": "Zero-based measure-column indexes."
            },
            "series": {
              "type": [
                "integer",
                "null"
              ],
              "minimum": 0,
              "description": "Optional zero-based series/group column index."
            }
          },
          "additionalProperties": true,
          "description": "Existing chart-family line configuration."
        },
        {
          "type": "object",
          "required": [
            "type",
            "x",
            "y"
          ],
          "properties": {
            "type": {
              "const": "area"
            },
            "x": {
              "type": "integer",
              "minimum": 0,
              "description": "Zero-based X-axis column index."
            },
            "y": {
              "type": "array",
              "items": {
                "type": "integer",
                "minimum": 0
              },
              "minItems": 1,
              "uniqueItems": true,
              "description": "Zero-based measure-column indexes."
            },
            "series": {
              "type": [
                "integer",
                "null"
              ],
              "minimum": 0,
              "description": "Optional zero-based series/group column index."
            }
          },
          "additionalProperties": true,
          "description": "Existing chart-family area configuration."
        },
        {
          "type": "object",
          "required": [
            "type",
            "x",
            "y"
          ],
          "properties": {
            "type": {
              "const": "pie"
            },
            "x": {
              "type": "integer",
              "minimum": 0,
              "description": "Zero-based X-axis column index."
            },
            "y": {
              "type": "array",
              "items": {
                "type": "integer",
                "minimum": 0
              },
              "minItems": 1,
              "uniqueItems": true,
              "description": "Zero-based measure-column indexes."
            },
            "series": {
              "type": [
                "integer",
                "null"
              ],
              "minimum": 0,
              "description": "Optional zero-based series/group column index."
            }
          },
          "additionalProperties": true,
          "description": "Existing chart-family pie configuration."
        },
        {
          "type": "object",
          "required": [
            "type"
          ],
          "properties": {
            "type": {
              "const": "table"
            }
          },
          "additionalProperties": true,
          "description": "Table panel; no schema-bound fields."
        },
        {
          "type": "object",
          "required": [
            "type"
          ],
          "properties": {
            "type": {
              "const": "logs"
            },
            "time": {
              "$ref": "#/$defs/columnName"
            },
            "msg": {
              "$ref": "#/$defs/columnName"
            },
            "level": {
              "$ref": "#/$defs/columnName"
            }
          },
          "additionalProperties": true,
          "description": "Logs panel with optional exact-name role overrides."
        },
        {
          "type": "object",
          "required": [
            "type",
            "content"
          ],
          "properties": {
            "type": {
              "const": "text"
            },
            "content": {
              "type": "string"
            }
          },
          "additionalProperties": true,
          "description": "Markdown text panel."
        },
        {
          "type": "object",
          "required": [
            "type"
          ],
          "properties": {
            "type": {
              "const": "kpi"
            },
            "layout": {
              "type": "string",
              "enum": [
                "auto",
                "row",
                "grid"
              ],
              "default": "auto"
            }
          },
          "additionalProperties": true,
          "description": "One-row KPI panel. Each eligible top-level result field is one KPI card. Numeric scalars are simple cards; named Tuple(value, delta?) fields are composite cards."
        },
        {
          "type": "object",
          "required": [
            "type"
          ],
          "properties": {
            "type": {
              "const": "stat"
            },
            "layout": {
              "type": "string",
              "enum": [
                "auto",
                "row",
                "grid"
              ],
              "default": "auto"
            }
          },
          "additionalProperties": true,
          "description": "One-row multi-value stat panel for numeric, string, boolean, or named-tuple values."
        },
        {
          "type": "object",
          "required": [
            "type"
          ],
          "properties": {
            "type": {
              "const": "gauge"
            },
            "layout": {
              "type": "string",
              "enum": [
                "auto",
                "row",
                "grid"
              ],
              "default": "auto"
            }
          },
          "additionalProperties": true,
          "description": "One-row gauge panel. Fields may be scalar or named Tuple(value, min?, max?, target?)."
        },
        {
          "type": "object",
          "required": [
            "type",
            "time",
            "series"
          ],
          "properties": {
            "type": {
              "const": "candlestick"
            },
            "time": {
              "$ref": "#/$defs/columnName"
            },
            "series": {
              "$ref": "#/$defs/columnNameList"
            }
          },
          "additionalProperties": true,
          "description": "Rows over time; each series column is Tuple(open, high, low, close, volume?)."
        },
        {
          "type": "object",
          "required": [
            "type",
            "x",
            "series"
          ],
          "properties": {
            "type": {
              "const": "confidence"
            },
            "x": {
              "$ref": "#/$defs/columnName"
            },
            "series": {
              "$ref": "#/$defs/columnNameList"
            }
          },
          "additionalProperties": true,
          "description": "Rows over an X domain; each series column is Tuple(value, lower, upper)."
        },
        {
          "type": "object",
          "required": [
            "type",
            "category",
            "series"
          ],
          "properties": {
            "type": {
              "const": "box"
            },
            "category": {
              "$ref": "#/$defs/columnName"
            },
            "series": {
              "$ref": "#/$defs/columnNameList"
            }
          },
          "additionalProperties": true,
          "description": "Rows by category; each series column is Tuple(min, q1, median, q3, max, outliers?)."
        },
        {
          "type": "object",
          "required": [
            "type",
            "items"
          ],
          "properties": {
            "type": {
              "const": "range"
            },
            "items": {
              "$ref": "#/$defs/columnNameList"
            }
          },
          "additionalProperties": true,
          "description": "Each configured column is a row-oriented Tuple(label?, start, end, value?, lane?, status?)."
        },
        {
          "type": "object",
          "required": [
            "type",
            "item"
          ],
          "properties": {
            "type": {
              "const": "gantt"
            },
            "item": {
              "$ref": "#/$defs/columnName"
            }
          },
          "additionalProperties": true,
          "description": "Each row contains one task Tuple(id, label, start, end, progress?, state?, parent?, dependencies?)."
        },
        {
          "type": "object",
          "required": [
            "type",
            "buckets"
          ],
          "properties": {
            "type": {
              "const": "histogram"
            },
            "buckets": {
              "$ref": "#/$defs/columnNameList"
            }
          },
          "additionalProperties": true,
          "description": "Each configured column is Tuple(lower, upper, count)."
        },
        {
          "type": "object",
          "required": [
            "type",
            "cells"
          ],
          "properties": {
            "type": {
              "const": "heatmap"
            },
            "cells": {
              "$ref": "#/$defs/columnNameList"
            }
          },
          "additionalProperties": true,
          "description": "Each configured column is Tuple(xLower, xUpper, yLower, yUpper, value)."
        },
        {
          "type": "object",
          "required": [
            "type",
            "edge"
          ],
          "properties": {
            "type": {
              "const": "network"
            },
            "edge": {
              "$ref": "#/$defs/columnName"
            }
          },
          "additionalProperties": true,
          "description": "Each row contains one edge Tuple(source, target, value?, sourceLabel?, targetLabel?)."
        },
        {
          "type": "object",
          "required": [
            "type",
            "edge"
          ],
          "properties": {
            "type": {
              "const": "sankey"
            },
            "edge": {
              "$ref": "#/$defs/columnName"
            }
          },
          "additionalProperties": true,
          "description": "Each row contains one flow Tuple(source, target, value, sourceLabel?, targetLabel?)."
        },
        {
          "type": "object",
          "required": [
            "type"
          ],
          "properties": {
            "type": {
              "const": "status"
            },
            "layout": {
              "type": "string",
              "enum": [
                "auto",
                "cards",
                "list"
              ],
              "default": "auto"
            },
            "items": {
              "$ref": "#/$defs/columnNameList"
            }
          },
          "additionalProperties": true,
          "description": "Health/status panel. One-row tuple fields or an explicit item list may be rendered."
        },
        {
          "type": "object",
          "required": [
            "type"
          ],
          "properties": {
            "type": {
              "type": "string",
              "not": {
                "enum": [
                  "bar",
                  "hbar",
                  "line",
                  "area",
                  "pie",
                  "table",
                  "logs",
                  "text",
                  "kpi",
                  "stat",
                  "gauge",
                  "candlestick",
                  "confidence",
                  "box",
                  "range",
                  "gantt",
                  "histogram",
                  "heatmap",
                  "network",
                  "sankey",
                  "status"
                ]
              },
              "description": "Unknown future panel type; preserved for forward compatibility."
            }
          },
          "additionalProperties": true,
          "description": "Forward-compatible unknown panel cfg. Runtime reports unsupported type but persistence remains lossless."
        }
      ],
      "x-altinity-discriminator": "type"
    },
    "panel": {
      "type": "object",
      "required": [
        "cfg"
      ],
      "properties": {
        "cfg": {
          "$ref": "#/$defs/panelCfg"
        },
        "key": {
          "type": [
            "string",
            "null"
          ],
          "description": "Existing chart-family schema key. Name-based and tuple-based panels do not use it."
        },
        "fieldConfig": {
          "$ref": "#/$defs/fieldConfig"
        },
        "transformations": {
          "type": "array"
        },
        "links": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/link"
          }
        }
      },
      "additionalProperties": true
    },
    "dashboard": {
      "type": "object",
      "properties": {
        "role": {
          "type": "string",
          "enum": [
            "panel",
            "filter",
            "setup"
          ],
          "default": "panel"
        },
        "param": {
          "type": "string",
          "minLength": 1
        },
        "layout": {
          "type": "object"
        },
        "refresh": {
          "type": "object"
        }
      },
      "additionalProperties": true
    }
  },
  "x-altinity-specVersion": 1
}
```

## Example: valid multi-KPI Spec

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
          "unit": "%",
          "decimals": 1,
          "delta": {
            "unit": " pp",
            "decimals": 1,
            "positiveIsGood": false
          }
        }
      }
    }
  }
}
```

## Example: structurally invalid Spec

```jsonc
{
  "favorite": "yes",
  "panel": {
    "cfg": {
      "type": "candlestick",
      "series": []
    },
    "fieldConfig": {
      "columns": {
        "price": {
          "decimals": -1
        }
      }
    }
  }
}
```

Expected schema findings:

```text
favorite must be boolean
candlestick cfg requires time
series must contain at least one item
decimals must be >= 0
```

## Recommended tests

### Schema validity

- Draft 2020-12 meta-schema accepts the schema;
- `$ref` targets resolve;
- every panel branch has a unique `type` const;
- examples validate.

### Core Spec

- known valid fields pass;
- known wrong types fail;
- blank name fails;
- unknown root fields pass and survive round trip.

### Panel cfg

- every known type accepts its minimal valid shape;
- missing required structural selectors fail;
- unrelated cfg branch properties do not satisfy another branch;
- an unknown future type passes the forward-compatible fallback branch and is preserved;
- runtime reports that the current build cannot render the unknown type.

### Field metadata

- exact column-name map accepts arbitrary valid keys;
- dynamic completion annotation is present;
- decimals boundaries;
- delta booleans;
- thresholds require value/color;
- unknown metadata passes.

### Completion

- property completion by path;
- enum value completion;
- discriminated cfg completion;
- duplicate keys omitted;
- result-column values offered;
- result-column object keys offered;
- no network request;
- incomplete JSON still yields local completion;
- descriptions/defaults/examples surface correctly.

### Diagnostic integration

- instance paths convert to exact path arrays;
- errors highlight the closest existing JSON node;
- Save blocks on schema errors;
- warnings do not block;
- unknown extensions do not produce errors.

## References

- JSON Schema Draft 2020-12 Core: <https://json-schema.org/draft/2020-12/json-schema-core>
- JSON Schema Draft 2020-12 Validation: <https://json-schema.org/draft/2020-12/json-schema-validation>
- CodeMirror reference manual: <https://codemirror.net/docs/ref/>
- ClickHouse JSON formats: <https://clickhouse.com/docs/interfaces/formats>
