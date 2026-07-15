import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidLibraryDocument } from '../../examples/validate-library.mjs';
import { parseImportDoc } from '../../src/core/saved-io.js';
import { querySpecSchemaService } from '../../src/core/spec-schema.js';
import { filterExecution } from '../../src/core/filter-execution.js';
import { effectiveDashboardRole } from '../../src/core/result-choice.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('schema artifacts and examples', () => {
  it('keeps generated schema artifacts deterministic and current', () => {
    expect(() => execFileSync(process.execPath, ['build/compile-json-schemas.mjs', '--check'], {
      cwd: root, stdio: 'pipe',
    })).not.toThrow();
  });

  it('validates every checked-in example Library and the generated drilldown template', () => {
    const examples = resolve(root, 'examples');
    for (const name of readdirSync(examples).filter((item) => item.endsWith('.json'))) {
      const { queries } = parseImportDoc(readFileSync(resolve(examples, name), 'utf8'));
      expect(queries.length, name).toBeGreaterThan(0);
    }
    const template = readFileSync(resolve(examples, 'iceberg-templates/ice_meta_drilldown.json.tmpl'), 'utf8')
      .replaceAll('__CATALOG__', 'demo');
    expect(parseImportDoc(template).queries.length).toBeGreaterThan(0);
  });

  it('every Filter-role example query is a valid Filter source (single row-returning statement, no params/FORMAT)', () => {
    const examples = resolve(root, 'examples');
    for (const name of readdirSync(examples).filter((item) => item.endsWith('.json'))) {
      const { queries } = parseImportDoc(readFileSync(resolve(examples, name), 'utf8'));
      for (const q of queries) {
        if (effectiveDashboardRole(q.spec) !== 'filter') continue;
        expect(filterExecution(q.sql).diagnostics, `${name}:${q.id}`).toEqual([]);
      }
    }
  });

  it('validates every JSON Spec example used by the authoring documentation', () => {
    for (const name of ['saved-query-spec-json-schema.md', 'visualization-spec-authoring-guide.md']) {
      const source = readFileSync(resolve(root, 'docs/drafts', name), 'utf8');
      const snippets = [...source.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]));
      expect(snippets.length, name).toBeGreaterThan(0);
      for (const spec of snippets) expect(querySpecSchemaService.validate(spec), name).toEqual([]);
    }
  });

  it('makes generator validation fail before an invalid document can be written', () => {
    const valid = {
      format: 'altinity-sql-browser/saved-queries', version: 2, exportedAt: '2026-07-14T00:00:00.000Z',
      queries: [{ id: 'q', sql: 'SELECT 1', specVersion: 1, spec: { panel: { cfg: { type: 'table' } } } }],
    };
    expect(assertValidLibraryDocument(valid).queries).toHaveLength(1);
    valid.queries[0].spec.panel.cfg = { type: 'pie', x: 0, y: [1, 2] };
    expect(() => assertValidLibraryDocument(valid)).toThrow('panel.cfg.y must contain at most 1 item');
  });
});
