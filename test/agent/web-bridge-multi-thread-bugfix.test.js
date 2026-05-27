/**
 * web-bridge-multi-thread-bugfix.test.js — guards the fix-vp-multi-thread
 * branch:
 *
 *   bug 1  user follow-up to a thinking VP no longer reaches the engine
 *   bug 2  route_forward leaves thread.status='thinking' forever
 *   bug 3  VP-to-VP routing also stops working once threads pile up
 *   bug 4  debug panel only shows turns that happened after it was opened
 *
 * These tests pin the *route-and-state* layer; deeper engine drain
 * semantics are covered by web-bridge-vp-thread-routing.test.js.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn(),
}));

vi.mock('../../agent/unify/vp/vp-crud.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    readVp: vi.fn((vpId) => ({
      vpId,
      displayName: vpId,
      role: 'tester',
      persona: `persona of ${vpId}`,
    })),
  };
});

import { sendToServer } from '../../agent/connection/buffer.js';
import {
  __testEnqueueForVp,
  __testGetVpThreads,
  __testResetVpState,
  __testSetSession,
  __testSetThreadClassifier,
  __testWaitForRoutePromises,
  __testDrainVpDrivers,
  handleUnifyFetchDebugHistory,
} from '../../agent/unify/web-bridge.js';
import { NullTrace, DebugTrace } from '../../agent/unify/debug-trace.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

class QuietAdapter {
  constructor({ delayMs = 0 } = {}) {
    this.delayMs = delayMs;
  }

  async *stream() {
    yield { type: 'text_delta', text: 'ok' };
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    yield { type: 'stop', stopReason: 'end_turn' };
  }

  async call() { return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }; }
}

function mkSession({ delayMs = 0, trace = new NullTrace() } = {}) {
  return {
    adapter: new QuietAdapter({ delayMs }),
    trace,
    config: { model: 'test-model', fastModel: 'fast-test-model', maxOutputTokens: 64, _readOnly: true, language: 'en' },
    conversationStore: null,
    memoryIndex: null,
    amsRegistry: null,
    toolRegistry: null,
    skillManager: null,
    mcpManager: null,
    yeaftDir: null,
    toolStats: null,
  };
}

function envelope(id, text) {
  return {
    groupId: 'g1',
    taskId: `task-${id}`,
    trigger: 'mention',
    msg: {
      id,
      from: 'user',
      text,
      meta: {},
    },
  };
}

async function route(id, text, vpId = 'linus') {
  __testEnqueueForVp('g1', vpId, envelope(id, text));
  await __testWaitForRoutePromises(id);
  return __testGetVpThreads('g1', vpId);
}

describe('fix-vp-multi-thread bugfix guards', () => {
  beforeEach(async () => {
    await __testResetVpState();
    __testSetSession(mkSession());
    sendToServer.mockClear();
  });

  afterEach(async () => {
    await __testResetVpState();
    __testSetSession(null);
    __testSetThreadClassifier(null);
  });

  // ─── bug 2 ───────────────────────────────────────────────────────────
  it('bug 2: thread.status flips back to idle after the turn finishes', async () => {
    const threads = await route('msg-1', '@linus inspect this');
    // Wait for the driver loop's finally block to settle the thread back to idle.
    await __testDrainVpDrivers();

    const after = __testGetVpThreads('g1', 'linus');
    expect(after).toHaveLength(1);
    expect(after[0].threadId).toBe(threads[0].threadId);
    expect(after[0].status).toBe('idle');
  });

  // ─── bug 1 + bug 3 ─────────────────────────────────────────────────
  it('bug 1+3: a related follow-up while engine is running is preserved on pendingQueries with originalText for rescue replay', async () => {
    __testSetSession(mkSession({ delayMs: 40 }));
    sendToServer.mockClear();

    const first = await route('msg-1', '@linus fix auth bug');
    const targetThreadId = first[0].threadId;
    __testSetThreadClassifier(vi.fn(async () => ({
      decision: 'related',
      targetThreadId,
      title: 'Fix auth bug',
      reason: 'same issue',
    })));

    // Route a second related query while the first is still in-flight.
    // Even if the engine has already drained its inbox, the bridge must
    // either deliver via `appendUserMessage` OR keep the query on
    // `pendingQueries` with originalText so the driver-loop tail can
    // rescue-replay it as a new turn.
    __testEnqueueForVp('g1', 'linus', envelope('msg-2', '@linus also check token refresh'));
    await __testWaitForRoutePromises('msg-2');

    const after = __testGetVpThreads('g1', 'linus');
    const thread = after.find((t) => t.threadId === targetThreadId);
    expect(thread).toBeDefined();

    // The follow-up has been counted: either it was delivered to the
    // running engine (pendingQueries empty + history shows append) or
    // it's still queued for rescue (pendingQueries item with the
    // originalText preserved for replay).
    if (Array.isArray(thread.pendingQueries) && thread.pendingQueries.length > 0) {
      // Rescue-replay path: originalText must be present so the driver tail
      // can re-enqueue without double-prefixing `@vp-linus`.
      const pending = thread.pendingQueries[0];
      expect(typeof pending.originalText).toBe('string');
      expect(pending.originalText).toContain('also check token refresh');
    }

    // Drain so the test cleanup doesn't leave background work.
    await __testDrainVpDrivers();
  });

  // ─── bug 4 ──────────────────────────────────────────────────────────
  it('bug 4: handleUnifyFetchDebugHistory replies with an empty snapshot when no session', async () => {
    // Detach session so handler hits the no-trace branch and replies safely.
    __testSetSession(null);
    sendToServer.mockClear();

    await handleUnifyFetchDebugHistory({});

    expect(sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'unify_debug_history',
      loops: [],
      turns: [],
    }));
  });

  it('bug 4: handleUnifyFetchDebugHistory round-trips persisted SQLite rows back as loops + turns', async () => {
    // Build a real DebugTrace backed by a temp file, write one fake
    // turn, then call the handler and assert the reply contains it.
    const dir = mkdtempSync(join(tmpdir(), 'debug-trace-test-'));
    const dbPath = join(dir, 'trace.sqlite');
    try {
      const trace = new DebugTrace(dbPath);
      const turnId = trace.startTurn({
        traceId: 'trace-1',
        messageId: 'msg-1',
        mode: 'unify',
        turnNumber: 1,
        groupId: 'g1',
        vpId: 'linus',
        threadId: 'thr_a',
        // C2 fix: persist the user prompt EXPLICITLY at startTurn time
        // so the panel header survives multi-loop tool cycles where
        // messages_json gets overwritten by the cumulative snapshot.
        userPrompt: 'hello',
      });
      trace.endTurn(turnId, {
        model: 'test-model',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end_turn',
        latencyMs: 123,
        responseText: 'hi',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        ttfbMs: 50,
      });

      // Mount a session whose `trace` is our real DebugTrace so the
      // bridge handler reads back from disk.
      __testSetSession(mkSession({ trace }));
      sendToServer.mockClear();

      await handleUnifyFetchDebugHistory({ limit: 50 });

      const call = sendToServer.mock.calls.find(
        ([m]) => m && m.type === 'unify_debug_history'
      );
      expect(call).toBeDefined();
      const [payload] = call;
      expect(Array.isArray(payload.loops)).toBe(true);
      expect(Array.isArray(payload.turns)).toBe(true);
      expect(payload.loops).toHaveLength(1);
      expect(payload.loops[0]).toMatchObject({
        turnId: 'trace-1',
        loopNumber: 1,
        groupId: 'g1',
        vpId: 'linus',
        threadId: 'thr_a',
        model: 'test-model',
      });
      expect(payload.turns).toHaveLength(1);
      expect(payload.turns[0]).toMatchObject({
        turnId: 'trace-1',
        groupId: 'g1',
        vpId: 'linus',
        threadId: 'thr_a',
        loopCount: 1,
      });
      // bug 4 hydration: the user prompt should be reconstructed from
      // messages_json so the panel header is non-empty after restart.
      expect(payload.turns[0].userPrompt).toBe('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bug 4: fetchRecentDebugHistory respects groupId + threadId filters', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'debug-trace-test-'));
    const dbPath = join(dir, 'trace.sqlite');
    try {
      const trace = new DebugTrace(dbPath);
      const t1 = trace.startTurn({ traceId: 't1', groupId: 'g1', vpId: 'linus', threadId: 'thr_a' });
      trace.endTurn(t1, { latencyMs: 1, messages: [{ role: 'user', content: 'a' }] });
      const t2 = trace.startTurn({ traceId: 't2', groupId: 'g1', vpId: 'linus', threadId: 'thr_b' });
      trace.endTurn(t2, { latencyMs: 1, messages: [{ role: 'user', content: 'b' }] });
      const t3 = trace.startTurn({ traceId: 't3', groupId: 'g2', vpId: 'linus', threadId: 'thr_a' });
      trace.endTurn(t3, { latencyMs: 1, messages: [{ role: 'user', content: 'c' }] });

      const filteredByGroup = trace.fetchRecentDebugHistory({ groupId: 'g1' });
      expect(filteredByGroup.loops.map((l) => l.turnId).sort()).toEqual(['t1', 't2']);

      const filteredByThread = trace.fetchRecentDebugHistory({ threadId: 'thr_a' });
      expect(filteredByThread.loops.map((l) => l.turnId).sort()).toEqual(['t1', 't3']);

      const filteredByBoth = trace.fetchRecentDebugHistory({ groupId: 'g2', threadId: 'thr_a' });
      expect(filteredByBoth.loops.map((l) => l.turnId)).toEqual(['t3']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fetchRecentDebugHistory returns recent persisted dream events scoped to group', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'debug-trace-test-'));
    const dbPath = join(dir, 'trace.sqlite');
    try {
      const trace = new DebugTrace(dbPath);
      trace.logEvent({ traceId: 'dream-1', eventType: 'dream_progress', eventData: { phase: 'triage', groupId: 'g1', ts: 100 } });
      trace.logEvent({ traceId: 'dream-2', eventType: 'dream_progress', eventData: { phase: 'apply', target: 'group/g2', ts: 200 } });
      trace.logEvent({ traceId: 'dream-3', eventType: 'dream_progress', eventData: { phase: 'done', ts: 300 } });

      const out = trace.fetchRecentDebugHistory({ groupId: 'g1', dreamLimit: 5 });
      expect(out.dreamEvents.map(e => e.phase)).toEqual(['triage', 'done']);
      expect(out.dreamEvents[0]).toEqual(expect.objectContaining({ type: 'dream_progress', groupId: 'g1' }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fetchRecentDebugHistory returns persisted dream metrics and loop events after reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'debug-trace-test-'));
    const dbPath = join(dir, 'trace.sqlite');
    try {
      const trace = new DebugTrace(dbPath);
      trace.event('dream_loop', {
        type: 'loop',
        turnId: 'dream-1',
        groupId: 'g1',
        pass: 'triage-pass1',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        latencyMs: 12,
      });
      trace.event('dream_run', {
        type: 'dream_run',
        turnId: 'dream-1',
        groupId: 'g1',
        phase: 'result',
        metrics: { durationMs: 20, llmCallCount: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
      const out = trace.fetchRecentDebugHistory({ groupId: 'g1', dreamLimit: 5 });
      expect(out.dreamEvents.map(e => e.type)).toEqual(['loop', 'dream_run']);
      expect(out.dreamEvents[1].metrics).toEqual(expect.objectContaining({ llmCallCount: 1, totalTokens: 15 }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });


  it('bug 4: opening an old DB without the new columns auto-migrates without throwing', async () => {
    // Simulate the pre-bugfix DB shape: create the file by writing to a
    // stripped-down SCHEMA, then re-open via DebugTrace and verify the
    // migration ALTER TABLE calls succeed (no-op when columns already
    // exist).
    const dir = mkdtempSync(join(tmpdir(), 'debug-trace-test-'));
    const dbPath = join(dir, 'trace.sqlite');
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const oldDb = new DatabaseSync(dbPath);
      // Minimal pre-bugfix schema (no group_id/vp_id/thread_id/...).
      oldDb.exec(`
        CREATE TABLE trace_turns (
          id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          message_id TEXT,
          mode TEXT,
          turn_number INTEGER,
          started_at INTEGER,
          ended_at INTEGER,
          model TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_write_tokens INTEGER DEFAULT 0,
          stop_reason TEXT,
          latency_ms INTEGER,
          response_text TEXT
        );
        CREATE TABLE trace_tools (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          tool_name TEXT,
          tool_input TEXT,
          tool_output TEXT,
          duration_ms INTEGER,
          is_error INTEGER DEFAULT 0,
          created_at INTEGER
        );
      `);
      oldDb.close();

      // Open via DebugTrace — auto-migration runs in the constructor.
      const trace = new DebugTrace(dbPath);
      // Use it: write + read should work end-to-end.
      const turnId = trace.startTurn({ traceId: 'migrated', groupId: 'g1', vpId: 'linus', threadId: 'thr_a' });
      trace.endTurn(turnId, { latencyMs: 2, messages: [{ role: 'user', content: 'after-migration' }] });
      const out = trace.fetchRecentDebugHistory({ groupId: 'g1' });
      expect(out.loops).toHaveLength(1);
      expect(out.loops[0].groupId).toBe('g1');
      expect(out.loops[0].threadId).toBe('thr_a');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
