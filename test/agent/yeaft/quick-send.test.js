import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { createCoordinator } from '../../../agent/yeaft/sessions/coordinator.js';
import {
  validateQuickSend, buildVpQueryOpts, __testSetSession, __testResetVpState,
  __testEnqueueForVp, __testWaitForRoutePromises, __testDrainVpDrivers,
  __testGetVpThreads, __testSetThreadClassifier,
} from '../../../agent/yeaft/web-bridge.js';

const quickSend = { model: 'other/gpt-5', effort: 'low', maxOutputTokens: 2048 };
const config = {
  model: 'base/gpt-5', modelEffort: 'high', maxOutputTokens: 1024, _readOnly: true,
  availableModels: [{ ref: 'other/gpt-5', id: 'gpt-5', effortOptions: ['low', 'high'], maxOutput: 4096, contextWindow: 32000 }],
};
const drain = async (engine, options) => { for await (const _ of engine.query(options)) { /* drain */ } };

afterEach(async () => {
  await __testResetVpState();
  __testSetSession(null);
  __testSetThreadClassifier(null);
});

describe('quick send ingestion', () => {
  it('validates and copies the model-qualified wire payload', () => {
    expect(validateQuickSend(quickSend, config)).toEqual(quickSend);
    expect(validateQuickSend(quickSend, config)).not.toBe(quickSend);
    expect(validateQuickSend({ ...quickSend, effort: null, maxOutputTokens: null }, config))
      .toEqual({ ...quickSend, effort: null, maxOutputTokens: null });
    expect(validateQuickSend(undefined, config)).toBeNull();
  });

  it.each([
    null, [], {}, { ...quickSend, model: 'gpt-5' }, { ...quickSend, model: 'missing/gpt-5' },
    { ...quickSend, effort: 'max' }, { ...quickSend, effort: 1 },
    ...[0, -1, 1.5, '2048', 4097, Infinity].map(maxOutputTokens => ({ ...quickSend, maxOutputTokens })),
  ])('rejects invalid settings %j', value => {
    expect(() => validateQuickSend(value, config)).toThrow(/quickSend/);
  });

  it('resolves the runtime output ceiling when the catalog has no explicit limit', () => {
    const catalog = { availableModels: [{ ref: 'custom/unknown-quick-send', id: 'unknown-quick-send' }] };
    expect(() => validateQuickSend({ model: 'custom/unknown-quick-send', effort: null, maxOutputTokens: 999999 }, catalog)).toThrow(/output limit/);
  });

  it('fans out ephemeral settings to direct recipients without persisting or forwarding them', () => {
    const persisted = [];
    const delivered = [];
    const coord = createCoordinator({
      getMeta: () => ({ id: 'qs', roster: ['alice', 'bob'], defaultVpId: 'alice' }),
      appendMessage: row => { persisted.push(row); return { ...row, id: 'user-1' }; },
    }, { deliver: (vpId, envelope) => { delivered.push({ vpId, envelope }); } });
    coord.ingest({ from: 'user', role: 'user', text: '@all hello', _turnConfig: quickSend });
    expect(delivered).toHaveLength(2);
    for (const { vpId, envelope } of delivered) {
      expect(buildVpQueryOpts({ vpId, sessionId: 'qs', sessionCoordinator: coord, envelope }).turnConfig).toEqual(quickSend);
    }
    expect(persisted[0]).not.toHaveProperty('_turnConfig');
    const forwarded = { msg: { from: 'alice', role: 'assistant', meta: { injectedBy: 'route_forward' } }, _turnConfig: quickSend };
    expect(buildVpQueryOpts({ vpId: 'bob', envelope: forwarded }).turnConfig).toBeUndefined();
    expect(buildVpQueryOpts({ vpId: 'bob', envelope: { msg: { role: 'user' } } }).turnConfig).toBeUndefined();
  });
});

describe('query-local configuration', () => {
  it('applies all fields to each tool-loop request and restores config on the next query', async () => {
    const requests = [];
    const engine = new Engine({ config, trace: new NullTrace(), adapter: {
      async *stream(params) {
        requests.push(params);
        if (requests.length === 1) {
          yield { type: 'tool_call', id: 'probe-1', name: 'probe', input: {} };
          yield { type: 'stop', stopReason: 'tool_use' };
        } else yield { type: 'stop', stopReason: 'end_turn' };
      },
    } });
    engine.registerTool({ name: 'probe', description: 'probe', parameters: {}, execute: async () => 'ok' });
    await drain(engine, { prompt: 'one', turnConfig: quickSend });
    await drain(engine, { prompt: 'two' });
    expect(requests).toHaveLength(3);
    expect(requests.slice(0, 2)).toEqual([expect.objectContaining({ model: quickSend.model, effort: 'low', maxTokens: 2048 }), expect.objectContaining({ model: quickSend.model, effort: 'low', maxTokens: 2048 })]);
    expect(requests[2]).toMatchObject({ model: config.model, effort: 'high', maxTokens: 1024 });
    expect(config).toMatchObject({ model: 'base/gpt-5', modelEffort: 'high', maxOutputTokens: 1024 });
  });

  it('queues quick-send on a related busy thread instead of appending and keeps the override', async () => {
    const requests = [];
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const sessionId = 'quick-send-busy';
    const vpId = 'alice';
    __testSetSession({ config, trace: new NullTrace(), conversationStore: { append: row => row, loadRecentBySession: () => [] }, adapter: {
      async *stream(params) {
        requests.push(params);
        if (requests.length === 1) await blocked;
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    } });
    const envelope = id => ({ sessionId, trigger: 'fallback', msg: { id, from: 'user', role: 'user', text: id, meta: {} } });
    try {
      __testEnqueueForVp(sessionId, vpId, envelope('first'));
      await __testWaitForRoutePromises('first');
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      const threadId = __testGetVpThreads(sessionId, vpId)[0].threadId;
      __testSetThreadClassifier(async () => ({ decision: 'related', targetThreadId: threadId }));
      __testEnqueueForVp(sessionId, vpId, { ...envelope('second'), _turnConfig: quickSend });
      await __testWaitForRoutePromises('second');
      expect(__testGetVpThreads(sessionId, vpId)).toHaveLength(1);
      expect(__testGetVpThreads(sessionId, vpId)[0].pendingQueries).toHaveLength(0);
      expect(requests).toHaveLength(1);
      release();
      await __testDrainVpDrivers();
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({ model: quickSend.model, effort: 'low', maxTokens: 2048 });
    } finally { release(); await __testDrainVpDrivers(); }
  });
});
