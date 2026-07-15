import { readFileSync } from 'node:fs';
import { parseImportDoc } from './src/core/saved-io.js';
import { defaultSpecValidationService } from './src/core/spec-draft.js';

const path = process.argv[2];
const text = readFileSync(path, 'utf8');

let decoded;
try {
  decoded = parseImportDoc(text, defaultSpecValidationService);
} catch (err) {
  console.error('PARSE/VALIDATION FAILED:', err && err.message);
  if (err && err.cause) console.error('cause:', JSON.stringify(err.cause, null, 2));
  process.exit(1);
}

console.log('OK —', decoded.queries.length, 'queries validated');
for (const q of decoded.queries) {
  console.log(' -', q.id, '|', q.spec.name, '| role:', q.spec.dashboard?.role || 'panel', '| panel type:', q.spec.panel?.cfg?.type || 'n/a');
}
