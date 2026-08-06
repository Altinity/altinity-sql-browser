// Phase 0 / issue #585 — non-secret credential fixtures shared by the
// deterministic fault-server tests, the local-Docker matrix, and the browser
// harness. None of these are real secrets: Basic users A/B are created
// fresh in each ephemeral local container (`clickhouse-containers.mjs`) with
// throwaway passwords that exist only for the lifetime of that container;
// the Bearer/JWT fixtures are opaque strings the fault server pattern-matches
// on, never sent to a real ClickHouse Cloud endpoint (Cloud Bearer coverage
// is `not evaluated` — see docs/evidence/585/environment.json). Never log or
// commit a REAL credential value (plan §12 "Do not commit ... test
// credentials"); these fixtures are safe to commit because they are inert by
// construction.

import type { SpikeCredential } from './types.js';

export const BASIC_USER_A: SpikeCredential = { kind: 'basic', username: 'asb_spike_a', password: 'asb-spike-a-nonsecret' };
export const BASIC_USER_B: SpikeCredential = { kind: 'basic', username: 'asb_spike_b', password: 'asb-spike-b-nonsecret' };
export const BEARER_FIXTURE: SpikeCredential = { kind: 'bearer', token: 'asb-spike-bearer-fixture-token' };
export const JWT_AS_BASIC_FIXTURE: SpikeCredential = { kind: 'jwt-as-basic', username: 'asb_spike_jwt', jwt: 'asb.spike.jwt-fixture' };
export const INVALID_CREDENTIAL: SpikeCredential = { kind: 'invalid' };

/** SQL fragments creating the fault-server/local-container fixture users —
 * intentionally minimal grants (no superuser), matching plan §12's "create
 * non-secret users for Basic auth, roles, denial, and cancellation
 * observation". */
export const FIXTURE_USER_DDL: string[] = [
  `CREATE USER IF NOT EXISTS ${BASIC_USER_A.kind === 'basic' ? BASIC_USER_A.username : ''} IDENTIFIED WITH plaintext_password BY '${(BASIC_USER_A as { password: string }).password}'`,
  `CREATE USER IF NOT EXISTS ${BASIC_USER_B.kind === 'basic' ? BASIC_USER_B.username : ''} IDENTIFIED WITH plaintext_password BY '${(BASIC_USER_B as { password: string }).password}'`,
  `GRANT SELECT ON system.* TO ${(BASIC_USER_A as { username: string }).username}`,
  `GRANT SELECT ON system.* TO ${(BASIC_USER_B as { username: string }).username}`,
  // A denial fixture: a real user with NO grants, for the 403 taxonomy case.
  `CREATE USER IF NOT EXISTS asb_spike_denied IDENTIFIED WITH plaintext_password BY 'asb-spike-denied-nonsecret'`,
];

export const DENIED_USER: SpikeCredential = { kind: 'basic', username: 'asb_spike_denied', password: 'asb-spike-denied-nonsecret' };
