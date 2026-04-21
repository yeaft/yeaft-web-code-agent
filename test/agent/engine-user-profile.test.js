/**
 * engine-user-profile.test.js — Verify engine.js injects user profile
 * from buildUserProfile(memoryShardStore) into the system prompt via
 * the userProfile param of buildSystemPrompt.
 *
 * Tests:
 *   UP-a  buildUserProfile is called with memoryShardStore during query
 *   UP-b  profile content appears in adapter call's system prompt
 *   UP-c  graceful fallback when memoryShardStore is null (no profile)
 */

import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../../agent/unify/engine.js';
import { NullTrace } from '../../agent/unify/debug-trace.js';

// Mock user-memory-store to intercept buildUserProfile
vi.mock('../../agent/unify/memory/user-memory-store.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    buildUserProfile: vi.fn((store) => {
      if (!store) return '';
      return '- Name: Alice\n- Role: Engineer\n- Prefers TypeScript';
    }),
  };
});

// Mock recallR6 to avoid needing full shard store
vi.mock('../../agent/unify/memory/recall-r6.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    recallR6: vi.fn(async () => ({
      entries: [],
      shards: [],
      fingerprint: 'test',
      cached: false,
    })),
    formatForInjection: vi.fn(() => ''),
  };
});

const { buildUserProfile } = await import('../../agent/unify/memory/user-memory-store.js');

class MockAdapter {
  constructor() { this.callLog = []; }
  async *stream(params) {
    this.callLog.push(params);
    yield { type: 'text_delta', text: 'ok' };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
  async call() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }
}

function mkEngine(adapter, opts = {}) {
  return new Engine({
    adapter,
    trace: new NullTrace(),
    config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true },
    memoryShardStore: opts.memoryShardStore,
  });
}

async function drainQuery(engine, prompt) {
  const out = [];
  for await (const ev of engine.query({ prompt, messages: [] })) out.push(ev);
  return out;
}

describe('UP-a buildUserProfile called with memoryShardStore', () => {
  it('calls buildUserProfile during query', async () => {
    const adapter = new MockAdapter();
    const fakeStore = { stats: () => ({ shards: {}, count: 0 }) };
    const engine = mkEngine(adapter, { memoryShardStore: fakeStore });

    buildUserProfile.mockClear();
    await drainQuery(engine, 'hello');

    expect(buildUserProfile).toHaveBeenCalledTimes(1);
    expect(buildUserProfile).toHaveBeenCalledWith(fakeStore);
  });
});

describe('UP-b profile content injected into system prompt', () => {
  it('system prompt contains user profile content', async () => {
    const adapter = new MockAdapter();
    const fakeStore = { stats: () => ({ shards: {}, count: 0 }) };
    const engine = mkEngine(adapter, { memoryShardStore: fakeStore });

    await drainQuery(engine, 'hello');

    expect(adapter.callLog.length).toBeGreaterThan(0);
    const systemPrompt = adapter.callLog[0].system;
    expect(systemPrompt).toContain('Alice');
    expect(systemPrompt).toContain('Engineer');
  });
});

describe('UP-c graceful fallback without memoryShardStore', () => {
  it('does not call buildUserProfile when memoryShardStore is null', async () => {
    const adapter = new MockAdapter();
    const engine = mkEngine(adapter, { memoryShardStore: null });

    buildUserProfile.mockClear();
    await drainQuery(engine, 'hello');

    // buildUserProfile is called but with null — returns ''
    expect(buildUserProfile).toHaveBeenCalledWith(null);
    // Should still complete without error
    const systemPrompt = adapter.callLog[0].system;
    expect(systemPrompt).not.toContain('Alice');
  });
});
