/**
 * snapshot-filter.test.js — pins the VP-isolation contract for the
 * in-memory `baseSnapshot` projection used by `web-bridge.js` before
 * every VP turn.
 *
 * This is the table-driven test for `filterSnapshotForVp`. The function
 * is a pure projection (input array → filtered array), so the tests
 * compose snapshot fixtures and assert on the returned shape directly.
 *
 * Contract being pinned (mirrors persist.js#loadSessionHistoryForVp):
 *   - user rows: KEPT for every VP (no `speakerVpId` stamp).
 *   - this VP's assistant rows: KEPT intact (toolCalls + thinkingBlocks
 *     preserved so the VP's own tool arcs are not orphaned).
 *   - other VP's assistant rows: text KEPT, toolCalls + thinkingBlocks
 *     STRIPPED (signed thinking is VP-private; orphan tool_use ids 422
 *     the API).
 *   - this VP's `role:'tool'` rows: KEPT.
 *   - other VP's `role:'tool'` rows: DROPPED (their tool_use ids were
 *     stripped above; keeping the results would orphan them).
 *   - `_reflection` / `internal` / `systemOnly` rows: DROPPED.
 *   - Empty / no-vpId inputs: graceful (return copy or empty).
 *   - Unknown role: KEPT (forward-compat).
 *   - Reflection rows are filtered EVEN when vpId is missing.
 */
import { describe, it, expect } from 'vitest';
import { filterSnapshotForVp } from '../../../agent/yeaft/snapshot-filter.js';

describe('filterSnapshotForVp — VP-isolated baseSnapshot projection', () => {
  it('returns [] on empty input', () => {
    expect(filterSnapshotForVp([], 'vp-A')).toEqual([]);
    expect(filterSnapshotForVp(null, 'vp-A')).toEqual([]);
    expect(filterSnapshotForVp(undefined, 'vp-A')).toEqual([]);
  });

  it('user rows are kept for every VP (no speakerVpId stamp)', () => {
    const snapshot = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'world' },
    ];
    const outA = filterSnapshotForVp(snapshot, 'vp-A');
    const outB = filterSnapshotForVp(snapshot, 'vp-B');
    expect(outA.map(m => m.content)).toEqual(['hello', 'world']);
    expect(outB.map(m => m.content)).toEqual(['hello', 'world']);
  });

  it('own assistant rows are kept intact (toolCalls + thinkingBlocks preserved)', () => {
    const snapshot = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'using bash',
        speakerVpId: 'vp-A',
        toolCalls: [{ id: 'tu_A1', name: 'bash', input: { command: 'ls' } }],
        thinkingBlocks: [{ thinking: 'private', signature: 'sig-A' }],
      },
      {
        role: 'tool',
        toolCallId: 'tu_A1',
        content: 'file.txt\n',
        speakerVpId: 'vp-A',
      },
    ];
    const out = filterSnapshotForVp(snapshot, 'vp-A');
    expect(out).toHaveLength(3);
    expect(out[1].toolCalls).toEqual(snapshot[1].toolCalls);
    expect(out[1].thinkingBlocks).toEqual(snapshot[1].thinkingBlocks);
    expect(out[2].toolCallId).toBe('tu_A1');
  });

  it('OTHER VP assistant rows keep text but strip toolCalls + thinkingBlocks', () => {
    const snapshot = [
      {
        role: 'assistant',
        content: 'I ran bash to find it',
        speakerVpId: 'vp-A',
        toolCalls: [{ id: 'tu_A1', name: 'bash', input: { command: 'grep foo' } }],
        thinkingBlocks: [{ thinking: 'A-private reasoning', signature: 'sig-A' }],
      },
    ];
    const out = filterSnapshotForVp(snapshot, 'vp-B');
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('I ran bash to find it');
    expect(out[0].speakerVpId).toBe('vp-A');
    expect(out[0].toolCalls).toBeUndefined();
    expect(out[0].thinkingBlocks).toBeUndefined();
    // Source must NOT be mutated.
    expect(snapshot[0].toolCalls).toBeDefined();
    expect(snapshot[0].thinkingBlocks).toBeDefined();
  });

  it('OTHER VP role:tool rows are DROPPED (would orphan tool_use ids)', () => {
    const snapshot = [
      {
        role: 'assistant',
        content: 'using bash',
        speakerVpId: 'vp-A',
        toolCalls: [{ id: 'tu_A1', name: 'bash', input: { command: 'ls' } }],
      },
      {
        role: 'tool',
        toolCallId: 'tu_A1',
        content: 'file.txt\n',
        speakerVpId: 'vp-A',
      },
      { role: 'user', content: 'next' },
    ];
    const out = filterSnapshotForVp(snapshot, 'vp-B');
    expect(out.map(m => m.role)).toEqual(['assistant', 'user']);
    // The assistant kept (text-only) but the tool row was dropped.
    expect(out.find(m => m.role === 'tool')).toBeUndefined();
  });

  it('end-to-end: multi-VP transcript projected for vp-B has no orphan tool_use', () => {
    // VP-A ran bash; VP-B replied without tools. Build the snapshot
    // exactly as appendTurnToSessionHistory would, then project for
    // vp-B. The projection MUST NOT contain `tu_A1` anywhere.
    const snapshot = [
      { role: 'user', content: '@vp-A list files' },
      {
        role: 'assistant',
        content: 'ran ls',
        speakerVpId: 'vp-A',
        toolCalls: [{ id: 'tu_A1', name: 'bash', input: { command: 'ls' } }],
        thinkingBlocks: [{ thinking: 'A thought', signature: 'sig-A' }],
      },
      {
        role: 'tool',
        toolCallId: 'tu_A1',
        content: 'a.md\nb.md\n',
        speakerVpId: 'vp-A',
      },
      { role: 'user', content: '@vp-B summarize' },
      {
        role: 'assistant',
        content: 'summary text from B',
        speakerVpId: 'vp-B',
      },
    ];
    const out = filterSnapshotForVp(snapshot, 'vp-B');
    const json = JSON.stringify(out);
    expect(json).not.toContain('tu_A1');
    expect(json).not.toContain('sig-A');
    // The VP-A assistant text survives so VP-B has the conversational thread.
    expect(out.some(m => m.role === 'assistant' && m.content === 'ran ls')).toBe(true);
    // VP-B's own turn is kept intact.
    expect(out[out.length - 1].content).toBe('summary text from B');
  });

  it('drops _reflection / internal / systemOnly rows', () => {
    const snapshot = [
      { role: 'user', content: 'kept' },
      { role: 'assistant', content: 'reflection only', _reflection: true, speakerVpId: 'vp-A' },
      { role: 'assistant', content: 'internal only', internal: true, speakerVpId: 'vp-A' },
      { role: 'assistant', content: 'system only', systemOnly: true, speakerVpId: 'vp-A' },
      { role: 'assistant', content: 'systemOnlyMessage variant', systemOnlyMessage: true, speakerVpId: 'vp-A' },
      { role: 'assistant', content: 'real reply', speakerVpId: 'vp-A' },
    ];
    const out = filterSnapshotForVp(snapshot, 'vp-A');
    expect(out.map(m => m.content)).toEqual(['kept', 'real reply']);
  });

  it('also drops reflection/internal/systemOnly when vpId is missing (fail-open is content-safe)', () => {
    // Reading without a vpId means "give me everything visible" — but
    // engine-private reflection rows must still never leak.
    const snapshot = [
      { role: 'user', content: 'kept' },
      { role: 'assistant', content: 'reflection only', _reflection: true, speakerVpId: 'vp-A' },
      { role: 'assistant', content: 'real reply', speakerVpId: 'vp-A' },
    ];
    const out = filterSnapshotForVp(snapshot, null);
    expect(out.map(m => m.content)).toEqual(['kept', 'real reply']);
  });

  it('un-attributed (pre-rename) assistant rows are kept intact', () => {
    // Backward-compat: rows persisted before the speakerVpId stamp do
    // not have a speakerVpId; treating them as "own" preserves the
    // historical conversation rather than silently stripping it.
    const snapshot = [
      {
        role: 'assistant',
        content: 'pre-rename row',
        toolCalls: [{ id: 'tu_old', name: 'bash', input: {} }],
      },
      { role: 'tool', toolCallId: 'tu_old', content: 'result' },
    ];
    const out = filterSnapshotForVp(snapshot, 'vp-A');
    expect(out).toHaveLength(2);
    expect(out[0].toolCalls).toEqual(snapshot[0].toolCalls);
    expect(out[1].toolCallId).toBe('tu_old');
  });

  it('unknown role is preserved (forward-compat schema additions)', () => {
    const snapshot = [
      { role: 'user', content: 'q' },
      { role: 'system_notice', content: 'something new' },
      { role: 'assistant', content: 'reply', speakerVpId: 'vp-A' },
    ];
    const out = filterSnapshotForVp(snapshot, 'vp-A');
    expect(out).toHaveLength(3);
    expect(out[1].role).toBe('system_notice');
  });

  it('skips null / non-object entries gracefully', () => {
    const snapshot = [
      null,
      undefined,
      'a string',
      42,
      { role: 'user', content: 'kept' },
    ];
    const out = filterSnapshotForVp(snapshot, 'vp-A');
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('kept');
  });
});
