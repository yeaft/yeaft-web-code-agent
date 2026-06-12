import { describe, it, expect, vi } from 'vitest';
import { createYeaftStatusCache } from '../../agent/yeaft/status-cache.js';

describe('Yeaft agent status cache', () => {
  it('emits model candidates on startup and keeps refreshing in the background', async () => {
    vi.useFakeTimers();
    const emitted = [];
    let calls = 0;
    const cache = createYeaftStatusCache({
      intervalMs: 1000,
      now: () => 100 + calls,
      emit: (event) => emitted.push(event),
      loadConfig: async () => {
        calls += 1;
        return {
          model: `model-${calls}`,
          availableModels: [{ id: `model-${calls}`, provider: 'p' }],
          dir: '/tmp/yeaft',
        };
      },
    });

    cache.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(emitted.at(-1)).toMatchObject({
      type: 'yeaft_status',
      model: 'model-1',
      availableModels: [{ id: 'model-1', provider: 'p', label: 'model-1' }],
      refreshing: false,
      refreshError: null,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(emitted.at(-1)).toMatchObject({
      type: 'yeaft_status',
      model: 'model-2',
      availableModels: [{ id: 'model-2', provider: 'p', label: 'model-2' }],
      refreshing: false,
    });

    cache.stop();
    vi.useRealTimers();
  });

  it('retains the previous good model list when a refresh fails', async () => {
    const emitted = [];
    let fail = false;
    const cache = createYeaftStatusCache({
      now: () => 1234,
      emit: (event) => emitted.push(event),
      loadConfig: async () => {
        if (fail) throw new Error('provider down');
        return {
          model: 'good-model',
          availableModels: [{ id: 'good-model', provider: 'p' }],
          dir: '/tmp/yeaft',
        };
      },
    });

    await cache.refresh({ reason: 'startup', emitRefreshing: false });
    fail = true;
    await cache.refresh({ reason: 'interval' });

    expect(emitted.at(-1)).toMatchObject({
      type: 'yeaft_status',
      model: 'good-model',
      availableModels: [{ id: 'good-model', provider: 'p', label: 'good-model' }],
      refreshing: false,
      refreshError: 'provider down',
    });
  });
});
