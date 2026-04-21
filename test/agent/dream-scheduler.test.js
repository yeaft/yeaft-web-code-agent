/**
 * wave-6b — dream-scheduler tests.
 *
 * DS-a: createDreamScheduler returns expected shape.
 * DS-b: noteUserMessage increments counter and resets timer.
 * DS-c: triggerDreamNow calls dreamShard and returns result.
 * DS-d: triggerDreamNow skips when already running.
 * DS-e: triggerDreamNow skips when no shard store.
 * DS-f: idle timer fires after configured idle period.
 * DS-g: idle timer resets on new user message.
 * DS-h: recompression hook runs post-dream.
 * DS-i: shutdown clears timers and prevents further runs.
 * DS-j: onDreamStart/onDreamEnd callbacks fire.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dream-shard and recompression before importing scheduler
vi.mock('../../agent/unify/memory/dream-shard.js', () => ({
  dreamShard: vi.fn(async () => ({
    scan: { totalEntries: 10 },
    compact: { compacted: [], skipped: [], errors: [] },
    merge: null,
    prune: null,
    entriesMerged: 0,
    entriesPruned: 0,
    bytesReclaimed: 0,
    errors: [],
  })),
}));

vi.mock('../../agent/unify/memory/recompression.js', () => ({
  checkRecompression: vi.fn(() => ({
    compacted: [],
    skipped: ['general'],
    stats: {},
  })),
}));

const { createDreamScheduler, DREAM_IDLE_MS } = await import(
  '../../agent/unify/memory/dream-scheduler.js'
);
const { dreamShard } = await import('../../agent/unify/memory/dream-shard.js');
const { checkRecompression } = await import('../../agent/unify/memory/recompression.js');

function makeFakeStore() {
  return {
    stats: () => ({ shards: { general: { entries: 5, bytes: 1024 } }, count: 5 }),
    query: () => ({ results: [] }),
    get: () => null,
  };
}

function makeFakeAdapter() {
  return {
    call: vi.fn(async () => ({ text: '{}' })),
  };
}

describe('wave-6b DS-a — createDreamScheduler shape', () => {
  it('returns expected API', () => {
    const ds = createDreamScheduler({});
    expect(typeof ds.noteUserMessage).toBe('function');
    expect(typeof ds.triggerDreamNow).toBe('function');
    expect(typeof ds.shutdown).toBe('function');
    expect(ds.isRunning).toBe(false);
    expect(ds.messagesSinceLastDream).toBe(0);
    expect(ds.lastDreamAt).toBe(0);
    ds.shutdown();
  });
});

describe('wave-6b DS-b — noteUserMessage', () => {
  it('increments message counter', () => {
    const ds = createDreamScheduler({});
    ds.noteUserMessage();
    expect(ds.messagesSinceLastDream).toBe(1);
    ds.noteUserMessage();
    expect(ds.messagesSinceLastDream).toBe(2);
    ds.shutdown();
  });
});

describe('wave-6b DS-c — triggerDreamNow calls dreamShard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls dreamShard and returns result', async () => {
    const ds = createDreamScheduler({
      memoryShardStore: makeFakeStore(),
      adapter: makeFakeAdapter(),
      config: { primaryModel: 'test-model' },
    });
    ds.noteUserMessage();
    const result = await ds.triggerDreamNow();
    expect(dreamShard).toHaveBeenCalledTimes(1);
    expect(result.entriesMerged).toBe(0);
    expect(result.recompression).toBeDefined();
    expect(ds.messagesSinceLastDream).toBe(0); // reset after dream
    expect(ds.lastDreamAt).toBeGreaterThan(0);
    ds.shutdown();
  });
});

describe('wave-6b DS-d — triggerDreamNow skips when running', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns skipped when dream already running', async () => {
    // Make dreamShard hang
    let resolve;
    dreamShard.mockImplementationOnce(() => new Promise(r => { resolve = r; }));

    const ds = createDreamScheduler({
      memoryShardStore: makeFakeStore(),
      adapter: makeFakeAdapter(),
      config: {},
    });

    const p1 = ds.triggerDreamNow();
    expect(ds.isRunning).toBe(true);

    const result2 = await ds.triggerDreamNow();
    expect(result2.skipped).toBe(true);
    expect(result2.reason).toBe('already_running');

    // Cleanup
    resolve({
      scan: null, compact: null, merge: null, prune: null,
      entriesMerged: 0, entriesPruned: 0, bytesReclaimed: 0, errors: [],
    });
    await p1;
    ds.shutdown();
  });
});

describe('wave-6b DS-e — triggerDreamNow skips when no shard store', () => {
  it('returns skipped', async () => {
    const ds = createDreamScheduler({
      adapter: makeFakeAdapter(),
      config: {},
    });
    const result = await ds.triggerDreamNow();
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_shard_store');
    ds.shutdown();
  });

  it('returns skipped when no adapter', async () => {
    const ds = createDreamScheduler({
      memoryShardStore: makeFakeStore(),
      config: {},
    });
    const result = await ds.triggerDreamNow();
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_adapter');
    ds.shutdown();
  });
});

describe('wave-6b DS-f — idle timer fires', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires dream after idle period', async () => {
    const ds = createDreamScheduler({
      memoryShardStore: makeFakeStore(),
      adapter: makeFakeAdapter(),
      config: {},
      idleMs: 100, // 100ms for test
    });
    ds.noteUserMessage();
    expect(ds.messagesSinceLastDream).toBe(1);

    vi.advanceTimersByTime(101);
    // Allow the async dream to complete
    await vi.runAllTimersAsync();

    expect(dreamShard).toHaveBeenCalled();
    ds.shutdown();
  });
});

describe('wave-6b DS-g — idle timer resets on new message', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fire if message arrives before idle period', async () => {
    const ds = createDreamScheduler({
      memoryShardStore: makeFakeStore(),
      adapter: makeFakeAdapter(),
      config: {},
      idleMs: 200,
    });
    ds.noteUserMessage();
    vi.advanceTimersByTime(150);
    ds.noteUserMessage(); // reset timer
    vi.advanceTimersByTime(150);
    // 150+150=300ms total but timer was reset at 150ms, so only 150ms since reset
    expect(dreamShard).not.toHaveBeenCalled();
    ds.shutdown();
  });
});

describe('wave-6b DS-h — recompression hook runs post-dream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls checkRecompression after dreamShard', async () => {
    const store = makeFakeStore();
    const ds = createDreamScheduler({
      memoryShardStore: store,
      adapter: makeFakeAdapter(),
      config: {},
    });
    await ds.triggerDreamNow();
    expect(checkRecompression).toHaveBeenCalledWith(store);
    ds.shutdown();
  });
});

describe('wave-6b DS-i — shutdown prevents further runs', () => {
  it('clears state and prevents dream', async () => {
    const ds = createDreamScheduler({
      memoryShardStore: makeFakeStore(),
      adapter: makeFakeAdapter(),
      config: {},
    });
    ds.shutdown();
    ds.noteUserMessage(); // no-op after shutdown — counter doesn't increment
    expect(ds.messagesSinceLastDream).toBe(0); // stays at 0
  });
});

describe('wave-6b DS-j — callbacks fire', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls onDreamStart and onDreamEnd', async () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const ds = createDreamScheduler({
      memoryShardStore: makeFakeStore(),
      adapter: makeFakeAdapter(),
      config: {},
      onDreamStart: onStart,
      onDreamEnd: onEnd,
    });
    await ds.triggerDreamNow();
    expect(onStart).toHaveBeenCalledWith('default');
    expect(onEnd).toHaveBeenCalledWith('default', expect.objectContaining({ trigger: 'manual' }));
    ds.shutdown();
  });
});
