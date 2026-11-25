import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ctx from '../../../agent/context.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { loadConfig } from '../../../agent/yeaft/config.js';
import { getPluginConfig, updatePluginConfig } from '../../../agent/yeaft/config-api.js';
import { flushAllAgentPerfTraces } from '../../../agent/yeaft/perf-trace.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { __testHooks, __testResetVpState, __testSetSession, handleYeaftUpdateSessionConfig } from '../../../agent/yeaft/web-bridge.js';
import { _resetAgentRegistry } from '../../../agent/yeaft/tools/agent.js';
import { loadSessionConfig, resolveSessionConfig, saveSessionConfig } from '../../../agent/yeaft/sessions/session-config.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { sessionsRoot } from '../../../agent/yeaft/sessions/session-crud.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';

const roots = [];
const originalConfig = ctx.CONFIG;

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function makeDir() {
  return tempRoot('yeaft-session-config-');
}

afterEach(async () => {
  flushAllAgentPerfTraces();
  await __testResetVpState();
  await closeConversationHistoryIndexes();
  ctx.CONFIG = originalConfig;
  __testSetSession(null);
  _resetAgentRegistry();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
});

describe('Yeaft session-scoped model config', () => {
  it('persists High using the selected route rather than the Gemini model ID', () => {
    const root = makeDir();
    const id = 'gemini-4-carbon';
    const availableModels = ['openai-responses', 'openai-chat-completions', 'gemini'].map(protocol =>
      ({ id, ref: `${protocol}/${id}`, provider: protocol, protocol }));
    const config = { availableModels, model: id, primaryModel: availableModels[1].ref };
    for (const [model, input, expected] of [
      [undefined, 'high', 'high'], [availableModels[1].ref, 'low', 'medium'],
      [availableModels[0].ref, 'high', 'xhigh'], [availableModels[2].ref, 'low', 'low'],
    ]) {
      const sessionId = `configured-${expected}`;
      createSession(sessionsRoot(root), { id: sessionId, roster: ['omni'] }).close();
      const saved = saveSessionConfig(root, sessionId, { model, modelEffort: input }, config);
      expect(saved.modelEffort).toBe(expected);
      expect(loadSessionConfig(root, sessionId, config)).toEqual(saved);
      expect(resolveSessionConfig(config, saved).modelEffort).toBe(expected);
    }
  });

  it('keeps High from disk to wire for a qualified Chat alias missing from the local model catalog', async () => {
    const root = makeDir(), sessionId = 'stale-catalog';
    // Same-name rows are supported. The qualified Chat fallback can be the second row.
    const providers = [
      { name: 'proxy', protocol: 'openai-responses', baseUrl: 'https://responses.invalid/v1', apiKey: 'fixture', models: ['listed-responses'] },
      { name: 'proxy', protocol: 'chat-completions', baseUrl: 'https://chat.invalid/v1', apiKey: 'fixture', models: ['listed-chat'] },
    ];
    const config = { providers, adapter: 'openai-responses', availableModels: [], model: 'listed' };
    const selection = { model: 'proxy/unlisted-alias', modelEffort: 'high' };
    createSession(sessionsRoot(root), { id: sessionId, roster: ['omni'] }).close();
    expect(saveSessionConfig(root, sessionId, selection, config)).toEqual(selection);
    const resolved = resolveSessionConfig(config, loadSessionConfig(root, sessionId, config));
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    try {
      await new AdapterRouter({ providers }).call({ model: resolved.model, effort: resolved.modelEffort, effortSource: 'user', messages: [{ role: 'user', content: 'Hi' }] });
      expect(String(fetch.mock.calls[0][0])).toBe('https://chat.invalid/v1/chat/completions');
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ model: 'unlisted-alias', reasoning_effort: 'high' });
      // A listed model on the first row still uses Responses, even with a stale public catalog.
      expect(resolveSessionConfig(config, { ...selection, model: 'proxy/listed-responses' }).modelEffort).toBe('xhigh');
    } finally { fetch.mockRestore(); }
  });

  it('fails closed for an invalid config.json root and preserves every bad file', () => {
    const root = makeDir();
    const configPath = join(root, 'config.json');
    for (const invalidRoot of ['{"plugins":{"tools":["FileRead"]}', '[]']) {
      writeFileSync(configPath, invalidRoot);

      expect(loadConfig({ dir: root })).toMatchObject({
        plugins: { tools: [], skills: [], mcpServers: [] },
        pluginConfigError: expect.stringContaining('config.json is invalid'),
      });
      expect(getPluginConfig(root)).toMatchObject({ error: expect.stringContaining('Failed to read plugin config') });
      expect(updatePluginConfig({ tools: ['Bash'] }, root)).toMatchObject({
        error: expect.stringContaining('Failed to read plugin config'),
      });
      expect(readFileSync(configPath, 'utf8')).toBe(invalidRoot);
    }
  });

  it('publishes persisted config to cached engines at the next provider boundary without aborting a running stream', async () => {
    const root = makeDir();
    const sessionId = 'session_live_model';
    const otherId = 'session_other_model';
    for (const id of [sessionId, otherId]) createSession(sessionsRoot(root), { id, roster: ['omni'] }).close();
    const otherConfig = { model: 'test/other', modelEffort: 'max' };
    saveSessionConfig(root, otherId, otherConfig);
    const keys = ['CONFIG', 'ws', 'outboundSendQueue', 'outboundSendQueueActive', 'serverEncryptionRequired', 'serverCapabilities'];
    const previous = Object.fromEntries(keys.map(key => [key, ctx[key]]));
    ctx.CONFIG = { yeaftDir: root };
    ctx.ws = { readyState: 1, send() {} };
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueActive = true;
    ctx.serverEncryptionRequired = false;
    const requests = [];
    const adapter = { async *stream(params) {
      requests.push(params);
      if (requests.length === 1) {
        // Refresh while the provider request is in flight, not between queries.
        handleYeaftUpdateSessionConfig({ sessionId, requestId: 'live-edit', config: { model: 'test/new', modelEffort: 'ultra' } });
        expect(params).toMatchObject({ model: 'test/old', effort: 'medium' });
        expect(params.signal.aborted).toBe(false);
        yield { type: 'text_delta', text: 'old stream completed' };
        yield { type: 'tool_call', id: 'loop', name: 'echo', input: {} };
        yield { type: 'stop', stopReason: 'tool_use' };
      } else {
        yield { type: 'text_delta', text: 'new loop completed' };
        yield { type: 'stop', stopReason: 'end_turn' };
      }
    } };
    const config = { dir: root, model: 'test/old', primaryModel: 'test/old', modelEffort: 'medium', maxOutputTokens: 1024 };
    __testSetSession({ yeaftDir: root, config, adapter, trace: new NullTrace() });
    const getEngine = __testHooks.getOrCreateVpEngineForTest;
    const engine = getEngine(sessionId, 'omni');
    const backgroundThread = getEngine(sessionId, 'omni', 'background');
    const otherEngine = getEngine(otherId, 'omni');
    const targetRefresh = vi.spyOn(engine, 'refreshConfig');
    const backgroundRefresh = vi.spyOn(backgroundThread, 'refreshConfig');
    const otherRefresh = vi.spyOn(otherEngine, 'refreshConfig');
    const running = __testHooks.seedRunningVpTurn({ sessionId, vpId: 'omni' });
    const coordinator = __testHooks.seedSessionContext(sessionId, { id: sessionId, roster: ['omni'], defaultVpId: 'omni' });
    engine.registerTool({ name: 'echo', description: 'Continue test loop', parameters: { type: 'object' }, execute: async () => 'ok' });
    try {
      const events = [];
      for await (const event of engine.query({ prompt: 'Run two provider loops', sessionId, signal: running.ctrl.signal })) events.push(event);
      expect(requests.map(({ model, effort }) => ({ model, effort }))).toEqual([
        { model: 'test/old', effort: 'medium' }, { model: 'test/new', effort: 'ultra' },
      ]);
      expect(running.ctrl.signal.aborted).toBe(false);
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toHaveLength(1);
      expect(targetRefresh).toHaveBeenCalledTimes(1);
      expect(backgroundRefresh).toHaveBeenCalledTimes(1);
      expect(otherRefresh).not.toHaveBeenCalled();
      expect(loadSessionConfig(root, otherId)).toEqual(otherConfig);
      expect(resolveSessionConfig(config, loadSessionConfig(root, otherId)))
        .toMatchObject({ model: 'test/other', primaryModel: 'test/other', modelEffort: 'max' });
      expect(loadSessionConfig(root, sessionId)).toEqual({ model: 'test/new', modelEffort: 'ultra' });
      expect(__testHooks.getOrCreateSessionContextForTest(sessionId)).toBe(coordinator);
      expect(getEngine(sessionId, 'omni')).toBe(engine);
      expect(targetRefresh).toHaveBeenCalledTimes(1); // Published cache key agrees with the persisted config.
      // Resetting to inheritance also keeps cached Engines and active controls.
      handleYeaftUpdateSessionConfig({ sessionId, config: { model: null, modelEffort: null } });
      expect(targetRefresh).toHaveBeenLastCalledWith(expect.objectContaining(config));
      expect(running.ctrl.signal.aborted).toBe(false);
    } finally {
      Object.assign(ctx, previous);
    }
  });

});
