import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorkCenterFeatureSettings, updateWorkCenterFeatureSettings } from '../../../../agent/yeaft/config-api.js';
import { startWorkCenterFeature } from '../../../../agent/yeaft/work-center/feature.js';
import { __testSetWorkCenterFactory, bootWorkCenter, createWorkItemFromProducer, setWorkCenterFeatureEnabled, shutdownWorkCenter } from '../../../../agent/yeaft/work-center/bridge.js';
import { applyWorkCenterFeatureUpdate } from '../../../../agent/connection/message-router.js';

const roots = [];
afterEach(async () => {
  await shutdownWorkCenter();
  __testSetWorkCenterFactory(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Work Center feature settings', () => {
  it('defaults false and persists only workCenter.enabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-work-center-feature-'));
    roots.push(root);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ language: 'zh-CN', workCenter: { note: 'keep' } }));
    expect(getWorkCenterFeatureSettings(root, {})).toEqual({ enabled: false, source: 'config', overridden: false });
    expect(updateWorkCenterFeatureSettings({ enabled: true }, root, {})).toEqual({ enabled: true, source: 'config', overridden: false });
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).toMatchObject({ language: 'zh-CN', workCenter: { enabled: true, note: 'keep' } });
  });

  it('treats an explicitly present environment variable as a read-only override', () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-work-center-feature-'));
    roots.push(root);
    expect(getWorkCenterFeatureSettings(root, { YEAFT_WORK_CENTER_ENABLED: 'false' })).toEqual({ enabled: false, source: 'environment', overridden: true });
    expect(updateWorkCenterFeatureSettings({ enabled: true }, root, { YEAFT_WORK_CENTER_ENABLED: 'false' })).toMatchObject({ enabled: false, overridden: true, error: expect.any(String) });
  });

  it('fails closed for producer calls left in already-loaded Sessions', async () => {
    const service = { start: vi.fn(), shutdown: vi.fn(), handle: vi.fn() };
    __testSetWorkCenterFactory(vi.fn().mockResolvedValue(service));
    await bootWorkCenter();
    setWorkCenterFeatureEnabled(false);
    await shutdownWorkCenter();
    await expect(createWorkItemFromProducer({ title: 'stale tool' })).rejects.toThrow(/disabled/i);
    expect(service.handle).not.toHaveBeenCalled();
  });

  it('rolls persisted state back and reports effective state when runtime transition fails', async () => {
    let enabled = false;
    const update = vi.fn(({ enabled: next }) => {
      enabled = next;
      return { enabled, source: 'config', overridden: false };
    });
    const result = await applyWorkCenterFeatureUpdate({ settings: { enabled: true } }, {
      yeaftDir: '/tmp/test',
      getWorkCenterFeatureSettings: () => ({ enabled: false, source: 'config', overridden: false }),
      updateWorkCenterFeatureSettings: update,
      bridge: { setWorkCenterFeatureEnabled: vi.fn(), bootWorkCenter: vi.fn().mockRejectedValue(new Error('boot failed')), shutdownWorkCenter: vi.fn() },
      refreshAgentCapabilities: vi.fn(),
    });
    expect(update).toHaveBeenNthCalledWith(2, { enabled: false }, '/tmp/test');
    expect(result).toMatchObject({ enabled: false, effective: false, persisted: false, rolledBack: true, error: expect.stringContaining('boot failed') });
  });

  it('restores the runtime when capability refresh fails after a transition', async () => {
    let enabled = true;
    const bridge = {
      setWorkCenterFeatureEnabled: vi.fn(),
      bootWorkCenter: vi.fn(),
      shutdownWorkCenter: vi.fn(),
    };
    const refreshAgentCapabilities = vi.fn()
      .mockRejectedValueOnce(new Error('capability broadcast failed'))
      .mockResolvedValueOnce([]);
    const result = await applyWorkCenterFeatureUpdate({ settings: { enabled: false } }, {
      yeaftDir: '/tmp/test',
      getWorkCenterFeatureSettings: () => ({ enabled: true, source: 'config', overridden: false }),
      updateWorkCenterFeatureSettings: vi.fn(({ enabled: next }) => {
        enabled = next;
        return { enabled, source: 'config', overridden: false };
      }),
      bridge,
      refreshAgentCapabilities,
    });
    expect(bridge.shutdownWorkCenter).toHaveBeenCalledTimes(1);
    expect(bridge.bootWorkCenter).toHaveBeenCalledTimes(1);
    expect(bridge.setWorkCenterFeatureEnabled).toHaveBeenLastCalledWith(true);
    expect(refreshAgentCapabilities).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ enabled: true, effective: true, persisted: false, rolledBack: true, error: expect.stringContaining('capability broadcast failed') });
  });

  it('shuts down and republishes disabled capabilities when persistence rollback fails', async () => {
    const bridge = {
      setWorkCenterFeatureEnabled: vi.fn(),
      bootWorkCenter: vi.fn(),
      shutdownWorkCenter: vi.fn(),
    };
    const refreshAgentCapabilities = vi.fn()
      .mockRejectedValueOnce(new Error('capability broadcast failed'))
      .mockResolvedValueOnce([]);
    let updateCount = 0;
    const result = await applyWorkCenterFeatureUpdate({ settings: { enabled: true } }, {
      yeaftDir: '/tmp/test',
      getWorkCenterFeatureSettings: () => ({ enabled: false, source: 'config', overridden: false }),
      updateWorkCenterFeatureSettings: vi.fn(({ enabled }) => (++updateCount === 1
        ? { enabled, source: 'config', overridden: false }
        : { enabled: true, source: 'config', overridden: false, error: 'disk is read-only' })),
      bridge,
      refreshAgentCapabilities,
    });
    expect(bridge.shutdownWorkCenter).toHaveBeenCalledTimes(1);
    expect(bridge.setWorkCenterFeatureEnabled).toHaveBeenLastCalledWith(false);
    expect(refreshAgentCapabilities).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ effective: false, persisted: true, rolledBack: false, error: expect.stringContaining('capability broadcast failed') });
  });

  it('documents that enabling registers CreateWorkItem for new Sessions only', async () => {
    const result = await applyWorkCenterFeatureUpdate({ settings: { enabled: true } }, {
      yeaftDir: '/tmp/test',
      getWorkCenterFeatureSettings: () => ({ enabled: false }),
      updateWorkCenterFeatureSettings: () => ({ enabled: true, source: 'config', overridden: false }),
      bridge: { setWorkCenterFeatureEnabled: vi.fn(), bootWorkCenter: vi.fn(), shutdownWorkCenter: vi.fn() },
      refreshAgentCapabilities: vi.fn(),
    });
    expect(result).toMatchObject({ enabled: true, effective: true, persisted: true, sessionTools: 'new_sessions_only' });
  });

  it.each([true, false])('preserves configured state and effective=%s when persistence is rejected', async runtimeEnabled => {
    const result = await applyWorkCenterFeatureUpdate({ settings: { enabled: false } }, {
      yeaftDir: '/tmp/test',
      getWorkCenterFeatureSettings: () => ({ enabled: true, source: 'environment', overridden: true }),
      updateWorkCenterFeatureSettings: () => ({ enabled: false, source: 'environment', overridden: true, error: 'managed by environment' }),
      bridge: { setWorkCenterFeatureEnabled: vi.fn(), bootWorkCenter: vi.fn(), shutdownWorkCenter: vi.fn() },
      refreshAgentCapabilities: vi.fn(),
      runtimeEnabled,
    });
    expect(result).toMatchObject({
      enabled: true,
      effective: runtimeEnabled,
      source: 'environment',
      overridden: true,
      persisted: false,
      error: 'managed by environment',
    });
  });

  it('can boot again after shutdown', async () => {
    const first = { start: vi.fn(), shutdown: vi.fn() };
    const second = { start: vi.fn(), shutdown: vi.fn() };
    const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    __testSetWorkCenterFactory(factory);
    await bootWorkCenter();
    await shutdownWorkCenter();
    await bootWorkCenter();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(first.shutdown).toHaveBeenCalledTimes(1);
    expect(second.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    [[false, true], true],
    [[true, false], false],
  ])('serializes rapid transitions %j so the last request wins', async ([first, last], expected) => {
    let persisted = !first;
    let effective = persisted;
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    let transitionCount = 0;
    const dependencies = {
      yeaftDir: '/tmp/test',
      getWorkCenterFeatureSettings: () => ({ enabled: persisted, source: 'config', overridden: false }),
      updateWorkCenterFeatureSettings: ({ enabled }) => {
        persisted = enabled;
        return { enabled, source: 'config', overridden: false };
      },
      bridge: {
        setWorkCenterFeatureEnabled: value => { effective = value; },
        bootWorkCenter: async () => { if (++transitionCount === 1) await firstGate; },
        shutdownWorkCenter: async () => { if (++transitionCount === 1) await firstGate; },
      },
      refreshAgentCapabilities: vi.fn(),
    };
    const one = applyWorkCenterFeatureUpdate({ settings: { enabled: first } }, dependencies);
    const two = applyWorkCenterFeatureUpdate({ settings: { enabled: last } }, dependencies);
    await Promise.resolve();
    expect(persisted).toBe(first);
    releaseFirst();
    await Promise.all([one, two]);
    expect({ persisted, effective }).toEqual({ persisted: expected, effective: expected });
  });

  it('does not hand out a service after shutdown has begun', async () => {
    let releaseShutdown;
    const shutdownGate = new Promise(resolve => { releaseShutdown = resolve; });
    const service = { start: vi.fn(), shutdown: vi.fn(() => shutdownGate), handle: vi.fn() };
    __testSetWorkCenterFactory(vi.fn().mockResolvedValue(service));
    await bootWorkCenter();
    const stopping = shutdownWorkCenter();
    await expect(createWorkItemFromProducer({ title: 'racing producer' })).rejects.toThrow(/shutting down/i);
    expect(service.handle).not.toHaveBeenCalled();
    releaseShutdown();
    await stopping;
  });


  it('keeps configured enablement while reporting a failed boot as ineffective', async () => {
    const result = await startWorkCenterFeature(true, vi.fn().mockRejectedValue(new Error('database unavailable')));
    expect(result).toEqual({ effective: false, runtimeError: 'database unavailable' });
  });

});
