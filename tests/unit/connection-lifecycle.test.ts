import { describe, expect, it } from 'vitest';
import {
  connectionLifecyclePresentation,
  initialConnectionLifecycle,
  reduceConnectionLifecycle,
  type AuthenticationPriorState,
  type ConnectionLifecycleState,
} from '../../src/core/connection-lifecycle.js';

const connected = (epoch = 4) => ({ kind: 'connected' as const, epoch });
const starting = (epoch = 4) => ({ kind: 'starting' as const, epoch });
const offline = (epoch = 4) => ({ kind: 'offline' as const, epoch });
const authRequired = (epoch = 4) => ({ kind: 'auth-required' as const, epoch, detail: 'expired' });
const signedOut = (epoch = 4) => ({ kind: 'signed-out' as const, epoch, detail: 'user choice' });
const reauthenticating = (epoch = 4) => ({ kind: 'reauthenticating' as const, epoch });

describe('connection lifecycle reducer', () => {
  it('starts at epoch zero and only includes detail when supplied', () => {
    expect(initialConnectionLifecycle()).toEqual({ kind: 'starting', epoch: 0 });
    expect(initialConnectionLifecycle('restoring')).toEqual({ kind: 'starting', epoch: 0, detail: 'restoring' });
  });

  it('starts interactive authentication in a new epoch', () => {
    expect(reduceConnectionLifecycle(connected(), { type: 'start-authentication', detail: 'renew' }))
      .toEqual({ kind: 'reauthenticating', epoch: 5, detail: 'renew' });
  });

  it('installs credentials in a new epoch', () => {
    expect(reduceConnectionLifecycle(authRequired(), { type: 'credentials-installed' }))
      .toEqual({ kind: 'starting', epoch: 5 });
  });

  it('signs out in a new epoch', () => {
    expect(reduceConnectionLifecycle(connected(), { type: 'signed-out', detail: 'user choice' }))
      .toEqual({ kind: 'signed-out', epoch: 5, detail: 'user choice' });
  });

  it('begins a current refresh from every resumable state, retaining that exact state', () => {
    for (const state of [connected(), starting(), offline()]) {
      const refreshed = reduceConnectionLifecycle(state, { type: 'begin-refresh', epoch: 4, detail: 'renewing' });
      expect(refreshed).toMatchObject({ kind: 'refreshing', epoch: 4, detail: 'renewing' });
      expect(refreshed.kind === 'refreshing' && refreshed.resume).toBe(state);
    }
  });

  it('returns the retained resume state after a successful refresh, never inventing connected', () => {
    for (const state of [connected(), starting(), offline()]) {
      const refreshing = reduceConnectionLifecycle(state, { type: 'begin-refresh', epoch: 4 });
      const resumed = reduceConnectionLifecycle(refreshing, { type: 'refresh-succeeded', epoch: 4 });
      expect(resumed).toBe(state);
    }
  });

  it('moves current starting/offline transport to connected', () => {
    expect(reduceConnectionLifecycle(starting(), { type: 'transport-connected', epoch: 4 }))
      .toEqual({ kind: 'connected', epoch: 4 });
    expect(reduceConnectionLifecycle(offline(), { type: 'transport-connected', epoch: 4, detail: 'probe' }))
      .toEqual({ kind: 'connected', epoch: 4, detail: 'probe' });
  });

  it('moves current non-protected transport state offline', () => {
    for (const state of [starting(), connected(), { kind: 'refreshing', epoch: 4, resume: connected() } as ConnectionLifecycleState]) {
      expect(reduceConnectionLifecycle(state, { type: 'transport-offline', epoch: 4, detail: 'network' }))
        .toEqual({ kind: 'offline', epoch: 4, detail: 'network' });
    }
  });

  it('does not let transport offline overwrite authentication or sign-out states', () => {
    for (const state of [authRequired(), signedOut(), reauthenticating()]) {
      expect(reduceConnectionLifecycle(state, { type: 'transport-offline', epoch: 4 })).toBe(state);
    }
  });

  it('moves a current live state to auth required', () => {
    expect(reduceConnectionLifecycle(connected(), { type: 'auth-required', epoch: 4, detail: 'expired' }))
      .toEqual({ kind: 'auth-required', epoch: 5, detail: 'expired' });
  });

  it('restores the supplied auth failure prior state at the current epoch', () => {
    const prior: AuthenticationPriorState = { kind: 'signed-out', epoch: 1, detail: 'cancelled' };
    expect(reduceConnectionLifecycle(reauthenticating(), {
      type: 'failed-authentication', epoch: 4, prior,
    })).toEqual({ kind: 'signed-out', epoch: 4, detail: 'cancelled' });
  });

  it('returns the same object for stale and illegal events', () => {
    const refreshing: ConnectionLifecycleState = { kind: 'refreshing', epoch: 4, resume: connected() };
    const cases: Array<[ConnectionLifecycleState, Parameters<typeof reduceConnectionLifecycle>[1]]> = [
      [connected(), { type: 'begin-refresh', epoch: 3 }],
      [connected(), { type: 'refresh-succeeded', epoch: 4 }],
      [connected(), { type: 'transport-connected', epoch: 4 }],
      [offline(), { type: 'auth-required', epoch: 3 }],
      [signedOut(), { type: 'auth-required', epoch: 4 }],
      [reauthenticating(), { type: 'failed-authentication', epoch: 3, prior: signedOut() }],
      [connected(), { type: 'failed-authentication', epoch: 4, prior: authRequired() }],
      [refreshing, { type: 'transport-connected', epoch: 4 }],
    ];
    for (const [state, event] of cases) expect(reduceConnectionLifecycle(state, event)).toBe(state);
  });
});

describe('connection lifecycle presentation', () => {
  it.each([
    [connected(), 'Connected', 'ClickHouse connection: connected', 'conn-status connection-chip is-connected tone-success', 'success'],
    [starting(), 'Connecting…', 'ClickHouse connection: connecting', 'conn-status connection-chip is-starting tone-warning', 'warning'],
    [{ kind: 'refreshing', epoch: 4, resume: offline() } as ConnectionLifecycleState, 'Refreshing…', 'ClickHouse connection: refreshing', 'conn-status connection-chip is-refreshing tone-warning', 'warning'],
    [offline(), 'Offline', 'ClickHouse connection: offline', 'conn-status connection-chip is-offline tone-offline', 'offline'],
    [authRequired(), 'Sign in required', 'ClickHouse connection: authentication required', 'conn-status connection-chip is-auth-required tone-error', 'error'],
    [reauthenticating(), 'Signing in…', 'ClickHouse connection: reauthenticating', 'conn-status connection-chip is-reauthenticating tone-warning', 'warning'],
    [signedOut(), 'Signed out', 'ClickHouse connection: signed out', 'conn-status connection-chip is-signed-out tone-neutral', 'neutral'],
  ] as const)('%s projects a concise accessible chip', (state, label, ariaLabel, className, tone) => {
    expect(connectionLifecyclePresentation(state)).toEqual({ label, ariaLabel, className, tone });
  });
});
