import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { Engine } from '../../../agent/yeaft/engine.js';
import { DebugTrace, NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { trimSnapshotForBudget } from '../../../agent/yeaft/history-compact.js';
import { __testAppendTurnToSessionHistory, __testGroupHistory } from '../../../agent/yeaft/web-bridge.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import YeaftDebugPanel from '../../../web/components/YeaftDebugPanel.js';

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
    const raw = 'x'.repeat(12 * 1024);
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
    const toolExec = events.find(e => e.type === 'tool_exec');
    expect(toolExec.toolOutput).toBe(raw);
    expect(trace.tools[0].toolOutput).toBe(raw);
    expect(trace.tools[0].toolCallId).toBe('call_1');

    const secondCallToolMessage = adapter.callLog[1].messages.find(m => m.role === 'tool');
    expect(secondCallToolMessage.content).not.toBe(raw);
    expect(secondCallToolMessage.content).toContain('[truncated: BigTool returned');
    expect(secondCallToolMessage.content.length).toBeLessThan(raw.length);
  });

  it('ToolRegistry.execute returns raw normalized text', async () => {
    const raw = 'y'.repeat(12 * 1024);
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'BigRegistryTool',
      description: 'returns a large result',
      parameters: { type: 'object', properties: {} },
      execute: async () => raw,
    }));

    await expect(registry.execute('BigRegistryTool', {}, { config: { language: 'zh-CN' } })).resolves.toBe(raw);
  });


  it('persists debug trace tool output raw beyond 10KiB', () => {
    const dbPath = join(tmpdir(), `yeaft-tool-raw-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    const raw = 'r'.repeat(12 * 1024);
    const trace = new DebugTrace(dbPath);
    try {
      const turnId = trace.startTurn({ traceId: 'trace_raw_tool', turnNumber: 1, userPrompt: 'run tool' });
      const toolTraceId = trace.logTool(turnId, {
        toolName: 'LargeTool',
        toolCallId: 'call_raw',
        toolInput: '{}',
        toolOutput: raw,
        durationMs: 3,
        isError: false,
      });

      const { tools } = trace.queryByTrace('trace_raw_tool');
      const row = tools.find(t => t.id === toolTraceId);
      expect(row.tool_output).toBe(raw);
      expect(row.tool_output).not.toContain('[truncated]');
      expect(row.tool_call_id).toBe('call_raw');
    } finally {
      trace.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
      }
    }
  });

  it('copies raw debug tool output before falling back to truncated model messages', () => {
    const copied = [];
    const ctx = {
      ...YeaftDebugPanel.methods,
      copyText(text, label) {
        copied.push({ text, label });
      },
    };
    const turn = {
      loops: [{ messages: [{ role: 'tool', toolCallId: 'call_1', content: 'truncated output' }] }],
    };

    YeaftDebugPanel.methods.copyToolOutput.call(ctx, turn, {
      callId: 'call_1',
      toolOutput: 'raw output',
    });
    expect(copied.at(-1)).toEqual({ text: 'raw output', label: 'tool output' });

    YeaftDebugPanel.methods.copyToolOutput.call(ctx, turn, { callId: 'call_1' });
    expect(copied.at(-1)).toEqual({ text: 'truncated output', label: 'tool output' });
  });

  it('renders pending tool calls before their results arrive', () => {
    const ctx = {
      ...YeaftDebugPanel.methods,
      $t(key) {
        return {
          'yeaft.debugToolRunning': 'running',
          'yeaft.debugToolRunningNoResult': 'Running; no result yet',
        }[key] || key;
      },
    };
    const loop = {
      loopNumber: 66,
      toolCalls: [
        { id: 'call_glob', name: 'Glob', input: { pattern: '**/*.js' } },
        { id: 'call_grep', name: 'Grep', input: { pattern: 'needle' } },
        { id: 'call_read', name: 'FileRead', input: { file_path: 'README.md' } },
      ],
    };
    const turn = {
      turnId: 'turn_1',
      loops: [loop],
      tools: [
        { loopNumber: 66, callId: 'call_glob', name: 'Glob', durationMs: 12, isError: false, toolOutput: 'glob ok' },
        { loopNumber: 66, callId: 'call_grep', name: 'Grep', durationMs: 5, isError: true, toolOutput: 'grep failed' },
      ],
    };

    const rows = YeaftDebugPanel.methods.toolsForLoop.call(ctx, turn, loop);
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.name)).toEqual(['Glob', 'Grep', 'FileRead']);
    expect(rows[0]).toMatchObject({ hasResult: true, isRunning: false, isError: false, toolOutput: 'glob ok' });
    expect(rows[1]).toMatchObject({ hasResult: true, isRunning: false, isError: true, toolOutput: 'grep failed' });
    expect(rows[2]).toMatchObject({ callId: 'call_read', hasResult: false, isRunning: true, isError: false });
    expect(YeaftDebugPanel.methods.toolInputText.call(ctx, rows[2])).toContain('README.md');
    expect(YeaftDebugPanel.methods.toolOutputText.call(ctx, rows[2])).toBe('Running; no result yet');
  });

  it('does not attach same-name results to the wrong pending call', () => {
    const ctx = {
      ...YeaftDebugPanel.methods,
      $t(key) {
        return {
          'yeaft.debugToolRunningNoResult': 'Running; no result yet',
        }[key] || key;
      },
    };
    const loop = {
      loopNumber: 7,
      toolCalls: [
        { id: 'call_a', name: 'FileRead', input: { file_path: 'a.md' } },
        { id: 'call_b', name: 'FileRead', input: { file_path: 'b.md' } },
        { id: 'call_c', name: 'FileRead', input: { file_path: 'c.md' } },
      ],
    };
    const turn = {
      turnId: 'turn_same_name',
      loops: [loop],
      tools: [
        { loopNumber: 7, callId: 'call_b', name: 'FileRead', durationMs: 11, isError: false, toolOutput: 'b output' },
        { loopNumber: 7, callId: 'call_c', name: 'FileRead', durationMs: 13, isError: true, toolOutput: 'c error' },
      ],
    };

    const rows = YeaftDebugPanel.methods.toolsForLoop.call(ctx, turn, loop);
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.callId)).toEqual(['call_a', 'call_b', 'call_c']);
    expect(rows[0]).toMatchObject({ isRunning: true, hasResult: false, toolOutput: null });
    expect(YeaftDebugPanel.methods.toolOutputText.call(ctx, rows[0])).toBe('Running; no result yet');
    expect(rows[1]).toMatchObject({ isRunning: false, isError: false, toolOutput: 'b output' });
    expect(rows[2]).toMatchObject({ isRunning: false, isError: true, toolOutput: 'c error' });
  });

  it('tracks tool detail expansion by turn loop and call id', () => {
    const ctx = {
      ...YeaftDebugPanel.methods,
      expandedToolDetails: {},
    };
    const tool = { callId: 'call_1', name: 'Glob' };
    expect(YeaftDebugPanel.methods.isToolDetailExpanded.call(ctx, 'turn_1', 2, tool, 0)).toBe(false);
    YeaftDebugPanel.methods.toggleToolDetail.call(ctx, 'turn_1', 2, tool, 0);
    expect(YeaftDebugPanel.methods.isToolDetailExpanded.call(ctx, 'turn_1', 2, tool, 0)).toBe(true);
  });

  it('keeps in-memory session history raw but truncates replay snapshot for the model', () => {
    const sessionId = `session_tool_raw_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const raw = 'z'.repeat(12 * 1024);
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
