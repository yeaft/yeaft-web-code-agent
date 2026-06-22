import { describe, expect, it, vi } from 'vitest';
import { createPerfTraceId, recordPerfTrace, flushPerfTrace } from '../../web/stores/helpers/perfTrace.js';

describe('web perf trace helper', () => {
  it('queues sanitized events and flushes through websocket send', () => {
    vi.useFakeTimers();
    try {
      const sent = [];
      const store = {
        _perfTraceQueue: [],
        _perfTraceFlushTimer: null,
        sendWsMessage(msg) { sent.push(msg); },
      };

      recordPerfTrace(store, {
        traceId: 'pt-web-1',
        phase: 'send.prepare',
        sessionId: 'sess-1',
        detail: { text: 'secret', attachmentCount: 1 },
      });
      flushPerfTrace(store);

      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('perf_trace_events');
      expect(sent[0].events[0]).toMatchObject({
        traceId: 'pt-web-1',
        source: 'web',
        phase: 'send.prepare',
        sessionId: 'sess-1',
        detail: { attachmentCount: 1 },
      });
      expect(sent[0].events[0].detail.text).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates prefixed trace ids', () => {
    expect(createPerfTraceId()).toMatch(/^pt_/);
  });
});
