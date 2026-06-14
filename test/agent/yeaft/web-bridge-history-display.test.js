import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn(),
}));

const { __testHooks } = await import('../../../agent/yeaft/web-bridge.js');

describe('Yeaft web bridge history display projection', () => {
  it('keeps persisted history entries full for LLM hydration', () => {
    const full = 'tool-output-'.repeat(200);

    const entry = __testHooks.projectPersistedToHistoryEntry({
      id: 'm0001',
      role: 'tool',
      content: full,
      toolCallId: 'call-1',
      sessionId: 'session-1',
    });

    expect(entry.content).toBe(full);
  });

  it('truncates tool output only for visible history display', () => {
    const full = 'tool-output-'.repeat(200);

    const entry = __testHooks.projectPersistedToVisibleHistoryEntry({
      id: 'm0001',
      role: 'tool',
      content: full,
      toolCallId: 'call-1',
      sessionId: 'session-1',
    });

    expect(entry.content.length).toBeLessThan(full.length);
    expect(entry.content).toContain('history display truncated');
    expect(entry.content).toContain('persisted storage keep the full result');
  });
});
