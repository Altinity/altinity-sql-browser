# Decision table (plan §29/§30 — generated from `results.json`, never hand-edited)

| Gate | Result | Evidence |
|---|---|---|
| exact-value parity | pass | parity.test.ts + live-precision.test.ts |
| progressive first-row parity | pass | parity.test.ts + live-parity.test.ts timing block |
| mid-stream error parity | pass | parity.test.ts + live-parity.test.ts exception block |
| auth/epoch parity | pass | parity.test.ts auth/epoch blocks |
| raw/export bytes | pass | parity.test.ts raw/export block |
| supported-server matrix | pass | docs/evidence/585/compatibility-matrix.md |
| browser matrix | pass | docs/evidence/585/compatibility-matrix.md (browser section) |
| single-file build | pass | docs/evidence/585/candidate/* |
| bundle delta | measured | docs/evidence/585/candidate/normalized-bundle-size-report.md |
| net production-code deletion | measured | docs/evidence/585/deletion-estimate.md |

**Decision: Accepted**

- every hard gate passed or was positively measured/estimated
