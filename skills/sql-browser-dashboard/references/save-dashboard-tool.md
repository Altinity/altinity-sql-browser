# Altinity MCP `save_dashboard` contract

## Skill-visible tool

The skill requires one Altinity MCP dynamic tool with the exact basename:

```text
save_dashboard
```

Recommended reflected signature:

```text
save_dashboard(payload: string)
```

`payload` is the complete JSON-encoded SQL Browser PortableBundleV2 containing exactly one Dashboard and its exact query dependency closure.

A single-payload tool is preferred over duplicating `dashboard_id`, title, version, and counts as caller-supplied arguments. The storage write path can derive catalogue metadata from the validated bundle, preventing metadata drift or spoofing.

## Server-side reflection pattern

Follow the BentoClick pattern:

1. expose a narrow write relation suitable for Altinity MCP reflection;
2. use primitive reflected column types (`String` for JSON text);
3. grant only the required column-level `INSERT` privilege to the MCP writer role;
4. route writes through a validating `SQL SECURITY DEFINER` materialized view;
5. keep direct `INSERT` on the readable catalogue table unavailable to ordinary writers;
6. let the server derive author and version metadata.

Conceptual objects:

```text
asb.dashboards_raw   Null engine; reflected as save_dashboard(payload String)
        │
        ▼
asb.dashboards_mv    validates/extracts bundle metadata under definer privileges
        │
        ▼
asb.dashboards       versioned read catalogue consumed by SQL Browser
```

The exact Altinity MCP deployment YAML is deployment-specific and intentionally outside this skill. Configure the dynamic tool alias so the reflected write relation appears to agents as `save_dashboard`.

## Catalogue metadata derived by the server

From the payload:

- `dashboard_id` = the only Dashboard document's `id`;
- `title` = the Dashboard document's `title`;
- `description` = the Dashboard document's description or empty string;
- `bundle_version` = top-level bundle version;
- `query_count` = top-level query array length;
- `tile_count` = Dashboard tile array length;
- `payload` = original validated JSON text.

From server/session defaults:

- `version` = generated immutable `UInt64` version;
- `saved_at` = timestamp derived from or stored with the version;
- `saved_by` = authenticated ClickHouse/MCP user.

## Minimum write-path checks

The server-side write path should reject at least:

- malformed JSON;
- wrong bundle format or version;
- zero or multiple Dashboards;
- missing Dashboard ID/title;
- count fields inconsistent with the payload if duplicated anywhere;
- payload above the deployment's accepted byte bound.

SQL Browser still validates the complete bundle as untrusted input during catalogue import. The materialized view is a write-path guard, not a replacement for the browser decoder.

## Invocation rules

- Call once per complete Dashboard publication.
- Never send one request per query or tile.
- Never include credentials or connection details inside the payload.
- Do not automatically retry ambiguous failures.
- Do not claim a version unless returned explicitly by the tool.
