/**
 * dream-scheduler-tick-wireup.test.js — Phase 8 PR-F.
 *
 * Asserts dream-v2/tick.runDreamTick is invoked from the scheduler's
 * post-dream phase when memoryDir is provided:
 *   F-a  triggerDreamNow ⇒ runDreamTick called with memoryDir as root
 *        and a user scope at minimum
 *   F-b  no memoryDir ⇒ runDreamTick NOT called (graceful no-op)
 *   F-c  group provided ⇒ runDreamTick scopes include groups/<id>
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../agent/unify/memory/dream-shard.js', () => ({
  dreamShard: vi.fn(async () => ({ scan: { totalEntries: 0 }, errors: [] })),
}));
vi.mock('../../agent/unify/memory/recompression.js', () => ({
  checkRecompression: vi.fn(() => ({ compacted: [], skipped: [] })),
}));
vi.mock('../../agent/unify/memory/user-memory-store.js', () => ({
  runUserDreamJob: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../agent/unify/dream-v2/tick.js', () => ({
  runDreamTick: vi.fn(async () => ({ ran: [], skipped: [], errors: [] })),
}));

const { createDreamScheduler } = await import('../../agent/unify/memory/dream-scheduler.js');
const { runDreamTick } = await import('../../agent/unify/dream-v2/tick.js');

function fakeStore() {
  return { stats: () => ({ shards: {}, count: 0 }), query: () => ({ results: [] }), get: () => null };
}
function fakeAdapter() { return { call: vi.fn(async () => ({ text: '{}' })) }; }

describe('F-a runDreamTick called with memoryDir + user scope', () => {
  it('invokes tick once with root=memoryDir and a user scope', async () => {
    runDreamTick.mockClear();
    const scheduler = createDreamScheduler({
      memoryShardStore: fakeStore(),
      adapter: fakeAdapter(),
      config: { primaryModel: 'm' },
      memoryDir: '/tmp/yeaft-mem',
    });

    await scheduler.triggerDreamNow();
    scheduler.shutdown();

    expect(runDreamTick).toHaveBeenCalledTimes(1);
    const arg = runDreamTick.mock.calls[0][0];
    expect(arg.root).toBe('/tmp/yeaft-mem');
    expect(arg.scopes.find(s => s.scopeDir === 'user')).toBeTruthy();
  });
});

describe('F-b no memoryDir ⇒ tick NOT invoked', () => {
  it('does not call runDreamTick when memoryDir is null', async () => {
    runDreamTick.mockClear();
    const scheduler = createDreamScheduler({
      memoryShardStore: fakeStore(),
      adapter: fakeAdapter(),
      config: { primaryModel: 'm' },
      memoryDir: null,
    });

    await scheduler.triggerDreamNow();
    scheduler.shutdown();

    expect(runDreamTick).not.toHaveBeenCalled();
  });
});

describe('F-c group provided ⇒ scopes include groups/<id>', () => {
  it('includes groups/<id> in scopes when group is wired', async () => {
    runDreamTick.mockClear();
    const scheduler = createDreamScheduler({
      memoryShardStore: fakeStore(),
      adapter: fakeAdapter(),
      config: { primaryModel: 'm' },
      memoryDir: '/tmp/yeaft-mem',
      group: { id: 'g_42' },
    });

    await scheduler.triggerDreamNow();
    scheduler.shutdown();

    expect(runDreamTick).toHaveBeenCalled();
    const scopes = runDreamTick.mock.calls[0][0].scopes;
    expect(scopes.find(s => s.scopeDir === 'groups/g_42')).toBeTruthy();
  });
});
