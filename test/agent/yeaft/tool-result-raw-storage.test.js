import { describe, it, expect } from 'vitest';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { trimSnapshotForBudget } from '../../../agent/yeaft/history-compact.js';
import { __testAppendTurnToSessionHistory, __testGroupHistory } from '../../../agent/yeaft/web-bridge.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';

class MockAdapter {
  constructor() {
    this.responses = [];
    this.callLog = [];
  }

  pushResponse(events) {
    this.responses.push(events);
  }

  async *stream({ messages, system, tools }) {
    this.callLog.push({ messages, system, tools });
    const events = this.responses.shift();
    if (!events) throw new Error('No mock response configured');
    for (const event of events) yield event;
  }
}

class CapturingTrace extends NullTrace {
  constructor() {
    super();
    this.tools = [];
  }

  logTool(turnId, entry) {
    this.tools.push({ turnId, ...entry });
    return 'tool-trace';
  }
}

describe('tool result raw storage boundaries', () => {
  it('keeps tool_end/debug raw while truncating only the model tool message', async () => {
    const raw = 'x'.repeat(1500);
    const adapter = new MockAdapter();
    adapter.pushResponse([
      { type: 'tool_call', id: 'call_1', name: 'BigTool', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    adapter.pushResponse([
      { type: 'text_delta', text: 'done' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const trace = new CapturingTrace();
    const engine = new Engine({
      adapter,
      trace,
      config: { model: 'test-model', language: 'en' },
    });
    engine.registerTool({
      name: 'BigTool',
      description: 'returns a large result',
      parameters: { type: 'object', properties: {} },
      execute: async () => raw,
    });

    const events = [];
    for await (const event of engine.query({ prompt: 'run big tool' })) {
      events.push(event);
    }

    const toolEnd = events.find(e => e.type === 'tool_end');
    expect(toolEnd.output).toBe(raw);
    expect(trace.tools[0].toolOutput).toBe(raw);

    const secondCallToolMessage = adapter.callLog[1].messages.find(m => m.role === 'tool');
    expect(secondCallToolMessage.content).not.toBe(raw);
    expect(secondCallToolMessage.content).toContain('[truncated: BigTool returned');
    expect(secondCallToolMessage.content.length).toBeLessThan(raw.length);
  });

  it('ToolRegistry.execute returns raw normalized text', async () => {
    const raw = 'y'.repeat(1500);
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'BigRegistryTool',
      description: 'returns a large result',
      parameters: { type: 'object', properties: {} },
      execute: async () => raw,
    }));

    await expect(registry.execute('BigRegistryTool', {}, { config: { language: 'zh-CN' } })).resolves.toBe(raw);
  });

  it('keeps in-memory session history raw but truncates replay snapshot for the model', () => {
    const sessionId = `session_tool_raw_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const raw = 'z'.repeat(1500);
    __testAppendTurnToSessionHistory(
      sessionId,
      'main',
      'vp-linus',
      ['please run tool'],
      ['assistant text'],
      [{ id: 'call_1', name: 'BigTool', input: {} }],
      [{ role: 'tool', toolCallId: 'call_1', content: raw, isError: false }],
      [],
    );

    const historyToolMessage = __testGroupHistory(sessionId).find(m => m.role === 'tool');
    expect(historyToolMessage.content).toBe(raw);

    const replay = trimSnapshotForBudget(__testGroupHistory(sessionId), {
      messageTokenBudget: 100000,
      recentTurnCap: 10,
      keepToolTurns: 10,
      language: 'en',
    });
    const replayToolMessage = replay.find(m => m.role === 'tool');
    expect(replayToolMessage.content).not.toBe(raw);
    expect(replayToolMessage.content).toContain('[truncated: tool_result returned');
  });
});
