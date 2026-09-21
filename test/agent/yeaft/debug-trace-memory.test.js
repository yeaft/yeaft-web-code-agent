import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DebugTrace } from '../../../agent/yeaft/debug-trace.js';

const roots = [];

async function traceRoot() {
  const root = await mkdtemp(join(tmpdir(), 'yeaft-debug-memory-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('DebugTrace active payload release', () => {
  it('keeps flushed active loops lossless on disk while continuing from the latest snapshot', async () => {
    const root = await traceRoot();
    const archived = JSON.stringify([{ eventType: 'dream_progress', eventData: { body: 'archived Dream' } }]);
    await fs.writeFile(join(root, 'events.json'), archived);
    const trace = new DebugTrace(root);
    const sessionId = 'memory-session';
    const traceId = 'memory-turn';
    const expectedMessages = [];

    for (let loopNumber = 1; loopNumber <= 40; loopNumber += 1) {
      expectedMessages.push({ role: 'user', content: `message-${loopNumber}-${'x'.repeat(2_000)}` });
      const turn = trace.startTurn({ traceId, sessionId, turnNumber: loopNumber });
      trace.endTurn(turn, {
        messages: expectedMessages,
        systemPrompt: `system-${loopNumber}`,
        rawRequest: { body: { messages: expectedMessages, model: 'test-model' } },
        responseText: `response-${loopNumber}`,
        model: 'test-model',
        usage: { inputTokens: loopNumber, outputTokens: 1 },
        stopReason: loopNumber === 40 ? 'end_turn' : 'tool_use',
      });
      await trace.flush();
    }

    trace.event('dream_progress', { sessionId, phase: 'done', body: 'retired Dream output' });
    const history = await trace.fetchRecentDebugHistory({ sessionId, dreamLimit: 50 });
    expect(history.dreamEvents).toEqual([]);
    expect((await trace.fetchTurnDebug({ sessionId, turnId: traceId, dreamLimit: 50 })).dreamEvents).toEqual([]);
    const detail = await trace.fetchTurnDebug({ sessionId, turnId: traceId });
    expect(detail.loops).toHaveLength(40);
    expect(detail.loops.map(loop => loop.response)).toEqual(
      Array.from({ length: 40 }, (_, index) => `response-${index + 1}`),
    );
    expect(detail.loops.at(-1).messages).toEqual(expectedMessages);
    expect(detail.loops.at(-1).rawRequest.body.messages).toEqual(expectedMessages);
    expect(await trace.stats()).toMatchObject({ turnCount: 40, requestCount: 1 });
    expect(await trace.search('response-17')).toHaveLength(40);
    await trace.close();
    expect(await readFile(join(root, 'events.json'), 'utf8')).toBe(archived);
    const readSpy = vi.spyOn(fs, 'readFile');
    const reopened = new DebugTrace(root);
    try {
      await reopened.stats();
      await reopened.fetchRecentDebugHistory({ dreamLimit: 50 });
      await reopened.close();
      expect(readSpy.mock.calls.some(([path]) => String(path) === join(root, 'events.json'))).toBe(false);
    } finally { readSpy.mockRestore(); }
  });

  it('retains unpersisted diagnostic payload when opening the event log fails', async () => {
    const root = await traceRoot();
    const writer = new DebugTrace(root);
    const open = vi.spyOn(fs, 'open').mockRejectedValueOnce(new Error('simulated disk failure'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const turn = writer.startTurn({ sessionId: 'failed-write', traceId: 'failed-turn', turnNumber: 1 });
      writer.endTurn(turn, {
        messages: [{ role: 'user', content: 'request before disk failure' }],
        rawRequest: { body: 'complete request' },
        rawResponse: { body: 'complete response' },
        responseText: 'still available',
        stopReason: 'tool_use',
      });
      await writer.flush();
      expect(open).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('[Yeaft] debug trace append failed:', 'simulated disk failure');
      const detail = await writer.fetchTurnDebug({ sessionId: 'failed-write', turnId: 'failed-turn' });
      expect(detail.loops).toHaveLength(1);
      expect(detail.loops[0]).toMatchObject({
        response: 'still available',
        rawRequest: { body: 'complete request' },
        rawResponse: { body: 'complete response' },
      });
    } finally {
      open.mockRestore();
      warn.mockRestore();
      await writer.close();
    }
  });

  it('merges durable detail with a failed append without hiding loops or tools', async () => {
    const root = await traceRoot();
    const writer = new DebugTrace(root);
    const identity = { sessionId: 'mixed-write', traceId: 'mixed-turn' };
    const messages = [{ role: 'user', content: 'first request' }];
    const first = writer.startTurn({ ...identity, turnNumber: 1 });
    writer.endTurn(first, { messages, responseText: 'persisted response', stopReason: 'tool_use' });
    writer.logTool(first, { toolName: 'Inspect', toolOutput: 'persisted output' });
    await writer.flush();

    const open = vi.spyOn(fs, 'open').mockRejectedValueOnce(new Error('later append failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      messages.push({ role: 'user', content: 'second request' });
      const second = writer.startTurn({ ...identity, turnNumber: 2 });
      writer.endTurn(second, { messages, responseText: 'unwritten response', stopReason: 'tool_use' });
      writer.logTool(second, { toolName: 'Inspect', toolOutput: 'unwritten output' });
      await writer.flush();
      expect(warn).toHaveBeenCalledWith('[Yeaft] debug trace append failed:', 'later append failed');
      const detail = await writer.fetchTurnDebug({ sessionId: identity.sessionId, turnId: identity.traceId });
      expect(detail.loops.map(loop => loop.response)).toEqual(['persisted response', 'unwritten response']);
      expect(detail.loops[1].messages).toEqual(messages);
      const tools = await writer.queryTools({ name: 'Inspect' });
      expect(tools.map(tool => tool.tool_output).sort()).toEqual(['persisted output', 'unwritten output']);
      expect(await writer.search('unwritten response')).toHaveLength(2);
      expect(await writer.search('persisted response')).toHaveLength(2);
    } finally {
      open.mockRestore();
      warn.mockRestore();
      await writer.close();
    }
  });

  it.each(['first', 'middle', 'partial'])('replays a %s append failure before finalize and survives restart', async (failure) => {
    const root = await traceRoot();
    const writer = new DebugTrace(root);
    const identity = { sessionId: 'replay-session', traceId: 'replay-turn' };
    const messages = [];
    const append = (number) => {
      messages.push({ role: 'user', content: `request-${number}` });
      const turn = writer.startTurn({ ...identity, turnNumber: number });
      writer.endTurn(turn, {
        messages, rawRequest: { body: { messages } },
        rawResponse: { body: `raw-${number}` },
        responseText: `response-${number}`, stopReason: 'tool_use',
      });
      writer.logTool(turn, { toolName: 'Inspect', toolInput: `input-${number}`, toolOutput: `output-${number}` });
    };
    if (failure !== 'first') { append(1); await writer.flush(); }
    const originalOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, 'open');
    if (failure === 'partial') {
      open.mockImplementationOnce(async (...args) => {
        const handle = await originalOpen(...args);
        const write = handle.writeFile.bind(handle);
        let calls = 0;
        handle.writeFile = async (text, ...rest) => {
          if (++calls === 2) {
            await write(text.slice(0, 25), ...rest);
            throw new Error('simulated partial append');
          }
          return write(text, ...rest);
        };
        return handle;
      });
    } else open.mockRejectedValueOnce(new Error('simulated append failure'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failedNumber = failure === 'first' ? 1 : 2;
      append(failedNumber);
      await writer.flush();
      expect(warn).toHaveBeenCalled();
      // The retry can fail too: it must retain both prior and newer deltas.
      open.mockRejectedValueOnce(new Error('retry failed'));
      append(failedNumber + 1);
      await writer.flush();
      open.mockRestore();
      writer.finalizeQuery(identity.traceId, { sessionId: identity.sessionId });
      await writer.close();

      const reader = new DebugTrace(root);
      try {
        const detail = await reader.fetchTurnDebug({ sessionId: identity.sessionId, turnId: identity.traceId });
        const numbers = Array.from({ length: failedNumber + 1 }, (_, i) => i + 1);
        expect(detail.loops.map(loop => loop.response)).toEqual(numbers.map(i => `response-${i}`));
        expect(detail.loops.map(loop => loop.rawResponse.body)).toEqual(numbers.map(i => `raw-${i}`));
        expect(detail.loops.at(-1).messages).toEqual(messages);
        expect(detail.loops.at(-1).rawRequest.body.messages).toEqual(messages);
        const tools = await reader.queryTools({ name: 'Inspect' });
        expect(tools.map(tool => tool.tool_output).sort()).toEqual(numbers.map(i => `output-${i}`));
        expect(await reader.stats()).toMatchObject({ requestCount: 1, turnCount: numbers.length, toolCount: numbers.length });
        const index = await reader.fetchRecentDebugHistory({ sessionId: identity.sessionId, indexOnly: true });
        expect(index.turns[0]).toMatchObject({ loopCount: numbers.length });
        const requestsDir = join(root, 'sessions', identity.sessionId, 'debug', 'requests');
        const [requestKey] = await fs.readdir(requestsDir);
        const meta = JSON.parse(await readFile(join(requestsDir, requestKey, 'meta.json'), 'utf8'));
        expect(meta).toMatchObject({ active: false, finalStopReason: 'end_turn', loopCount: numbers.length, toolCount: numbers.length });
        expect(meta).not.toHaveProperty('_failedAppend');
      } finally { await reader.close(); }
    } finally {
      open.mockRestore();
      warn.mockRestore();
      await writer.close();
    }
  });

  it('retries an otherwise idle failed append once at close', async () => {
    const root = await traceRoot();
    const writer = new DebugTrace(root);
    const open = vi.spyOn(fs, 'open').mockRejectedValueOnce(new Error('temporary disk failure'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const turn = writer.startTurn({ sessionId: 'close-session', traceId: 'close-turn', turnNumber: 1 });
      writer.endTurn(turn, { messages: [{ role: 'user', content: 'keep me' }], responseText: 'durable after close' });
      await writer.flush();
      expect(warn).toHaveBeenCalled();
      open.mockRestore();
      await writer.close();
      const reader = new DebugTrace(root);
      try {
        const detail = await reader.fetchTurnDebug({ sessionId: 'close-session', turnId: 'close-turn' });
        expect(detail.loops).toHaveLength(1);
        expect(detail.loops[0].response).toBe('durable after close');
      } finally { await reader.close(); }
    } finally {
      open.mockRestore();
      warn.mockRestore();
      await writer.close();
    }
  });

  it('persists terminal metadata and tools that arrive after the stop reason across restart', async () => {
    const root = await traceRoot();
    const sessionId = 'late-tool-session';
    const traceId = 'late-tool-turn';
    const writer = new DebugTrace(root);
    const turn = writer.startTurn({ traceId, sessionId, turnNumber: 1, userPrompt: 'inspect' });
    writer.endTurn(turn, {
      messages: [{ role: 'user', content: 'inspect' }],
      responseText: 'done',
      model: 'terminal-model',
      stopReason: 'end_turn',
    });
    writer.logTool(turn, {
      toolName: 'LateTool',
      toolCallId: 'late-call',
      toolInput: 'full-input',
      toolOutput: `full-output-${'z'.repeat(20_000)}`,
      durationMs: 17,
    });
    await writer.flush();
    const liveTools = await writer.queryTools({ name: 'LateTool' });
    expect(liveTools).toHaveLength(1);
    expect(liveTools[0].tool_output).toContain('z'.repeat(20_000));
    await writer.close();

    const reader = new DebugTrace(root);
    const index = await reader.fetchRecentDebugHistory({ sessionId, indexOnly: true });
    expect(index.turns[0]).toMatchObject({
      turnId: traceId,
      loopCount: 1,
      detailsLoaded: false,
      tools: [],
    });
    const detail = await reader.fetchTurnDebug({ sessionId, turnId: traceId });
    expect(detail.turns[0].tools).toEqual([
      expect.objectContaining({ name: 'LateTool', callId: 'late-call', toolInput: 'full-input' }),
    ]);
    expect(detail.turns[0].tools[0].toolOutput).toContain('z'.repeat(20_000));
    expect(await reader.stats()).toMatchObject({ turnCount: 1, toolCount: 1, requestCount: 1 });

    const requestDirs = join(root, 'sessions', sessionId, 'debug', 'requests');
    const { readdir } = await import('node:fs/promises');
    const [requestKey] = await readdir(requestDirs);
    const events = await readFile(join(requestDirs, requestKey, 'events.jsonl'), 'utf8');
    expect(events.match(/"type":"loop"/g)).toHaveLength(1);
    expect(events.match(/"type":"tool"/g)).toHaveLength(1);
    expect(events).toContain('full-output-');
    await reader.close();
  });
});
