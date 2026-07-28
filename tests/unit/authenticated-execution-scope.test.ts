import { describe, expect, it, vi } from 'vitest';
import {
  createAuthenticatedExecutionScope,
  type AuthenticatedCancellationLease,
} from '../../src/application/authenticated-execution-scope.js';

const asFetch = (value: object): typeof fetch => value as typeof fetch;

function makeLease(overrides: Partial<AuthenticatedCancellationLease> = {}): AuthenticatedCancellationLease {
  return {
    epoch: 17,
    origin: 'https://old-cluster.example',
    authorization: 'Bearer opaque.old.token',
    fetch: asFetch(vi.fn()),
    ...overrides,
  };
}

function makeScope(epoch = 17, cancelRemote = vi.fn()) {
  return { cancelRemote, scope: createAuthenticatedExecutionScope({ epoch, cancelRemote }) };
}

describe('AuthenticatedExecutionScope', () => {
  it('aborts registered work, passes the original lease and query id unchanged, and fences its handle', () => {
    const lease = makeLease();
    const { scope, cancelRemote } = makeScope();
    const abort = vi.fn(() => {
      expect(scope.closed).toBe(true);
      expect(scope.isOpen()).toBe(false);
    });
    const registration = scope.register({ name: 'workbench query', abort, getQueryId: () => 'query-123' });

    expect(scope.epoch).toBe(17);
    expect(registration.isCurrent()).toBe(true);
    expect(scope.isCurrent(registration)).toBe(true);

    scope.close(lease);

    expect(abort).toHaveBeenCalledOnce();
    expect(cancelRemote).toHaveBeenCalledOnce();
    expect(cancelRemote).toHaveBeenCalledWith(lease, 'query-123');
    expect(registration.isCurrent()).toBe(false);
    expect(scope.isCurrent(registration)).toBe(false);
  });

  it('is idempotent and re-entrant, even when an abort closes the scope again', () => {
    const { scope, cancelRemote } = makeScope();
    const firstAbort = vi.fn(() => scope.close());
    const secondAbort = vi.fn();
    scope.register({ name: 'first', abort: firstAbort, getQueryId: () => 'q-first' });
    scope.register({ name: 'second', abort: secondAbort, getQueryId: () => 'q-second' });

    scope.close(makeLease());
    scope.close(makeLease({ authorization: 'Bearer ignored-after-close' }));

    expect(firstAbort).toHaveBeenCalledOnce();
    expect(secondAbort).toHaveBeenCalledOnce();
    expect(cancelRemote.mock.calls).toEqual([
      [expect.any(Object), 'q-first'],
      [expect.any(Object), 'q-second'],
    ]);
  });

  it('allows released work to settle without later cancellation', () => {
    const { scope, cancelRemote } = makeScope();
    const abort = vi.fn();
    const registration = scope.register({ name: 'finished export', abort, getQueryId: () => 'export-q' });

    registration.release();
    registration.release();
    scope.close(makeLease());

    expect(registration.isCurrent()).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    expect(cancelRemote).not.toHaveBeenCalled();
  });

  it('does not treat a registration from another open scope as current', () => {
    const first = makeScope().scope;
    const second = makeScope().scope;
    const foreign = second.register({ name: 'other session', abort: vi.fn() });

    expect(foreign.isCurrent()).toBe(true);
    expect(first.isCurrent(foreign)).toBe(false);
  });

  it('stops a late registration immediately and ignores absent, empty, and throwing query-id providers', () => {
    const { scope, cancelRemote } = makeScope();
    const closeLease = makeLease({ authorization: 'Bearer refreshed-before-close' });
    scope.close(closeLease);
    const lateAbort = vi.fn();
    const late = scope.register({ name: 'late', abort: lateAbort, getQueryId: () => 'late-q' });
    const noIdAbort = vi.fn();
    const noIdScope = makeScope(17, cancelRemote).scope;
    noIdScope.register({ name: 'none', abort: noIdAbort });
    noIdScope.register({ name: 'empty', abort: vi.fn(), getQueryId: () => '' });
    noIdScope.register({ name: 'broken provider', abort: vi.fn(), getQueryId: () => { throw new Error('no id'); } });

    noIdScope.close(makeLease());

    expect(late.isCurrent()).toBe(false);
    expect(lateAbort).toHaveBeenCalledOnce();
    expect(noIdAbort).toHaveBeenCalledOnce();
    expect(cancelRemote.mock.calls.map((call) => call[1])).toEqual(['late-q']);
    expect(cancelRemote).toHaveBeenCalledWith(closeLease, 'late-q');
  });

  it('uses the latest close lease, keeps Basic and Bearer authorization opaque, and swallows remote failures without retrying', async () => {
    const basicLease = makeLease({
      origin: 'https://basic-cluster.example/base',
      authorization: 'Basic ZGVtbzpwQHNzdzByZA==',
    });
    const bearerLease = makeLease({ authorization: 'Bearer not-parsed-or-refreshed' });
    const basicCancel = vi.fn(async () => { throw new Error('network down'); });
    const bearerCancel = vi.fn(() => { throw new Error('synchronous failure'); });
    const basicScope = makeScope(17, basicCancel).scope;
    const bearerScope = makeScope(17, bearerCancel).scope;
    basicScope.register({ name: 'basic', abort: vi.fn(), getQueryId: () => 'basic-q' });
    bearerScope.register({ name: 'bearer', abort: vi.fn(), getQueryId: () => 'bearer-q' });

    expect(() => basicScope.close(basicLease)).not.toThrow();
    expect(() => bearerScope.close(bearerLease)).not.toThrow();
    await Promise.resolve();

    expect(basicCancel).toHaveBeenCalledTimes(1);
    expect(basicCancel).toHaveBeenCalledWith(basicLease, 'basic-q');
    expect(bearerCancel).toHaveBeenCalledTimes(1);
    expect(bearerCancel).toHaveBeenCalledWith(bearerLease, 'bearer-q');
    expect(basicLease.origin).toBe('https://basic-cluster.example/base');
    expect(basicLease.authorization).toBe('Basic ZGVtbzpwQHNzdzByZA==');
    expect(bearerLease.authorization).toBe('Bearer not-parsed-or-refreshed');
  });

  it('continues cancelling other work when an owner abort throws', () => {
    const { scope, cancelRemote } = makeScope();
    scope.register({ name: 'broken abort', abort: () => { throw new Error('broken'); }, getQueryId: () => 'broken-q' });
    const healthyAbort = vi.fn();
    scope.register({ name: 'healthy', abort: healthyAbort, getQueryId: () => 'healthy-q' });

    expect(() => scope.close(makeLease())).not.toThrow();
    expect(healthyAbort).toHaveBeenCalledOnce();
    expect(cancelRemote.mock.calls.map((call) => call[1])).toEqual(['broken-q', 'healthy-q']);
  });

  it('still aborts locally but skips remote cancellation for a missing or foreign close lease', () => {
    const missing = makeScope();
    const foreign = makeScope();
    const missingAbort = vi.fn();
    const foreignAbort = vi.fn();
    missing.scope.register({ name: 'missing lease', abort: missingAbort, getQueryId: () => 'missing-q' });
    foreign.scope.register({ name: 'foreign lease', abort: foreignAbort, getQueryId: () => 'foreign-q' });

    missing.scope.close();
    foreign.scope.close(makeLease({ epoch: 18 }));

    expect(missingAbort).toHaveBeenCalledOnce();
    expect(foreignAbort).toHaveBeenCalledOnce();
    expect(missing.cancelRemote).not.toHaveBeenCalled();
    expect(foreign.cancelRemote).not.toHaveBeenCalled();
  });
});
