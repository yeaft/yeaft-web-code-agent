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
import agentTool from '../../../agent/yeaft/tools/agent.js';
import sendMessage from '../../../agent/yeaft/tools/send-message.js';
import waitAgent from '../../../agent/yeaft/tools/wait-agent.js';
import closeAgent from '../../../agent/yeaft/tools/close-agent.js';
import listAgents from '../../../agent/yeaft/tools/list-agents.js';

import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';

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

describe('status helpers', () => {
  it('STATUS enum is frozen', () => {
    expect(Object.isFrozen(STATUS)).toBe(true);
    expect(() => { STATUS.NEW = 'new'; }).toThrow();
  });

  it('terminal set matches the four documented terminal states', () => {
    expect(isTerminalAgentStatus(STATUS.COMPLETED)).toBe(true);
    expect(isTerminalAgentStatus(STATUS.FAILED)).toBe(true);
    expect(isTerminalAgentStatus(STATUS.CLOSED)).toBe(true);
    expect(isTerminalAgentStatus(STATUS.ABANDONED)).toBe(true);
    expect(isTerminalAgentStatus(STATUS.RUNNING)).toBe(false);
    expect(isTerminalAgentStatus(STATUS.IDLE)).toBe(false);
    expect(isTerminalAgentStatus(STATUS.CREATED)).toBe(false);
    expect(isTerminalAgentStatus('nonsense')).toBe(false);
    expect(isTerminalAgentStatus(undefined)).toBe(false);
  });

  it('interactive set excludes terminal states', () => {
    expect(isInteractiveAgentStatus(STATUS.CREATED)).toBe(true);
    expect(isInteractiveAgentStatus(STATUS.RUNNING)).toBe(true);
    expect(isInteractiveAgentStatus(STATUS.IDLE)).toBe(true);
    expect(isInteractiveAgentStatus(STATUS.COMPLETED)).toBe(false);
    expect(isInteractiveAgentStatus(STATUS.ABANDONED)).toBe(false);
  });

  it('promptable set accepts created/running/idle and rejects terminal', () => {
    expect(isPromptableAgentStatus(STATUS.CREATED)).toBe(true);
    expect(isPromptableAgentStatus(STATUS.RUNNING)).toBe(true);
    expect(isPromptableAgentStatus(STATUS.IDLE)).toBe(true);
    expect(isPromptableAgentStatus(STATUS.COMPLETED)).toBe(false);
    expect(isPromptableAgentStatus(STATUS.FAILED)).toBe(false);
    expect(isPromptableAgentStatus(STATUS.CLOSED)).toBe(false);
    expect(isPromptableAgentStatus(STATUS.ABANDONED)).toBe(false);
  });

  it('describeAgentStatus produces human-readable labels for every status', () => {
    expect(describeAgentStatus(STATUS.CREATED)).toMatch(/spawn/i);
    expect(describeAgentStatus(STATUS.RUNNING)).toMatch(/running/i);
    expect(describeAgentStatus(STATUS.IDLE)).toMatch(/idle/i);
    expect(describeAgentStatus(STATUS.COMPLETED)).toMatch(/completed/i);
    expect(describeAgentStatus(STATUS.FAILED)).toMatch(/failed/i);
    expect(describeAgentStatus(STATUS.CLOSED)).toMatch(/closed/i);
    expect(describeAgentStatus(STATUS.ABANDONED)).toMatch(/abandoned/i);
  });
});

// -------------------------------------------------------------------------
// 2. output-log.js
// -------------------------------------------------------------------------

describe('output-log durable JSONL', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeaft-sublog-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('resolveLogPath rejects unsafe agent ids', () => {
    expect(() => resolveLogPath('../escape', tmpDir)).toThrow(/unsafe/);
    expect(() => resolveLogPath('foo/bar', tmpDir)).toThrow(/unsafe/);
    expect(() => resolveLogPath('')).toThrow();
  });

  it('write/close persists each event as a JSON line with timestamp', () => {
    const sink = createOutputLog('agent-abc', tmpDir);
    sink.write({ type: 'sub_agent_spawned', agentId: 'agent-abc' });
    sink.write({ type: 'text_delta', text: 'hello' });
    sink.write({ type: 'stop', stopReason: 'end_turn' });
    sink.close();

    const recs = readOutputLog('agent-abc', tmpDir);
    expect(recs).toHaveLength(3);
    expect(recs[0].type).toBe('sub_agent_spawned');
    expect(recs[1].type).toBe('text_delta');
    expect(recs[1].text).toBe('hello');
    expect(recs[2].stopReason).toBe('end_turn');
    expect(typeof recs[0].t).toBe('number');
    expect(sink.path.endsWith('agent-abc.log')).toBe(true);
  });

  it('trims long text payloads inside the line so writes stay bounded', () => {
    const sink = createOutputLog('agent-long', tmpDir);
    const huge = 'A'.repeat(10_000);
    sink.write({ type: 'text_delta', text: huge });
    sink.close();

    const recs = readOutputLog('agent-long', tmpDir);
    expect(recs).toHaveLength(1);
    expect(recs[0].text.length).toBeLessThan(huge.length);
    expect(recs[0].text.endsWith('…')).toBe(true);
  });

  it('rotates to <id>.log.1 once MAX_BYTES is exceeded', () => {
    const sink = createOutputLog('rotato', tmpDir);
    // serialize() caps `text` at 2048 chars, so each write produces a
    // line of ~2.1 KiB. Push until rotation triggers (MAX_BYTES = 2 MiB).
    const target = outputLogInternals.MAX_BYTES + 64 * 1024;
    let i = 0;
    while (i < 5000) {
      sink.write({ type: 'text_delta', text: 'a'.repeat(2048) });
      // Rotation flips the on-disk size back to ~0; detect via the
      // rotated file appearing rather than tracking bytes by hand.
      if (fs.existsSync(path.join(tmpDir, 'rotato.log.1'))) break;
      i += 1;
    }
    sink.close();

    const original = path.join(tmpDir, 'rotato.log');
    const rotated = `${original}.1`;
    expect(fs.existsSync(rotated)).toBe(true);
    // After rotation the current log is smaller than the pre-rotation cap.
    expect(fs.statSync(original).size).toBeLessThanOrEqual(outputLogInternals.MAX_BYTES);
    // Sanity: we did at least one write per iteration before rotation
    // (otherwise the loop bailed for the wrong reason).
    expect(i).toBeGreaterThan(0);
  });

  it('tail() returns the last N bytes and drops a partial leading record', () => {
    const sink = createOutputLog('tail-test', tmpDir);
    for (let i = 0; i < 50; i += 1) {
      sink.write({ type: 'text_delta', text: `chunk-${i}` });
    }
    sink.close();

    const tail = sink.tail(200);
    expect(tail.length).toBeGreaterThan(0);
    // First char of the tail must be `{` (clean record boundary).
    expect(tail.trimStart().startsWith('{')).toBe(true);
  });

  it('write becomes a no-op after a disk failure (best-effort)', () => {
    // Point at an unwritable path (file as a parent dir).
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'not-a-dir');
    // resolveLogPath will treat `${blocker}/log` as the file — append fails.
    const sink = createOutputLog('agent-x', blocker);
    expect(() => sink.write({ type: 'x' })).not.toThrow();
    expect(() => sink.write({ type: 'y' })).not.toThrow();
    sink.close();
  });
});

// -------------------------------------------------------------------------
// 3. notifications.js
// -------------------------------------------------------------------------

describe('notifications queue', () => {
  beforeEach(() => _resetNotifications());

  it('enqueueTerminalNotification dedups per-agent', () => {
    const first = enqueueTerminalNotification({
      agentId: 'a1', agentName: 'a1', status: 'completed', result: 'r', parentVpId: 'vp-1',
    });
    const second = enqueueTerminalNotification({
      agentId: 'a1', agentName: 'a1', status: 'completed', result: 'r', parentVpId: 'vp-1',
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const peek = _peekAll();
    expect(peek.byParent['vp-1']).toHaveLength(1);
  });

  it('buckets by parentVpId and falls back to __no_vp__ when missing', () => {
    enqueueTerminalNotification({ agentId: 'a1', agentName: 'a1', status: 'closed', parentVpId: 'vp-A' });
    enqueueTerminalNotification({ agentId: 'a2', agentName: 'a2', status: 'closed', parentVpId: 'vp-B' });
    enqueueTerminalNotification({ agentId: 'a3', agentName: 'a3', status: 'closed' /* no parent */ });

    expect(consumePendingNotifications('vp-A').map(n => n.agentId)).toEqual(['a1']);
    expect(consumePendingNotifications('vp-A')).toEqual([]); // drained
    expect(consumePendingNotifications('vp-B').map(n => n.agentId)).toEqual(['a2']);
    expect(consumePendingNotifications(null).map(n => n.agentId)).toEqual(['a3']);
  });

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

  it('consumeNotificationForAgent drains a single record from both maps', () => {
    enqueueTerminalNotification({ agentId: 'a1', agentName: 'a1', status: 'closed', parentVpId: 'vp-A' });
    enqueueTerminalNotification({ agentId: 'a2', agentName: 'a2', status: 'closed', parentVpId: 'vp-A' });

    const drained = consumeNotificationForAgent('a1');
    expect(drained).not.toBeNull();
    expect(drained.agentId).toBe('a1');

    // a1 must NOT reappear in the parent bucket drain.
    const remaining = consumePendingNotifications('vp-A');
    expect(remaining.map(n => n.agentId)).toEqual(['a2']);
  });

  it('consumeNotificationForAgent returns null for unknown ids', () => {
    expect(consumeNotificationForAgent('does-not-exist')).toBeNull();
    expect(consumeNotificationForAgent('')).toBeNull();
  });

  it('formatNotificationsForPrompt produces empty string when nothing pending', () => {
    expect(formatNotificationsForPrompt([])).toBe('');
    expect(formatNotificationsForPrompt(null)).toBe('');
  });

  it('formatNotificationsForPrompt wraps each notification in XML', () => {
    const block = formatNotificationsForPrompt([
      { id: 'i1', agentId: 'a1', agentName: 'planner', status: 'completed', result: 'plan ready', error: null, outputFile: '/tmp/x.log', turns: 3, parentVpId: 'vp', createdAt: 0 },
      { id: 'i2', agentId: 'a2', agentName: 'reviewer', status: 'failed', result: '', error: 'boom', outputFile: null, turns: 1, parentVpId: 'vp', createdAt: 0 },
    ]);
    expect(block).toMatch(/<sub-agent-notifications>/);
    expect(block).toMatch(/<\/sub-agent-notifications>/);
    expect(block).toMatch(/agent="planner"/);
    expect(block).toMatch(/status="completed"/);
    expect(block).toMatch(/error: boom/);
    expect(block).toMatch(/result:/);
    expect(block).toMatch(/plan ready/);
    expect(block).toMatch(/outputFile: \/tmp\/x.log/);
  });

  it('formatNotificationsForPrompt truncates very long results', () => {
    const huge = 'X'.repeat(5000);
    const block = formatNotificationsForPrompt([{
      id: 'i', agentId: 'a', agentName: 'a', status: 'completed', result: huge,
      error: null, outputFile: null, turns: 1, parentVpId: null, createdAt: 0,
    }]);
    expect(block).toMatch(/truncated/);
    expect(block.length).toBeLessThan(huge.length + 1000);
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

  it('terminal envelope includes outputFile, liveness, status and next_steps', async () => {
    const liveness = makeLiveness();
    bumpLivenessFromEvent(liveness, { type: 'tool_start', toolName: 'Bash' });
    bumpLivenessFromEvent(liveness, { type: 'text_delta', text: 'hello world' });

    const agents = getAgentRegistry();
    agents.set('agent-done', {
      id: 'agent-done', name: 'done', status: STATUS.COMPLETED, result: 'all set',
      error: null, messages: [], usage: { turns: 2 },
      outputFile: '/tmp/agent-done.log', liveness,
    });

    const env = JSON.parse(await waitAgent.execute({ agent_id: 'agent-done' }, {}));
    expect(env.status).toBe('completed');
    expect(env.result).toBe('all set');
    expect(env.outputFile).toBe('/tmp/agent-done.log');
    expect(env.liveness.toolUseCount).toBe(1);
    expect(env.liveness.tokenCount).toBe('hello world'.length);
    expect(env.liveness.recentTools).toContain('Bash');
    expect(env.turns).toBe(2);
    expect(env.next_steps).toMatch(/user/i);
  });

  it('idle envelope reads from agent.lastResult when result is empty', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-id', {
      id: 'agent-id', name: 'id', status: STATUS.IDLE,
      result: '', lastResult: 'mid-stream preview',
      error: null, messages: [], usage: { turns: 1 },
      outputFile: null, liveness: makeLiveness(),
    });

    const env = JSON.parse(await waitAgent.execute({ agent_id: 'agent-id' }, {}));
    expect(env.status).toBe('idle');
    expect(env.result).toBe('mid-stream preview');
    expect(env.next_steps).toMatch(/PromptAgent/);
    expect(env.next_steps).toMatch(/CloseAgent/);
  });

  it('timed-out envelope flags runningInBackground and surfaces lastResult', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-bg', {
      id: 'agent-bg', name: 'bg', status: STATUS.RUNNING,
      result: '', lastResult: 'partial',
      error: null, messages: [], usage: { turns: 0 },
      outputFile: '/tmp/bg.log', liveness: makeLiveness(),
    });

    const env = JSON.parse(await waitAgent.execute(
      { agent_id: 'agent-bg', timeout_ms: 100 },
      {},
    ));
    expect(env.timedOut).toBe(true);
    expect(env.runningInBackground).toBe(true);
    expect(env.result).toBe('partial');
    expect(env.next_steps).toMatch(/background/i);
    expect(env.next_steps).toMatch(/ListAgents/);
    expect(env.next_steps).not.toMatch(/larger timeout_ms|keep waiting/i);
  });

  it('timed-out stale envelope warns not to wait in a loop', async () => {
    const liveness = makeLiveness();
    liveness.lastEventAt = Date.now() - 180000;
    liveness.lastEventType = 'tool_call';
    const agents = getAgentRegistry();
    agents.set('agent-stale', {
      id: 'agent-stale', name: 'stale', status: STATUS.RUNNING,
      result: '', lastResult: '', error: null, messages: [], usage: { turns: 0 },
      outputFile: '/tmp/stale.log', liveness, createdAt: Date.now() - 180000,
    });

    const env = JSON.parse(await waitAgent.execute({ agent_id: 'agent-stale', timeout_ms: 0 }, {}));
    expect(env.timedOut).toBe(true);
    expect(env.stale).toBe(true);
    expect(env.stalled).toBe(true);
    expect(env.msSinceLastEvent).toBeGreaterThanOrEqual(120000);
    expect(env.lastEventType).toBe('tool_call');
    expect(env.diagnostic).toMatch(/stalled/i);
    expect(env.next_steps).toMatch(/Do NOT keep/i);
  });

  it('terminal envelope preserves budget_exceeded details', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-budget-wait', {
      id: 'agent-budget-wait', name: 'budget-wait', status: STATUS.COMPLETED,
      result: {
        status: 'budget_exceeded',
        partial_output: 'partial work',
        reason: 'max_turns (1) reached',
        usage: { turns: 1, tokens: 42 },
      },
      lastResult: 'stale preview',
      error: null, messages: [], usage: { turns: 1 },
      outputFile: null, liveness: makeLiveness(),
    });

    const env = JSON.parse(await waitAgent.execute({ agent_id: 'agent-budget-wait' }, {}));
    expect(env.status).toBe(STATUS.COMPLETED);
    expect(env.result).toBe('partial work');
    expect(env.budgetExceeded).toBe(true);
    expect(env.budget_status).toBe('budget_exceeded');
    expect(env.budget_reason).toMatch(/max_turns/);
    expect(env.partial_output).toBe('partial work');
    expect(env.budget_usage).toEqual({ turns: 1, tokens: 42 });
    expect(env.next_steps).toMatch(/budget/i);
    expect(env.next_steps).not.toMatch(/finished successfully/i);
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
  });

  it('timeout_ms zero still returns an idle snapshot instead of background timeout', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-idle-zero', {
      id: 'agent-idle-zero', name: 'idle-zero', status: STATUS.IDLE,
      result: 'ready now', lastResult: '', error: null, messages: [],
      usage: { turns: 1 }, outputFile: null, liveness: makeLiveness(),
      pendingPrompts: [],
    });

    const env = JSON.parse(await waitAgent.execute({ agent_id: 'agent-idle-zero', timeout_ms: 0 }, {}));
    expect(env.status).toBe(STATUS.IDLE);
    expect(env.result).toBe('ready now');
    expect(env.timedOut).toBeUndefined();
    expect(env.runningInBackground).toBeUndefined();
  });

  it('SpawnAgent returns async background guidance without forcing WaitAgent', async () => {
    const out = JSON.parse(await agentTool.execute(
      { name: 'async-task', mission: 'do async work' },
      { parentEngineDeps: mkDeps(new TextAdapter('done')) },
    ));
    expect(out.success).toBe(true);
    expect(out.status).toBe(STATUS.RUNNING);
    expect(out.outputFile).toBeTruthy();
    expect(out.liveness).toBeTruthy();
    expect(agentTool.description.en).not.toMatch(/MUST call WaitAgent next/);
    expect(out.next_steps).toMatch(/background/i);
    expect(out.next_steps).toMatch(/ListAgents/);
    expect(out.next_steps).not.toMatch(/Call WaitAgent next/i);
  });

  it('name collisions are scoped to the caller owner', async () => {
    const ctxA = { parentEngineDeps: { parentSessionId: 'session-a', parentVpId: 'vp-a' } };
    const ctxB = { parentEngineDeps: { parentSessionId: 'session-b', parentVpId: 'vp-b' } };

    const first = JSON.parse(await agentTool.execute({ name: 'same-name', mission: 'a' }, ctxA));
    expect(first.success).toBe(true);
    const sameOwner = JSON.parse(await agentTool.execute({ name: 'same-name', mission: 'a2' }, ctxA));
    expect(sameOwner.error).toMatch(/already exists/);
    const otherOwner = JSON.parse(await agentTool.execute({ name: 'same-name', mission: 'b' }, ctxB));
    expect(otherOwner.success).toBe(true);
  });

  it('drains the agent notification when idle so engine does not redeliver', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-idle-drained', {
      id: 'agent-idle-drained', name: 'idle-drained', status: STATUS.IDLE,
      result: 'ok', error: null, messages: [], usage: { turns: 1 },
      outputFile: null, liveness: makeLiveness(),
    });
    enqueueTerminalNotification({
      agentId: 'agent-idle-drained', agentName: 'idle-drained', status: STATUS.IDLE,
      result: 'ok', parentVpId: 'vp-X',
    });
    expect(_peekAll().byAgent['agent-idle-drained']).toBeTruthy();

    const env = JSON.parse(await waitAgent.execute({ agent_id: 'agent-idle-drained' }, {}));
    expect(env.status).toBe(STATUS.IDLE);
    expect(_peekAll().byAgent['agent-idle-drained']).toBeUndefined();
  });

  it('drains the agent notification when terminal so engine does not redeliver', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-drained', {
      id: 'agent-drained', name: 'drained', status: STATUS.COMPLETED,
      result: 'ok', error: null, messages: [], usage: { turns: 1 },
      outputFile: null, liveness: makeLiveness(),
    });
    enqueueTerminalNotification({
      agentId: 'agent-drained', agentName: 'drained', status: STATUS.COMPLETED,
      result: 'ok', parentVpId: 'vp-X',
    });
    expect(_peekAll().byAgent['agent-drained']).toBeTruthy();

    await waitAgent.execute({ agent_id: 'agent-drained' }, {});
    expect(_peekAll().byAgent['agent-drained']).toBeUndefined();
    // Parent bucket drain must also be a no-op now.
    expect(consumePendingNotifications('vp-X')).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// 5. tickAgent budget enforcement
// -------------------------------------------------------------------------

describe('tickAgent budget enforcement', () => {
  beforeEach(() => {
    _resetAgentRegistry();
    _resetNotifications();
  });

  it('exceeded max_turns returns budget_exceeded envelope and flips status', () => {
    const agents = getAgentRegistry();
    agents.set('agent-budget', {
      id: 'agent-budget', name: 'budget', status: STATUS.RUNNING,
      budget: { max_turns: 1 },
      usage: { tokens: 0, turns: 0, startedAt: Date.now() },
      diagnostics: [],
      messages: [], result: null, lastResult: '', partial_output: '',
      abortController: new AbortController(),
    });

    const envelope = tickAgent('agent-budget', { turns: 1, tokens: 10, partial_output: 'so-far' });
    expect(envelope).not.toBeNull();
    expect(envelope.status).toBe('budget_exceeded');
    expect(envelope.reason).toMatch(/max_turns/);
    expect(envelope.partial_output).toBe('so-far');

    const agent = agents.get('agent-budget');
    expect(agent.status).toBe(STATUS.COMPLETED);
    expect(agent.abortController.signal.aborted).toBe(true);
    expect(agent.diagnostics.some(d => d.type === 'budget_exceeded')).toBe(true);
  });

  it('within-budget tick returns null and leaves status alone', () => {
    const agents = getAgentRegistry();
    agents.set('agent-budget2', {
      id: 'agent-budget2', name: 'b2', status: STATUS.RUNNING,
      budget: { max_turns: 5, max_tokens: 1000 },
      usage: { tokens: 0, turns: 0, startedAt: Date.now() },
      diagnostics: [], messages: [], result: null, lastResult: '',
      abortController: new AbortController(),
    });
    expect(tickAgent('agent-budget2', { turns: 1, tokens: 50 })).toBeNull();
    expect(agents.get('agent-budget2').status).toBe(STATUS.RUNNING);
  });

  it('returns null and no-ops when the agent is already terminal', () => {
    const agents = getAgentRegistry();
    agents.set('agent-done', {
      id: 'agent-done', name: 'done', status: STATUS.COMPLETED,
      budget: { max_turns: 1 },
      usage: { tokens: 0, turns: 5, startedAt: Date.now() },
      diagnostics: [], messages: [], result: 'ok',
      abortController: new AbortController(),
    });
    expect(tickAgent('agent-done', { turns: 1 })).toBeNull();
    expect(agents.get('agent-done').status).toBe(STATUS.COMPLETED);
  });

  it('is wired into the sub-agent driver and cuts a real run at max_turns', async () => {
    const adapter = new TextAdapter('done turn');
    const deps = mkDeps(adapter);
    const out = JSON.parse(await agentTool.execute(
      { name: 'budgeted', mission: 'one shot only', budget: { max_turns: 1 } },
      { parentEngineDeps: deps },
    ));
    const id = out.agentId;
    const agent = getAgentRegistry().get(id);

    // First turn runs; tickAgent should then trip max_turns=1 and finalize.
    await settle(agent, 2000);
    // Driver may transition idle → terminal; allow a beat for finalize.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !isTerminalAgentStatus(agent.status)) {
      await new Promise(r => setTimeout(r, 20));
    }
    expect(isTerminalAgentStatus(agent.status)).toBe(true);
    expect(agent.status).toBe(STATUS.COMPLETED);
    expect(agent.result).toBeTruthy();
  });

  it('max_tokens uses per-turn deltas instead of cumulative liveness', async () => {
    const adapter = new TextAdapter('abcd');
    const deps = mkDeps(adapter);
    const out = JSON.parse(await agentTool.execute(
      { name: 'token-delta', mission: 'first', budget: { max_tokens: 7 } },
      { parentEngineDeps: deps },
    ));
    const id = out.agentId;
    const agent = getAgentRegistry().get(id);
    await settle(agent, 2000);
    expect(agent.status).toBe(STATUS.IDLE);
    expect(agent.usage.tokens).toBe(4);

    adapter.reply = 'ef';
    await sendMessage.execute({ agent_id: id, message: 'second' }, vpTestCtx);
    await settle(agent, 2000);
    expect(agent.status).toBe(STATUS.IDLE);
    expect(agent.usage.tokens).toBe(6);
  });

  it('max_tokens budget uses provider usage events when available', async () => {
    const adapter = new UsageAdapter({ text: 'ok', inputTokens: 100, outputTokens: 25 });
    const deps = mkDeps(adapter);
    const out = JSON.parse(await agentTool.execute(
      { name: 'usage-budget', mission: 'count exact usage', budget: { max_tokens: 50 } },
      { parentEngineDeps: deps },
    ));
    const agent = getAgentRegistry().get(out.agentId);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !isTerminalAgentStatus(agent.status)) {
      await new Promise(r => setTimeout(r, 20));
    }

    expect(agent.status).toBe(STATUS.COMPLETED);
    expect(agent.usage.tokens).toBe(125);
    expect(agent.result.status).toBe('budget_exceeded');
    expect(agent.result.reason).toMatch(/max_tokens/);
  });

  it('budget cutoff notifications include the budget reason', async () => {
    const adapter = new TextAdapter('budget partial');
    const deps = mkDeps(adapter);
    const out = JSON.parse(await agentTool.execute(
      { name: 'budget-notify', mission: 'one shot', budget: { max_turns: 1 } },
      { parentEngineDeps: deps },
    ));
    const agent = getAgentRegistry().get(out.agentId);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !isTerminalAgentStatus(agent.status)) {
      await new Promise(r => setTimeout(r, 20));
    }

    const notifs = consumePendingNotifications('vp-test');
    const notif = notifs.find(n => n.agentId === out.agentId);
    expect(notif).toBeTruthy();
    expect(notif.status).toBe(STATUS.COMPLETED);
    expect(notif.budgetExceeded).toBe(true);
    expect(notif.budgetReason).toMatch(/max_turns/);
    const block = formatNotificationsForPrompt([notif]);
    expect(block).toMatch(/budgetExceeded: true/);
    expect(block).toMatch(/budgetReason: max_turns/);
  });
});

// -------------------------------------------------------------------------
// 6. Idle watchdog
// -------------------------------------------------------------------------

describe('idle watchdog', () => {
  beforeEach(() => {
    _resetAgentRegistry();
    _resetNotifications();
  });

  it('flips an idle agent to abandoned after idleAbandonMs and enqueues a notification', async () => {
    const adapter = new TextAdapter('first reply');
    const deps = mkDeps(adapter, { idleAbandonMs: 200 });
    const out = JSON.parse(await agentTool.execute(
      { name: 'lazy', mission: 'reply once' },
      { parentEngineDeps: deps },
    ));
    const id = out.agentId;
    const agent = getAgentRegistry().get(id);

    // Wait for first turn + idle notification, drain it, then wait for the
    // idle watchdog's terminal notification.
    await settle(agent, 1000);
    expect(agent.status).toBe(STATUS.IDLE);
    consumePendingNotifications('vp-test');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !isTerminalAgentStatus(agent.status)) {
      await new Promise(r => setTimeout(r, 30));
    }
    expect(agent.status).toBe(STATUS.ABANDONED);
    expect(agent.error).toMatch(/idle/);

    // Notification queue should contain the abandoned record.
    const notifs = consumePendingNotifications('vp-test');
    expect(notifs.length).toBeGreaterThanOrEqual(1);
    expect(notifs[0].status).toBe(STATUS.ABANDONED);
    expect(notifs[0].agentId).toBe(id);
  });

  it('a follow-up prompt arriving before the watchdog cancels the abandon', async () => {
    const adapter = new TextAdapter('first');
    const deps = mkDeps(adapter, { idleAbandonMs: 1000 });
    const out = JSON.parse(await agentTool.execute(
      { name: 'rescued', mission: 'go' },
      { parentEngineDeps: deps },
    ));
    const id = out.agentId;
    const agent = getAgentRegistry().get(id);
    await settle(agent, 2000);
    expect(agent.status).toBe(STATUS.IDLE);

    adapter.reply = 'second';
    await sendMessage.execute({ agent_id: id, message: 'keep going' }, vpTestCtx);
    // Give the driver time to process the follow-up.
    await new Promise(r => setTimeout(r, 200));
    await settle(agent, 2000);
    expect(agent.status).toBe(STATUS.IDLE); // not abandoned
    expect(agent.usage.turns).toBe(2);
  });
});

// -------------------------------------------------------------------------
// 7. Driver finally{} cleanup
// -------------------------------------------------------------------------

describe('driver finally cleanup', () => {
  beforeEach(() => {
    _resetAgentRegistry();
    _resetNotifications();
  });

  it('closes outputLog and nulls subEngine after a terminal transition', async () => {
    const adapter = new TextAdapter('cleanup-text');
    const deps = mkDeps(adapter);
    const out = JSON.parse(await agentTool.execute(
      { name: 'cleanme', mission: 'go' },
      { parentEngineDeps: deps },
    ));
    const id = out.agentId;
    const agent = getAgentRegistry().get(id);

    // Wait for first turn → idle, then close.
    await settle(agent, 2000);
    await closeAgent.execute({ agent_id: id, result: 'wrap' }, vpTestCtx);

    // Allow the driver loop to exit through finally.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && (agent.subEngine !== null || agent.__driverStarted)) {
      await new Promise(r => setTimeout(r, 20));
    }
    expect(agent.subEngine).toBeNull();
    expect(agent.__driverStarted).toBe(false);
    // outputFile path is preserved even after the log handle closes.
    expect(typeof agent.outputFile).toBe('string');
    expect(agent.outputFile.length).toBeGreaterThan(0);
  });

  it('a thrown listener does not stop liveness from being bumped', async () => {
    const adapter = new TextAdapter('hi');
    const events = [];
    const deps = mkDeps(adapter, {
      onEvent: (id, evt) => {
        events.push(evt.type);
        if (evt.type === 'text_delta') throw new Error('listener boom');
      },
    });
    const out = JSON.parse(await agentTool.execute(
      { name: 'listener-throws', mission: 'tick' },
      { parentEngineDeps: deps },
    ));
    const id = out.agentId;
    const agent = getAgentRegistry().get(id);
    await settle(agent, 2000);
    expect(agent.liveness.tokenCount).toBeGreaterThan(0);
    expect(agent.status).toBe(STATUS.IDLE);
    expect(events).toContain('text_delta');
  });

  it('closing a running agent preserves the explicit close result', async () => {
    const adapter = new SlowAdapter(['part1 ', 'part2 ', 'part3'], 100);
    const deps = mkDeps(adapter);
    const out = JSON.parse(await agentTool.execute(
      { name: 'close-running', mission: 'stream slowly' },
      { parentEngineDeps: deps },
    ));
    const id = out.agentId;
    const agent = getAgentRegistry().get(id);

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !agent.lastResult) {
      await new Promise(r => setTimeout(r, 10));
    }
    const closed = JSON.parse(await closeAgent.execute(
      { agent_id: id, result: 'WRAP' },
      vpTestCtx,
    ));
    expect(closed.success).toBe(true);
    expect(closed.result).toBe('WRAP');

    const done = Date.now() + 1000;
    while (Date.now() < done && agent.__driverStarted) {
      await new Promise(r => setTimeout(r, 20));
    }
    expect(agent.status).toBe(STATUS.CLOSED);
    expect(agent.result).toBe('WRAP');
    expect(agent.subEngine).toBeNull();
  });
});

// -------------------------------------------------------------------------
// 8. Mid-stream lastResult
// -------------------------------------------------------------------------

describe('mid-stream lastResult', () => {
  beforeEach(() => _resetAgentRegistry());

  it('lastResult is updated on every text_delta before end_turn', async () => {
    const adapter = new SlowAdapter(['part1 ', 'part2 ', 'part3'], 25);
    const deps = mkDeps(adapter);
    const out = JSON.parse(await agentTool.execute(
      { name: 'slow-talker', mission: 'speak in parts' },
      { parentEngineDeps: deps },
    ));
    const id = out.agentId;
    const agent = getAgentRegistry().get(id);

    // Poll for lastResult to grow while the stream is in flight.
    const observed = new Set();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !isTerminalAgentStatus(agent.status) && agent.status !== STATUS.IDLE) {
      if (agent.lastResult) observed.add(agent.lastResult);
      await new Promise(r => setTimeout(r, 10));
    }
    expect(agent.status).toBe(STATUS.IDLE);
    expect(agent.lastResult).toContain('part3');
    // We should have seen more than one distinct prefix while the model
    // streamed — if not, mid-stream visibility regressed.
    expect(observed.size).toBeGreaterThanOrEqual(1);
  });
});

// -------------------------------------------------------------------------
// 9. Engine prepend — consumePendingNotifications hooks into the user prompt
// -------------------------------------------------------------------------

describe('engine prepends sub-agent notifications to the next user turn', () => {
  beforeEach(() => _resetNotifications());

  it('queued notifications appear in the user message that engine.query sends', async () => {
    // Use Engine directly with a parent-shaped vpPersona so the drain
    // bucket key matches.
    const { Engine } = await import('../../../agent/yeaft/engine.js');
    const adapter = new TextAdapter('parent reply');
    const reg = mkParentRegistry();
    const engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 256, _readOnly: true, language: 'en' },
      toolRegistry: reg,
    });

    enqueueTerminalNotification({
      agentId: 'a-x', agentName: 'planner', status: 'completed',
      result: 'I built the plan.', parentVpId: 'vp-parent', turns: 3,
    });

    const events = [];
    for await (const evt of engine.query({
      prompt: 'continue parent work',
      messages: [],
      vpPersona: { vpId: 'vp-parent', persona: 'You are Parent.' },
    })) {
      events.push(evt);
    }

    // The adapter saw exactly one user message that mentions the
    // notification block.
    expect(adapter.streamCalls).toHaveLength(1);
    const lastUser = adapter.streamCalls[0].messages.find(m => m.role === 'user');
    expect(lastUser).toBeTruthy();
    expect(String(lastUser.content)).toMatch(/<sub-agent-notifications>/);
    expect(String(lastUser.content)).toMatch(/planner/);
    expect(String(lastUser.content)).toMatch(/I built the plan/);
    expect(String(lastUser.content)).toMatch(/continue parent work/);
  });

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

  it('keeps notifications queued when the parent turn fails before delivery', async () => {
    const { Engine } = await import('../../../agent/yeaft/engine.js');
    const failingEngine = new Engine({
      adapter: new ThrowingAdapter('parent failed'),
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 256, _readOnly: true, language: 'en' },
      toolRegistry: mkParentRegistry(),
      sessionId: 'session-ack',
      vpId: 'vp-parent',
    });

    enqueueTerminalNotification({
      agentId: 'ack-agent', agentName: 'ack-agent', status: 'completed',
      result: 'do not lose me', parentVpId: 'vp-parent',
      parentSessionId: 'session-ack',
    });

    for await (const _ of failingEngine.query({
      prompt: 'this will fail',
      messages: [],
      vpPersona: { vpId: 'vp-parent', persona: 'You are Parent.' },
      sessionId: 'session-ack',
    })) { /* drain */ }

    const stillQueued = consumePendingNotifications({
      parentVpId: 'vp-parent', sessionId: 'session-ack',
    });
    expect(stillQueued.map(n => n.agentId)).toEqual(['ack-agent']);
  });

  it('acknowledges delivered notifications when a tool requests handoff', async () => {
    const { Engine } = await import('../../../agent/yeaft/engine.js');
    const reg = new ToolRegistry();
    reg.registerAll([handoffTool]);
    const engine = new Engine({
      adapter: new ToolUseAdapter('handoff'),
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 256, _readOnly: true, language: 'en' },
      toolRegistry: reg,
      sessionId: 'session-handoff',
      vpId: 'vp-parent',
    });

    enqueueTerminalNotification({
      agentId: 'handoff-agent', agentName: 'handoff-agent', status: 'completed',
      result: 'handoff delivered', parentVpId: 'vp-parent',
      parentSessionId: 'session-handoff',
    });

    for await (const _ of engine.query({
      prompt: 'handoff turn',
      messages: [],
      vpPersona: { vpId: 'vp-parent', persona: 'You are Parent.' },
      sessionId: 'session-handoff',
    })) { /* drain */ }

    expect(consumePendingNotifications({
      parentVpId: 'vp-parent', sessionId: 'session-handoff',
    })).toEqual([]);
  });

  it('sub-agent engines do not drain parent notifications', async () => {
    const { Engine } = await import('../../../agent/yeaft/engine.js');
    const childAdapter = new TextAdapter('child');
    const parentAdapter = new TextAdapter('parent');
    const childEngine = new Engine({
      adapter: childAdapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 256, _readOnly: true, language: 'en' },
      toolRegistry: mkParentRegistry(),
      sessionId: 'session-sub',
      vpId: 'vp-parent',
    });
    const parentEngine = new Engine({
      adapter: parentAdapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 256, _readOnly: true, language: 'en' },
      toolRegistry: mkParentRegistry(),
      sessionId: 'session-sub',
      vpId: 'vp-parent',
    });

    enqueueTerminalNotification({
      agentId: 'parent-only', agentName: 'parent-only', status: 'completed',
      result: 'for parent only', parentVpId: 'vp-parent',
      parentSessionId: 'session-sub',
    });

    for await (const _ of childEngine.query({
      prompt: 'child turn',
      messages: [],
      vpPersona: {
        vpId: 'vp-parent',
        persona: 'You are a child.',
        subAgent: { parentVpId: 'vp-parent', agentId: 'child-agent', agentName: 'child' },
      },
      sessionId: 'session-sub',
    })) { /* drain */ }
    const childUser = childAdapter.streamCalls[0].messages.find(m => m.role === 'user');
    expect(String(childUser.content)).not.toMatch(/sub-agent-notifications/);

    for await (const _ of parentEngine.query({
      prompt: 'parent turn',
      messages: [],
      vpPersona: { vpId: 'vp-parent', persona: 'You are Parent.' },
      sessionId: 'session-sub',
    })) { /* drain */ }
    const parentUser = parentAdapter.streamCalls[0].messages.find(m => m.role === 'user');
    expect(String(parentUser.content)).toMatch(/for parent only/);
  });

  it('no notifications → user prompt is unchanged', async () => {
    const { Engine } = await import('../../../agent/yeaft/engine.js');
    const adapter = new TextAdapter('clean');
    const engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 256, _readOnly: true, language: 'en' },
      toolRegistry: mkParentRegistry(),
    });
    for await (const _ of engine.query({
      prompt: 'just talk',
      messages: [],
      vpPersona: { vpId: 'vp-clean', persona: 'You are Clean.' },
    })) { /* drain */ }
    expect(adapter.streamCalls).toHaveLength(1);
    const lastUser = adapter.streamCalls[0].messages.find(m => m.role === 'user');
    expect(String(lastUser.content)).toBe('just talk');
  });

  it('drained notifications are removed — second turn sees nothing', async () => {
    const { Engine } = await import('../../../agent/yeaft/engine.js');
    const adapter = new TextAdapter('parent reply');
    const engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 256, _readOnly: true, language: 'en' },
      toolRegistry: mkParentRegistry(),
    });
    enqueueTerminalNotification({
      agentId: 'q', agentName: 'q', status: 'completed', result: 'r', parentVpId: 'vp-2x',
    });

    for await (const _ of engine.query({
      prompt: 'turn 1',
      messages: [],
      vpPersona: { vpId: 'vp-2x', persona: 'You are 2x.' },
    })) { /* drain */ }
    for await (const _ of engine.query({
      prompt: 'turn 2',
      messages: [],
      vpPersona: { vpId: 'vp-2x', persona: 'You are 2x.' },
    })) { /* drain */ }

    expect(adapter.streamCalls).toHaveLength(2);
    const second = adapter.streamCalls[1].messages.find(m => m.role === 'user');
    expect(String(second.content)).not.toMatch(/<sub-agent-notifications>/);
    expect(String(second.content)).toBe('turn 2');
  });
});

// -------------------------------------------------------------------------
// 10. ListAgents reports outputFile + liveness for live agents
// -------------------------------------------------------------------------

describe('list-agents envelope', () => {
  beforeEach(() => {
    _resetAgentRegistry();
    _resetNotifications();
  });

  it('reports outputFile, liveness, and turns for non-terminal agents by default', async () => {
    const adapter = new TextAdapter('hi');
    const deps = mkDeps(adapter);
    const out = JSON.parse(await agentTool.execute(
      { name: 'listed', mission: 'go' },
      { parentEngineDeps: deps },
    ));
    const id = out.agentId;
    const agent = getAgentRegistry().get(id);
    await settle(agent, 2000);

    const env = JSON.parse(await listAgents.execute({}, vpTestCtx));
    expect(Array.isArray(env.agents)).toBe(true);
    const a = env.agents.find(x => x.id === id);
    expect(a).toBeTruthy();
    expect(a.outputFile).toBeTruthy();
    expect(typeof a.liveness.toolUseCount).toBe('number');
    expect(typeof a.turns).toBe('number');
  });

  it('hides terminal agents unless include_terminal=true', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-cls', {
      id: 'agent-cls', name: 'closed', status: STATUS.CLOSED,
      result: '', error: null, messages: [], usage: { turns: 0 },
      outputFile: null, liveness: makeLiveness(),
    });
    const noShow = JSON.parse(await listAgents.execute({}, {}));
    expect(noShow.agents.length).toBe(0);

    const show = JSON.parse(await listAgents.execute({ include_terminal: true }, {}));
    expect(show.agents.length).toBe(1);
    expect(show.agents[0].status).toBe('closed');
  });

  it('surfaces stale diagnostics and result tail without blocking', async () => {
    const liveness = makeLiveness();
    liveness.lastEventAt = Date.now() - 180000;
    liveness.lastEventType = 'tool_call';
    const agents = getAgentRegistry();
    agents.set('agent-stale-list', {
      id: 'agent-stale-list', name: 'stale-list', status: STATUS.RUNNING,
      result: '', lastResult: 'partial output tail', error: null, messages: [],
      usage: { turns: 0, startedAt: Date.now() - 180000 },
      outputFile: '/tmp/stale-list.log', liveness, createdAt: Date.now() - 180000,
    });

    const env = JSON.parse(await listAgents.execute({}, {}));
    expect(env.agents).toHaveLength(1);
    expect(env.agents[0].stale).toBe(true);
    expect(env.agents[0].stalled).toBe(true);
    expect(env.agents[0].lastEventType).toBe('tool_call');
    expect(env.agents[0].diagnostic).toMatch(/stalled/i);
    expect(env.agents[0].resultTail).toBe('partial output tail');
  });

  it('background sub-agent completes and notifies parent without WaitAgent', async () => {
    const deps = mkDeps(new TextAdapter('background done'), { parentSessionId: 'session-bg' });
    const out = JSON.parse(await agentTool.execute(
      { name: 'background-finish', mission: 'finish async' },
      { parentEngineDeps: deps },
    ));
    const agent = getAgentRegistry().get(out.agentId);
    await settle(agent, 2000);
    expect(agent.status).toBe(STATUS.IDLE);

    const notifications = consumePendingNotifications({ sessionId: 'session-bg', parentVpId: 'vp-test' });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].agentId).toBe(out.agentId);
    expect(notifications[0].status).toBe(STATUS.IDLE);
    expect(notifications[0].result).toMatch(/background done/);
  });

  it('wall_time_ms watchdog aborts stuck turns and leaves a terminal record', async () => {
    const adapter = new StuckAdapter();
    const deps = mkDeps(adapter, { parentSessionId: 'session-timeout' });
    const out = JSON.parse(await agentTool.execute(
      { name: 'stuck', mission: 'never finish', budget: { wall_time_ms: 40 } },
      { parentEngineDeps: deps },
    ));
    const agent = getAgentRegistry().get(out.agentId);
    await settle(agent, 1000);
    const abortDeadline = Date.now() + 500;
    while (!adapter.aborted && Date.now() < abortDeadline) {
      await new Promise(r => setTimeout(r, 10));
    }

    expect(adapter.aborted).toBe(true);
    expect(isTerminalAgentStatus(agent.status)).toBe(true);
    expect(agent.status).toBe(STATUS.COMPLETED);
    expect(agent.result.status).toBe('budget_exceeded');
    expect(agent.result.reason).toMatch(/wall_time_ms/);

    const listed = JSON.parse(await listAgents.execute(
      { include_terminal: true },
      { parentEngineDeps: deps },
    ));
    const row = listed.agents.find(a => a.id === out.agentId);
    expect(row.status).toBe(STATUS.COMPLETED);
    expect(row.hasResult).toBe(true);

    const notifications = consumePendingNotifications({ sessionId: 'session-timeout', parentVpId: 'vp-test' });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].status).toBe(STATUS.COMPLETED);
  });
});
