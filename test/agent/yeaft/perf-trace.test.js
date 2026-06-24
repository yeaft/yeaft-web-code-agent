import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { __perfTraceForTest, recordAgentPerfTrace } from '../../../agent/yeaft/perf-trace.js';

describe('agent perf trace', () => {
  it('removes jsonl files older than the retention window', () => {
    const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-perf-retention-'));
    const traceDir = join(yeaftDir, 'perf-traces');
    try {
      mkdirSync(traceDir, { recursive: true });
      writeFileSync(join(traceDir, '2000-01-01.jsonl'), '{}\n');
      writeFileSync(join(traceDir, new Date().toISOString().slice(0, 10) + '.jsonl'), '{}\n');
      __perfTraceForTest.cleanupOldTraceFiles(traceDir);
      expect(existsSync(join(traceDir, '2000-01-01.jsonl'))).toBe(false);
      expect(existsSync(join(traceDir, new Date().toISOString().slice(0, 10) + '.jsonl'))).toBe(true);
    } finally {
      rmSync(yeaftDir, { recursive: true, force: true });
    }
  });

  it('writes jsonl events under the local yeaft directory without prompt bodies', () => {
    const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-perf-trace-'));
    try {
      const ok = recordAgentPerfTrace({ yeaftDir }, {
        traceId: 'pt-agent-1',
        phase: 'vp.engine_complete',
        durationMs: 12.5,
        sessionId: 'sess-1',
        vpId: 'vp-1',
        turnId: 'turn-1',
        detail: { prompt: 'do not persist', toolCallCount: 3 },
      });

      expect(ok).toBe(true);
      const day = new Date().toISOString().slice(0, 10);
      const row = JSON.parse(readFileSync(join(yeaftDir, 'perf-traces', `${day}.jsonl`), 'utf8').trim());
      expect(row).toMatchObject({
        traceId: 'pt-agent-1',
        source: 'agent',
        phase: 'vp.engine_complete',
        durationMs: 12.5,
        sessionId: 'sess-1',
        vpId: 'vp-1',
        turnId: 'turn-1',
      });
      expect(row.detail).toEqual({ toolCallCount: 3 });
    } finally {
      rmSync(yeaftDir, { recursive: true, force: true });
    }
  });
});
