import { afterEach, describe, expect, it } from 'vitest';
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

    const detail = await trace.fetchTurnDebug({ sessionId, turnId: traceId });
    expect(detail.loops).toHaveLength(40);
    expect(detail.loops.map(loop => loop.response)).toEqual(
      Array.from({ length: 40 }, (_, index) => `response-${index + 1}`),
    );
    expect(detail.loops.at(-1).messages).toEqual(expectedMessages);
    expect(detail.loops.at(-1).rawRequest.body.messages).toEqual(expectedMessages);
    expect(await trace.stats()).toMatchObject({ turnCount: 40, requestCount: 1 });
    await trace.close();
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
