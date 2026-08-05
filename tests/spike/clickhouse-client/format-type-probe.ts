// Phase 0 / issue #585, ADR-0005 §16 — compile-time proof of whether the
// installed `@clickhouse/client-web@1.23.1` publicly supports requesting
// `JSONStringsEachRowWithProgress` (the exact format `src/net/ch-client.ts`
// uses for Table streaming — see `chUrl`'s default and `runQuery`'s
// `fmtParam`).
//
// This file is included in the root `tsconfig.json` (`tests/spike/
// clickhouse-client/**/*.ts`) so `npm run check:types` compiles it under the
// repository's normal strict settings. A future upstream type-surface change
// (the format becoming supported, or the `@ts-expect-error` becoming
// unnecessary) makes `check:types` FAIL until this file and the ADR evidence
// are reconciled — the file is the compile-time proof, not just a comment
// about one.
//
// Never imported by production or by the parity harness — it exists purely
// to be type-checked and to fail loudly on a `@ts-expect-error` mismatch.

import { createClient } from '@clickhouse/client-web';

// A non-secret, unused-at-runtime client instance: this module is never
// executed (no test imports it, no build entry references it), only
// type-checked. `noUnusedLocals`/`noUnusedParameters` are not enabled in the
// repository's tsconfig, so an unused top-level const is fine here — but to
// stay unambiguous about intent, every probe below is inlined into a single
// generic function signature check instead of constructing a real client.

declare const client: ReturnType<typeof createClient>;

// ── Positive control ─────────────────────────────────────────────────────
// `JSONEachRowWithProgress` (the KPI-path format, unquoted numeric progress)
// IS part of the public `DataFormat` literal union
// (`SupportedJSONFormats`/`StreamableJSONFormats` in
// `dist/common/data_formatter/formatter.d.ts`). An uncast call must compile.
void client.query({ query: 'SELECT 1', format: 'JSONEachRowWithProgress' });

// ── Negative probe ───────────────────────────────────────────────────────
// `JSONStringsEachRowWithProgress` (the Table-path format
// `chUrl`/`runQuery` default to — every numeric/precision-sensitive value
// arrives pre-stringified by the server, which is exactly what
// `core/stream.ts`'s `applyStreamLine` and the precision corpus rely on) is
// NOT a member of `SupportedJSONFormats`/`StreamableJSONFormats`/`DataFormat`
// in the installed 1.23.1 `dist/common/data_formatter/formatter.d.ts`. An
// uncast call is a compile error under the closed literal union — this line
// is expected to fail, and `@ts-expect-error` itself fails `check:types` if
// the line stops erroring (i.e. if upstream ever adds public support).
//
// Diagnostic captured in evidence (docs/evidence/585/critical-questions.md):
// TS2322-class "Argument of type '"JSONStringsEachRowWithProgress"' is not
// assignable to parameter of type 'DataFormat'" (exact literal not part of
// the `JSONDataFormat | RawDataFormat` union).
//
// @ts-expect-error — JSONStringsEachRowWithProgress is not a public DataFormat literal (see ADR-0005 §"JSONStringsEachRowWithProgress decision").
void client.query({ query: 'SELECT 1', format: 'JSONStringsEachRowWithProgress' });

// A type cast does NOT count as public support (plan §16) — recorded here so
// the distinction is visible next to the probe, not exercised: casting past
// the union (`format: 'JSONStringsEachRowWithProgress' as any`) always
// "compiles" and would prove nothing about public support. `exec()` (used
// with the full literal SQL, `FORMAT JSONStringsEachRowWithProgress`) is the
// experimentally-chosen path — see `progress-bridge.ts`.
