// One-time source migration used by the rework-examples workflow. It updates
// the existing generators and regression tests in the same commit as the
// generated example artifacts, then the workflow removes this file.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const write =