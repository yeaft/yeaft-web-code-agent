// Sub-agent ownership, driver cleanup, and collectable follow-up replies.

import { describe, it, expect, beforeEach } from 'vitest';
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
    try {
      const manager = new TaskManager({ yeaftDir: dir });
      const registry = mkParentRegistry().register(owned);
      const deps = mkDeps(adapter, { parentToolRegistry: registry, parentSessionId: 'owned-scope', childVpId: 'owned-vp', taskManager: manager, subAgentLogDir: dir });
      const spawned = JSON.parse(await agentTool.execute({ name: 'owned', mission: 'use owned' }, { parentEngineDeps: deps, taskManager: manager }));
      const agent = getAgentRegistry().get(spawned.agentId);
      expect(agent.driverPromise).toBeInstanceOf(Promise);
      await agent.driverPromise;
      expect(observedVpId).toBe('owned-vp');
      expect(agent.result).toBe('done');
      expect(agent.__driverStarted).toBe(false);
      expect(agent.subEngine).toBe(null);
      expect(agent.status).toBe(STATUS.COMPLETED);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps a PromptAgent follow-up collectable across a bounded timeout', async () => {
    const agents = getAgentRegistry();
    const agent = {
      id: 'agent-follow-up', name: 'follow-up', status: STATUS.IDLE,
      result: 'initial reply', lastResult: '', error: null, messages: [],
      usage: { turns: 1, startedAt: Date.now() }, createdAt: Date.now(),
      outputFile: '/tmp/follow-up.log', liveness: makeLiveness(),
      parentSessionId: null, parentVpId: 'vp-test', pendingPrompts: [],
    };
    agents.set(agent.id, agent);

    const prompted = JSON.parse(await sendMessage.execute({
      agent_id: agent.id,
      message: 'slow follow-up',
    }, vpTestCtx));
    expect(prompted.success).toBe(true);
    expect(prompted.next_steps).toMatch(/Call WaitAgent/i);
    expect(prompted.message).toMatch(/Call WaitAgent now/i);
    expect(prompted.message).not.toMatch(/ListAgents|notifications/i);
    expect(agent.promptReplyPending).toBe(true);

    const firstWait = JSON.parse(await waitAgent.execute({
      agent_id: agent.id,
      timeout_ms: 10,
    }, vpTestCtx));
    expect(firstWait).toMatchObject({
      status: STATUS.RUNNING,
      timedOut: true,
      mustCollectReply: true,
      stale: false,
    });
    expect(firstWait.next_steps).toMatch(/must be collected/i);
    expect(firstWait.next_steps).toMatch(/Call WaitAgent again/i);
    expect(firstWait.next_steps).not.toMatch(/only call WaitAgent again if|ListAgents later/i);
    expect(agent.promptReplyPending).toBe(true);

    const finishFollowUp = setTimeout(() => {
      agent.result = 'follow-up reply';
      agent.status = STATUS.IDLE;
    }, 30);
    const secondWait = JSON.parse(await waitAgent.execute({
      agent_id: agent.id,
      timeout_ms: 200,
    }, vpTestCtx));
    clearTimeout(finishFollowUp);

    expect(secondWait).toMatchObject({
      status: STATUS.IDLE,
      result: 'follow-up reply',
      mustCollectReply: false,
    });
    expect(secondWait.next_steps).toMatch(/relay it to the user/i);
    expect(agent.promptReplyPending).toBe(false);
    expect(agent.promptReplyPendingAt).toBeNull();
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
});
