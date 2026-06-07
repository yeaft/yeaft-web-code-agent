/**
 * web-bridge-append-turn-vp-stamp.test.js — pins the `speakerVpId` stamp
 * contract written by `appendTurnToSessionHistory`.
 *
 * Without this stamp, the in-memory baseSnapshot filter
 * (`filterSnapshotForVp`) cannot tell whose `toolCalls` and
 * `thinkingBlocks` belong to whom, and the next VP turn inherits the
 * previous VP's tool_use ids without matching tool_result rows →
 * Anthropic API 422.
 *
 * Contract:
 *   1. User rows: NEVER stamped (every VP must see prompts).
 *   2. Assistant rows: stamped with `speakerVpId`.
 *   3. role:'tool' rows: stamped with `speakerVpId`.
 *   4. `vpId` falsy: assistant + tool rows are appended WITHOUT a stamp
 *      (back-compat with un-attributed history; the filter treats
 *      unstamped rows as "own" for whichever VP is reading).
 *   5. Thinking blocks survive the round-trip on the stamped row.
 *   6. Two consecutive turns from two different VPs produce a history
 *      where each VP's `speakerVpId` is on its own turn only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  __testAppendTurnToSessionHistory,
  __testGroupHistory,
  __testResetVpState,
  __testSetSession,
} from '../../../agent/yeaft/web-bridge.js';

afterEach(async () => {
  __testSetSession(null);
  await __testResetVpState();
});

describe('appendTurnToSessionHistory — speakerVpId stamp contract', () => {
  it('stamps assistant + tool rows; leaves user rows un-stamped', () => {
    const sessionId = 'grp_stamp_basic';
    __testAppendTurnToSessionHistory(
      sessionId,
      'main',
      'vp-A',
      ['user prompt'],
      ['assistant reply'],
      [{ id: 'tu_1', name: 'bash', input: { command: 'ls' } }],
      [{ toolCallId: 'tu_1', content: 'file.txt\n', isError: false }],
      [],
    );

    const hist = __testGroupHistory(sessionId);
    expect(hist.map(m => m.role)).toEqual(['user', 'assistant', 'tool']);

    const [u, a, t] = hist;
    expect(u.speakerVpId).toBeUndefined();
    expect(a.speakerVpId).toBe('vp-A');
    expect(a.toolCalls).toEqual([{ id: 'tu_1', name: 'bash', input: { command: 'ls' } }]);
    expect(t.speakerVpId).toBe('vp-A');
    expect(t.toolCallId).toBe('tu_1');
  });

  it('does NOT stamp when vpId is falsy (back-compat with un-attributed history)', () => {
    const sessionId = 'grp_stamp_novpid';
    __testAppendTurnToSessionHistory(
      sessionId,
      'main',
      null,            // no VP context
      ['prompt'],
      ['reply'],
      [{ id: 'tu_x', name: 'bash', input: {} }],
      [{ toolCallId: 'tu_x', content: 'ok', isError: false }],
      [],
    );

    const hist = __testGroupHistory(sessionId);
    expect(hist).toHaveLength(3);
    for (const m of hist) {
      expect(m.speakerVpId).toBeUndefined();
    }
  });

  it('round-trips thinkingBlocks on the stamped assistant row', () => {
    const sessionId = 'grp_stamp_thinking';
    const blocks = [
      { thinking: 'private reasoning A', signature: 'sig-A1' },
      { thinking: 'more', signature: 'sig-A2' },
    ];
    __testAppendTurnToSessionHistory(
      sessionId,
      'main',
      'vp-A',
      ['q'],
      ['a'],
      [],
      [],
      blocks,
    );

    const hist = __testGroupHistory(sessionId);
    const assistant = hist.find(m => m.role === 'assistant');
    expect(assistant.speakerVpId).toBe('vp-A');
    expect(assistant.thinkingBlocks).toEqual(blocks);
  });

  it('two VPs in the same session keep their stamps separate', () => {
    const sessionId = 'grp_stamp_multi';
    __testAppendTurnToSessionHistory(
      sessionId,
      'main',
      'vp-A',
      ['@vp-A do X'],
      ['A reply'],
      [{ id: 'tu_A', name: 'bash', input: {} }],
      [{ toolCallId: 'tu_A', content: 'A out', isError: false }],
      [],
    );
    __testAppendTurnToSessionHistory(
      sessionId,
      'main',
      'vp-B',
      ['@vp-B summarize'],
      ['B reply'],
      [],
      [],
      [],
    );

    const hist = __testGroupHistory(sessionId);
    expect(hist.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);

    // user rows: no stamp at any position
    expect(hist[0].speakerVpId).toBeUndefined();
    expect(hist[3].speakerVpId).toBeUndefined();

    // VP-A's assistant + tool: stamped A
    expect(hist[1].speakerVpId).toBe('vp-A');
    expect(hist[2].speakerVpId).toBe('vp-A');

    // VP-B's assistant: stamped B
    expect(hist[4].speakerVpId).toBe('vp-B');
  });

  it('skips assistant row entirely when text empty AND no tool calls', () => {
    // Empty-turn defensive case — the appender only pushes when there's
    // either text or tool calls. User row still goes in.
    const sessionId = 'grp_stamp_empty';
    __testAppendTurnToSessionHistory(
      sessionId,
      'main',
      'vp-A',
      ['just a prompt'],
      [''],
      [],
      [],
      [],
    );
    const hist = __testGroupHistory(sessionId);
    expect(hist.map(m => m.role)).toEqual(['user']);
  });

  it('threads multiple user prompts in one call into separate user rows', () => {
    const sessionId = 'grp_stamp_multiuser';
    __testAppendTurnToSessionHistory(
      sessionId,
      'main',
      'vp-A',
      ['first', 'second', '  '], // whitespace-only is filtered
      ['ok'],
      [],
      [],
      [],
    );
    const hist = __testGroupHistory(sessionId);
    expect(hist.map(m => m.role)).toEqual(['user', 'user', 'assistant']);
    expect(hist[0].content).toBe('first');
    expect(hist[1].content).toBe('second');
    expect(hist[0].speakerVpId).toBeUndefined();
    expect(hist[1].speakerVpId).toBeUndefined();
    expect(hist[2].speakerVpId).toBe('vp-A');
  });
});
