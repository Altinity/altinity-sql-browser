# Design reference bundle (imported)

This directory is a verbatim snapshot of the **"sql browser"** Claude Design
project's `design_handoff_altinity_play/` handoff bundle — the UI source-of-truth
for the editor-enhancement work (issues #23–#27).

**Reference only — not shipped.** These are React/Babel prototypes. The production
app is the zero-dependency vanilla-ES-module SPA under `src/`. esbuild bundles only
`src/main.js` → `dist/sql.html`, so nothing here is built into the served artifact,
and `tests/` coverage (`include: ['src/**/*.js']`) never sees it.

Start with `README.md` (the full handoff: design tokens, region-by-region spec, and
the per-issue editor-enhancement reference). The `.jsx` files are the reference
implementations to port.
