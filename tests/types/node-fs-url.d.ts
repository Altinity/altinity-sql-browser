// Minimal ambient shapes for Node's `node:fs`/`node:url` built-ins, scoped to
// exactly what `tests/unit/side-panel-source-contract.test.ts` imports
// (`readFileSync`, `fileURLToPath`). The repo carries no `@types/node`
// devDependency (ADR-0002 is dev-time-only strict TS over the browser-shipped
// source — CLAUDE.md hard rule 1/4; `tests/types/node-crypto.d.ts` is the
// precedent for this exact pattern). Must live in its own import/export-free
// file — `declare module` in a file that already has top-level imports is
// parsed as an augmentation of an existing module, which fails for a module
// TS otherwise can't resolve at all.
declare module 'node:fs' {
  function readFileSync(path: string, encoding: string): string;
  export { readFileSync };
}
declare module 'node:url' {
  function fileURLToPath(url: string): string;
  export { fileURLToPath };
}
declare module 'node:path' {
  function dirname(path: string): string;
  function join(...parts: string[]): string;
  export { dirname, join };
}
