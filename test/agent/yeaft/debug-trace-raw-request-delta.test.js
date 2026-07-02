import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DebugTrace, reconstructDebugRawRequest } from '../../../agent/yeaft/debug-trace.js';

let trace;
let rootDir;

afterEach(async () => {
  try { await trace?.close(); } catch { /* ignore */ }
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  trace = null;
  rootDir = null;
});

function makeTrace() {
  rootDir = join(tmpdir(), `yeaft-debug-raw-delta-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  rmSync(rootDir, { recursive: true, force: true });
  trace = new DebugTrace(rootDir);
  return trace;
}

function readStoredTrace(sessionId) {
  const requestsDir = join(rootDir, 'sessions', sessionId, 'debug', 'requests');
  const [dir] = readdirSync(requestsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  return JSON.parse(readFileSync(join(requestsDir, dir, 'trace.json'), 'utf8'));
}

describe('DebugTrace raw request deltas', () => {
  it('stores raw request messages as append deltas and reconstructs copyable requests', async () => {
    const t = makeTrace();
    const first = t.startTurn({ traceId: 'req-1', turnNumber: 1, sessionId: 's1', userPrompt: 'work' });
    t.endTurn(first, {
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'work' }],
      rawRequest: {
        method: 'POST',
        url: 'https://llm.example/v1/responses',
        body: {
          model: 'm',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'work' }] }],
          stream: true,
        },
      },
      stopReason: 'tool_use',
    });
    const second = t.startTurn({ traceId: 'req-1', turnNumber: 2, sessionId: 's1', userPrompt: 'work' });
    t.endTurn(second, {
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: 'work' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'Bash', input: { command: 'pwd' } }] },
        { role: 'tool', toolCallId: 'call_1', content: '/tmp/project' },
      ],
      rawRequest: {
        method: 'POST',
        url: 'https://llm.example/v1/responses',
        body: {
          model: 'm',
          input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'work' }] },
            { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"pwd"}' },
            { type: 'function_call_output', call_id: 'call_1', output: '/tmp/project' },
          ],
          stream: true,
        },
      },
      stopReason: 'end_turn',
    });

    await t.close();
    const stored = readStoredTrace('s1');
    expect(stored.baseRequest.rawRequest).toBeNull();
    expect(stored.loops[0].requestDelta.rawRequestDelta.base.body.input).toHaveLength(1);
    expect(stored.loops[1].requestDelta.rawRequestDelta.body).toMatchObject({ messagesFrom: 1 });
    expect(stored.loops[1].requestDelta.rawRequestDelta.body).not.toHaveProperty('messages');

    const firstRequest = reconstructDebugRawRequest(null, stored.loops[0].requestDelta);
    const secondRequest = reconstructDebugRawRequest(firstRequest, stored.loops[1].requestDelta);
    expect(secondRequest.body.input).toHaveLength(3);
    expect(secondRequest.body.input[2]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });

    const detail = await t.fetchRecentDebugHistory({ sessionId: 's1', detailTurnId: 'req-1', dreamLimit: 0 });
    expect(detail.loops).toHaveLength(2);
    expect(detail.loops[0].rawRequest).toBeNull();
    expect(detail.loops[0].requestDelta.rawRequestDelta.base.body.input).toHaveLength(1);
  });
});
