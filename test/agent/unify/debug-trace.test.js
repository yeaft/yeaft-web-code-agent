import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DebugTrace, NullTrace, createTrace } from '../../../agent/unify/debug-trace.js';

const TEST_DB = join(tmpdir(), `yeaft-test-trace-${Date.now()}.db`);
let trace;

beforeEach(() => {
  trace = new DebugTrace(TEST_DB);
});

afterEach(() => {
  if (trace) trace.close();
  // Remove db and WAL files
  for (const suffix of ['', '-wal', '-shm']) {
    const path = TEST_DB + suffix;
    if (existsSync(path)) rmSync(path);
  }
});

describe('DebugTrace', () => {
  describe('startTurn + endTurn', () => {
    it('should create and complete a turn', () => {
      const turnId = trace.startTurn({ traceId: 't1', mode: 'chat', turnNumber: 1 });
      expect(turnId).toBeTruthy();

      trace.endTurn(turnId, {
        model: 'claude-sonnet-4',
        inputTokens: 100,
        outputTokens: 50,
        stopReason: 'end_turn',
        latencyMs: 500,
        responseText: 'Hello!',
      });

      const turns = trace.queryRecent(1);
      expect(turns).toHaveLength(1);
      expect(turns[0].id).toBe(turnId);
      expect(turns[0].trace_id).toBe('t1');
      expect(turns[0].model).toBe('claude-sonnet-4');
      expect(turns[0].input_tokens).toBe(100);
      expect(turns[0].output_tokens).toBe(50);
      expect(turns[0].stop_reason).toBe('end_turn');
      expect(turns[0].latency_ms).toBe(500);
      expect(turns[0].response_text).toBe('Hello!');
      expect(turns[0].ended_at).toBeTruthy();
    });
  });

  describe('logTool', () => {
    it('should log a tool call', () => {
      const turnId = trace.startTurn({ traceId: 't1' });
      const toolId = trace.logTool(turnId, {
        toolName: 'WebSearch',
        toolInput: '{"q":"test"}',
        toolOutput: 'results here',
        durationMs: 120,
        isError: false,
      });

      expect(toolId).toBeTruthy();

      const tools = trace.queryTools({ name: 'WebSearch' });
      expect(tools).toHaveLength(1);
      expect(tools[0].tool_name).toBe('WebSearch');
      expect(tools[0].tool_input).toBe('{"q":"test"}');
      expect(tools[0].duration_ms).toBe(120);
      expect(tools[0].is_error).toBe(0);
    });

    it('should truncate tool_output over 10KB', () => {
      const turnId = trace.startTurn({ traceId: 't1' });
      const longOutput = 'x'.repeat(20000);
      trace.logTool(turnId, {
        toolName: 'Bash',
        toolOutput: longOutput,
      });

      const tools = trace.queryTools({ name: 'Bash' });
      expect(tools[0].tool_output.length).toBeLessThan(11000);
      expect(tools[0].tool_output).toContain('... [truncated]');
    });
  });

  describe('logEvent', () => {
    it('should log a freeform event', () => {
      const eventId = trace.logEvent({
        traceId: 't1',
        eventType: 'compact',
        eventData: { before: 100, after: 50 },
      });

      expect(eventId).toBeTruthy();

      const result = trace.queryByTrace('t1');
      expect(result.events).toHaveLength(1);
      expect(result.events[0].event_type).toBe('compact');
      expect(JSON.parse(result.events[0].event_data)).toEqual({ before: 100, after: 50 });
    });
  });

  describe('queryByMessage', () => {
    it('should return turns for a message', () => {
      const t1 = trace.startTurn({ traceId: 'tr1', messageId: 'msg1' });
      trace.endTurn(t1, { model: 'm1' });

      const result = trace.queryByMessage('msg1');
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0].message_id).toBe('msg1');
    });
  });

  describe('queryByTrace', () => {
    it('should return all data for a trace', () => {
      const t1 = trace.startTurn({ traceId: 'tr1' });
      trace.endTurn(t1, { model: 'm1' });
      trace.logTool(t1, { toolName: 'Bash' });
      trace.logEvent({ traceId: 'tr1', eventType: 'start' });

      const result = trace.queryByTrace('tr1');
      expect(result.turns).toHaveLength(1);
      expect(result.tools).toHaveLength(1);
      expect(result.events).toHaveLength(1);
    });
  });

  describe('queryRecent', () => {
    it('should return turns in reverse chronological order', () => {
      trace.startTurn({ traceId: 'a' });
      trace.startTurn({ traceId: 'b' });
      trace.startTurn({ traceId: 'c' });

      const recent = trace.queryRecent(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].trace_id).toBe('c');
      expect(recent[1].trace_id).toBe('b');
    });
  });

  describe('search', () => {
    it('should find turns by response_text', () => {
      const t1 = trace.startTurn({ traceId: 'tr1' });
      trace.endTurn(t1, { responseText: 'Hello world from Claude' });

      const results = trace.search('Claude');
      expect(results).toHaveLength(1);
    });

    it('should find turns by tool_output', () => {
      const t1 = trace.startTurn({ traceId: 'tr1' });
      trace.logTool(t1, { toolName: 'Bash', toolOutput: 'npm install success' });

      const results = trace.search('npm install');
      expect(results).toHaveLength(1);
    });
  });

  describe('stats', () => {
    it('should return correct counts', () => {
      const t1 = trace.startTurn({ traceId: 'tr1' });
      trace.logTool(t1, { toolName: 'Bash' });
      trace.logEvent({ traceId: 'tr1', eventType: 'test' });

      const s = trace.stats();
      expect(s.turnCount).toBe(1);
      expect(s.toolCount).toBe(1);
      expect(s.eventCount).toBe(1);
      expect(s.dbSizeBytes).toBeGreaterThan(0);
    });
  });

  describe('cleanup', () => {
    it('should delete old data', () => {
      const t1 = trace.startTurn({ traceId: 'tr1' });
      trace.logTool(t1, { toolName: 'Bash' });
      trace.logEvent({ traceId: 'tr1', eventType: 'test' });

      // Cleanup with -1 days retention → cutoff is in the future → deletes everything
      const result = trace.cleanup(-1);
      expect(result.deletedTurns).toBe(1);
      expect(result.deletedTools).toBe(1);
      expect(result.deletedEvents).toBe(1);

      const s = trace.stats();
      expect(s.turnCount).toBe(0);
    });
  });

  describe('purge', () => {
    it('should delete all data', () => {
      trace.startTurn({ traceId: 'tr1' });
      trace.startTurn({ traceId: 'tr2' });
      trace.logEvent({ traceId: 'tr1', eventType: 'test' });

      trace.purge();
      const s = trace.stats();
      expect(s.turnCount).toBe(0);
      expect(s.eventCount).toBe(0);
    });
  });
});

describe('NullTrace', () => {
  it('should implement all methods as no-ops', () => {
    const nt = new NullTrace();
    expect(nt.startTurn()).toBe('null');
    expect(nt.endTurn()).toBeUndefined();
    expect(nt.logTool()).toBe('null');
    expect(nt.logEvent()).toBe('null');
    expect(nt.queryByMessage()).toEqual({ turns: [], tools: [], events: [] });
    expect(nt.queryByTrace()).toEqual({ turns: [], tools: [], events: [] });
    expect(nt.queryRecent()).toEqual([]);
    expect(nt.queryTools()).toEqual([]);
    expect(nt.search()).toEqual([]);
    expect(nt.stats()).toEqual({ turnCount: 0, toolCount: 0, eventCount: 0, dbSizeBytes: 0 });
    expect(nt.cleanup()).toEqual({ deletedTurns: 0, deletedTools: 0, deletedEvents: 0 });
    nt.purge();
    nt.close();
  });
});

describe('createTrace', () => {
  it('should return NullTrace when disabled', () => {
    const t = createTrace({ enabled: false });
    expect(t).toBeInstanceOf(NullTrace);
  });

  it('should return DebugTrace when enabled with dbPath', () => {
    const dbPath = join(tmpdir(), `yeaft-test-create-${Date.now()}.db`);
    const t = createTrace({ enabled: true, dbPath });
    expect(t).toBeInstanceOf(DebugTrace);
    t.close();
    // Cleanup
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (existsSync(p)) rmSync(p);
    }
  });
});
