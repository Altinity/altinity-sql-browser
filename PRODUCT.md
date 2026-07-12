# SQL Browser

## Register

product

## Platform

web

## Users

SQL Browser is primarily for ClickHouse DBAs and data analysts. They work with live data in a task-focused environment and need equal support for ad-hoc querying and investigation, operational monitoring, and building reusable dashboards.

## Product Purpose

SQL Browser provides a complete ClickHouse-native workspace without the feature overload of a generic database IDE or observability platform. Success means users can move quickly from a question or operational signal to a trustworthy answer, then preserve useful work as a query, panel, or dashboard.

## Positioning

The focused SQL workspace that supports ClickHouse features exceptionally well while remaining simple enough to understand at a glance.

## Brand Personality

Precise, calm, capable. The interaction quality should have Notion's approachable restraint while preserving the density and rigor expected by database professionals.

## Anti-references

Avoid Grafana-style configuration density, IDE-like complexity, decorative dashboards, and controls that expose implementation detail before the user needs it. The product must not accumulate generic database features that dilute its ClickHouse focus or create visual and cognitive overload.

## Design Principles

1. Keep the task primary. Querying, investigating, monitoring, and composing dashboards should dominate the interface; product chrome should recede.
2. Be ClickHouse-native, not generically database-shaped. Support ClickHouse concepts deeply and present them in the language its users already understand.
3. Reveal complexity when it becomes useful. Prefer strong defaults, contextual controls, and progressive disclosure over permanent configuration surfaces.
4. Preserve continuity across workflows. A result should move naturally between inspection, visualization, saving, sharing, and dashboard use without changing mental models.
5. Earn trust through precision. State, errors, limits, loading, and destructive consequences should be explicit, consistent, and technically accurate.

## Accessibility & Inclusion

Target WCAG 2.2 AA. All core workflows must support keyboard operation, visible focus, sufficient contrast, color-independent meaning, and reduced-motion preferences. Dense data surfaces should remain legible and navigable at responsive sizes and browser zoom levels.
