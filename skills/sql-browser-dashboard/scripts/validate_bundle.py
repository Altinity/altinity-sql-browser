#!/usr/bin/env python3
"""Validate the strict SQL Browser Dashboard skill authoring profile.

This validator is intentionally self-contained and uses only Python's standard
library. It checks the profile's cross-resource semantics in addition to basic
shape constraints. SQL Browser's production decoder remains authoritative.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

SUPPORTED_PANELS = {"bar", "hbar", "line", "area", "pie", "kpi", "table", "logs", "text"}
CHART_PANELS = {"bar", "hbar", "line", "area", "pie"}
FLOW_PRESETS = {"report", "columns-2", "columns-3"}
FLOW_HEIGHTS = {"compact", "medium", "large"}
PARAM_RE = re.compile(r"\{([^{}:]+):([^{}]+)\}")


class ValidationError(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def non_blank(value: Any, label: str) -> str:
    require(isinstance(value, str) and bool(value.strip()), f"{label} must be a non-blank string")
    return value


def validate_bundle(bundle: Any) -> dict[str, Any]:
    require(isinstance(bundle, dict), "bundle must be a JSON object")
    require(bundle.get("format") == "altinity-sql-browser/portable-bundle", "bundle.format must be altinity-sql-browser/portable-bundle")
    require(bundle.get("version") == 2, "bundle.version must be 2")
    non_blank(bundle.get("exportedAt"), "bundle.exportedAt")

    queries = bundle.get("queries")
    dashboards = bundle.get("dashboards")
    require(isinstance(queries, list) and 1 <= len(queries) <= 100, "bundle.queries must contain 1..100 queries")
    require(isinstance(dashboards, list) and len(dashboards) == 1, "bundle.dashboards must contain exactly one Dashboard")

    query_by_id: dict[str, dict[str, Any]] = {}
    inferred_variables: dict[str, set[str]] = {}

    for index, query in enumerate(queries):
        path = f"queries[{index}]"
        require(isinstance(query, dict), f"{path} must be an object")
        qid = non_blank(query.get("id"), f"{path}.id")
        require(qid not in query_by_id, f"duplicate query id: {qid}")
        require(isinstance(query.get("sql"), str), f"{path}.sql must be a string")
        require(query.get("specVersion") == 1, f"{path}.specVersion must be 1")

        spec = query.get("spec")
        require(isinstance(spec, dict), f"{path}.spec must be an object")
        non_blank(spec.get("name"), f"{path}.spec.name")
        require(spec.get("view") == "panel", f"{path}.spec.view must be panel")

        panel = spec.get("panel")
        require(isinstance(panel, dict), f"{path}.spec.panel must be an object")
        cfg = panel.get("cfg")
        require(isinstance(cfg, dict), f"{path}.spec.panel.cfg must be an object")
        panel_type = cfg.get("type")
        require(panel_type in SUPPORTED_PANELS, f"{path} uses unsupported panel type {panel_type!r}")

        if panel_type in CHART_PANELS:
            require(isinstance(cfg.get("x"), int) and cfg["x"] >= 0, f"{path} chart x must be a zero-based integer")
            y = cfg.get("y")
            require(isinstance(y, list) and y and all(isinstance(v, int) and v >= 0 for v in y), f"{path} chart y must be a non-empty array of zero-based integers")
            require(len(y) == len(set(y)), f"{path} chart y indexes must be unique")
            if panel_type == "pie":
                require(len(y) == 1, f"{path} pie panel must have exactly one y index")
            series = cfg.get("series")
            require(series is None or (isinstance(series, int) and series >= 0), f"{path} chart series must be null or a zero-based integer")

        if panel_type == "text":
            require(isinstance(cfg.get("content"), str), f"{path} text panel requires string content")

        dashboard_spec = spec.get("dashboard")
        require(isinstance(dashboard_spec, dict), f"{path}.spec.dashboard must be an object")
        require(dashboard_spec.get("role") == "panel", f"{path}.spec.dashboard.role must be panel")

        query_by_id[qid] = query
        for name, ch_type in PARAM_RE.findall(query["sql"]):
            inferred_variables.setdefault(name, set()).add(ch_type)

    dashboard = dashboards[0]
    require(isinstance(dashboard, dict), "dashboards[0] must be an object")
    require(dashboard.get("documentVersion") == 2, "Dashboard documentVersion must be 2")
    dashboard_id = non_blank(dashboard.get("id"), "Dashboard id")
    title = non_blank(dashboard.get("title"), "Dashboard title")
    require(isinstance(dashboard.get("revision"), int) and dashboard["revision"] >= 1, "Dashboard revision must be an integer >= 1")

    tiles = dashboard.get("tiles")
    require(isinstance(tiles, list) and 1 <= len(tiles) <= 100, "Dashboard tiles must contain 1..100 entries")
    tile_ids: set[str] = set()
    referenced_query_ids: set[str] = set()
    for index, tile in enumerate(tiles):
        path = f"dashboard.tiles[{index}]"
        require(isinstance(tile, dict), f"{path} must be an object")
        tile_id = non_blank(tile.get("id"), f"{path}.id")
        require(tile_id not in tile_ids, f"duplicate tile id: {tile_id}")
        tile_ids.add(tile_id)
        query_id = non_blank(tile.get("queryId"), f"{path}.queryId")
        require(query_id in query_by_id, f"{path}.queryId references missing query {query_id!r}")
        referenced_query_ids.add(query_id)

    require(set(query_by_id) == referenced_query_ids, "bundle queries must equal the exact tile query dependency closure")

    layout = dashboard.get("layout")
    require(isinstance(layout, dict), "Dashboard layout must be an object")
    require(layout.get("type") == "flow" and layout.get("version") == 1, "Dashboard layout must be flow@1")
    require(layout.get("preset") in FLOW_PRESETS, "Dashboard flow preset must be report, columns-2, or columns-3")
    items = layout.get("items")
    require(isinstance(items, dict), "Dashboard layout.items must be an object")
    require(set(items) == tile_ids, "generated Dashboard layout.items must contain exactly every tile id")
    for tile_id, placement in items.items():
        require(isinstance(placement, dict), f"layout placement for {tile_id} must be an object")
        if "span" in placement:
            require(placement["span"] in {1, 2, 3}, f"layout span for {tile_id} must be 1, 2, or 3")
        if "height" in placement:
            require(placement["height"] in FLOW_HEIGHTS, f"layout height for {tile_id} is invalid")

    for name, types in inferred_variables.items():
        require(len(types) == 1, f"variable {name!r} is declared with inconsistent ClickHouse types: {sorted(types)}")

    variable_configs = dashboard.get("variableConfigs", {})
    require(isinstance(variable_configs, dict), "Dashboard variableConfigs must be an object")
    for name, config in variable_configs.items():
        require(name in inferred_variables, f"variableConfigs contains orphaned key {name!r}")
        require(isinstance(config, dict), f"variable config {name!r} must be an object")
        sql = non_blank(config.get("sql"), f"variableConfigs.{name}.sql")
        require(not PARAM_RE.search(sql), f"variable option SQL for {name!r} must not reference Dashboard variables")

    return {
        "dashboard_id": dashboard_id,
        "title": title,
        "query_count": len(queries),
        "tile_count": len(tiles),
        "variables": sorted(inferred_variables),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path, help="PortableBundleV2 JSON file")
    parser.add_argument("--normalized-out", type=Path, help="Write deterministic compact JSON after validation")
    args = parser.parse_args()

    try:
        raw = args.bundle.read_text(encoding="utf-8")
        bundle = json.loads(raw)
        summary = validate_bundle(bundle)
        if args.normalized_out:
            args.normalized_out.write_text(
                json.dumps(bundle, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n",
                encoding="utf-8",
            )
    except (OSError, json.JSONDecodeError, ValidationError) as exc:
        print(f"INVALID: {exc}", file=sys.stderr)
        return 1

    print(
        "VALID: "
        f"{summary['title']} ({summary['dashboard_id']}); "
        f"{summary['query_count']} queries, {summary['tile_count']} tiles, "
        f"variables={summary['variables']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
