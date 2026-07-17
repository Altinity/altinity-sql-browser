// Architecture boundary guard (issue #276 Phase 0). Day-1 rule only: modules
// under src/application/ must not import from src/ui/ or src/editor/ — the
// route/session layer coordinates state and network, it does not reach into
// DOM rendering or the CodeMirror editor adapters. `import type` counts too:
// a type-only import still couples the layers at compile time. Later phases
// (#276 Phases 3-5) extend the rule set (e.g. route sessions must not import
// each other) — add checks here rather than growing a second script.
//
// Hand-rolled regex scan, no AST parser: the codebase has no exotic import
// syntax, so scanning for import/export specifiers is enough and keeps this
// a zero-dependency, sub-second pretest step.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(repoRoot, 'src', 'application');
const FORBIDDEN = ['src/ui', 'src/editor'];
const SOURCE_EXT = /\.(ts|tsx|js|mjs)$/;

function collectFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

const files = fs.existsSync(appDir) ? collectFiles(appDir) : [];
if (files.length === 0) {
  console.log('check-boundaries: no files under src/application/ yet');
  process.exit(0);
}

// Matches, in order: static `import ... from '...'` (incl. `import type`),
// `export ... from '...'` (incl. `export type`), a bare side-effect
// `import '...'`, and dynamic `import('...')`. Each pattern requires only
// identifier/brace/comma/whitespace characters between the keyword and
// `from`, so it can't skip past a from-less import into a later statement's
// clause, and `\b` keeps it off the word "import" inside an identifier.
const SPECIFIER_PATTERNS = [
  /\bimport\s+[\w*{}\s,]+\s+from\s*['"]([^'"]+)['"]/g,
  /\bexport\s+[\w*{}\s,]+\s+from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
];

function extractSpecifiers(source) {
  const specs = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) specs.push(match[1]);
  }
  return specs;
}

// Relative specifiers resolve like esbuild/tsc do: a `.js` specifier written
// against a `.ts` source file still resolves to the `.ts` file on disk.
function resolveRelative(fromFile, spec) {
  const resolved = path.resolve(path.dirname(fromFile), spec);
  const noExt = resolved.replace(/\.(ts|tsx|js|mjs)$/, '');
  const candidates = [
    resolved, `${noExt}.ts`, `${noExt}.tsx`, `${noExt}.js`, `${noExt}.mjs`,
    path.join(resolved, 'index.ts'), path.join(resolved, 'index.js'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? resolved;
}

const violations = [];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const spec of extractSpecifiers(source)) {
    if (!spec.startsWith('.')) continue; // bare/package specifiers can't reach src/ui or src/editor
    const resolved = resolveRelative(file, spec);
    const relResolved = path.relative(repoRoot, resolved).split(path.sep).join('/');
    const inForbidden = FORBIDDEN.some((f) => relResolved === f || relResolved.startsWith(`${f}/`));
    if (inForbidden) {
      const relFile = path.relative(repoRoot, file).split(path.sep).join('/');
      violations.push(`${relFile} → ${spec} (resolved: ${relResolved})`);
    }
  }
}

if (violations.length) {
  console.error('check-boundaries: src/application/ must not import src/ui/ or src/editor/ (issue #276, day-1 rule):');
  for (const line of violations) console.error(`  ${line}`);
  process.exit(1);
}

console.log(`check-boundaries: OK (${files.length} file${files.length === 1 ? '' : 's'} under src/application/, no ui/editor imports)`);
process.exit(0);
