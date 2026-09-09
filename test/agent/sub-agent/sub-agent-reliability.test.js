/**
 * sub-agent-reliability.test.js — End-to-end coverage of the sub-agent
 * reliability overhaul.
 *
 * What this file pins (one describe block per concern):
 *
 *   1. status.js  — terminal / interactive / promptable helpers agree
 *                    with the rest of the subsystem on the same set.
 *
 *   2. output-log.js — durable JSONL events, rotation, tail-on-clean-record.
 *
 *   3. notifications.js — enqueue/dedup, bucket-by-parentVpId,
 *                          per-agent drain, prompt formatting.
 *
 *   4. wait-agent envelope — every status returns the new shape with
 *                             outputFile + liveness + status-specific
 *                             next_steps; timeout returns timedOut +
 *                             runningInBackground; consumes the
 *                             per-agent notification.
 *
 *   5. tickAgent budget enforcement — exceeded max_turns produces a
 *                                      budget_exceeded envelope and
 *                                      flips status to completed.
 *
 *   6. idle watchdog — abandons the agent after the configured ms and
 *                        enqueues a terminal notification.
 *
 *   7. driver finally{} — outputFile is closed and subEngine is nulled
 *                          out after a terminal transition.
 *
 *   8. mid-stream lastResult — lastResult is set on text_delta during
 *                               long generations, before the turn ends.
 *
 *   9. engine.js prepend — consumePendingNotifications drains into the
 *                           user prompt at the head of the next turn.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  STATUS,
  isTerminalAgentStatus,
  isInteractiveAgentStatus,
  isPromptableAgentStatus,
  describeAgentStatus,
} from '../../../agent/yeaft/sub-agent/status.js';

import {
  createOutputLog,
  readOutputLog,
  resolveLogPath,
  _internals as outputLogInternals,
} from '../../../agent/yeaft/sub-agent/output-log.js';

import {
  enqueueTerminalNotification,
  consumePendingNotifications,
  consumeNotificationForAgent,
  formatNotificationsForPrompt,
  _resetNotifications,
  _peekAll,
} from '../../../agent/yeaft/sub-agent/notifications.js';

import {
  makeLiveness,
  bumpLivenessFromEvent,
  snapshotLiveness,
} from '../../../agent/yeaft/sub-agent/liveness.js';

import {
  _resetAgentRegistry,
  getAgentRegistry,
  tickAgent,
} from '../../../agent/yeaft/tools/agent.js';
import { startSubAgent } from '../../../agent/yeaft/sub-agent/runner.js';
import agentTool from '../../../agent/yeaft/tools/agent.js';
import sendMessage from '../../../agent/yeaft/tools/send-message.js';
import waitAgent from '../../../agent/yeaft/tools/wait-agent.js';
import closeAgent from '../../../agent/yeaft/tools/close-agent.js';
import listAgents from '../../../agent/yeaft/tools/list-agents.js';

import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { TaskManager } from '../../../agent/yeaft/tasks/manager.js';
import { writeContent } from '../../../agent/yeaft/memory/store.js';

// -------------------------------------------------------------------------
// Shared scripted adapter + helpers
// -------------------------------------------------------------------------

class TextAdapter {
  constructor(reply = 'done') {
    this.reply = reply;
    this.streamCalls = [];
  }
  async *stream(params) {
    this.streamCalls.push({
      system: params.system,
      messages: JSON.parse(JSON.stringify(params.messages || [])),
    });
    yield { type: 'text_delta', text: this.reply };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
  async call() { return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }; }
}

/** A scripted adapter that pauses between text deltas so tests can
 *  inspect mid-stream state before the turn ends. */
class SlowAdapter {
  constructor(chunks = ['hello', ' ', 'world'], delayMs = 30) {
    this.chunks = chunks;
    this.delayMs = delayMs;
    this.streamCalls = [];
  }
  async *stream(params) {
    this.streamCalls.push({ system: params.system, messages: params.messages });
    for (const chunk of this.chunks) {
      yield { type: 'text_delta', text: chunk };
      await new Promise(r => setTimeout(r, this.delayMs));
    }
    yield { type: 'stop', stopReason: 'end_turn' };
  }
  async call() { return { text: 'ok', usage: {} }; }
}

class ThrowingAdapter {
  constructor(message = 'adapter boom') {
    this.message = message;
    this.streamCalls = [];
  }
  async *stream(params) {
    this.streamCalls.push({ system: params.system, messages: params.messages });
    throw new Error(this.message);
  }
  async call() { return { text: 'ok', usage: {} }; }
}

class UsageAdapter {
  constructor({ text = 'ok', inputTokens = 0, outputTokens = 0 } = {}) {
    this.text = text;
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
    this.streamCalls = [];
  }
  async *stream(params) {
    this.streamCalls.push({ system: params.system, messages: params.messages });
    if (this.text) yield { type: 'text_delta', text: this.text };
    yield { type: 'usage', inputTokens: this.inputTokens, outputTokens: this.outputTokens };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
  async call() { return { text: 'ok', usage: {} }; }
}

class StuckAdapter {
  constructor() {
    this.streamCalls = [];
    this.aborted = false;
  }
  async *stream(params) {
    this.streamCalls.push(params);
    while (!params.signal?.aborted) {
      await new Promise(r => setTimeout(r, 10));
    }
    this.aborted = true;
    throw new Error(params.signal.reason || 'aborted');
  }
  async call() { return { text: 'ok', usage: {} }; }
}

class ToolUseAdapter {
  constructor(toolName) {
    this.toolName = toolName;
    this.streamCalls = [];
  }
  async *stream(params) {
    this.streamCalls.push({ system: params.system, messages: params.messages });
    yield { type: 'tool_call', id: 'tc-1', name: this.toolName, input: {} };
    yield { type: 'stop', stopReason: 'tool_use' };
  }
  async call() { return { text: 'ok', usage: {} }; }
}

const echoTool = defineTool({
  name: 'echo',
  description: 'echo input',
  parameters: { type: 'object', properties: {} },
  async execute(input) { return JSON.stringify({ echo: input }); },
});

const handoffTool = defineTool({
  name: 'handoff',
  description: 'request end turn',
  parameters: { type: 'object', properties: {} },
  async execute(_input, ctx) {
    ctx.requestEndTurn?.({ kind: 'test_handoff' });
    return 'handoff ok';
  },
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

async function settle(agent, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && agent.status !== 'idle' && !isTerminalAgentStatus(agent.status)) {
    await new Promise(r => setTimeout(r, 20));
  }
}

// -------------------------------------------------------------------------
// 1. status.js
// -------------------------------------------------------------------------


// -------------------------------------------------------------------------
// 2. output-log.js
// -------------------------------------------------------------------------


// -------------------------------------------------------------------------
// 3. notifications.js
// -------------------------------------------------------------------------

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

// -------------------------------------------------------------------------
// 4. wait-agent envelope shape
// -------------------------------------------------------------------------

describe('wait-agent envelope shape', () => {
  beforeEach(() => {
    _resetAgentRegistry();
    _resetNotifications();
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

  it('keeps ordinary SpawnAgent timeouts on the asynchronous path', async () => {
    const agent = {
      id: 'agent-background', name: 'background', status: STATUS.RUNNING,
      result: '', lastResult: '', error: null, messages: [],
      usage: { turns: 0, startedAt: Date.now() }, createdAt: Date.now(),
      outputFile: '/tmp/background.log', liveness: makeLiveness(),
      parentSessionId: null, parentVpId: 'vp-test', pendingPrompts: [],
    };
    getAgentRegistry().set(agent.id, agent);

    const waited = JSON.parse(await waitAgent.execute({
      agent_id: agent.id,
      timeout_ms: 5,
    }, vpTestCtx));
    expect(waited).toMatchObject({
      status: STATUS.RUNNING,
      timedOut: true,
      mustCollectReply: false,
    });
    expect(waited.next_steps).toMatch(/ListAgents later/i);
    expect(waited.next_steps).not.toMatch(/must be collected/i);
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

    const rollbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeaft-runner-startup-'));
    const partialAgent = {
      id: 'agent-partial-startup',
      name: 'partial-startup',
      mission: 'fail after output log creation',
      status: STATUS.CREATED,
    };
    const partialDeps = mkDeps(new TextAdapter(), { subAgentLogDir: rollbackDir });
    Object.defineProperty(partialDeps, 'language', {
      configurable: true,
      get() { throw new Error('preamble setup failed'); },
    });
    expect(() => startSubAgent(partialAgent, partialDeps)).toThrow('preamble setup failed');
    const partialLogPath = path.join(rollbackDir, 'agent-partial-startup.log');
    expect(fs.existsSync(partialLogPath)).toBe(true);
    expect(fs.readFileSync(partialLogPath, 'utf8')).toContain('sub_agent_spawned');
    expect(partialAgent).toMatchObject({
      __driverStarted: false,
      subEngine: null,
      subVpPersona: null,
      outputLog: null,
      outputFile: null,
    });
    fs.rmSync(rollbackDir, { recursive: true, force: true });
  });

  it('sessionless scoped tools still isolate different parent VPs', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-vp-a', {
      id: 'agent-vp-a', name: 'vp-a-agent', status: STATUS.IDLE,
      result: 'vp-a result', lastResult: '', error: null, messages: [],
      usage: { turns: 1 }, outputFile: '/tmp/vp-a.log', liveness: makeLiveness(),
      parentSessionId: null, parentVpId: 'vp-a',
      pendingPrompts: [],
    });
    agents.set('agent-vp-b', {
      id: 'agent-vp-b', name: 'vp-b-agent', status: STATUS.IDLE,
      result: 'vp-b result', lastResult: '', error: null, messages: [],
      usage: { turns: 1 }, outputFile: '/tmp/vp-b.log', liveness: makeLiveness(),
      parentSessionId: null, parentVpId: 'vp-b',
      pendingPrompts: [],
    });
    const ctxB = { parentEngineDeps: { parentVpId: 'vp-b' } };

    const emptyScopeDenied = JSON.parse(await waitAgent.execute({ agent_id: 'agent-vp-a' }, {}));
    expect(emptyScopeDenied.error).toMatch(/not found/i);
    const denied = JSON.parse(await waitAgent.execute({ agent_id: 'agent-vp-a' }, ctxB));
    expect(denied.error).toMatch(/not found/i);
    const listed = JSON.parse(await listAgents.execute({}, ctxB));
    expect(listed.agents.map(a => a.id)).toEqual(['agent-vp-b']);

    // A retained child must use the Project snapshot attached to each queued
    // continuation, not the Project context captured when it was spawned.
    _resetAgentRegistry();
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeaft-project-context-runner-'));
    const adapter = new TextAdapter('done');
    const scopeFilters = [];
    const memoryRoot = path.join(logDir, 'memory');
    await writeContent(
      { kind: 'session', id: 'old-sibling' },
      'Old sibling experience should be visible only on the initial sub-agent turn.',
      { root: memoryRoot },
    );
    await writeContent(
      { kind: 'session', id: 'new-sibling' },
      'New sibling experience should replace the old Project context.',
      { root: memoryRoot },
    );
    await writeContent(
      { kind: 'session', id: 'session-live' },
      'Sub-agent recall must survive the single AMS render outlet.',
      { root: memoryRoot },
    );
    const memoryIndex = {
      search({ scopeFilter }) {
        scopeFilters.push([...scopeFilter]);
        if (!scopeFilter.includes('sessions/session-live')) return [];
        const scopes = [
          'sessions/session-live',
          ...['sessions/old-sibling', 'sessions/new-sibling']
            .filter(scope => scopeFilter.includes(scope)),
        ];
        return scopes.map((scope, index) => ({
          id: `canonical-${index}`,
          scope,
          kind: 'context',
          tags: ['canonical-content', 'project'],
          sourceMessages: [],
          body: 'Canonical content selector only.',
          rank: -1 - index,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        }));
      },
    };
    const agent = {
      id: 'agent-project-context',
      name: 'project-context',
      mission: 'initial project policy',
      status: STATUS.CREATED,
      messages: [],
      result: null,
      lastResult: '',
      partial_output: '',
      diagnostics: [],
      usage: { tokens: 0, turns: 0, startedAt: Date.now() },
      createdAt: Date.now(),
      trace: [],
      liveness: makeLiveness(),
      outputFile: null,
      parentVpId: 'vp-test',
      parentSessionId: 'session-live',
      parentThreadId: 'main',
      abortController: new AbortController(),
    };
    const ownerContext = {
      parentEngineDeps: {
        parentSessionId: 'session-live',
        parentVpId: 'vp-test',
        parentThreadId: 'main',
      },
    };
    getAgentRegistry().set(agent.id, agent);

    try {
      startSubAgent(agent, mkDeps(adapter, {
        memoryIndex,
        parentSessionId: 'session-live',
        parentThreadId: 'main',
        projectSessionIds: ['old-sibling'],
        projectInstruction: 'OLD PROJECT INSTRUCTION MUST DISAPPEAR',
        yeaftDir: logDir,
        subAgentLogDir: logDir,
        idleAbandonMs: 10_000,
      }));
      await settle(agent);
      expect(agent.status).toBe(STATUS.IDLE);
      expect(adapter.streamCalls).toHaveLength(1);
      expect(adapter.streamCalls[0].system).toContain('OLD PROJECT INSTRUCTION MUST DISAPPEAR');
      expect(adapter.streamCalls[0].system).not.toContain('Old sibling experience should be visible');
      expect(adapter.streamCalls[0].system).not.toContain('Sub-agent recall must survive the single AMS render outlet.');
      expect(scopeFilters).toEqual([]);

      const updated = JSON.parse(await sendMessage.execute({
        agent_id: agent.id,
        message: 'updated project policy',
      }, {
        parentEngineDeps: {
          ...ownerContext.parentEngineDeps,
          projectSessionIds: ['new-sibling'],
          projectInstruction: 'NEW PROJECT INSTRUCTION',
        },
      }));
      expect(updated.success).toBe(true);
      await settle(agent);
      expect(agent.status).toBe(STATUS.IDLE);
      expect(adapter.streamCalls).toHaveLength(2);
      expect(adapter.streamCalls[1].system).toContain('NEW PROJECT INSTRUCTION');
      expect(adapter.streamCalls[1].system).not.toContain('New sibling experience should replace the old Project context.');
      expect(adapter.streamCalls[1].system).not.toContain('Old sibling experience should be visible');
      expect(adapter.streamCalls[1].system).not.toContain('OLD PROJECT INSTRUCTION MUST DISAPPEAR');
      expect(scopeFilters).toEqual([]);

      const cleared = JSON.parse(await sendMessage.execute({
        agent_id: agent.id,
        message: 'cleared project policy',
      }, {
        parentEngineDeps: {
          ...ownerContext.parentEngineDeps,
          projectSessionIds: [],
          projectInstruction: '',
        },
      }));
      expect(cleared.success).toBe(true);
      await settle(agent);
      expect(agent.status).toBe(STATUS.IDLE);
      expect(adapter.streamCalls).toHaveLength(3);
      expect(adapter.streamCalls[2].system).not.toContain('OLD PROJECT INSTRUCTION MUST DISAPPEAR');
      expect(adapter.streamCalls[2].system).not.toContain('NEW PROJECT INSTRUCTION');
      expect(adapter.streamCalls[2].system).not.toContain('Old sibling experience should be visible');
      expect(adapter.streamCalls[2].system).not.toContain('New sibling experience should replace');
      expect(scopeFilters).toEqual([]);
    } finally {
      await closeAgent.execute({ agent_id: agent.id }, ownerContext);
      await new Promise(resolve => setTimeout(resolve, 80));
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });


});

// -------------------------------------------------------------------------
// 5. tickAgent budget enforcement
// -------------------------------------------------------------------------


// -------------------------------------------------------------------------
// 6. Idle watchdog
// -------------------------------------------------------------------------


// -------------------------------------------------------------------------
// 7. Driver finally{} cleanup
// -------------------------------------------------------------------------


// -------------------------------------------------------------------------
// 8. Mid-stream lastResult
// -------------------------------------------------------------------------


// -------------------------------------------------------------------------
// 9. Engine prepend — consumePendingNotifications hooks into the user prompt
// -------------------------------------------------------------------------

describe('engine prepends sub-agent notifications to the next user turn', () => {
  beforeEach(() => _resetNotifications());


  it('does not let another session with the same VP drain the notification', async () => {
    const { Engine } = await import('../../../agent/yeaft/engine.js');
    const wrongAdapter = new TextAdapter('wrong');
    const rightAdapter = new TextAdapter('right');
    const wrongEngine = new Engine({
      adapter: wrongAdapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 256, _readOnly: true, language: 'en' },
      toolRegistry: mkParentRegistry(),
      sessionId: 'session-wrong',
      vpId: 'vp-parent',
    });
    const rightEngine = new Engine({
      adapter: rightAdapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 256, _readOnly: true, language: 'en' },
      toolRegistry: mkParentRegistry(),
      sessionId: 'session-right',
      vpId: 'vp-parent',
    });

    enqueueTerminalNotification({
      agentId: 'scoped-agent', agentName: 'scoped', status: 'completed',
      result: 'session-right result', parentVpId: 'vp-parent',
      parentSessionId: 'session-right',
    });

    for await (const _ of wrongEngine.query({
      prompt: 'wrong session',
      messages: [],
      vpPersona: { vpId: 'vp-parent', persona: 'You are Parent.' },
      sessionId: 'session-wrong',
    })) { /* drain */ }
    const wrongUser = wrongAdapter.streamCalls[0].messages.find(m => m.role === 'user');
    expect(String(wrongUser.content)).not.toMatch(/sub-agent-notifications/);

    for await (const _ of rightEngine.query({
      prompt: 'right session',
      messages: [],
      vpPersona: { vpId: 'vp-parent', persona: 'You are Parent.' },
      sessionId: 'session-right',
    })) { /* drain */ }
    const rightUser = rightAdapter.streamCalls[0].messages.find(m => m.role === 'user');
    expect(String(rightUser.content)).toMatch(/<sub-agent-notifications>/);
    expect(String(rightUser.content)).toMatch(/session-right result/);
  });


});

// -------------------------------------------------------------------------
// 10. ListAgents reports outputFile + liveness for live agents
// -------------------------------------------------------------------------
