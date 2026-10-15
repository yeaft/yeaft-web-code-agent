// Sub-agent ownership, driver cleanup, and collectable follow-up replies.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Engine } from '../../../agent/yeaft/engine.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { STATUS } from '../../../agent/yeaft/sub-agent/status.js';
import { enqueueTerminalNotification, consumePendingNotifications, _resetNotifications } from '../../../agent/yeaft/sub-agent/notifications.js';
import { makeLiveness } from '../../../agent/yeaft/sub-agent/liveness.js';
import { _resetAgentRegistry, getAgentRegistry } from '../../../agent/yeaft/tools/agent.js';

import agentTool from '../../../agent/yeaft/tools/agent.js';
import sendMessage from '../../../agent/yeaft/tools/send-message.js';
import waitAgent from '../../../agent/yeaft/tools/wait-agent.js';
import closeAgent from '../../../agent/yeaft/tools/close-agent.js';
import listAgents from '../../../agent/yeaft/tools/list-agents.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { TaskManager } from '../../../agent/yeaft/tasks/manager.js';

const echoTool = defineTool({
  name: 'echo',
  description: 'echo input',
  parameters: { type: 'object', properties: {} },
  async execute(input) { return JSON.stringify({ echo: input }); },
});

function mkParentRegistry() {
  const reg = new ToolRegistry();
  reg.registerAll([echoTool, agentTool, sendMessage, waitAgent, closeAgent, listAgents]);
  return reg;
}

function mkDeps(adapter, overrides = {}) {
  return {
    adapter,
    trace: new NullTrace(),
    config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true, language: 'en' },
    parentToolRegistry: mkParentRegistry(),
    parentName: 'TestParent',
    parentVpId: 'vp-test',
    parentVpPersona: { vpId: 'vp-test', persona: 'You are TestPersona.' },
    ...overrides,
  };
}

const vpTestCtx = { parentEngineDeps: { parentVpId: 'vp-test' } };

describe('notifications queue', () => {
  beforeEach(() => _resetNotifications());

  it('scopes parent drains by session and VP', () => {
    enqueueTerminalNotification({
      agentId: 'a-session-1', agentName: 'a1', status: 'completed',
      parentVpId: 'vp-same', parentSessionId: 'session-1',
    });
    enqueueTerminalNotification({
      agentId: 'a-session-2', agentName: 'a2', status: 'completed',
      parentVpId: 'vp-same', parentSessionId: 'session-2',
    });
    enqueueTerminalNotification({
      agentId: 'a-session-1-second', agentName: 'a3', status: 'completed',
      parentVpId: 'vp-same', parentSessionId: 'session-1',
    });

    expect(consumePendingNotifications({
      parentVpId: 'vp-same', sessionId: 'session-1',
    }).map(n => n.agentId)).toEqual(['a-session-1', 'a-session-1-second']);
    expect(consumePendingNotifications({
      parentVpId: 'vp-same', sessionId: 'session-1',
    })).toEqual([]);
    expect(consumePendingNotifications({
      parentVpId: 'vp-same', sessionId: 'session-2',
    }).map(n => n.agentId)).toEqual(['a-session-2']);
  });
});

describe('wait-agent envelope shape', () => {
  beforeEach(() => {
    _resetAgentRegistry();
    _resetNotifications();
  });

  it('exposes an awaitable driver cleanup and optional host VP ownership', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-driver-join-'));
    let observedVpId;
    const owned = defineTool({
      name: 'FileRead', description: 'observe ownership', parameters: { type: 'object', properties: {} },
      isReadOnly: () => true,
      async execute(_input, ctx) { observedVpId = ctx.currentVpId; return 'owned'; },
    });
    let calls = 0;
    const adapter = { async *stream() {
      if (calls++ === 0) { yield { type: 'tool_call', id: 'owned-call', name: 'FileRead', input: {} }; yield { type: 'stop', stopReason: 'tool_use' }; }
      else { yield { type: 'text_delta', text: 'done' }; yield { type: 'stop', stopReason: 'end_turn' }; }
    } };
    let querySpy;
    try {
      const manager = new TaskManager({ yeaftDir: dir });
      const refreshSpy = vi.spyOn(manager, 'refreshTaskLog');
      const onEvent = vi.fn();
      const originalQuery = Engine.prototype.query;
      querySpy = vi.spyOn(Engine.prototype, 'query').mockImplementation(async function* (...args) {
        // Inject Engine control events at the runner boundary, while keeping
        // the actual child query/tool flow below intact.
        const refreshCount = refreshSpy.mock.calls.length;
        for (const type of ['provider_activity', 'query_progress', 'query_progress']) {
          yield { type, toolCalls: 2, repeatedResults: 1 };
          expect(refreshSpy).toHaveBeenCalledTimes(refreshCount);
        }
        yield* originalQuery.apply(this, args);
      });
      const registry = mkParentRegistry().register(owned);
      const deps = mkDeps(adapter, { parentToolRegistry: registry, parentSessionId: 'owned-scope', childVpId: 'owned-vp', taskManager: manager, subAgentLogDir: dir, onEvent });
      const ctx = { cwd: dir, queryTurnId: 'owned-query', parentEngineDeps: deps, taskManager: manager };
      const spec = { name: 'owned', mission: 'use owned', baseline: '04f0705a' };
      const spawned = JSON.parse(await agentTool.execute(spec, ctx));
      const retry = JSON.parse(await agentTool.execute({ ...spec, name: 'renamed' }, ctx));
      expect(retry).toMatchObject({ reused: true, agentId: spawned.agentId, taskId: spawned.taskId });
      expect(getAgentRegistry().size).toBe(1);
      const agent = getAgentRegistry().get(spawned.agentId);
      expect(agent.driverPromise).toBeInstanceOf(Promise);
      await agent.driverPromise;
      expect(observedVpId).toBe('owned-vp');
      expect(agent.result).toBe('done');
      expect(agent.__driverStarted).toBe(false);
      expect(agent.subEngine).toBe(null);
      expect(agent.status).toBe(STATUS.COMPLETED);
      const childLog = fs.readFileSync(agent.outputFile, 'utf8');
      expect(childLog).toContain('text_delta');
      expect(childLog).not.toMatch(/provider_activity|query_progress/);
      expect(onEvent.mock.calls.some(([, evt]) => ['provider_activity', 'query_progress'].includes(evt.type))).toBe(false);
      expect(JSON.stringify(agent.engineMessages)).not.toContain('query_progress');
      expect(agent.subVpPersona.runtimePreamble).toContain('Workspace baseline: 04f0705a');
      const terminalRetry = JSON.parse(await agentTool.execute({ ...spec, name: 'terminal-renamed' }, ctx));
      expect(terminalRetry).toMatchObject({ reused: true, status: STATUS.COMPLETED, agentId: spawned.agentId, taskId: spawned.taskId });
      const collected = JSON.parse(await waitAgent.execute({ agent_id: agent.id }, ctx));
      expect(collected.result).toBe('done');
      expect(terminalRetry.resultRef).toBe(collected.resultRef);
      const repeated = JSON.parse(await waitAgent.execute({ agent_id: agent.id }, ctx));
      expect(repeated).toMatchObject({ alreadyCollected: true, resultRef: collected.resultRef, status: STATUS.COMPLETED });
      expect(repeated).not.toHaveProperty('result');
      expect(calls).toBe(2);
      expect(querySpy).toHaveBeenCalledTimes(1);
    } finally {
      querySpy?.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('separates completed lifecycle from an incomplete budget outcome in WaitAgent', async () => {
    const agent = {
      id: 'agent-budget', name: 'budget', status: STATUS.COMPLETED,
      result: { status: 'budget_exceeded', outcome: 'incomplete', complete: false,
        partial_output: 'APPROVE', reason: 'max_tool_calls reached', usage: { turns: 1 },
        truncated: true, final_report: { reserved: true, received: true, truncated: true, text: 'APPROVE' } },
      lastResult: '', error: null, messages: [], usage: { turns: 1, startedAt: Date.now() },
      outputFile: '/tmp/budget.log', liveness: makeLiveness(), parentSessionId: null,
      parentVpId: 'vp-test', pendingPrompts: [],
    };
    getAgentRegistry().set(agent.id, agent);
    const waited = JSON.parse(await waitAgent.execute({ agent_id: agent.id, timeout_ms: 0 }, vpTestCtx));
    expect(waited).toMatchObject({
      status: STATUS.COMPLETED,
      lifecycle: { status: STATUS.COMPLETED, terminal: true },
      outcome: { status: 'incomplete', complete: false, reason: 'budget_exceeded', truncated: true },
      budgetExceeded: true, incomplete: true, truncated: true, partial_output: 'APPROVE',
      final_report: { reserved: true, received: true, truncated: true },
    });
    expect(waited.next_steps).toContain('Do NOT present this as an ordinary successful completion');
    const repeated = JSON.parse(await waitAgent.execute({ agent_id: agent.id, timeout_ms: 0 }, vpTestCtx));
    expect(repeated).toMatchObject({ alreadyCollected: true, resultRef: waited.resultRef, incomplete: true, budgetExceeded: true });
    expect(repeated).not.toHaveProperty('result');
    expect(repeated).not.toHaveProperty('partial_output');
    expect(repeated).not.toHaveProperty('final_report');
  });

  it('scoped tools reject agents owned by another session', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-owned-a', {
      id: 'agent-owned-a', name: 'owned-a', status: STATUS.IDLE,
      result: 'secret result', lastResult: '', error: null, messages: [],
      usage: { turns: 1 }, outputFile: '/tmp/secret.log', liveness: makeLiveness(),
      parentSessionId: 'session-a', parentVpId: 'vp-a',
      pendingPrompts: [],
    });
    agents.set('agent-owned-b', {
      id: 'agent-owned-b', name: 'owned-b', status: STATUS.IDLE,
      result: 'visible result', lastResult: '', error: null, messages: [],
      usage: { turns: 1 }, outputFile: '/tmp/visible.log', liveness: makeLiveness(),
      parentSessionId: 'session-b', parentVpId: 'vp-b',
      pendingPrompts: [],
    });
    const ctxB = { parentEngineDeps: { parentSessionId: 'session-b', parentVpId: 'vp-b' } };

    const deniedWait = JSON.parse(await waitAgent.execute({ agent_id: 'agent-owned-a' }, ctxB));
    expect(deniedWait.error).toMatch(/not found/i);
    const deniedPrompt = JSON.parse(await sendMessage.execute({ agent_id: 'agent-owned-a', message: 'steal' }, ctxB));
    expect(deniedPrompt.error).toMatch(/not found/i);
    const deniedClose = JSON.parse(await closeAgent.execute({ agent_id: 'agent-owned-a' }, ctxB));
    expect(deniedClose.error).toMatch(/not found/i);

    const listed = JSON.parse(await listAgents.execute({}, ctxB));
    expect(listed.agents.map(a => a.id)).toEqual(['agent-owned-b']);
    const ownWait = JSON.parse(await waitAgent.execute({ agent_id: 'agent-owned-b' }, ctxB));
    expect(ownWait.result).toBe('visible result');
  });

  it('uses canonical exact specs and rejects explicit identity conflicts without semantic deduplication', async () => {
    const parentToolRegistry = mkParentRegistry().register(defineTool({ name: 'FileRead', aliases: ['Read'], description: 'read', parameters: {}, execute: async () => 'read' }));
    const ctx = { cwd: os.tmpdir(), queryTurnId: 'canonical-query', parentEngineDeps: { parentVpId: 'vp-test', parentToolRegistry } };
    const spec = { name: 'canonical', taskKey: 'review', mission: 'Review baseline', persona: 'reviewer', cwd: '.', baseline: '04f0705a',
      expected_output: { type: 'object', properties: { evidence: { type: 'string' }, ok: { type: 'boolean' } } }, allow_tools: ['echo', 'FileRead'] };
    const spawned = JSON.parse(await agentTool.execute(spec, ctx));
    expect(spawned.success).toBe(true);
    const canonicalRetry = { ...spec, name: 'renamed', cwd: path.resolve(ctx.cwd), allow_tools: ['Read', 'echo', 'echo'],
      expected_output: { properties: { ok: { type: 'boolean' }, evidence: { type: 'string' } }, type: 'object' } };
    expect(JSON.parse(await agentTool.execute(canonicalRetry, ctx))).toMatchObject({ reused: true, agentId: spawned.agentId });
    // Each execution-relevant field must conflict under the explicit identity.
    for (const change of [
      { mission: 'Review the baseline' }, { persona: 'explorer' }, { cwd: 'other' }, { baseline: 'different-sha' },
      { expected_output: { type: 'string' } }, { allow_tools: ['echo'] }, { budget: { max_turns: 2 } },
    ]) {
      const conflict = JSON.parse(await agentTool.execute({ ...spec, ...change, name: 'changed' }, ctx));
      expect(conflict.error).toMatch(/Task identity conflict/);
      expect(conflict.agentId).toBe(spawned.agentId);
    }
    expect(getAgentRegistry().size).toBe(1);
    const independent = JSON.parse(await agentTool.execute({ ...spec, name: 'independent', taskKey: 'review-independent' }, ctx));
    expect(independent.success).toBe(true);
    expect(independent.agentId).not.toBe(spawned.agentId);
    const implicit = { ...spec, name: 'implicit', taskKey: undefined };
    const first = JSON.parse(await agentTool.execute(implicit, ctx));
    expect(JSON.parse(await agentTool.execute({ ...implicit, name: 'implicit-retry' }, ctx))).toMatchObject({ reused: true, agentId: first.agentId });
    const similar = JSON.parse(await agentTool.execute({ ...implicit, name: 'similar', mission: 'Review the baseline' }, ctx));
    expect(similar.success).toBe(true);
    expect(similar.agentId).not.toBe(first.agentId);
  });

  it('isolates exact delegation reuse by query, workspace and owner, leaving legacy callers unchanged', async () => {
    const ctx = { cwd: os.tmpdir(), queryTurnId: 'query-a', sessionId: 'session-a', senderVpId: 'vp-a', threadId: 'thread-a' };
    const spec = { name: 'scoped', mission: 'Same task', taskKey: 'same-key' };
    const spawned = JSON.parse(await agentTool.execute(spec, ctx));
    for (const [index, change] of [
      { queryTurnId: 'query-b' }, { cwd: path.join(os.tmpdir(), 'other-workspace') },
      { sessionId: 'session-b' }, { senderVpId: 'vp-b' }, { threadId: 'thread-b' },
    ].entries()) {
      const independent = JSON.parse(await agentTool.execute({ ...spec, name: 'scope-' + index }, { ...ctx, ...change }));
      expect(independent.success).toBe(true);
      expect(independent.reused).not.toBe(true);
      expect(independent.agentId).not.toBe(spawned.agentId);
    }
    const legacyCtx = { ...ctx, queryTurnId: undefined };
    const legacy = JSON.parse(await agentTool.execute({ ...spec, name: 'legacy-a' }, legacyCtx));
    const legacyRetry = JSON.parse(await agentTool.execute({ ...spec, name: 'legacy-b' }, legacyCtx));
    expect(legacyRetry.agentId).not.toBe(legacy.agentId);
    expect(legacyRetry.reused).not.toBe(true);
  });

  it('collects identical-text PromptAgent revisions once each while preserving live wait and cancellation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-reply-revision-'));
    let calls = 0;
    let releaseFollowUp;
    const followUpGate = new Promise(resolve => { releaseFollowUp = resolve; });
    const reply = 'evidence '.repeat(3000);
    const adapter = { async *stream() {
      if (calls++ > 0) await followUpGate;
      yield { type: 'text_delta', text: reply };
      yield { type: 'stop', stopReason: 'end_turn' };
    } };
    const ctx = { cwd: dir, queryTurnId: 'reply-query', sessionId: 'ctx-session', senderVpId: 'vp-test',
      parentEngineDeps: mkDeps(adapter, { subAgentLogDir: dir }) };
    let agent;
    try {
      const spawned = JSON.parse(await agentTool.execute({ name: 'revisions', mission: 'Return evidence' }, ctx));
      agent = getAgentRegistry().get(spawned.agentId);
      // The runner must not discard ctx ownership when deps omit the session.
      expect(agent.parentSessionId).toBe('ctx-session');
      const first = JSON.parse(await waitAgent.execute({ agent_id: agent.id, timeout_ms: 2000 }, ctx));
      expect(first.result).toBe(reply);
      expect(first.status).toBe(STATUS.IDLE);
      const repeated = JSON.parse(await waitAgent.execute({ agent_id: agent.id }, ctx));
      expect(repeated).toMatchObject({ alreadyCollected: true, resultRef: first.resultRef });
      expect(repeated).not.toHaveProperty('result');
      expect(JSON.stringify(repeated).length).toBeLessThan(2500);
      const prompted = JSON.parse(await sendMessage.execute({ agent_id: agent.id, message: 'Return identical evidence again' }, ctx));
      expect(prompted.success).toBe(true);
      const live = JSON.parse(await waitAgent.execute({ agent_id: agent.id, timeout_ms: 10 }, ctx));
      expect(live).toMatchObject({ status: STATUS.RUNNING, timedOut: true, mustCollectReply: true, stale: false });
      expect(live).not.toHaveProperty('alreadyCollected');
      expect(live.next_steps).toMatch(/must be collected/i);
      expect(live.next_steps).toMatch(/Call WaitAgent again/i);
      expect(agent.promptReplyPending).toBe(true);
      const abort = new AbortController();
      abort.abort();
      const cancelled = JSON.parse(await waitAgent.execute({ agent_id: agent.id }, { ...ctx, signal: abort.signal }));
      expect(cancelled.error).toBe('Wait cancelled');
      expect(agent.abortController.signal.aborted).toBe(false);
      releaseFollowUp();
      const second = JSON.parse(await waitAgent.execute({ agent_id: agent.id, timeout_ms: 2000 }, ctx));
      expect(second).toMatchObject({ status: STATUS.IDLE, result: reply, mustCollectReply: false });
      expect(second.resultRef).not.toBe(first.resultRef);
      expect(agent.resultRevision).toBe(2);
      expect(agent.promptReplyPending).toBe(false);
      expect(agent.promptReplyPendingAt).toBeNull();
      expect(JSON.parse(await waitAgent.execute({ agent_id: agent.id }, ctx))).toMatchObject({ alreadyCollected: true, resultRef: second.resultRef });
      const closed = JSON.parse(await closeAgent.execute({ agent_id: agent.id }, ctx));
      expect(closed.status).toBe(STATUS.CLOSED);
      expect(agent.abortController.signal.aborted).toBe(true);
      await agent.driverPromise;
      expect(calls).toBe(2);
    } finally {
      releaseFollowUp();
      if (agent) {
        await closeAgent.execute({ agent_id: agent.id }, ctx);
        await agent.driverPromise;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
