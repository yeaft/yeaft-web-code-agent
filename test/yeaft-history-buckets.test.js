import { describe, expect, it } from 'vitest';
import { buildHistoryBuckets, estimateMessagesTokens, trimSnapshotForBudget } from '../agent/yeaft/history-window.js';
import { hasOrphanPairs } from '../agent/yeaft/pair-sanitize.js';

function turn(seq, text = `question ${seq}`, answer = `answer ${seq}`) {
  return [
    { id: `m${seq}`, seq, role: 'user', content: text },
    { id: `m${seq + 1}`, seq: seq + 1, role: 'assistant', content: answer },
  ];
}
function run(past, options = {}, current = { id: 'm10000', seq: 10000, role: 'user', content: 'current' }) {
  return buildHistoryBuckets([...past, current], { currentTurnStartIndex: past.length, ...options });
}
function users(result) { return result.messages.filter(message => message.role === 'user').map(message => message.id); }

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe('dual-bucket provider history', () => {
  it('keeps 20 past turns by default, separately protecting the current turn', () => {
    const past = Array.from({ length: 25 }, (_, i) => turn(i * 10)).flat();
    const result = run(past);
    expect(result.meta.recent.turnCount).toBe(20);
    expect(result.meta.related.turnCount).toBe(0);
    expect(users(result)).toEqual([...Array.from({ length: 20 }, (_, i) => `m${(i + 5) * 10}`), 'm10000']);
    expect(result.meta.current.startIndex).toBe(past.length);
    expect(typeof trimSnapshotForBudget).toBe('function');
  });

  it('never merges separate questions by equal text, including VP mentions without IDs', () => {
    const past = [...turn(10, 'same'), ...turn(20, 'same'), ...turn(30, 'same')];
    expect(users(run(past, { recentTurnCap: 2 }))).toEqual(['m20', 'm30', 'm10000']);
    const anonymous = [{ role: 'user', content: '@vp-a same' }, { role: 'assistant', content: 'a' },
      { role: 'user', content: '@vp-b same' }, { role: 'assistant', content: 'b' }];
    expect(run(anonymous).meta.recent.turnCount).toBe(2);
    expect(run(anonymous).meta.dropped.pastTurnCount).toBe(0);
  });

  it('groups stable client fan-out identity and preserves every VP and intermediate assistant text', () => {
    const past = [
      { role: 'user', id: 'm1', clientMessageId: 'client-one', content: '@vp-a question' },
      { role: 'assistant', id: 'm2', speakerVpId: 'a', content: 'A step' },
      { role: 'assistant', id: 'm3', speakerVpId: 'b', content: 'B reply' },
      { role: 'user', id: 'm4', clientMessageId: 'client-one', content: '@vp-b question' },
      { role: 'assistant', id: 'm5', speakerVpId: 'a', content: 'A final' },
      { role: 'user', id: 'm6', internal: true, content: '[system note] internal' },
    ];
    const result = run(past, { recentTurnCap: 1 });
    expect(result.meta.recent.turnCount).toBe(1);
    expect(result.messages.filter(row => row.role === 'assistant').map(row => row.content))
      .toEqual(['A step', 'B reply', 'A final']);
    expect(result.messages.some(row => row.id === 'm6')).toBe(false);
    const budget = estimateMessagesTokens(result.messages) - 1;
    expect(() => run(past, { recentTurnCap: 1, messageTokenBudget: budget }))
      .toThrow('complete recent history turns');
  });

  it('merges interleaved fan-out fragments without losing new replies or repeating persisted rows', () => {
    const first = { id: 'm2', role: 'assistant', content: 'VP A reply' };
    const result = run([
      { id: 'm1', role: 'user', clientMessageId: 'q1', content: 'question one' }, first,
      ...turn(3, 'question two'),
      { id: 'm5', role: 'user', clientMessageId: 'q1', content: 'question one' },
      { ...first }, { id: 'm6', role: 'assistant', content: 'VP B reply' },
    ]);
    expect(result.meta.recent.turnCount).toBe(2);
    expect(result.messages.filter(row => row.role === 'assistant').map(row => row.id))
      .toEqual(['m2', 'm6', 'm4']);
    expect(result.meta.recent.sourceMessageIds).toContain('m6');
  });

  it('fails closed on incomparable mixed-source chronology instead of sorting unknown seq as zero', () => {
    const result = run([
      ...turn(10), { role: 'user', content: 'CacheRouter' }, ...turn(30),
    ], { recentTurnCap: 1, prompt: 'CacheRouter', relatedTurns: [
      { id: 'external-five', userSeq: 5, score: 100, messages: turn(5, 'CacheRouter') },
    ] });
    expect(users(result)).toEqual(['m5', 'm30', 'm10000']);
    const localOnly = run([
      { role: 'user', content: 'CacheRouter' }, ...turn(30),
    ], { recentTurnCap: 1, prompt: 'CacheRouter' });
    expect(localOnly.meta.related.turnCount).toBe(1);
  });

  it('deduplicates canonical source IDs against runtime persisted IDs, never against text', () => {
    const past = [
      { role: 'user', _persistedMessageId: 'm10', content: 'same' },
      { role: 'assistant', _persistedMessageId: 'm11', content: 'answer' },
    ];
    const relatedTurns = [
      { id: 'canonical-ten', userSeq: 10, score: 9, messages: [
        { role: 'user', entry: { sourceMessageIds: ['m10'] }, content: 'same' },
        { role: 'assistant', sourceMessageIds: ['m11', 'm12'], content: 'answer' },
      ] },
      { id: 'different-question', userSeq: 1, score: 7, messages: turn(1, 'same', 'answer') },
    ];
    const result = run(past, { relatedTurns });
    expect(result.meta.recent.turnCount).toBe(1);
    expect(result.meta.related.turnCount).toBe(1);
    expect(result.meta.related.sourceMessageIds).toEqual(['m1', 'm2']);
    expect(result.meta.dropped.duplicateTurnCount).toBe(1);
    expect(result.messages.filter(row => row.content === 'same')).toHaveLength(2);
  });

  it('deduplicates current turn against both history sources and handles explicit user boundaries', () => {
    const current = { role: 'user', _persistedMessageId: 'm50', seq: 50, content: 'same' };
    const result = run([...turn(10, 'same'), ...turn(50, 'same')], {
      relatedTurns: [{ id: 'current', userSeq: 50, messages: turn(50), score: 9 }],
    }, current);
    expect(result.meta.recent.turnCount).toBe(1);
    expect(result.meta.related.turnCount).toBe(0);
    expect(result.messages.filter(row => row.id === 'm50')).toHaveLength(0);
    expect(result.messages.at(-1)._persistedMessageId).toBe('m50');
  });

  it('gives recent text priority over related history and reduces only the oldest suffix end', () => {
    const past = Array.from({ length: 20 }, (_, i) => turn(i * 10, `question ${i}`, 'x'.repeat(80))).flat();
    const budget = estimateMessagesTokens([...past.slice(-14), { role: 'user', content: 'current' }]);
    const result = run(past, { messageTokenBudget: budget, relatedTurns: [
      { id: 'old', userSeq: -10, score: 100, messages: turn(-10, 'related', 'short') },
    ] });
    expect(result.meta.recent.turnCount).toBe(7);
    expect(result.meta.related.turnCount).toBe(0);
    expect(users(result)).toEqual([...Array.from({ length: 7 }, (_, i) => `m${(i + 13) * 10}`), 'm10000']);
    expect(result.messages.slice(0, -1)).toEqual(past.slice(-14));
    expect(result.meta.budget.usedTokens).toBeLessThanOrEqual(budget);
    expect(result.meta.budget.relatedReservedTokens).toBe(0);
  });

  it('selects related by score but outputs by chronology, rejecting newer and unknown chronology', () => {
    const relatedTurns = [
      { id: 'r1', userSeq: 10, messages: turn(10), score: 4 },
      { id: 'r2', userSeq: 20, messages: turn(20), score: 9 },
      { id: 'r3', userSeq: 30, messages: turn(30), score: 1 },
      { id: 'future', userSeq: 90, messages: turn(90), score: 100 },
      { id: 'unknown', messages: [{ role: 'user', content: 'unknown' }], score: 200 },
    ];
    const result = run(turn(80), { relatedTurns, relatedTurnCap: 2 });
    expect(result.meta.related.turnIds).toEqual(['r1', 'r2']);
    expect(users(result)).toEqual(['m10', 'm20', 'm80', 'm10000']);
  });

  it('caps related turns at five and skips oversized candidates rather than truncating text', () => {
    const relatedTurns = Array.from({ length: 15 }, (_, i) => ({
      id: `r${i}`, userSeq: i * 10, messages: turn(i * 10), score: i + 1,
    }));
    relatedTurns.unshift({ id: 'huge', userSeq: -1, messages: turn(-1, 'huge', 'x'.repeat(100000)), score: 100 });
    const result = run(turn(900), { relatedTurns, relatedTurnCap: 50, messageTokenBudget: 1000 });
    expect(result.meta.related.turnCount).toBe(5);
    expect(result.meta.related.turnIds).not.toContain('huge');
    expect(result.meta.dropped.oversizedTurnCount).toBe(1);
    expect(result.meta.budget.usedTokens).toBeLessThanOrEqual(1000);
  });

  it('returns unused related reservation to the recent suffix without crossing related chronology', () => {
    const past = [10, 20, 30, 40].flatMap(seq => turn(seq, 'a', 'b'));
    const result = run(past, { messageTokenBudget: 33,
      relatedTurns: [{ id: 'old', userSeq: 1, score: 10, messages: turn(1, 'a', 'b') }],
    }, { id: 'm100', seq: 100, role: 'user', content: 'c' });
    expect(result.meta.recent.turnCount).toBe(4);
    expect(result.meta.related.turnCount).toBe(1);
    expect(result.meta.budget.usedTokens).toBe(33);
  });

  it('never restores hidden historical tool owners or results via optional enrichment', () => {
    for (const hidden of ['owner', 'result', 'both']) {
      const past = [
        { id: 'm1', role: 'user', content: 'a' },
        { id: 'm2', role: 'assistant', internal: hidden !== 'result', content: '',
          toolCalls: [{ id: 'hidden-call', name: 'Read', input: {} }] },
        { id: 'm3', role: 'tool', internal: hidden !== 'owner',
          toolCallId: 'hidden-call', content: 'PRIVATE_CONTROL_PAYLOAD' },
        { id: 'm4', role: 'assistant', content: 'b' },
      ];
      const result = run(past);
      expect(result.messages.map(row => row.id)).toEqual(['m1', 'm4', 'm10000']);
      expect(hasOrphanPairs(result.messages)).toBe(false);
    }
  });

  it('preserves the five-turn floor or fails explicitly rather than fabricating clipped turns', () => {
    const past = freeze(Array.from({ length: 20 }, (_, index) => (
      turn(index * 10, `question ${index}`, 'x'.repeat(200))
    )).flat());
    const budget = estimateMessagesTokens([...past.slice(-10), { role: 'user', content: 'current' }]);
    const five = run(past, { messageTokenBudget: budget });
    expect(five.meta.recent.turnCount).toBe(5);
    expect(five.messages.slice(0, -1)).toEqual(past.slice(-10));
    expect(() => run(past, { messageTokenBudget: budget - 1 })).toThrow('retain 5');
    expect(() => run(past, { maxMessageCount: 10 })).toThrow('retain 5');
    const oversized = past.map(row => row.id === 'm181' ? { ...row, content: 'x'.repeat(100000) } : row);
    expect(() => run(oversized, { messageTokenBudget: 500 })).toThrow('retain 5');
  });

  it('never exceeds the hard message cap while considering a 20-turn text window', () => {
    const result = run(Array.from({ length: 20 }, (_, index) => turn(index * 10)).flat(), {
      maxMessageCount: 21,
    });
    expect(result.messages).toHaveLength(21);
    expect(result.meta.budget.usedMessages).toBe(21);
    expect(result.meta.recent.turnCount).toBe(10);
  });

  it('makes tool replay optional and paired without evicting complete text from either bucket', () => {
    const past = [
      ...turn(10),
      { role: 'user', id: 'm20', content: 'inspect' },
      { role: 'assistant', id: 'm21', content: 'checking', toolCalls: [{ id: 'call', name: 'Read', input: {} }] },
      { role: 'tool', id: 'm22', toolCallId: 'call', content: 'x'.repeat(50000) },
      { role: 'assistant', id: 'm23', content: 'all done' },
    ];
    const result = run(past, { messageTokenBudget: 150 });
    expect(result.meta.recent.turnCount).toBe(2);
    expect(result.messages.filter(row => row.role === 'assistant').map(row => row.content)).toEqual(['answer 10', 'checking', 'all done']);
    expect(hasOrphanPairs(result.messages)).toBe(false);
    expect(result.meta.budget.usedTokens).toBeLessThanOrEqual(150);
    const roomy = run(past.map(row => row.role === 'tool' ? { ...row, content: 'ok' } : row));
    expect(roomy.messages.some(row => row.role === 'tool')).toBe(true);
    expect(hasOrphanPairs(roomy.messages)).toBe(false);
  });

  it.each([false, true])('keeps 20 text turns but only the newest 3 tool turns (repeated prompt: %s)', repeated => {
    const past = Array.from({ length: 20 }, (_, index) => {
      const base = index * 10;
      return [
        { id: `m${base}`, seq: base, role: 'user', content: repeated ? 'same question' : `question ${index}` },
        { id: `m${base + 1}`, seq: base + 1, role: 'assistant', content: `checking ${index}`,
          toolCalls: [{ id: `call-${index}`, name: 'Read', input: {} }] },
        { id: `m${base + 2}`, seq: base + 2, role: 'tool', toolCallId: `call-${index}`,
          content: index === 16 ? `OUTSIDE_TOOL_WINDOW_${'x'.repeat(50000)}` : `result ${index}` },
        { id: `m${base + 3}`, seq: base + 3, role: 'assistant', content: `answer ${index}` },
      ];
    }).flat();
    const result = run(past);
    const replayedCalls = result.messages.flatMap(row => row.toolCalls || []).map(call => call.id);
    const replayedResults = result.messages.filter(row => row.role === 'tool').map(row => row.toolCallId);

    expect(result.meta.recent.turnCount).toBe(20);
    expect(users(result)).toHaveLength(21);
    expect(replayedCalls).toEqual(['call-17', 'call-18', 'call-19']);
    expect(replayedResults).toEqual(['call-17', 'call-18', 'call-19']);
    expect(JSON.stringify(result.messages)).not.toContain('OUTSIDE_TOOL_WINDOW');
    expect(hasOrphanPairs(result.messages)).toBe(false);
  });

  it('keeps fitted tool calls attached to their original assistant owners', () => {
    const past = Array.from({ length: 20 }, (_, index) => {
      const base = index * 10;
      return [
        { id: `m${base}`, seq: base, role: 'user', content: `question ${index}` },
        { id: `m${base + 1}`, seq: base + 1, role: 'assistant', content: `owner ${index} ${'x'.repeat(200)}`,
          toolCalls: [{ id: `call-${index}`, name: 'Read', input: {} }] },
        { id: `m${base + 2}`, seq: base + 2, role: 'tool', toolCallId: `call-${index}`, content: `result ${index}` },
        { id: `m${base + 3}`, seq: base + 3, role: 'assistant', content: `answer ${index}` },
      ];
    }).flat();
    const result = run(past, { messageTokenBudget: 3000 });
    const owners = result.messages.filter(row => Array.isArray(row.toolCalls));

    expect(result.meta.recent.turnCount).toBe(20);
    expect(owners.map(row => [row.content.split(' ')[1], row.toolCalls[0].id])).toEqual([
      ['17', 'call-17'], ['18', 'call-18'], ['19', 'call-19'],
    ]);
    expect(hasOrphanPairs(result.messages)).toBe(false);
  });

  it('keeps active internal completion and reflection controls without recalling old controls', () => {
    const notice = { role: 'user', internal: true, content: '[completion] task finished' };
    const reflection = { role: 'user', reflection: true, content: '[reflection] next step' };
    const snapshot = [...turn(1), { ...notice, content: 'old notice' },
      { role: 'user', id: 'current', content: 'current prompt' },
      { role: 'assistant', content: 'waiting' }, notice, reflection];
    const result = buildHistoryBuckets(snapshot, { currentTurnStartIndex: 3 });
    expect(result.messages).toContainEqual(notice);
    expect(result.messages).toContainEqual(reflection);
    expect(result.messages.some(row => row.content === 'old notice')).toBe(false);
  });

  it('fits only current content, retains its prompt and strips an unfit signed tool arc atomically', () => {
    const snapshot = freeze([
      { id: 'm10', role: 'user', content: 'current prompt' },
      { role: 'assistant', content: 'checking', thinkingBlocks: [{ thinking: 'x'.repeat(20000), signature: 'signed' }], toolCalls: [{ id: 'c', name: 'Read', input: {} }] },
      { role: 'tool', toolCallId: 'c', content: { data: 'y'.repeat(50000) } },
      { role: 'assistant', content: 'z'.repeat(50000) },
    ]);
    const result = buildHistoryBuckets(snapshot, { currentTurnStartIndex: 0, messageTokenBudget: 100, maxMessageCount: 3 });
    expect(result.meta.recent.turnCount).toBe(0);
    expect(result.messages[0]).toEqual(snapshot[0]);
    expect(result.meta.budget.usedTokens).toBeLessThanOrEqual(100);
    expect(result.messages.length).toBeLessThanOrEqual(3);
    expect(hasOrphanPairs(result.messages)).toBe(false);
    expect(JSON.stringify(result.messages)).not.toContain('signed');
    expect(snapshot.at(-1).content).toHaveLength(50000);
  });

  it('recomputes purely from frozen raw candidates at each budget and does not leak symbol metadata', () => {
    const past = freeze([...turn(1), ...turn(10, 'long', 'x'.repeat(1000))]);
    expect(() => run(past, { messageTokenBudget: 30 })).toThrow('retain 2');
    const large = run(past, { messageTokenBudget: 1000 });
    expect(large.meta.recent.turnCount).toBe(2);
    expect(large.messages.find(row => row.id === 'm11').content).toHaveLength(1000);
    expect(large.messages.every(row => Object.getOwnPropertySymbols(row).length === 0)).toBe(true);
    expect(run(past, { messageTokenBudget: 1000 })).toEqual(large);
  });

  it('shares conservative relevance for evicted raw turns and fences an unpersisted current prompt via past history', () => {
    const past = [...turn(10, 'CacheRouter reconnect fence', 'a'.repeat(40)),
      ...turn(20, 'other', 'b'.repeat(160)), ...turn(30, 'latest', 'c'.repeat(40))];
    const recalled = run(past, { prompt: 'CacheRouter reconnect', messageTokenBudget: 95, recentTurnCap: 1 });
    expect(recalled.meta.related.turnCount).toBe(1);
    expect(recalled.meta.related.sourceMessageIds).toContain('m10');
    const result = run(turn(100), { relatedTurns: [{ id: 'r', userSeq: 10, score: 10, messages: turn(10) }] },
      { role: 'user', content: 'runtime current without persisted ID' });
    expect(result.meta.related.turnCount).toBe(1);
    const rows = run([...turn(100), ...turn(200)], {
      maxMessageCount: 5,
      relatedTurns: [{ id: 'r', userSeq: 10, score: 10, messages: turn(10) }],
    });
    expect(users(rows)).toEqual(['m100', 'm200', 'm10000']);
    const newestOnly = run(turn(10, 'CacheRouter reconnect'), {
      prompt: 'CacheRouter reconnect', maxMessageCount: 3,
    });
    expect(newestOnly.meta.recent.turnCount).toBe(1);
    expect(newestOnly.meta.related.turnCount).toBe(0);
  });

  it('does not treat VP routing or ubiquitous local keywords as relevant subject matter', () => {
    const past = Array.from({ length: 12 }, (_, i) => turn(i * 10,
      '@vp-omni cache reconnect behavior', 'cache reconnect details')).flat();
    for (const prompt of ['@vp-omni 继续', 'cache reconnect']) {
      const result = run(past, { prompt, recentTurnCap: 2 });
      expect(result.meta.related.turnCount).toBe(0);
      expect(result.meta.recent.turnCount).toBe(2);
    }
  });

  it('never exceeds tiny, zero, row or multimodal budgets, even for current-only payloads', () => {
    const current = freeze({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(10000) },
      { type: 'image', source: { data: 'y'.repeat(100000), media_type: 'image/png' } }] });
    for (const messageTokenBudget of [0, 1, 2, 3, 5, 20, 100]) {
      for (const maxMessageCount of [0, 1, 2]) {
        const result = buildHistoryBuckets([current], { currentTurnStartIndex: 0, messageTokenBudget, maxMessageCount });
        expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(messageTokenBudget);
        expect(result.messages.length).toBeLessThanOrEqual(maxMessageCount);
      }
    }
    expect(() => run([...turn(10), ...turn(20)], { maxMessageCount: 4 })).toThrow('retain 2');
  });
});
