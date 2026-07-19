import { describe, it, expect } from 'vitest';
import {
  docKindFromServerType,
  docKindToServerType,
  documentationCapabilityFromColumns,
  documentationProbePolicy,
  buildDocumentationSelect,
  buildDocumentationNameSelect,
  DOCUMENTATION_DISAMBIGUATION_LIMIT,
  normalizeDocumentationRow,
  documentationEntryToDocEntry,
  MAX_DOC_MARKDOWN_BYTES,
  type DocumentationCapability,
} from '../../src/core/doc-documentation.js';
import { parseServerVersion } from '../../src/core/format.js';

const escape = (s: string) => "'" + String(s).replace(/'/g, "''") + "'";

// ── docKindFromServerType / docKindToServerType ─────────────────────────────

describe('docKindFromServerType', () => {
  it('maps every known 26.6.1 server label to its stable DocKind', () => {
    expect(docKindFromServerType('Function')).toBe('function');
    expect(docKindFromServerType('Aggregate Function')).toBe('aggregate-function');
    expect(docKindFromServerType('Table Function')).toBe('table-function');
    expect(docKindFromServerType('Table Engine')).toBe('table-engine');
    expect(docKindFromServerType('Database Engine')).toBe('database-engine');
    expect(docKindFromServerType('Data Type')).toBe('data-type');
    expect(docKindFromServerType('Dictionary Layout')).toBe('dictionary-layout');
    expect(docKindFromServerType('Dictionary Source')).toBe('dictionary-source');
    expect(docKindFromServerType('Aggregate Function Combinator')).toBe('aggregate-combinator');
    expect(docKindFromServerType('Data Skipping Index')).toBe('skipping-index');
    expect(docKindFromServerType('Disk Type')).toBe('disk-type');
    expect(docKindFromServerType('Setting')).toBe('setting');
    expect(docKindFromServerType('MergeTree Setting')).toBe('mergetree-setting');
    expect(docKindFromServerType('Server Setting')).toBe('server-setting');
    expect(docKindFromServerType('Format')).toBe('format');
  });

  it('maps the forward-compatible Codec/Metric/System Table labels even though no live server emits them yet', () => {
    expect(docKindFromServerType('Codec')).toBe('codec');
    expect(docKindFromServerType('Metric')).toBe('metric');
    expect(docKindFromServerType('System Table')).toBe('system-table');
  });

  it('maps an unrecognized label to "unknown", preserving nothing itself (the caller keeps the original label separately)', () => {
    expect(docKindFromServerType('Something Future')).toBe('unknown');
    expect(docKindFromServerType('')).toBe('unknown');
  });
});

describe('docKindToServerType', () => {
  it('is the reverse of docKindFromServerType for every known kind', () => {
    expect(docKindToServerType('function')).toBe('Function');
    expect(docKindToServerType('mergetree-setting')).toBe('MergeTree Setting');
    expect(docKindToServerType('codec')).toBe('Codec');
  });

  it('returns null for "unknown" — no server label to query by', () => {
    expect(docKindToServerType('unknown')).toBeNull();
  });
});

// ── documentationCapabilityFromColumns ──────────────────────────────────────

describe('documentationCapabilityFromColumns', () => {
  it('full four-column shape: available, source confirmed', () => {
    expect(documentationCapabilityFromColumns(['name', 'type', 'description', 'source']))
      .toEqual({ available: true, source: true });
  });

  it('real 26.6.1 three-column shape (no source): still available, source false', () => {
    expect(documentationCapabilityFromColumns(['name', 'type', 'description']))
      .toEqual({ available: true, source: false });
  });

  it('column order does not matter', () => {
    expect(documentationCapabilityFromColumns(['description', 'source', 'type', 'name']))
      .toEqual({ available: true, source: true });
  });

  it('missing "name" -> unavailable', () => {
    expect(documentationCapabilityFromColumns(['type', 'description', 'source']))
      .toEqual({ available: false, source: false });
  });

  it('missing "type" -> unavailable', () => {
    expect(documentationCapabilityFromColumns(['name', 'description', 'source']))
      .toEqual({ available: false, source: false });
  });

  it('missing "description" -> unavailable', () => {
    expect(documentationCapabilityFromColumns(['name', 'type', 'source']))
      .toEqual({ available: false, source: false });
  });

  it('empty column list (missing table / denied) -> unavailable', () => {
    expect(documentationCapabilityFromColumns([])).toEqual({ available: false, source: false });
  });
});

// ── documentationProbePolicy ─────────────────────────────────────────────────

describe('documentationProbePolicy', () => {
  it('skips below 26.6', () => {
    expect(documentationProbePolicy(parseServerVersion('26.5.9'))).toBe('skip');
    expect(documentationProbePolicy(parseServerVersion('25.9'))).toBe('skip');
    expect(documentationProbePolicy(parseServerVersion('1.0'))).toBe('skip');
  });

  it('probes at exactly 26.6 and above', () => {
    expect(documentationProbePolicy(parseServerVersion('26.6.0'))).toBe('probe');
    expect(documentationProbePolicy(parseServerVersion('26.6'))).toBe('probe');
    expect(documentationProbePolicy(parseServerVersion('26.7.1'))).toBe('probe');
    expect(documentationProbePolicy(parseServerVersion('27.0'))).toBe('probe');
  });

  it('probes (does not assume either way) when the version is null/unparsable', () => {
    expect(documentationProbePolicy(null)).toBe('probe');
    expect(documentationProbePolicy(parseServerVersion('not-a-version'))).toBe('probe');
    expect(documentationProbePolicy(parseServerVersion(undefined))).toBe('probe');
  });
});

// ── SQL construction ─────────────────────────────────────────────────────────

const FULL_CAP: DocumentationCapability = { available: true, source: true };
const NO_SOURCE_CAP: DocumentationCapability = { available: true, source: false };
const UNAVAILABLE_CAP: DocumentationCapability = { available: false, source: false };

describe('buildDocumentationSelect', () => {
  it('returns null when the capability is unavailable', () => {
    expect(buildDocumentationSelect(UNAVAILABLE_CAP, 'setting', 'max_threads', escape)).toBeNull();
  });

  it('returns null when the kind has no known server type label', () => {
    expect(buildDocumentationSelect(FULL_CAP, 'unknown', 'whatever', escape)).toBeNull();
  });

  it('still builds a query for the forward-compatible "codec" kind (it HAS a label, "Codec" — just no live server emits it yet)', () => {
    const sql = buildDocumentationSelect(FULL_CAP, 'codec', 'ZSTD', escape)!;
    expect(sql).toContain("WHERE type = 'Codec'");
  });

  it('builds a type+name-filtered SELECT with source when confirmed present', () => {
    const sql = buildDocumentationSelect(FULL_CAP, 'setting', 'max_threads', escape)!;
    expect(sql).toContain('SELECT name, type, description, source FROM system.documentation');
    expect(sql).toContain("WHERE type = 'Setting' AND (");
    expect(sql).toContain("name = 'max_threads'");
    expect(sql).toContain('LIMIT 1 FORMAT JSON');
  });

  it('omits source from the SELECT list when not confirmed present', () => {
    const sql = buildDocumentationSelect(NO_SOURCE_CAP, 'function', 'now', escape)!;
    expect(sql).toContain('SELECT name, type, description FROM system.documentation');
    expect(sql).not.toContain('source');
  });

  it('quotes the name via the escape seam case-insensitively (exact/lower/upper)', () => {
    const sql = buildDocumentationSelect(FULL_CAP, 'table-function', "o'brien", escape)!;
    expect(sql).toContain("name = 'o''brien'");
    expect(sql).toContain("lower(name) = lower('o''brien')");
    expect(sql).toContain("upper(name) = upper('o''brien')");
  });
});

describe('buildDocumentationNameSelect', () => {
  it('returns null when the capability is unavailable', () => {
    expect(buildDocumentationNameSelect(UNAVAILABLE_CAP, 'MergeTree', escape)).toBeNull();
  });

  it('builds a name-only SELECT with no type filter, bounded by the disambiguation limit', () => {
    const sql = buildDocumentationNameSelect(FULL_CAP, 'MergeTree', escape)!;
    expect(sql).not.toContain('type =');
    expect(sql).toContain("name = 'MergeTree'");
    expect(sql).toContain('LIMIT ' + DOCUMENTATION_DISAMBIGUATION_LIMIT + ' FORMAT JSON');
  });

  it('omits source from the SELECT list when not confirmed present', () => {
    const sql = buildDocumentationNameSelect(NO_SOURCE_CAP, 'X', escape)!;
    expect(sql).toContain('SELECT name, type, description FROM system.documentation');
  });
});

// ── normalizeDocumentationRow ────────────────────────────────────────────────

describe('normalizeDocumentationRow', () => {
  it('normalizes a full four-column row (known type label)', () => {
    const row = { name: 'max_threads', type: 'Setting', description: 'Max threads.\nMore detail.', source: 'docs/settings.md' };
    const entry = normalizeDocumentationRow(row, FULL_CAP);
    expect(entry).toEqual({
      target: { kind: 'setting', name: 'max_threads' },
      title: 'max_threads',
      signature: 'max_threads',
      summary: 'Max threads.',
      renderMode: 'markdown-subset',
      markdown: 'Max threads.\nMore detail.',
      serverTypeLabel: 'Setting',
      source: 'docs/settings.md',
    });
  });

  it('normalizes a real 26.6.1 three-column row (no source column at all)', () => {
    const row = { name: 'CSV', type: 'Format', description: 'The CSV format.' };
    const entry = normalizeDocumentationRow(row, NO_SOURCE_CAP);
    expect(entry.source).toBeUndefined();
    expect(entry.target).toEqual({ kind: 'format', name: 'CSV' });
    expect(entry.serverTypeLabel).toBe('Format');
  });

  it('maps the ROW\'s own type label to the DocKind — not whatever was requested', () => {
    const row = { name: 'quantile', type: 'Aggregate Function', description: 'An aggregate function.' };
    const entry = normalizeDocumentationRow(row, NO_SOURCE_CAP);
    expect(entry.target.kind).toBe('aggregate-function');
  });

  it('unrecognized type label -> kind "unknown", label preserved verbatim', () => {
    const row = { name: 'thing', type: 'Some Future Kind', description: 'x' };
    const entry = normalizeDocumentationRow(row, NO_SOURCE_CAP);
    expect(entry.target.kind).toBe('unknown');
    expect(entry.serverTypeLabel).toBe('Some Future Kind');
  });

  it('a null source cell (column confirmed present, value genuinely null) normalizes to undefined', () => {
    const row = { name: 'X', type: 'Setting', description: 'd', source: null };
    const entry = normalizeDocumentationRow(row, FULL_CAP);
    expect(entry.source).toBeUndefined();
  });

  it('a blank/whitespace-only source column normalizes to undefined, not an empty string', () => {
    const row = { name: 'X', type: 'Setting', description: 'd', source: '   ' };
    const entry = normalizeDocumentationRow(row, FULL_CAP);
    expect(entry.source).toBeUndefined();
  });

  it('never throws on a missing name/type/description (defensive normalization)', () => {
    const entry = normalizeDocumentationRow({}, NO_SOURCE_CAP);
    expect(entry.target).toEqual({ kind: 'unknown', name: '' });
    expect(entry.markdown).toBe('');
    expect(entry.summary).toBe('');
  });

  it('summary is empty when the description has content but every line is blank/whitespace', () => {
    const row = { name: 'X', type: 'Setting', description: '\n   \n\t\n  ' };
    const entry = normalizeDocumentationRow(row, NO_SOURCE_CAP);
    expect(entry.summary).toBe('');
  });

  it('summary is the first non-empty line of the (possibly leading-blank) description', () => {
    const row = { name: 'X', type: 'Setting', description: '\n\n  Real summary line.  \nMore.' };
    const entry = normalizeDocumentationRow(row, NO_SOURCE_CAP);
    expect(entry.summary).toBe('Real summary line.');
  });

  it('truncates and flags oversized descriptions beyond MAX_DOC_MARKDOWN_BYTES', () => {
    const big = 'x'.repeat(MAX_DOC_MARKDOWN_BYTES + 500);
    const row = { name: 'Big', type: 'Setting', description: big };
    const entry = normalizeDocumentationRow(row, NO_SOURCE_CAP);
    expect(entry.oversized).toBe(true);
    expect(entry.markdown.length).toBe(MAX_DOC_MARKDOWN_BYTES);
    expect(entry.markdown.length).toBeLessThan(big.length);
  });

  it('does not flag oversized for a description at or under the byte bound', () => {
    const row = { name: 'Small', type: 'Setting', description: 'x'.repeat(MAX_DOC_MARKDOWN_BYTES) };
    const entry = normalizeDocumentationRow(row, NO_SOURCE_CAP);
    expect(entry.oversized).toBeUndefined();
  });

  it('handles a multi-byte description near the byte bound without throwing (decodes defensively)', () => {
    // Each '€' is 3 UTF-8 bytes — a naive char-count truncation would split
    // mid-character right at the boundary; this must not throw.
    const big = '€'.repeat(Math.ceil((MAX_DOC_MARKDOWN_BYTES + 10) / 3));
    const row = { name: 'Euro', type: 'Setting', description: big };
    expect(() => normalizeDocumentationRow(row, NO_SOURCE_CAP)).not.toThrow();
    const entry = normalizeDocumentationRow(row, NO_SOURCE_CAP);
    expect(entry.oversized).toBe(true);
  });
});

describe('documentationEntryToDocEntry', () => {
  it('projects a MarkdownDocEntry to the shared DocEntry shape with sourceTable "documentation"', () => {
    const mdEntry = normalizeDocumentationRow(
      { name: 'max_threads', type: 'Setting', description: 'Max threads.', source: 'docs/x.md' },
      FULL_CAP,
    );
    const entry = documentationEntryToDocEntry(mdEntry);
    expect(entry).toEqual({
      target: { kind: 'setting', name: 'max_threads' },
      title: 'max_threads',
      signature: 'max_threads',
      summary: 'Max threads.',
      categories: [],
      description: 'Max threads.',
      renderMode: 'markdown-subset',
      markdown: 'Max threads.',
      serverTypeLabel: 'Setting',
      source: 'docs/x.md',
      sourceTable: 'documentation',
    });
  });

  it('omits source/oversized on the projected entry when absent', () => {
    const mdEntry = normalizeDocumentationRow({ name: 'CSV', type: 'Format', description: 'd' }, NO_SOURCE_CAP);
    const entry = documentationEntryToDocEntry(mdEntry);
    expect(entry.source).toBeUndefined();
    expect(entry.oversized).toBeUndefined();
  });

  it('carries the oversized flag through to the projected DocEntry', () => {
    const mdEntry = normalizeDocumentationRow(
      { name: 'Big', type: 'Setting', description: 'x'.repeat(MAX_DOC_MARKDOWN_BYTES + 10) },
      NO_SOURCE_CAP,
    );
    const entry = documentationEntryToDocEntry(mdEntry);
    expect(entry.oversized).toBe(true);
  });
});
