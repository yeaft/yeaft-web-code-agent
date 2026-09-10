import { afterEach, describe, expect, it, vi } from 'vitest';
import { beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { searchConversationIndex } from '../../../agent/yeaft/conversation/history-index.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sent = [];
let resolveLoadSession;
const loadSession = vi.fn(() => new Promise((resolve) => { resolveLoadSession = resolve; }));

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn((msg) => { sent.push(msg); }),
}));

vi.mock('../../../agent/yeaft/session.js', () => ({
  loadSession,
}));

vi.mock('../../../agent/yeaft/status-cache.js', () => ({
  hydrateYeaftStatusFromSession: vi.fn(),
}));

const ctx = (await import('../../../agent/context.js')).default;
const { ConversationStore } = await import('../../../agent/yeaft/conversation/persist.js');
const { AnthropicAdapter } = await import('../../../agent/yeaft/llm/anthropic.js');
const { createProviderContext, createProviderState } = await import('../../../agent/yeaft/llm/provider-state.js');
const { trimSnapshotForBudget } = await import('../../../agent/yeaft/history-window.js');
const { pairSanitize } = await import('../../../agent/yeaft/pair-sanitize.js');
const { filterSnapshotForVp } = await import('../../../agent/yeaft/snapshot-filter.js');
const {
  handleYeaftLoadHistory,
  handleYeaftLoadHistoryOutline,
  handleYeaftLoadMoreHistory,
  handleYeaftSearchHistory,
  handleYeaftArchiveSession,
  handleYeaftRenameSession,
  handleYeaftSessionAddMember,
  handleYeaftSessionRemoveMember,
  handleYeaftSessionSetDefaultVp,
  handleYeaftUpdateSession,
  handleYeaftAskUserAnswer,
  __testHandleEngineEvent,
  __testGetRegisteredThreadIds,
  __testGroupHistory,
  __testAppendTurnToSessionHistory,
  __testResetVpState,
  __testSeedAbortController,
  __testSetSession,
  __testHooks,
} = await import('../../../agent/yeaft/web-bridge.js');

function flushMicrotasks() {
  return new Promise(resolve => setImmediate(resolve));
}

const consolidatedHistoryScenarios = [];
function historyScenario(name, run) { consolidatedHistoryScenarios.push({ name, run }); }
async function runConsolidatedHistoryScenarios() {
  for (const scenario of consolidatedHistoryScenarios) {
    try { await scenario.run(); }
    catch (error) { error.message = `[${scenario.name}] ${error.message}`; throw error; }
  }
}

describe('Yeaft load-history first paint', () => {
  beforeEach(() => {
    __testSetSession(null);
    sent.length = 0;
    loadSession.mockClear();
    resolveLoadSession = null;
    ctx.CONFIG = null;
  });

  afterEach(() => {
    __testSetSession(null);
    sent.length = 0;
    loadSession.mockClear();
    resolveLoadSession = null;
    ctx.CONFIG = null;
  });

  it('replays human-paced AskUser requests and bounded terminal results without crossing identities', async () => {
    vi.useFakeTimers();
    __testHooks.resetPendingUserPrompts();
    const identity = {
      requestId: 'ask-bridge-flow', sessionId: 'session-bridge-flow',
      vpId: 'vp-bridge-flow', threadId: 'thread-bridge-flow',
      turnId: 'turn-bridge-flow', toolCallId: 'call-bridge-flow',
      conversationId: 'conversation-original', _requestClientId: 'browser-submitting',
    };
    const expectRejected = (submitted, reason) => {
      expect(sent.at(-1)).toMatchObject({
        type: 'yeaft_output', conversationId: submitted.conversationId,
        _requestClientId: submitted._requestClientId,
        sessionId: submitted.sessionId, vpId: submitted.vpId,
        turnId: submitted.turnId, threadId: submitted.threadId,
        event: {
          type: 'ask_user_answer_rejected', requestId: submitted.requestId,
          toolCallId: submitted.toolCallId, reason,
        },
      });
      expect(sent.at(-1).event).not.toHaveProperty('answers');
      expect(sent.at(-1).event).not.toHaveProperty('questions');
    };
    try {
      __testHooks.setYeaftConversationIdForTest(identity.conversationId);
      const answerPromise = __testHooks.seedPendingUserPrompt(identity);
      sent.length = 0;
      __testHooks.replayPendingUserPrompts('other-session');
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      __testHooks.setYeaftConversationIdForTest('conversation-reconnected');
      __testHooks.replayPendingUserPrompts(identity.sessionId);
      expect(sent.at(-1)).toMatchObject({
        sessionId: identity.sessionId, turnId: identity.turnId,
        event: { type: 'ask_user_question', requestId: identity.requestId, replay: true },
      });
      for (const field of ['sessionId', 'vpId', 'turnId', 'threadId', 'toolCallId']) {
        const wrong = { ...identity, [field]: `wrong-${field}` };
        expect(handleYeaftAskUserAnswer(wrong)).toBe(false);
        expectRejected(wrong, 'identity_mismatch');
      }
      const submitted = { ...identity, conversationId: 'conversation-reconnected', answers: { Continue: 'Yes' } };
      expect(handleYeaftAskUserAnswer(submitted)).toBe(true);
      await expect(answerPromise).resolves.toEqual({ Continue: 'Yes' });
      expect(sent.at(-1).conversationId).toBe(submitted.conversationId);
      const terminal = sent.at(-1).event;
      expect(terminal).toMatchObject({ type: 'ask_user_answered', answers: submitted.answers });
      expect(handleYeaftAskUserAnswer({ ...submitted, answers: { Continue: 'No' } })).toBe(true);
      expect(sent.at(-1).event).toEqual(terminal);
      expect(sent.at(-1)).toMatchObject({
        conversationId: submitted.conversationId, _requestClientId: submitted._requestClientId,
      });
      expect(handleYeaftAskUserAnswer({ requestId: identity.requestId })).toBe(true);
      expect(sent.at(-1).event).toEqual(terminal);
      const wrongTerminal = { ...identity, sessionId: 'other-session' };
      expect(handleYeaftAskUserAnswer(wrongTerminal)).toBe(false);
      expectRejected(wrongTerminal, 'identity_mismatch');
      const missing = { ...identity, requestId: 'missing-request' };
      expect(handleYeaftAskUserAnswer(missing)).toBe(false);
      expectRejected(missing, 'unavailable');

      // A blocked event loop may delay the timer past its deadline.
      const late = { ...identity, requestId: 'late-request' };
      const latePromise = __testHooks.seedPendingUserPrompt({ ...late, expiresAt: Date.now() + 1 });
      vi.setSystemTime(Date.now() + 2);
      expect(handleYeaftAskUserAnswer(late)).toBe(false);
      expectRejected(late, 'unavailable');
      await expect(latePromise).resolves.toEqual({ __yeaftTimedOut: true });
      const expired = sent.find(msg => msg.event?.requestId === late.requestId && msg.event.type === 'ask_user_expired').event;
      const replayStart = sent.length;
      expect(handleYeaftAskUserAnswer(late)).toBe(false);
      expect(sent.slice(replayStart)).toContainEqual(expect.objectContaining({ event: expired }));

      const timed = { ...identity, requestId: 'timer-request' };
      const timedPromise = __testHooks.seedPendingUserPrompt(timed);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await expect(timedPromise).resolves.toEqual({ __yeaftTimedOut: true });
      expect(sent.at(-1).event).toMatchObject({ type: 'ask_user_expired', requestId: timed.requestId });

      const aborted = { ...identity, requestId: 'aborted-request' };
      const controller = new AbortController();
      const abortedPromise = __testHooks.seedPendingUserPrompt({ ...aborted, signal: controller.signal });
      const abortExpectation = expect(abortedPromise).rejects.toThrow('aborted');
      controller.abort();
      await abortExpectation;
      expect(sent.at(-1).event).toMatchObject({ type: 'ask_user_expired', requestId: aborted.requestId });
      sent.length = 0;
      __testHooks.replayPendingUserPrompts(identity.sessionId);
      expect(sent).toEqual([]);
      expect(handleYeaftAskUserAnswer(aborted)).toBe(false);
      expectRejected(aborted, 'unavailable');

      // Evict old terminal entries; neither stale nor duplicate answers resolve again.
      for (let index = 0; index < 256; index++) {
        const next = { ...identity, requestId: `bounded-${index}` };
        const result = __testHooks.seedPendingUserPrompt(next);
        expect(handleYeaftAskUserAnswer(next)).toBe(true);
        await expect(result).resolves.toEqual({});
      }
      expect(handleYeaftAskUserAnswer(identity)).toBe(false);
      expectRejected(identity, 'unavailable');
      expect(handleYeaftAskUserAnswer({ ...identity, requestId: 'bounded-0' })).toBe(true);
    } finally {
      __testHooks.resetPendingUserPrompts();
      __testHooks.setYeaftConversationIdForTest(null);
      vi.useRealTimers();
    }
  });

  it('filters internal rows and uses a collision-resistant virtual conversation id', () => {
    const firstConversationId = __testHooks.ensureYeaftConversationIdForTest();
    __testHooks.setYeaftConversationIdForTest(null);
    const secondConversationId = __testHooks.ensureYeaftConversationIdForTest();
    expect(firstConversationId).toMatch(/^yeaft-[0-9a-f-]{36}$/);
    expect(secondConversationId).toMatch(/^yeaft-[0-9a-f-]{36}$/);
    expect(secondConversationId).not.toBe(firstConversationId);

    const hctx = {
      assistantTextParts: [],
      toolCallsAccum: [],
      toolResultsAccum: [],
      resetQueryTimer: vi.fn(),
      sessionId: 'session-fast',
      vpId: 'vp-linus',
      turnId: 'turn-retry',
      threadId: 'main',
    };
    __testHandleEngineEvent({
      type: 'llm_retry',
      attempt: 2,
      maxRetries: 3,
      delayMs: 2000,
      reason: 'stream_idle_timeout',
      recoveryMode: 'continue',
      errorName: 'LLMStreamIdleTimeoutError',
      statusCode: 0,
      message: 'idle',
    }, hctx);
    __testHandleEngineEvent({
      type: 'error',
      error: new Error('OpenAI stream idle timeout after 90000ms'),
      retryable: true,
      reason: 'stream_idle_timeout',
      retryExhausted: true,
      retryAttempts: 3,
      maxRetries: 3,
    }, hctx);
    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'llm_retry',
        recoveryMode: 'continue',
        attempt: 2,
      }),
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'vp_status_changed',
        state: 'retrying',
        turnId: 'turn-retry',
      }),
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'error',
        retryAttempts: 3,
        message: expect.stringContaining('after 3 fresh request retries'),
      }),
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({
        type: 'assistant',
        message: expect.objectContaining({
          content: [{ type: 'text', text: expect.stringContaining('after 3 fresh request retries') }],
        }),
      }),
    }));
    const markEngineTerminal = vi.fn();
    hctx.markEngineTerminal = markEngineTerminal;
    __testHandleEngineEvent({
      type: 'turn_end',
      stopReason: 'error',
      terminal: true,
      threadId: 'main',
    }, hctx);
    expect(markEngineTerminal).toHaveBeenCalledWith('error', expect.objectContaining({
      message: expect.stringContaining('after 3 fresh request retries'),
      reason: 'stream_idle_timeout',
      retryAttempts: 3,
    }));
    expect(__testHooks.decorateSessionsWithRuntimeState([{ id: 'session-fast' }])).toEqual([
      expect.objectContaining({
        id: 'session-fast',
        running: false,
        active: false,
        runningVpCount: 0,
      }),
    ]);
    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'vp_status_changed',
        state: 'error',
        runningThreadCount: 0,
        turnId: 'turn-retry',
      }),
    }));
    sent.length = 0;

    const policyError = Object.assign(new Error(
      'The LLM provider blocked this request under its content-safety policy. Continue and avoid repeating sensitive payloads or credential-like examples.',
    ), {
      name: 'LLMPolicyError',
      statusCode: 422,
      reasonCode: 'content_policy_denied',
    });
    __testHandleEngineEvent({
      type: 'error',
      error: policyError,
      retryable: false,
      reason: 'content_policy_denied',
      retryExhausted: true,
      retryAttempts: 1,
      maxRetries: 1,
    }, hctx);
    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'error',
        statusCode: 422,
        reasonCode: 'content_policy_denied',
        retryable: false,
        retryExhausted: true,
        message: expect.stringContaining('avoid repeating sensitive payloads'),
      }),
    }));
    expect(sent).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({
        type: 'assistant',
        message: expect.objectContaining({
          content: [{
            type: 'text',
            text: expect.stringContaining('Provider blocked this request for content-safety reasons'),
          }],
        }),
      }),
    }));
    sent.length = 0;

    const rows = [
      { id: 'm0001', role: 'user', content: 'visible q', sessionId: 'session-fast', threadId: 'main' },
      { id: 'm0002', role: 'user', content: '<task-result id="task_1" kind="shell" status="succeeded">\nPASS\n</task-result>', sessionId: 'session-fast', threadId: 'main' },
      { id: 'm0003', role: 'user', content: '[system note] You have called ListAgents with the same arguments 3 times. Previous result: {...}', sessionId: 'session-fast', threadId: 'main' },
      { id: 'm0004', role: 'assistant', content: 'visible a', sessionId: 'session-fast', threadId: 'main', speakerVpId: 'vp-linus' },
      { id: 'm0005', role: 'user', content: 'In docs, <task-result> is just prose', sessionId: 'session-fast', threadId: 'main' },
      { id: 'm0006', role: 'user', content: 'model-only continuation', sessionId: 'session-fast', threadId: 'main', userAuthored: false },
    ];
    const page = __testHooks.loadVisibleGroupHistoryPage({
      loadOlderBySession() {
        return { messages: rows };
      },
    }, 'session-fast', 10);

    expect(page.messages.map(m => m.content)).toEqual([
      'visible q',
      'visible a',
      'In docs, <task-result> is just prose',
    ]);

    const quote = {
      id: 'm0001', role: 'assistant', author: 'Linus', content: 'Prior answer',
      todos: [{ content: 'Verify', status: 'completed' }],
    };
    const projected = __testHooks.projectVisibleHistoryChunkMessages([
      { id: 'm0002', role: 'user', content: 'Follow up', sessionId: 'session-fast', quote },
    ]);
    expect(projected[0]).toMatchObject({ id: 'm0002', quote });
  });

  it('projects the latest TodoWrite snapshot with full tool actions', () => {
    const projected = __testHooks.projectVisibleHistoryChunkMessages([{
      id: 'm0003',
      role: 'assistant',
      content: 'Progress',
      sessionId: 'session-fast',
      responseKind: 'progress',
      llmCallCount: 3,
      toolCalls: [
        { id: 'todo-old', name: 'TodoWrite', input: { todos: [{ content: 'Old', status: 'pending' }] } },
        { id: 'bash', name: 'Bash', input: { command: 'true' } },
        { id: 'todo-new', name: 'TodoWrite', input: { todos: [{ content: 'New', status: 'completed' }] } },
      ],
    }]);

    expect(projected[0]).toMatchObject({
      todos: [{ content: 'New', status: 'completed' }],
      toolCalls: [{ id: 'bash', name: 'Bash', input: { command: 'true' } }],
      responseKind: 'progress',
      llmCallCount: 3,
    });

    expect(__testHooks.projectVisibleHistoryChunkMessages([{
      id: 'm0004', role: 'assistant', content: 'Partial', sessionId: 'session-fast',
      incomplete: true, stopReason: 'aborted',
    }])[0]).toMatchObject({ responseKind: 'progress' });
    expect(__testHooks.projectVisibleHistoryChunkMessages([{
      id: 'm0005', role: 'assistant', content: 'Partial before error', sessionId: 'session-fast',
      responseKind: 'result', incomplete: true, stopReason: 'error',
    }])[0]).toMatchObject({
      responseKind: 'progress', incomplete: true, stopReason: 'error',
    });
    expect(__testHooks.projectVisibleHistoryChunkMessages([{
      id: 'm0006', role: 'assistant', content: 'Cancelled partial', sessionId: 'session-fast',
      responseKind: 'result', stopReason: 'cancelled',
    }])[0]).toMatchObject({ responseKind: 'progress', stopReason: 'cancelled' });

    const markEngineTerminal = vi.fn();
    const handlerCtx = {
      assistantTextParts: [],
      toolCallsAccum: [],
      toolResultsAccum: [],
      resetQueryTimer: vi.fn(),
      pauseQueryTimer: vi.fn(),
      markEngineTerminal,
      sessionId: 'session-fast',
      vpId: 'vp-linus',
      turnId: 'turn-error',
      threadId: 'main',
    };
    __testHandleEngineEvent({
      type: 'error',
      error: new Error('provider exploded'),
      retryable: false,
    }, handlerCtx);
    expect(markEngineTerminal).not.toHaveBeenCalled();

    handlerCtx.resetQueryTimer.mockClear();
    handlerCtx.pauseQueryTimer.mockClear();
    __testHandleEngineEvent({
      type: 'llm_retry',
      attempt: 2,
      maxRetries: 2,
      delayMs: 120_000,
      reason: 'temporary_forbidden',
      threadId: 'main',
    }, handlerCtx);
    expect(handlerCtx.pauseQueryTimer).toHaveBeenCalledTimes(1);
    expect(handlerCtx.resetQueryTimer).not.toHaveBeenCalled();

    handlerCtx.pauseQueryTimer.mockClear();
    __testHandleEngineEvent({
      type: 'tool_start',
      id: 'call-slow',
      name: 'Bash',
      threadId: 'main',
    }, handlerCtx);
    expect(handlerCtx.pauseQueryTimer).toHaveBeenCalledTimes(1);
    expect(handlerCtx.resetQueryTimer).not.toHaveBeenCalled();

    __testHandleEngineEvent({
      type: 'tool_end',
      id: 'call-slow',
      name: 'Bash',
      output: 'done',
      isError: false,
      threadId: 'main',
    }, handlerCtx);
    expect(handlerCtx.resetQueryTimer).toHaveBeenCalledTimes(1);

    expect(sent).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        type: 'llm_retry',
        delayMs: 120_000,
      }),
    }));
    expect(sent.at(-1)).toMatchObject({
      sessionId: 'session-fast',
      vpId: 'vp-linus',
      turnId: 'turn-error',
      threadId: 'main',
    });
    handlerCtx.resetQueryTimer.mockClear();
    __testHandleEngineEvent({ type: 'turn_start', threadId: 'main' }, handlerCtx);
    expect(handlerCtx.resetQueryTimer).toHaveBeenCalledTimes(1);

    __testHandleEngineEvent({
      type: 'turn_end',
      stopReason: 'error',
      terminal: true,
      threadId: 'main',
    }, handlerCtx);
    expect(markEngineTerminal).toHaveBeenCalledWith('error', { message: 'provider exploded' });

    sent.length = 0;
    const waitWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      __testHandleEngineEvent({
        type: 'async_task_wait_end',
        turnId: 'turn-stalled-task',
        threadId: 'main',
        loopNumber: 2,
        aborted: false,
        remainingTaskIds: [],
        timedOut: true,
        deferredTaskIds: ['task-stalled'],
      }, handlerCtx);
      expect(handlerCtx.resetQueryTimer).toHaveBeenCalled();
      expect(waitWarn).toHaveBeenCalledWith(
        expect.stringContaining('async task wait timed out'),
        ['task-stalled'],
      );
      expect(sent).toContainEqual(expect.objectContaining({
        event: expect.objectContaining({
          type: 'vp_async_task_wait_end',
          timedOut: true,
          deferredTaskIds: ['task-stalled'],
        }),
      }));
    } finally {
      waitWarn.mockRestore();
    }
  });

  it('keeps live debug events lightweight and leaves full detail in the persisted trace', () => {
    sent.length = 0;
    const handlerCtx = {
      sessionId: 'session-fast',
      vpId: 'vp-linus',
      turnId: 'turn-large-debug',
      threadId: 'main',
      resetQueryTimer: vi.fn(),
    };
    const large = 'x'.repeat(1024 * 1024);

    __testHandleEngineEvent({
      type: 'loop',
      turnId: 'turn-large-debug',
      loopNumber: 7,
      model: 'provider/model',
      systemPrompt: large,
      messages: [{ role: 'user', content: large }],
      response: large,
      toolCalls: [{ id: 'call-1', name: 'Bash', input: { command: large } }],
      usage: { totalTokens: 42 },
      latencyMs: 12,
      ttfbMs: 3,
      stopReason: 'tool_use',
      at: 123,
      rawRequest: { body: large },
      rawResponse: large,
    }, handlerCtx);

    __testHandleEngineEvent({
      type: 'tool_exec',
      turnId: 'turn-large-debug',
      loopNumber: 7,
      callId: 'call-1',
      name: 'Bash',
      durationMs: 8,
      isError: false,
      toolOutput: large,
    }, handlerCtx);

    const loop = sent.find(message => message.event?.type === 'loop')?.event;
    expect(loop).toMatchObject({
      type: 'loop',
      turnId: 'turn-large-debug',
      loopNumber: 7,
      model: 'provider/model',
      usage: { totalTokens: 42 },
    });
    expect(loop).not.toHaveProperty('systemPrompt');
    expect(loop).not.toHaveProperty('messages');
    expect(loop).not.toHaveProperty('rawRequest');
    expect(loop).not.toHaveProperty('rawResponse');
    expect(loop).not.toHaveProperty('response');
    expect(loop).not.toHaveProperty('toolCalls');
    const tool = sent.find(message => message.event?.type === 'tool_exec')?.event;
    expect(tool).not.toHaveProperty('toolOutput');
    expect(JSON.stringify(sent).length).toBeLessThan(4096);
  });

  it('preserves TodoWrite through the real store page and history wire projection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-todo-history-'));
    try {
      const store = new ConversationStore(dir);
      store.append({ role: 'user', content: 'status?', sessionId: 'session-fast' });
      store.append({
        role: 'assistant',
        content: 'Progress',
        sessionId: 'session-fast',
        speakerVpId: 'vp-linus',
        responseKind: 'result',
        stopReason: 'end_turn',
        toolCalls: [
          { id: 'todo', name: 'TodoWrite', input: { todos: [{ content: 'Verify', status: 'completed' }] } },
          { id: 'bash', name: 'Bash', input: { command: 'true' } },
        ],
      });

      const page = __testHooks.loadVisibleGroupHistoryPage(store, 'session-fast', 1);
      const projected = __testHooks.projectVisibleHistoryChunkMessages(page.messages);

      expect(page.messages[1]).toMatchObject({
        todos: [{ content: 'Verify', status: 'completed' }],
        toolCalls: [{ id: 'bash', name: 'Bash', input: { command: 'true' } }],
        responseKind: 'result',
      });
      expect(projected[1]).toMatchObject({
        todos: [{ content: 'Verify', status: 'completed' }],
        toolCalls: [{ id: 'bash', name: 'Bash', input: { command: 'true' } }],
        responseKind: 'result',
      });

      store.append({
        role: 'assistant', content: 'Persisted partial', sessionId: 'session-fast',
        speakerVpId: 'vp-linus', responseKind: 'result', incomplete: true, stopReason: 'error',
      });
      const failedPage = __testHooks.loadVisibleGroupHistoryPage(store, 'session-fast', 1);
      const failedProjected = __testHooks.projectVisibleHistoryChunkMessages(failedPage.messages);
      expect(failedPage.messages.at(-1)).toMatchObject({
        responseKind: 'progress', incomplete: true, stopReason: 'error',
      });
      expect(failedProjected.at(-1)).toMatchObject({
        responseKind: 'progress', incomplete: true, stopReason: 'error',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the canonical image asset anchor in the history wire projection', () => {
    const projected = __testHooks.projectVisibleHistoryChunkMessages([
      { id: 'm0001', role: 'assistant', content: 'tool progress', sessionId: 'session-fast', turnId: 'turn-image' },
      { id: 'm0002', role: 'assistant', content: 'final response', sessionId: 'session-fast', turnId: 'turn-image', imageAssetAnchor: true },
    ]);

    expect(projected[0]).not.toHaveProperty('imageAssetAnchor');
    expect(projected[1]).toMatchObject({
      id: 'm0002',
      turnId: 'turn-image',
      imageAssetAnchor: true,
    });
  });

  it('projects a persisted AskUser answer as terminal history metadata', () => {
    const projected = __testHooks.projectVisibleHistoryChunkMessages([
      {
        id: 'm0100',
        role: 'assistant',
        content: '',
        sessionId: 'session-fast',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        toolCalls: [{ id: 'ask_1', name: 'AskUser', input: { question: 'Continue?', options: ['Yes', 'No'] } }],
      },
      {
        id: 'm0101',
        role: 'tool',
        content: JSON.stringify({ question: 'Continue?', answers: { 'Continue?': 'Yes' } }),
        sessionId: 'session-fast',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        toolCallId: 'ask_1',
      },
    ]);

    expect(projected).toEqual([
      expect.objectContaining({
        id: 'm0100',
        role: 'assistant',
        askUserResults: [{
          toolCallId: 'ask_1',
          status: 'answered',
          question: 'Continue?',
          options: ['Yes', 'No'],
          answers: { 'Continue?': 'Yes' },
        }],
      }),
    ]);
    expect(projected[0].toolCalls).toEqual([
      { id: 'ask_1', name: 'AskUser', input: { question: 'Continue?', options: ['Yes', 'No'] } },
    ]);
  });

  historyScenario('keeps outline totals opt-in and traces bounded outline/search scans', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-history-scan-trace-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      store.appendBatch([
        { role: 'user', content: 'first needle', sessionId: 'session-trace' },
        { role: 'assistant', content: 'first answer', sessionId: 'session-trace', speakerVpId: 'vp-linus' },
        { role: 'user', content: 'second question', sessionId: 'session-trace' },
        { role: 'assistant', content: 'second needle', sessionId: 'session-trace', speakerVpId: 'vp-linus' },
      ]);

      await handleYeaftLoadHistoryOutline({
        type: 'yeaft_load_history_outline',
        sessionId: 'session-trace',
        requestId: 'outline-default',
        perfTraceId: 'pt-outline-default',
        limit: 2,
      });
      expect(sent.find(message => message.requestId === 'outline-default')).toMatchObject({
        type: 'yeaft_history_outline',
        totalCount: null,
        error: 'index_building',
        perfTraceId: 'pt-outline-default',
      });
      await searchConversationIndex(dir, 'session-trace', 'needle');
      await handleYeaftLoadHistoryOutline({
        type: 'yeaft_load_history_outline',
        sessionId: 'session-trace',
        requestId: 'outline-counted',
        perfTraceId: 'pt-outline-counted',
        includeTotal: true,
        limit: 2,
      });
      await handleYeaftSearchHistory({
        type: 'yeaft_search_history',
        sessionId: 'session-trace',
        requestId: 'search-traced',
        perfTraceId: 'pt-search',
        query: 'needle',
        limit: 2,
      });
      await flushMicrotasks();
      const { flushAllAgentPerfTraces } = await import('../../../agent/yeaft/perf-trace.js');
      flushAllAgentPerfTraces();

      expect(sent.find(message => message.requestId === 'outline-counted')).toMatchObject({
        type: 'yeaft_history_outline', totalCount: 4,
      });
      expect(sent.find(message => message.requestId === 'search-traced')).toMatchObject({
        type: 'yeaft_history_search_result', perfTraceId: 'pt-search',
        results: expect.arrayContaining([expect.objectContaining({ snippet: expect.stringContaining('needle') })]),
      });

      const day = new Date().toISOString().slice(0, 10);
      const traces = readFileSync(join(dir, 'perf-traces', `${day}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      const outlineScan = traces.find(row => row.traceId === 'pt-outline-counted' && row.phase === 'history_outline.store_scan');
      const searchScan = traces.find(row => row.traceId === 'pt-search' && row.phase === 'history_search.store_scan');
      expect(outlineScan).toMatchObject({
        detail: {
          includeTotal: true,
          resultCount: 2,
          indexGeneration: expect.any(Number),
          indexFallback: false,
        },
      });
      expect(searchScan).toMatchObject({
        detail: {
          queryLength: 6,
          resultCount: 2,
          indexGeneration: expect.any(Number),
          indexFallback: false,
        },
      });
      expect(JSON.stringify(traces)).not.toContain('first needle');
      expect(traces).toEqual(expect.arrayContaining([
        expect.objectContaining({ traceId: 'pt-outline-counted', phase: 'history_outline.event_loop_delay' }),
        expect.objectContaining({ traceId: 'pt-search', phase: 'history_search.event_loop_delay' }),
      ]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads older pages from persisted history before runtime boot resolves', async () => {
    await runConsolidatedHistoryScenarios();
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-fast-older-history-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      const appended = store.appendBatch(Array.from({ length: 24 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `history ${index + 1}`,
        sessionId: 'session-fast-older',
        ...(index % 2 === 0 ? {} : { speakerVpId: 'vp-linus' }),
      })));

      await handleYeaftLoadMoreHistory({
        sessionId: 'session-fast-older',
        beforeSeq: store.getMessageSeqById(appended.at(-1).id) + 1,
        turns: 20,
      });

      expect(loadSession).not.toHaveBeenCalled();
      const chunk = sent.find(message => message.type === 'yeaft_history_chunk' && message.mode === 'older');
      expect(chunk).toMatchObject({ sessionId: 'session-fast-older', turns: 20 });
      expect(chunk.messages).toHaveLength(24);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replays the recent message window before full session boot resolves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-fast-history-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      store.appendBatch([
        { role: 'user', content: 'old q', sessionId: 'session-fast' },
        { role: 'assistant', content: 'old a', sessionId: 'session-fast', speakerVpId: 'vp-linus' },
        { role: 'user', content: 'new q', sessionId: 'session-fast' },
        { role: 'assistant', content: '', sessionId: 'session-fast', speakerVpId: 'vp-linus', toolCalls: [{ id: 'tool-1', name: 'Bash', input: { command: 'echo ok' } }] },
      ]);

      const pending = handleYeaftLoadHistory({
        sessionId: 'session-fast',
        limit: 1,
        requestId: 'history-request-1',
        _requestClientId: 'web-client-1',
      });
      await flushMicrotasks();

      expect(loadSession).toHaveBeenCalledTimes(1);
      const chunk = sent.find(m => m.type === 'yeaft_history_chunk');
      expect(chunk).toMatchObject({
        type: 'yeaft_history_chunk',
        sessionId: 'session-fast',
        requestId: 'history-request-1',
        _requestClientId: 'web-client-1',
        mode: 'recent',
        hasMore: true,
        messages: [
          { role: 'user', content: 'new q', sessionId: 'session-fast' },
          {
            role: 'assistant', content: '', sessionId: 'session-fast', speakerVpId: 'vp-linus',
            toolCalls: [{ id: 'tool-1', name: 'Bash', input: { command: 'echo ok' } }],
          },
        ],
      });
      const historyDone = sent.find(m => m.event?.type === 'history_loaded');
      expect(historyDone).toMatchObject({
        type: 'yeaft_output',
        requestId: 'history-request-1',
        _requestClientId: 'web-client-1',
        event: {
          type: 'history_loaded',
          mode: 'recent',
          count: 2,
          sessionId: 'session-fast',
          requestId: 'history-request-1',
          hasMore: true,
        },
      });
      expect(sent.filter(m => m.type === 'yeaft_output' && m.data)).toHaveLength(0);

      await pending;
      const historyLoadedEvents = sent.filter(m => m.event?.type === 'history_loaded');
      expect(historyLoadedEvents).toHaveLength(1);
      expect(sent.some(m => m.event?.type === 'session_ready' && !m.event.partial)).toBe(false);

      resolveLoadSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });
      await flushMicrotasks();

      await new Promise(resolve => setTimeout(resolve, 0));
      const ready = sent.find(m => m.event?.type === 'session_ready' && !m.event.partial);
      expect(ready).toMatchObject({
        type: 'yeaft_output',
        sessionId: 'session-fast',
        event: { type: 'session_ready' },
      });

      const hiddenSessionId = 'session-hidden-continuation';
      store.appendBatch([
        { role: 'user', content: 'reachable old question', sessionId: hiddenSessionId },
        { role: 'assistant', content: 'reachable old answer', sessionId: hiddenSessionId },
        ...Array.from({ length: 300 }, (_, index) => ({
          role: 'user', content: `hidden ${index}`, sessionId: hiddenSessionId, internal: true,
        })),
      ]);
      sent.length = 0;
      await handleYeaftLoadHistory({
        sessionId: hiddenSessionId,
        limit: 1,
        requestId: 'hidden-recent',
      });
      const hiddenRecent = sent.find(message => (
        message.type === 'yeaft_history_chunk' && message.requestId === 'hidden-recent'
      ));
      const hiddenDone = sent.find(message => message.event?.requestId === 'hidden-recent');
      expect(hiddenRecent).toMatchObject({
        mode: 'recent', messages: [], oldestSeq: null, hasMore: true,
        nextBeforeSeq: expect.any(Number),
      });
      expect(hiddenDone.event).toMatchObject({
        type: 'history_loaded', mode: 'recent', oldestSeq: null, hasMore: true,
        nextBeforeSeq: hiddenRecent.nextBeforeSeq,
      });

      let beforeSeq = hiddenRecent.nextBeforeSeq;
      let visibleMessages = [];
      const cursors = [];
      for (let attempt = 0; attempt < 4 && visibleMessages.length === 0; attempt += 1) {
        cursors.push(beforeSeq);
        const requestId = `hidden-older-${attempt}`;
        await handleYeaftLoadMoreHistory({
          sessionId: hiddenSessionId,
          requestId,
          beforeSeq,
          pageKind: 'server',
          cacheEpoch: 0,
          turns: 20,
        });
        const page = sent.find(message => (
          message.type === 'yeaft_history_chunk' && message.requestId === requestId
        ));
        visibleMessages = page.messages;
        beforeSeq = page.nextBeforeSeq;
      }
      expect(new Set(cursors).size).toBe(cursors.length);
      expect(cursors.every((cursor, index) => index === 0 || cursor < cursors[index - 1])).toBe(true);
      expect(visibleMessages.map(message => message.content)).toEqual([
        'reachable old question', 'reachable old answer',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cold-start history uses the user-level session store before runtime boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-workdir-history-default-'));
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-workdir-history-project-'));
    try {
      const sessionId = 'session-workdir';
      const sessionDir = join(dir, 'sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'session.json'), `${JSON.stringify({
        id: sessionId,
        name: 'WorkDir Session',
        roster: ['omni'],
        defaultVpId: 'omni',
        workDir,
        createdAt: '2026-06-26T00:00:00.000Z',
      }, null, 2)}\n`);
      mkdirSync(dir, { recursive: true });

      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      store.append({ role: 'user', content: 'workdir q', sessionId, time: '2026-06-26T01:00:00.000Z' });
      store.append({ role: 'assistant', content: 'workdir a', sessionId, speakerVpId: 'vp-linus', time: '2026-06-26T01:00:01.000Z' });

      const pending = handleYeaftLoadHistory({ sessionId, limit: 1 });
      await flushMicrotasks();

      const chunk = sent.find(m => m.type === 'yeaft_history_chunk' && m.mode === 'recent');
      expect(chunk.messages.map(m => m.content)).toEqual(['workdir q', 'workdir a']);
      expect(loadSession).toHaveBeenCalledTimes(1);
      expect(loadSession.mock.calls[0][0]).toMatchObject({ dir, workDir });
      expect(existsSync(join(workDir, '.yeaft', 'sessions', sessionId, 'conversation', 'segments', '000001.jsonl'))).toBe(false);

      await pending;
      resolveLoadSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });
      await flushMicrotasks();
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('migrates legacy project session history before cold-start replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-workdir-history-default-'));
    const workDir = mkdtempSync(join(tmpdir(), 'yeaft-workdir-history-project-'));
    try {
      const sessionId = 'session-workdir-legacy';
      const projectSessionDir = join(workDir, '.yeaft', 'sessions', sessionId);
      mkdirSync(projectSessionDir, { recursive: true });
      writeFileSync(join(projectSessionDir, 'session.json'), `${JSON.stringify({
        id: sessionId,
        name: 'Legacy WorkDir Session',
        roster: ['omni'],
        defaultVpId: 'omni',
        workDir,
        createdAt: '2026-06-26T00:00:00.000Z',
      }, null, 2)}\n`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'group-workdirs.json'), `${JSON.stringify({ [sessionId]: workDir }, null, 2)}\n`);

      ctx.CONFIG = { yeaftDir: dir };
      const projectStore = new ConversationStore(join(workDir, '.yeaft'));
      projectStore.append({ role: 'user', content: 'legacy q', sessionId, time: '2026-06-26T01:00:00.000Z' });
      projectStore.append({ role: 'assistant', content: 'legacy a', sessionId, speakerVpId: 'vp-linus', time: '2026-06-26T01:00:01.000Z' });

      const pending = handleYeaftLoadHistory({ sessionId, limit: 1 });
      await flushMicrotasks();

      const chunk = sent.find(m => m.type === 'yeaft_history_chunk' && m.mode === 'recent');
      expect(chunk.messages.map(m => m.content)).toEqual(['legacy q', 'legacy a']);
      expect(existsSync(join(dir, 'sessions', sessionId, 'session.json'))).toBe(true);
      expect(existsSync(join(dir, 'sessions', sessionId, 'conversation', 'segments', '000001.jsonl'))).toBe(true);
      expect(loadSession).toHaveBeenCalledTimes(1);
      expect(loadSession.mock.calls[0][0]).toMatchObject({ dir, workDir });

      await pending;
      resolveLoadSession({
        conversationStore: new ConversationStore(dir),
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });
      await flushMicrotasks();
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('loaded runtime history hydration uses the bounded recent window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-runtime-history-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      for (let i = 0; i < 500; i++) {
        store.append({ role: 'user', content: `old ${i}`, sessionId: 'session-fast' });
        store.append({ role: 'assistant', content: `old answer ${i}`, sessionId: 'session-fast', speakerVpId: 'vp-linus' });
      }
      store.append({ role: 'user', content: 'latest q', sessionId: 'session-fast' });
      store.append({ role: 'assistant', content: 'latest a', sessionId: 'session-fast', speakerVpId: 'vp-linus' });

      const readCounts = { count: 0 };
      const original = store.readMessageFile;
      store.readMessageFile = (...args) => {
        readCounts.count += 1;
        return original.call(store, ...args);
      };
      __testSetSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });

      await handleYeaftLoadHistory({ sessionId: 'session-fast', limit: 1 });
      const chunk = sent.find(m => m.type === 'yeaft_history_chunk');
      expect(chunk.messages.map(m => m.content)).toEqual(['latest q', 'latest a']);
      expect(__testHooks.loadVisibleGroupHistoryPage({
        loadVisibleBySession: (...args) => store.loadVisibleBySession(...args),
      }, 'session-fast', 1).messages.map(m => m.content)).toEqual(['latest q', 'latest a']);
      // One bounded UI replay (limit: 1) plus one bounded runtime hydrate
      // (default recentTurnsLimit) is fine; parsing the whole 1002-row session is not.
      expect(readCounts.count).toBeLessThan(80);

      store.append({ role: 'user', content: 'progress q', sessionId: 'session-progress' });
      store.append({
        role: 'assistant', content: 'I found the request construction boundary.',
        sessionId: 'session-progress', speakerVpId: 'vp-linus', responseKind: 'progress',
      });
      store.append({
        role: 'assistant', content: 'The prior turn completed.',
        sessionId: 'session-progress', speakerVpId: 'vp-linus',
        responseKind: 'result', stopReason: 'end_turn',
      });
      expect(__testGroupHistory('session-progress')).toEqual([
        expect.objectContaining({ role: 'user', content: 'progress q' }),
        expect.objectContaining({
          role: 'assistant',
          content: 'I found the request construction boundary.',
          responseKind: 'progress',
        }),
        expect.objectContaining({
          role: 'assistant',
          content: 'The prior turn completed.',
          responseKind: 'result',
        }),
      ]);
    } finally {
      __testSetSession(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hydrates signed thinking blocks from the real store and preserves the owner wire arc after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-signed-hydrate-'));
    const originalFetch = global.fetch;
    const calls = [];
    try {
      const store = new ConversationStore(dir);
      const requestIdentity = { instanceScope: dir, ownerScope: 'fixture', sessionId: 'session-signed', vpId: 'vp-linus', threadId: 'main' };
      const providerContext = createProviderContext({ protocol: 'anthropic', baseUrl: 'https://anthropic.test',
        credentialScopeId: 'fixture-account', model: 'claude-sonnet-4.5', capabilities: { nativeReasoningState: true } });
      const providerState = createProviderState({ context: providerContext, identity: requestIdentity, items: [
        { type: 'thinking', thinking: 'restart-safe reasoning', signature: 'restart-signature' },
        { type: 'tool_use', id: 'call-signed', name: 'Inspect', input: { path: 'README.md' } },
      ] });
      store.append({ role: 'user', content: 'use the tool', sessionId: 'session-signed', turnId: 'turn-signed' });
      store.append({
        role: 'assistant',
        content: '',
        sessionId: 'session-signed',
        turnId: 'turn-signed',
        speakerVpId: 'vp-linus',
        toolCalls: [{ id: 'call-signed', name: 'Inspect', input: { path: 'README.md' } }],
        providerState,
      });
      store.append({
        role: 'tool',
        content: 'tool result after restart',
        sessionId: 'session-signed',
        turnId: 'turn-signed',
        speakerVpId: 'vp-linus',
        toolCallId: 'call-signed',
      });

      __testSetSession({
        conversationStore: new ConversationStore(dir),
        config: { model: 'claude-sonnet-4.5', language: 'en', messageTokenBudget: 32_768 },
        status: { skills: 0, mcpServers: [], tools: 0 },
      });
      const hydrated = __testGroupHistory('session-signed');
      const ownerSnapshot = trimSnapshotForBudget(
        pairSanitize(filterSnapshotForVp(hydrated, 'vp-linus')),
        { messageTokenBudget: 32_768 },
      );
      expect(ownerSnapshot).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          toolCalls: [{ id: 'call-signed', name: 'Inspect', input: { path: 'README.md' } }],
          providerState,
        }),
        expect.objectContaining({ role: 'tool', toolCallId: 'call-signed' }),
      ]));

      global.fetch = vi.fn(async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ content: [{ type: 'text', text: 'restarted' }], usage: {} }),
          text: async () => '',
        };
      });
      const adapter = new AnthropicAdapter({ apiKey: 'key', baseUrl: 'https://anthropic.test' });
      await adapter.call({ model: 'claude-sonnet-4.5', system: '', messages: ownerSnapshot, requestIdentity, providerContext });
      const assistantWire = calls[0].body.messages.find(message => message.role === 'assistant');
      expect(assistantWire.content).toEqual([
        { type: 'thinking', thinking: 'restart-safe reasoning', signature: 'restart-signature' },
        { type: 'tool_use', id: 'call-signed', name: 'Inspect', input: { path: 'README.md' } },
      ]);
      expect(calls[0].body.messages.at(-1)).toMatchObject({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-signed', content: 'tool result after restart', is_error: false }],
      });
    } finally {
      global.fetch = originalFetch;
      __testSetSession(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds the shared runtime history cache without changing the durable store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-runtime-cache-bound-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      __testSetSession({
        conversationStore: store,
        config: { model: 'test-model', language: 'en' },
        status: { skills: 0, mcpServers: [], tools: 0 },
      });

      for (let index = 0; index < 40; index += 1) {
        const callId = `call-${index}`;
        __testAppendTurnToSessionHistory(
          'session-cache',
          'main',
          'vp-linus',
          [`question ${index}`],
          [`answer ${index}`],
          [{ id: callId, name: 'Bash', input: { command: 'pwd' } }],
          [{ toolCallId: callId, content: 'x'.repeat(200_000), isError: false }],
          [],
          { turnId: `turn-${index}` },
        );
      }

      const normalHistory = __testGroupHistory('session-cache');
      expect(normalHistory.length).toBeLessThanOrEqual(256);
      expect(normalHistory.every(message => message.content === undefined || typeof message.content === 'string' || Array.isArray(message.content))).toBe(true);
      expect(normalHistory.some(message => message.content === 'question 39')).toBe(true);
      expect(normalHistory.some(message => message.content === 'answer 39')).toBe(true);

      __testAppendTurnToSessionHistory(
        'session-cache',
        'main',
        'vp-linus',
        ['thinking question'],
        ['thinking answer'],
        [],
        [],
        [{ thinking: 'x'.repeat(200_000), signature: 'opaque-signature' }],
        { turnId: 'turn-thinking' },
      );

      const runtimeHistory = __testGroupHistory('session-cache');
      expect(runtimeHistory.length).toBeLessThanOrEqual(256);
      expect(JSON.stringify(runtimeHistory)).not.toContain('opaque-signature');
      expect(JSON.stringify(runtimeHistory)).not.toContain('x'.repeat(1_000));
      // This helper only changes the runtime cache. It never writes the
      // direct test appends to ConversationStore or deletes durable rows.
      expect(store.loadAllBySession('session-cache')).toEqual([]);
    } finally {
      __testSetSession(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('metadata-only load does not emit an empty recent history chunk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-metadata-only-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      store.appendBatch([
        { role: 'user', content: 'cached q', sessionId: 'session-fast' },
        { role: 'assistant', content: 'cached a', sessionId: 'session-fast', speakerVpId: 'vp-linus' },
      ]);

      const pending = handleYeaftLoadHistory({ sessionId: 'session-fast', limit: 0 });
      await flushMicrotasks();

      expect(sent.some(m => m.type === 'yeaft_history_chunk')).toBe(false);
      expect(sent.some(m => m.event?.type === 'history_loaded')).toBe(false);

      await pending;
      expect(sent.some(m => m.event?.type === 'session_ready')).toBe(false);

      resolveLoadSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });
      await flushMicrotasks();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(sent.some(m => m.type === 'yeaft_history_chunk')).toBe(false);
      expect(sent.some(m => m.event?.type === 'history_loaded')).toBe(false);
      expect(sent.some(m => m.event?.type === 'session_ready')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists inbound user rows with the coordinator receive timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-inbound-ts-'));
    try {
      const store = new ConversationStore(dir);
      __testSetSession({ conversationStore: store });

      const wrote = __testHooks.persistInboundMessageOnceByMsgId({
        msgId: 'g_msg_1',
        text: 'hello at the real send time',
        sessionId: 'session-fast',
        threadId: 'main',
        role: 'user',
        ts: '2026-06-20T01:02:03.456Z',
      });

      expect(wrote).toBe(true);
      const rows = store.loadAllBySession('session-fast');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        role: 'user',
        content: 'hello at the real send time',
        time: '2026-06-20T01:02:03.456Z',
        userAuthored: true,
      });
    } finally {
      __testSetSession(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cold-start delta replay preserves timestamps, attachments, and tool summaries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-delta-cold-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      const anchor = store.append({
        role: 'user',
        content: 'already seen',
        sessionId: 'session-fast',
        time: '2026-06-20T01:00:00.000Z',
      });
      store.append({
        role: 'user',
        content: 'with file',
        sessionId: 'session-fast',
        time: '2026-06-20T01:00:01.000Z',
        attachments: [{ fileId: 'file_1', name: 'note.txt', isImage: false }],
      });
      store.append({
        role: 'assistant',
        content: 'I will use a tool',
        sessionId: 'session-fast',
        threadId: 'main',
        speakerVpId: 'vp-linus',
        time: '2026-06-20T01:00:02.000Z',
        toolCalls: [{ id: 'toolu_1', name: 'Bash', input: { command: 'echo ok' } }],
      });
      store.append({
        role: 'tool',
        content: 'ok',
        sessionId: 'session-fast',
        threadId: 'main',
        toolCallId: 'toolu_1',
        time: '2026-06-20T01:00:03.000Z',
      });

      const pending = handleYeaftLoadHistory({ sessionId: 'session-fast', afterMessageId: anchor.id });
      await flushMicrotasks();

      const chunk = sent.find(m => m.type === 'yeaft_history_chunk' && m.mode === 'delta');
      expect(chunk).toMatchObject({
        type: 'yeaft_history_chunk',
        sessionId: 'session-fast',
        mode: 'delta',
        afterSeq: Number(anchor.id.slice(1)),
        messages: [
          {
            role: 'user',
            content: 'with file',
            ts: '2026-06-20T01:00:01.000Z',
            attachments: [{ fileId: 'file_1', name: 'note.txt', isImage: false }],
          },
          {
            role: 'assistant',
            content: 'I will use a tool',
            ts: '2026-06-20T01:00:02.000Z',
            speakerVpId: 'vp-linus',
            toolCalls: [{ id: 'toolu_1', name: 'Bash', input: { command: 'echo ok' } }],
          },
        ],
      });
      expect(chunk.messages).toHaveLength(2);
      expect(sent.filter(m => m.type === 'yeaft_output' && m.data)).toHaveLength(0);
      expect(sent.find(m => m.event?.type === 'history_loaded')?.event).toMatchObject({
        mode: 'delta',
        count: chunk.messages.length,
        sessionId: 'session-fast',
      });

      await pending;

      resolveLoadSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });
      await flushMicrotasks();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits an empty delta acknowledgement when no visible rows changed after the cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-empty-delta-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      const store = new ConversationStore(dir);
      const anchor = store.append({
        role: 'user',
        content: 'already seen',
        sessionId: 'session-fast',
        time: '2026-06-20T01:00:00.000Z',
      });
      const hidden = store.append({
        role: 'user',
        content: '[system note] You have called ListAgents with the same arguments 3 times. Previous result: {...}',
        sessionId: 'session-fast',
        time: '2026-06-20T01:00:01.000Z',
      });

      const pending = handleYeaftLoadHistory({ sessionId: 'session-fast', afterSeq: Number(anchor.id.slice(1)) });
      await flushMicrotasks();

      expect(sent.find(m => m.type === 'yeaft_history_chunk' && m.mode === 'delta')).toMatchObject({
        sessionId: 'session-fast',
        messages: [],
        latestSeq: Number(hidden.id.slice(1)),
        afterSeq: Number(anchor.id.slice(1)),
      });
      const event = sent.find(m => m.event?.type === 'history_loaded')?.event;
      expect(event).toMatchObject({
        mode: 'delta',
        count: 0,
        sessionId: 'session-fast',
        latestSeq: Number(hidden.id.slice(1)),
        afterSeq: Number(anchor.id.slice(1)),
      });
      expect(event.latestSeq).toBeGreaterThan(event.afterSeq);

      await pending;

      resolveLoadSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });
      await flushMicrotasks();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ready-session recent replay emits history before metadata snapshots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-ready-recent-first-'));
    try {
      const store = new ConversationStore(dir);
      store.append({
        role: 'user',
        content: 'ready recent user',
        sessionId: 'session-fast',
        time: '2026-06-20T03:00:00.000Z',
      });
      store.append({
        role: 'assistant',
        content: 'ready recent assistant',
        sessionId: 'session-fast',
        speakerVpId: 'vp-linus',
        time: '2026-06-20T03:00:01.000Z',
      });
      __testSetSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });

      await handleYeaftLoadHistory({ sessionId: 'session-fast', limit: 1 });

      const firstHistoryIndex = sent.findIndex(m => m.type === 'yeaft_history_chunk' && m.mode === 'recent');
      let sessionReadyIndex = sent.findIndex(m => m.event?.type === 'session_ready');
      expect(firstHistoryIndex).toBeGreaterThanOrEqual(0);
      expect(sessionReadyIndex).toBe(-1);
      await new Promise(resolve => setTimeout(resolve, 0));
      sessionReadyIndex = sent.findIndex(m => m.event?.type === 'session_ready');
      expect(sessionReadyIndex).toBeGreaterThan(firstHistoryIndex);
      expect(sent[sessionReadyIndex]).toMatchObject({
        type: 'yeaft_output',
        sessionId: 'session-fast',
        event: { type: 'session_ready' },
      });
      expect(sent[firstHistoryIndex].messages.map(m => m.content)).toEqual([
        'ready recent user',
        'ready recent assistant',
      ]);
    } finally {
      __testSetSession(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ready-session delta replay uses the same projected frame shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-delta-ready-'));
    try {
      const store = new ConversationStore(dir);
      const anchor = store.append({
        role: 'user',
        content: 'already seen',
        sessionId: 'session-fast',
        time: '2026-06-20T02:00:00.000Z',
      });
      store.append({
        role: 'user',
        content: 'ready delta user',
        sessionId: 'session-fast',
        time: '2026-06-20T02:00:01.000Z',
        attachments: [{ fileId: 'file_2', name: 'diagram.png', isImage: true }],
      });
      store.append({
        role: 'assistant',
        content: 'ready delta assistant',
        sessionId: 'session-fast',
        speakerVpId: 'vp-martin',
        time: '2026-06-20T02:00:02.000Z',
        toolCalls: [{ id: 'toolu_2', name: 'WebSearch', input: { query: 'yeaft' } }],
      });
      store.append({
        role: 'tool',
        content: 'result',
        sessionId: 'session-fast',
        toolCallId: 'toolu_2',
        time: '2026-06-20T02:00:03.000Z',
      });
      __testSetSession({
        conversationStore: store,
        config: { model: 'test-model', availableModels: [] },
        status: { skills: 0, mcpServers: [], tools: 0 },
        taskManager: { listActiveTasks: () => [] },
      });

      await handleYeaftLoadHistory({ sessionId: 'session-fast', afterSeq: Number(anchor.id.slice(1)) });

      const chunk = sent.find(m => m.type === 'yeaft_history_chunk' && m.mode === 'delta');
      expect(chunk).toMatchObject({
        type: 'yeaft_history_chunk',
        sessionId: 'session-fast',
        mode: 'delta',
        afterSeq: Number(anchor.id.slice(1)),
        messages: [
          {
            role: 'user',
            content: 'ready delta user',
            ts: '2026-06-20T02:00:01.000Z',
            attachments: [{ fileId: 'file_2', name: 'diagram.png', isImage: true }],
          },
          {
            role: 'assistant',
            content: 'ready delta assistant',
            ts: '2026-06-20T02:00:02.000Z',
            speakerVpId: 'vp-martin',
            toolCalls: [{ id: 'toolu_2', name: 'WebSearch', input: { query: 'yeaft' } }],
          },
        ],
      });
      expect(chunk.messages).toHaveLength(2);
      expect(sent.filter(m => m.type === 'yeaft_output' && m.data)).toHaveLength(0);
      expect(sent.find(m => m.event?.type === 'history_loaded')?.event).toMatchObject({
        mode: 'delta',
        count: chunk.messages.length,
        sessionId: 'session-fast',
      });

      vi.useFakeTimers();
      const metadataDir = mkdtempSync(join(tmpdir(), 'yeaft-roster-metadata-'));
      try {
        ctx.CONFIG = { yeaftDir: metadataDir };
        vi.setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
        createSession(join(metadataDir, 'sessions'), {
          id: 'session-roster',
          name: 'Roster',
          roster: ['omni'],
          defaultVpId: 'omni',
        }).close();

        const cases = [
          [new Date('2026-07-29T11:00:00.000Z'), handleYeaftSessionAddMember, 'add_member', 'reviewer'],
          [new Date('2026-07-29T12:00:00.000Z'), handleYeaftSessionSetDefaultVp, 'set_default_vp', 'reviewer'],
          [new Date('2026-07-29T13:00:00.000Z'), handleYeaftSessionRemoveMember, 'remove_member', 'reviewer'],
        ];
        for (const [at, handler, op, vpId] of cases) {
          vi.setSystemTime(at);
          sent.length = 0;
          handler({ sessionId: 'session-roster', vpId, requestId: `request-${op}` });
          expect(sent).toContainEqual(expect.objectContaining({
            type: 'yeaft_output',
            event: expect.objectContaining({
              type: 'session_roster_changed',
              sessionId: 'session-roster',
              metadataUpdatedAt: at.toISOString(),
            }),
          }));
        }
      } finally {
        vi.useRealTimers();
        rmSync(metadataDir, { recursive: true, force: true });
      }
    } finally {
      __testSetSession(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps in-flight VP work alive across Session metadata updates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-metadata-runtime-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      createSession(join(dir, 'sessions'), {
        id: 'session-live',
        name: 'Live',
        announcement: 'before',
        roster: ['linus'],
        defaultVpId: 'linus',
      }).close();

      const cases = [
        [handleYeaftRenameSession, { sessionId: 'session-live', name: 'Renamed' }],
        [handleYeaftUpdateSession, {
          sessionId: 'session-live',
          patch: { announcement: 'after' },
        }],
        [handleYeaftSessionAddMember, { sessionId: 'session-live', vpId: 'martin' }],
        [handleYeaftSessionSetDefaultVp, { sessionId: 'session-live', vpId: 'martin' }],
      ];

      for (const [index, [handler, payload]] of cases.entries()) {
        const ctrl = new AbortController();
        const threadId = `metadata-${index}`;
        __testSeedAbortController(threadId, ctrl, 'session-live', 'linus');
        handler({ ...payload, requestId: `request-${index}` });
        expect(ctrl.signal.aborted).toBe(false);
        expect(__testGetRegisteredThreadIds()).toContain(threadId);
      }
    } finally {
      await __testResetVpState();
      ctx.CONFIG = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still aborts in-flight VP work when the Session is archived', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-archive-runtime-'));
    try {
      ctx.CONFIG = { yeaftDir: dir };
      createSession(join(dir, 'sessions'), {
        id: 'session-archive',
        name: 'Archive',
        roster: ['linus'],
        defaultVpId: 'linus',
      }).close();
      const ctrl = new AbortController();
      __testSeedAbortController('archive-thread', ctrl, 'session-archive', 'linus');

      handleYeaftArchiveSession({ sessionId: 'session-archive', requestId: 'request-archive' });

      expect(ctrl.signal.aborted).toBe(true);
      expect(__testGetRegisteredThreadIds()).not.toContain('archive-thread');
    } finally {
      await __testResetVpState();
      ctx.CONFIG = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
