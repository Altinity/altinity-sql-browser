import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// #587 AC5 (per R2.10's falsifiability requirement — a fake-panel test alone
// proves an injectable builder accepts injected data, not that adding a REAL
// panel avoids these four files; types are erased at runtime, so a
// compile-time guarantee alone isn't falsifiable either). This is the third
// leg: an executable, source-level check that no panel id/label comparison or
// hard-coded tab-row vocabulary has crept back into the four files #587 AC5
// names — it must go red the moment one does (see the sabotage check in the
// phase report: reintroducing `sidePanel` into `workbench-session.ts`, or a
// hard-coded 'Databases' label into `state.ts`, both fail this test).
//
// Comments are stripped before matching (a best-effort block/line-comment
// regex, not a real parser) — every current mention of these strings in the
// four files is documentation ABOUT the invariant, not code enforcing a
// panel-specific branch, and this test must not flag its own explanatory
// comments as violations.

// `new URL(...)` goes through happy-dom's own (non-Node) URL implementation
// under this test environment, which rejects `file:` schemes — so this
// navigates from `import.meta.url` via `node:path` instead of the global URL.
const here = dirname(fileURLToPath(import.meta.url)); // tests/unit
const root = join(here, '..', '..'); // repo root

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'`])\/\/.*$/gm, '$1');
}

function codeOf(relativePath: string): string {
  return stripComments(readFileSync(join(root, relativePath), 'utf8'));
}

describe('#587 AC5 source contract: no panel id/label selection outside the registry', () => {
  it('workbench-session.ts never mentions `sidePanel` in code — it does not know the concept exists', () => {
    const code = codeOf('src/ui/workbench/workbench-session.ts');
    expect(code).not.toMatch(/sidePanel/);
    // The specific regression #587 replaced: a direct panel-id string compare.
    expect(code).not.toMatch(/===\s*'history'/);
  });

  it('app-preferences.ts never hard-codes a panel id — its union is a TYPE, derived, never a literal comparison', () => {
    const code = codeOf('src/application/app-preferences.ts');
    for (const id of ['library', 'databases', 'dashboards']) {
      expect(code).not.toContain(`'${id}'`);
    }
  });

  it('state.ts never hard-codes a display label — labels belong to the registry, not the state model', () => {
    const code = codeOf('src/state.ts');
    for (const label of ['Databases', 'Dashboards', 'Library', 'History']) {
      expect(code).not.toContain(`'${label}'`);
    }
  });

  it('app.ts never string-compares a lower-panel id directly — it addresses panels only through app.shell.sidePanels', () => {
    const code = codeOf('src/ui/app.ts');
    expect(code).not.toMatch(/sidePanel\.value\s*===\s*'(saved|history|library)'/);
  });

  // #600 review finding 1: `app-shell.ts` is the FOURTH file AC5 names
  // outright ("adding a panel must not touch app-shell.ts") — and the three
  // checks above never covered it, so the four concrete panel-def imports
  // that used to sit right in this file's composition stayed green forever.
  // `buildProductionSidePanelRegistry` (side-panel-registry.ts) is now the
  // ONE place the four defs are listed; this must go red the moment a
  // concrete panel-def import or a bare panel-id literal creeps back into
  // `app-shell.ts`.
  it('app-shell.ts names no concrete panel-def symbol or panel id — panel composition lives in the registry, not the shell', () => {
    const code = codeOf('src/ui/app-shell.ts');
    for (const symbol of ['databasesPanelDef', 'dashboardsPanelDef', 'libraryPanelDef', 'historyPanelDef']) {
      expect(code).not.toContain(symbol);
    }
    for (const id of ['databases', 'dashboards', 'library', 'history']) {
      expect(code).not.toMatch(new RegExp(`['"]${id}['"]`));
    }
  });
});
