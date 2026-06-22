import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { __perfTraceForTest, flushPerfTraceEvents, recordPerfTraceEvent } from '../../server/perf-trace.js';

afterEach(() => {
  delete process.env.PERF_TRACE_DIR;
  delete process.env.PERF_TRACE_DISABLED;
  __perfTraceForTest.queue.splice(0, __perfTraceForTest.queue.length);
});

describe('server perf trace normalization', () => {
  it('drops prompt-like fields and truncates long strings', () => {
    const detail = __perfTraceForTest.sanitizeValue({
      prompt: 'secret prompt',
      text: 'secret text',
      token: 'secret token',
      phase: 'ok',
      nested: { content: 'secret content', safe: 'x'.repeat(600) },
    });

    expect(detail.prompt).toBeUndefined();
    expect(detail.text).toBeUndefined();
    expect(detail.token).toBeUndefined();
    expect(detail.nested.content).toBeUndefined();
    expect(detail.phase).toBe('ok');
    expect(detail.nested.safe).toContain('[truncated]');
    expect(detail.nested.safe.length).toBeLessThan(540);
  });

  it('normalizes trace identity and timing metadata', () => {
    const row = __perfTraceForTest.normalizeEvent({
      perfTraceId: 'pt-1',
      source: 'web',
      phase: 'send.prepare',
      at: 123,
      durationMs: 4.5,
      sessionId: 'sess-1',
      detail: { prompt: 'nope', attachmentCount: 2 },
    });

    expect(row).toMatchObject({
      traceId: 'pt-1',
      source: 'web',
      phase: 'send.prepare',
      at: 123,
      durationMs: 4.5,
      sessionId: 'sess-1',
    });
    expect(row.detail).toEqual({ attachmentCount: 2 });
    expect(typeof row.createdAt).toBe('string');
  });

  it('writes queued events to server-local jsonl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeaft-server-perf-'));
    process.env.PERF_TRACE_DIR = dir;
    try {
      expect(recordPerfTraceEvent({ traceId: 'pt-server-1', source: 'server', phase: 'relay.forward_to_agent' })).toBe(true);
      expect(flushPerfTraceEvents()).toBe(1);
      const day = new Date().toISOString().slice(0, 10);
      const row = JSON.parse(readFileSync(join(dir, `${day}.jsonl`), 'utf8').trim());
      expect(row).toMatchObject({
        traceId: 'pt-server-1',
        source: 'server',
        phase: 'relay.forward_to_agent',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
