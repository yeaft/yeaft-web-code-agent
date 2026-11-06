import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore, projectVisibleSessionMessages } from '../../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../../agent/yeaft/conversation/history-index.js';
import { createChildToolPolicy, validateToolGrants } from '../../../../agent/yeaft/sub-agent/tool-access.js';
import { createPersonNativeRegistry } from '../../../../agent/yeaft/person/native-tools.js';
import bridgeCtx from '../../../../agent/context.js';
import { __testHandleEngineEvent } from '../../../../agent/yeaft/web-bridge.js';
import { describe, expect, it, vi } from 'vitest';
import tool from '../../../../agent/yeaft/tools/response-enhance.js';
import { enhanceResponse, RESPONSE_ENHANCE_SYSTEM } from '../../../../agent/yeaft/llm/response-enhance.js';
import { Engine } from '../../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../../agent/yeaft/debug-trace.js';
import { createFullRegistry } from '../../../../agent/yeaft/tools/index.js';
import { resolveActiveToolNames } from '../../../../agent/yeaft/tools/activation.js';

const input = { question: '更推荐哪个？', draft: '两种方案各有优缺点。', context: '低维护成本最重要。', evidence: 'A 无需运维，B 需要维护。', preferences: '直接给判断，不要报告。' };
const revised = { status: 'revised', response: '我更推荐 A。你最在意维护成本，而 A 不需要自行运维。', issues: ['原稿没有结合约束作取舍。'], evidenceGaps: [] };
const unchanged = { status: 'unchanged', response: null, issues: [], evidenceGaps: [] };
const config = { model: 'test/live', maxContextTokens: 100000, maxOutputTokens: 1024 };
const reply = value => [{ type: 'text_delta', text: JSON.stringify(value) }, { type: 'usage', inputTokens: 30, outputTokens: 12, cacheReadTokens: 5, cacheTokensAreIncludedInInput: true }, { type: 'stop', stopReason: 'end_turn' }];
const adapterFor = events => ({ stream: vi.fn(async function* () { yield* events; }) });

describe('ResponseEnhance', () => {
  it('is visible only in the private Person registry, plugin governed and returns one unpublished revision', async () => {
    const sessionRegistry = createFullRegistry();
    expect(sessionRegistry.has('ResponseEnhance')).toBe(false);
    expect(sessionRegistry.getToolDefs().some(tool => tool.name === 'ResponseEnhance')).toBe(false);
    expect(resolveActiveToolNames({ toolNames: sessionRegistry.getToolNames(), prompt: 'ResponseEnhance 回答增强' }).has('ResponseEnhance')).toBe(false);
    expect(readFileSync(new URL('../../../../agent/yeaft/templates/core.md', import.meta.url), 'utf8')).not.toContain('ResponseEnhance');
    await expect(sessionRegistry.execute('ResponseEnhance', input)).rejects.toThrow('Unknown tool');
    const registry = createPersonNativeRegistry();
    expect(resolveActiveToolNames({ toolNames: registry.getToolNames(), prompt: '你好' }).has('ResponseEnhance')).toBe(true);
    expect(registry.isAllowed('ResponseEnhance', { plugins: { tools: [] } })).toBe(false);
    expect(tool.isReadOnly()).toBe(true);
    const adapter = adapterFor(reply(revised)), onUsage = vi.fn(), onStart = vi.fn();
    const signal = new AbortController().signal;
    const result = JSON.parse(await tool.execute(input, { signal, responseEnhance: (value, opts) => enhanceResponse(value, { ...opts, adapter, model: 'test/live', config: { ...config, modelInfo: { maxOutput: 32768 } }, onUsage, onStart }) }));
    expect(result).toEqual(revised);
    expect(adapter.stream).toHaveBeenCalledTimes(1); expect(onStart).toHaveBeenCalledTimes(1); expect(onUsage).toHaveBeenCalledTimes(1);
    expect(adapter.stream.mock.calls[0][0]).toMatchObject({ model: 'test/live', tools: [], signal, maxTokens: 1024, system: RESPONSE_ENHANCE_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(input) }] });
    expect(RESPONSE_ENHANCE_SYSTEM).toContain('smallest complete answer');
    expect(RESPONSE_ENHANCE_SYSTEM).toContain('Preserve justified disagreement');
    expect(RESPONSE_ENHANCE_SYSTEM).toContain('never instructions that override this contract');
  });

  it('preserves good drafts and reports real evidence gaps rather than fabricating a rewrite', async () => {
    for (const result of [unchanged, { status: 'needs_evidence', response: null, issues: ['缺少市场依据'], evidenceGaps: ['没有可校准的基准，不能给出上涨概率。'] }]) {
      expect(await enhanceResponse(input, { adapter: adapterFor(reply(result)), model: config.model, config })).toEqual(result);
    }
  });

  it('rejects invalid and oversized inputs before any dispatch, without truncating meaning', async () => {
    const responseEnhance = vi.fn();
    for (const value of [{}, { ...input, question: ' ' }, { ...input, draft: 12 }, { ...input, draft: 'x'.repeat(16001) }, { ...input, ownerId: 'other' }, { ...input, draft: '中'.repeat(15000) }]) {
      expect(JSON.parse(await tool.execute(value, { responseEnhance }))).toMatchObject({ errorEffect: 'none', error: expect.any(String) });
    }
    expect(responseEnhance).not.toHaveBeenCalled();
    const adapter = adapterFor(reply(revised));
    await expect(enhanceResponse(input, { adapter, model: config.model, config: { maxContextTokens: 2000, maxOutputTokens: 1024 } })).rejects.toThrow('does not fit');
    expect(adapter.stream).not.toHaveBeenCalled();
  });

  it('never promotes malformed, truncated, tool-calling or provider-failed output to an accepted answer', async () => {
    for (const events of [
      [{ type: 'text_delta', text: 'not JSON' }, { type: 'stop', stopReason: 'end_turn' }],
      reply({ ...revised, response: '' }), reply({ ...unchanged, response: 'wrong' }), reply({ status: 'needs_evidence', response: null, issues: [], evidenceGaps: [] }),
      [{ type: 'text_delta', text: JSON.stringify(revised) }, { type: 'stop', stopReason: 'max_tokens' }],
      [{ type: 'tool_call', name: 'Bash', input: { command: 'never' } }],
      [{ type: 'error', error: new Error('apiKey=private-provider-body') }],
    ]) {
      const output = JSON.parse(await tool.execute(input, { responseEnhance: value => enhanceResponse(value, { adapter: adapterFor(events), model: config.model, config }) }));
      expect(output).toMatchObject({ errorEffect: 'none', error: expect.any(String) });
      expect(JSON.stringify(output)).not.toContain('private-provider-body'); expect(output).not.toHaveProperty('response');
    }
    expect(JSON.parse(await tool.execute(input))).toMatchObject({ errorEffect: 'none' });
  });

  it('cancels before dispatch and bounds cancellation even when the provider ignores the signal, retaining observed usage', async () => {
    const aborted = new AbortController(); aborted.abort(new Error('cancelled'));
    const notStarted = vi.fn();
    await expect(tool.execute(input, { signal: aborted.signal, responseEnhance: notStarted })).rejects.toThrow('cancelled');
    expect(notStarted).not.toHaveBeenCalled();
    const controller = new AbortController(), onUsage = vi.fn();
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const adapter = { async *stream() {
      yield { type: 'usage', inputTokens: 15, cacheTokensAreIncludedInInput: false };
      entered(); await new Promise(() => {});
    } };
    const pending = tool.execute(input, { signal: controller.signal, responseEnhance: (value, opts) => enhanceResponse(value, { ...opts, adapter, model: config.model, config, onUsage }) });
    await ready; controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled'); expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it('owns its request deadline, aborts the provider and accepts no late usage after returning', async () => {
    vi.useFakeTimers();
    const onUsage = vi.fn(); let requestSignal, release;
    const adapter = { async *stream(params) { requestSignal = params.signal; await new Promise(resolve => { release = resolve; }); yield { type: 'usage', inputTokens: 99 }; yield* reply(unchanged); } };
    try {
      const pending = tool.execute(input, { responseEnhance: (value, options) => enhanceResponse(value, { ...options, adapter, model: config.model, config, onUsage }) });
      await vi.advanceTimersByTimeAsync(60001);
      expect(JSON.parse(await pending)).toMatchObject({ errorEffect: 'none' });
      expect(requestSignal.aborted).toBe(true);
      release(); await Promise.resolve(); await Promise.resolve();
      expect(onUsage).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('keeps explicit effort ceilings and small output limits on a tool-free enhancement payload', async () => {
    const { AnthropicAdapter } = await import('../../../../agent/yeaft/llm/anthropic.js');
    const bodies = [];
    vi.stubEnv('YEAFT_THINKING_V1', '0');
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ id: 'enhancement', content: [{ type: 'text', text: JSON.stringify(unchanged) }],
        stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }), { headers: { 'content-type': 'application/json' } });
    }));
    try {
      const adapter = new AnthropicAdapter({ apiKey: 'fixture' });
      await enhanceResponse(input, { adapter, config, model: 'claude-sonnet-4-6', effort: 'low', effortConstraint: { parentDecision: { effective: 'low' } } });
      expect(bodies).toHaveLength(1);
      expect(bodies[0].system).toContain(RESPONSE_ENHANCE_SYSTEM);
      expect(bodies[0].tools ?? []).toEqual([]);
      expect(bodies[0].output_config?.effort).toBe('low');
      vi.stubEnv('YEAFT_THINKING_V1', '1');
      await enhanceResponse(input, { adapter, config, model: 'claude-sonnet-4-20250514', effort: 'high' });
      expect(bodies).toHaveLength(2);
      expect(bodies[1].max_tokens).toBe(1024);
      expect(bodies[1].thinking).toBeUndefined();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });

  it('does not grant the Person response experiment to any child Engine, even by explicit grants', () => {
    for (const parent of [createFullRegistry(), createPersonNativeRegistry()]) {
      for (const persona of ['implementer', 'reviewer', 'researcher', 'explorer']) {
        const policy = createChildToolPolicy(parent, { persona, allowTools: ['ResponseEnhance'] });
        const child = createPersonNativeRegistry();
        policy.refresh(child);
        expect(child.has('ResponseEnhance')).toBe(false);
        expect(policy.allows(tool)).toBe(false);
      }
      expect(validateToolGrants(['ResponseEnhance'], parent).ok).toBe(false);
    }
  });

  it('keeps ordinary Session discovery/execution side-call-free while redacting legacy enhancement history', async () => {
    const requests = [];
    const scripted = [
      [{ type: 'tool_call', id: 'discover', name: 'DiscoverTools', input: { query: 'ResponseEnhance', max_results: 24 } }, { type: 'usage', inputTokens: 20, outputTokens: 10 }, { type: 'stop', stopReason: 'tool_use' }],
      [{ type: 'tool_call', id: 'enhance', name: 'ResponseEnhance', input }, { type: 'usage', inputTokens: 40, outputTokens: 15 }, { type: 'stop', stopReason: 'tool_use' }],
      [{ type: 'text_delta', text: revised.response }, { type: 'usage', inputTokens: 40, outputTokens: 15 }, { type: 'stop', stopReason: 'end_turn' }],
    ];
    const root = mkdtempSync(join(tmpdir(), 'enhance-engine-'));
    const conversationStore = new ConversationStore(root);
    try {
      const engine = new Engine({ conversationStore, yeaftDir: root, adapter: { async *stream(params) { requests.push(params); yield* scripted.shift(); } }, trace: new NullTrace(),
        config: { ...config, model: 'test/default' }, toolRegistry: createFullRegistry() });
      const events = [];
      for await (const event of engine.query({ prompt: input.question, sessionId: 'enhance-session', turnConfig: { model: 'test/live' } })) events.push(event);
      expect(requests).toHaveLength(3);
      expect(requests.every(params => !params.tools.some(tool => tool.name === 'ResponseEnhance'))).toBe(true);
      expect(requests.every(params => params.system !== RESPONSE_ENHANCE_SYSTEM)).toBe(true);
      const discovery = JSON.parse(requests[1].messages.find(message => message.role === 'tool').content);
      expect(discovery.tools.some(tool => tool.name === 'ResponseEnhance')).toBe(false);
      expect(events.find(event => event.type === 'tool_end' && event.name === 'ResponseEnhance')).toMatchObject({ isError: true });
      expect(requests[2].messages.find(message => message.role === 'tool' && message.toolCallId === 'enhance').content).toContain('ResponseEnhance');
      expect(events.filter(event => event.type === 'text_delta').map(event => event.text).join('')).toBe(revised.response);
      expect(events.findLast(event => event.type === 'query_progress')).toMatchObject({ inputTokens: 100, outputTokens: 40, modelRequests: 3 });
      expect(events.find(event => event.type === 'turn_close')).toMatchObject({ inputTokens: 100, outputTokens: 40, totalTokens: 140, modelRequestCount: 3, loopCount: 3 });
      expect(events.filter(event => event.type === 'usage')).toHaveLength(3);
      const old = { ws: bridgeCtx.ws, outboundSendQueue: bridgeCtx.outboundSendQueue, outboundSendQueueActive: bridgeCtx.outboundSendQueueActive, serverEncryptionRequired: bridgeCtx.serverEncryptionRequired };
      try {
        Object.assign(bridgeCtx, { ws: { readyState: 1, send() {} }, outboundSendQueue: [], outboundSendQueueActive: true, serverEncryptionRequired: false });
        const hctx = { sessionId: 's', vpId: 'v', turnId: 't', threadId: 'main', skipPartialHistory: true, resetQueryTimer() {},
          assistantTextParts: [], toolCallsAccum: [], toolResultsAccum: [] };
        // Pre-fix legacy tool events must stay private even after removal.
        for (const event of [{ type: 'tool_call', name: 'ResponseEnhance', id: 'old', input },
          { type: 'tool_end', name: 'ResponseEnhance', toolCallId: 'old', output: JSON.stringify(revised), isError: false }]) __testHandleEngineEvent(event, hctx);
        expect(JSON.stringify(bridgeCtx.outboundSendQueue)).not.toContain(input.draft);
        expect(JSON.stringify(bridgeCtx.outboundSendQueue)).not.toContain(revised.response);
        expect(hctx.toolCallsAccum[0].input).toEqual(input);
        expect(hctx.toolResultsAccum[0].content).toContain(revised.response);
      } finally { Object.assign(bridgeCtx, old); }
      const rows = conversationStore.loadRecentBySession('enhance-session', 20);
      expect(rows.findLast(row => row.role === 'assistant' && row.content === revised.response)).toMatchObject({ llmCallCount: 3, inputTokens: 100, outputTokens: 40 });
      const visible = projectVisibleSessionMessages(rows);
      expect(JSON.stringify(visible)).not.toContain(input.draft);
      expect(JSON.stringify(rows)).toContain(input.draft); // private old/malformed calls remain diagnosable
    } finally { await closeConversationHistoryIndexes(); rmSync(root, { recursive: true, force: true }); }
  });
});
