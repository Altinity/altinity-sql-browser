// Architecture boundary guard (issue #276). Rule list, grown per phase:
//   Phase 0 — src/application/ must not import src/ui/ or src/editor/: the
//   service layer coordinates state and network, it does not reach into DOM
//   rendering or the CodeMirror editor adapters.
//   Phase 3 — the route sessions must not import each other's implementation
//   modules (ui/workbench ↔ ui/dashboard), and the dashboard route must not
//   depend on the editor ports at all.
//   Phase 5 — neither route shell (ui/workbench/**, ui/dashboard.ts +
//   ui/dashboard/**) may import src/ui/app.ts: both receive everything they
//   need injected (a narrow deps bag / the App type only) — reaching back
//   into app.ts itself would recreate the coupling this phase removes.
// `import type` counts too: a type-only import still couples the layers at
// compile time. Extend RULES below in later phases rather than growing a
// second script.
//
// Hand-rolled regex scan, no AST parser: the codebase has no exotic import
// syntax, so scanning for import/export specifiers is enough and keeps this
// a zero-dependency, sub-second pretest step.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXT = /\.(ts|tsx|js|mjs)$/;

/** Each rule: every source file under `dir` must not import anything that
 *  resolves under any of `forbidden` (directories OR single files,
 *  repo-relative — `dir` itself may also name a single file, e.g.
 *  `src/ui/dashboard.ts`, since that route shell has no dedicated directory
 *  of its own the way `src/ui/workbench/**`/`src/ui/dashboard/**` do). */
const RULES = [
  { dir: 'src/application', forbidden: ['src/ui', 'src/editor'], why: 'issue #276 day-1 rule' },
  {
    dir: 'src/ui/workbench',
    forbidden: ['src/ui/dashboard', 'src/ui/app.ts'],
    why: 'issue #276 Phase 3/5: route sessions must not import each other, and the shell must not reach back into app.ts (everything it needs is injected)',
  },
  {
    dir: 'src/ui/dashboard',
    forbidden: ['src/ui/workbench', 'src/editor', 'src/ui/app.ts'],
    why: 'issue #276 Phase 3/5: route sessions must not import each other, dashboard has no editor, and the shell must not reach back into app.ts',
  },
  {
    // The dashboard route's own shell file (no dedicated directory, unlike
    // its `dashboard-session.ts` runtime under `src/ui/dashboard/`) — same
    // Phase 5 rule as the workbench shell above.
    dir: 'src/ui/dashboard.ts',
    forbidden: ['src/ui/app.ts'],
    why: 'issue #276 Phase 5: the dashboard shell must not reach back into app.ts (everything it needs is injected)',
  },
];

function collectFiles(target) {
  if (fs.statSync(target).isFile()) return SOURCE_EXT.test(target) ? [target] : [];
  const out = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
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
let checkedFiles = 0;
let activeRules = 0;
for (const rule of RULES) {
  const ruleDir = path.join(repoRoot, rule.dir);
  const files = fs.existsSync(ruleDir) ? collectFiles(ruleDir) : [];
  if (files.length === 0) continue; // directory not born yet — rule activates with it
  activeRules += 1;
  checkedFiles += files.length;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const spec of extractSpecifiers(source)) {
      if (!spec.startsWith('.')) continue; // bare/package specifiers can't reach src dirs
      const resolved = resolveRelative(file, spec);
      const relResolved = path.relative(repoRoot, resolved).split(path.sep).join('/');
      const hit = rule.forbidden.find((f) => relResolved === f || relResolved.startsWith(`${f}/`));
      if (hit) {
        const relFile = path.relative(repoRoot, file).split(path.sep).join('/');
        violations.push(`${relFile} → ${spec} (resolved: ${relResolved}; ${rule.dir} must not import ${hit} — ${rule.why})`);
      }
    }
  }
}

if (violations.length) {
  console.error('check-boundaries: layer-boundary violations (issue #276):');
  for (const line of violations) console.error(`  ${line}`);
  process.exit(1);
}

if (checkedFiles === 0) {
  console.log('check-boundaries: no files under any guarded directory yet');
  process.exit(0);
}
console.log(`check-boundaries: OK (${checkedFiles} file${checkedFiles === 1 ? '' : 's'} across ${activeRules} active rule${activeRules === 1 ? '' : 's'}, no violations)`);
process.exit(0);
