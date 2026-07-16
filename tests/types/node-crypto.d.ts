// Minimal ambient shape for Node's `node:crypto` built-in, scoped to exactly
// what `tests/unit/pkce.test.ts` imports (`webcrypto`, the real Web Crypto
// implementation). The repo carries no `@types/node` devDependency (ADR-0002
// is dev-time-only strict TS over the browser-shipped source — CLAUDE.md hard
// rule 1/4), so this one ambient declaration stands in for it rather than
// adding a new dependency for a single test import. Must live in its own
// import/export-free file (a "script", not a module) — `declare module` in a
// file that already has top-level imports is parsed as an augmentation of an
// existing module, which fails for a module TS otherwise can't resolve at
// all. `Crypto` is already in scope via tsconfig's `lib: [..., "DOM"]`.
declare module 'node:crypto' {
  const webcrypto: Crypto;
  export { webcrypto };
}
