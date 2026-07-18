import { describe, expect, it } from 'vitest';
import {
  createLayoutRegistry, defaultLayoutRegistry, flowLayoutRegistration, grafanaGridLayoutRegistration,
} from '../../src/dashboard/layouts/layout-registry.js';
import { flowLayoutPlugin } from '../../src/dashboard/layouts/flow-layout.js';
import { grafanaGridLayoutPlugin } from '../../src/dashboard/layouts/grafana-grid-layout.js';
import type { DashboardLayoutPlugin } from '../../src/dashboard/layouts/flow-layout.js';
import type { DashboardLayoutRegistration } from '../../src/dashboard/layouts/layout-registry.js';

const flow = (items: Record<string, Record<string, unknown>> = {}) =>
  ({ type: 'flow', version: 1, preset: 'full-width', items });

// A stub grid plugin for a second registered engine.
const gridPlugin: DashboardLayoutPlugin = {
  type: 'grid', version: 2,
  normalize: (dashboard) => dashboard,
  validatePlacement: () => [],
};
const gridRegistration: DashboardLayoutRegistration = {
  id: 'grid', versions: [2], load: () => Promise.resolve(gridPlugin),
};

describe('createLayoutRegistry', () => {
  it('always includes the built-in flow@1 engine', () => {
    const registry = createLayoutRegistry();
    expect(registry.supports('flow', 1)).toBe(true);
    expect(flowLayoutRegistration.id).toBe('flow');
  });

  it('registers additional engines and ignores a shadowing or duplicate id', async () => {
    const shadow: DashboardLayoutRegistration = {
      id: 'flow', versions: [1], load: () => Promise.reject(new Error('should never be used')),
    };
    const duplicateGrid: DashboardLayoutRegistration = {
      id: 'grid', versions: [3], load: () => Promise.resolve(gridPlugin),
    };
    const registry = createLayoutRegistry([gridRegistration, shadow, duplicateGrid]);
    expect(registry.supports('grid', 2)).toBe(true);
    expect(registry.supports('grid', 3)).toBe(false); // duplicate id ignored
    // The built-in flow load wins over the shadow registration.
    expect(await registry.load('flow', 1)).toBe(flowLayoutPlugin);
  });
});

describe('supports', () => {
  const registry = createLayoutRegistry([gridRegistration]);
  it('is false for a non-string id, non-number version, unknown id, or unknown version', () => {
    expect(registry.supports(null, 1)).toBe(false);
    expect(registry.supports('flow', '1')).toBe(false);
    expect(registry.supports('nope', 1)).toBe(false);
    expect(registry.supports('flow', 2)).toBe(false);
  });
});

describe('load', () => {
  it('returns the plugin for a supported engine and null when unsupported', async () => {
    const registry = createLayoutRegistry([gridRegistration]);
    expect(await registry.load('grid', 2)).toBe(gridPlugin);
    expect(await registry.load('grid', 9)).toBeNull();
  });

  it('returns null (never throws) when the registration load throws', async () => {
    const boom: DashboardLayoutRegistration = {
      id: 'boom', versions: [1], load: () => { throw new Error('kaboom'); },
    };
    const registry = createLayoutRegistry([boom]);
    expect(await registry.load('boom', 1)).toBeNull();
  });
});

describe('resolve', () => {
  it('resolves the primary engine when supported', async () => {
    const registry = createLayoutRegistry([gridRegistration]);
    const result = await registry.resolve({ type: 'grid', version: 2, fallback: flow() });
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.plugin).toBe(gridPlugin); expect(result.usedFallback).toBe(false); }
  });

  it('renders the valid flow@1 fallback when the primary cannot load', async () => {
    const registry = createLayoutRegistry(); // grid not registered
    const result = await registry.resolve({ type: 'grid', version: 9, fallback: flow({ a: { span: 1 } }) });
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.plugin).toBe(flowLayoutPlugin); expect(result.usedFallback).toBe(true); }
  });

  it('falls back when a supported primary engine throws on load', async () => {
    const boom: DashboardLayoutRegistration = {
      id: 'grid', versions: [2], load: () => Promise.reject(new Error('load failed')),
    };
    const registry = createLayoutRegistry([boom]);
    const result = await registry.resolve({ type: 'grid', version: 2, fallback: flow() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.usedFallback).toBe(true);
  });

  it('fails closed for an unsupported primary without a valid flow@1 fallback', async () => {
    const registry = createLayoutRegistry();
    const noFallback = await registry.resolve({ type: 'grid', version: 9 });
    expect(noFallback.ok).toBe(false);
    if (!noFallback.ok) expect(noFallback.diagnostics[0].code).toBe('dashboard-layout-load-failed');

    const badFallback = await registry.resolve({ type: 'grid', version: 9, fallback: { type: 'flow', version: 2 } });
    expect(badFallback.ok).toBe(false);

    const notObject = await registry.resolve(null, ['dashboard', 'layout']);
    expect(notObject.ok).toBe(false);
    if (!notObject.ok) expect(notObject.diagnostics[0].path).toEqual(['dashboard', 'layout']);
  });
});

describe('defaultLayoutRegistry', () => {
  it('exposes the built-in flow@1 and grafana-grid@1 engines (#291), and nothing else', () => {
    expect(defaultLayoutRegistry.supports('flow', 1)).toBe(true);
    expect(defaultLayoutRegistry.supports('grafana-grid', 1)).toBe(true);
    expect(defaultLayoutRegistry.supports('grafana-grid', 2)).toBe(false);
    expect(defaultLayoutRegistry.supports('grid', 2)).toBe(false);
  });

  it('registration-time-lazy loads the real grafana-grid@1 plugin instance', async () => {
    expect(grafanaGridLayoutRegistration.id).toBe('grafana-grid');
    expect(await defaultLayoutRegistry.load('grafana-grid', 1)).toBe(grafanaGridLayoutPlugin);
  });

  it('resolves a grafana-grid@1 primary layout directly (no fallback needed)', async () => {
    const result = await defaultLayoutRegistry.resolve({ type: 'grafana-grid', version: 1, items: {}, fallback: flow() });
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.plugin).toBe(grafanaGridLayoutPlugin); expect(result.usedFallback).toBe(false); }
  });

  it('falls back to flow@1 for an unsupported grafana-grid version', async () => {
    const result = await defaultLayoutRegistry.resolve({
      type: 'grafana-grid', version: 9, items: {}, fallback: flow({ a: { span: 1 } }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.plugin).toBe(flowLayoutPlugin); expect(result.usedFallback).toBe(true); }
  });

  it('fails closed for an unsupported grafana-grid version without a valid flow@1 fallback', async () => {
    const result = await defaultLayoutRegistry.resolve({ type: 'grafana-grid', version: 9 });
    expect(result.ok).toBe(false);
  });
});
