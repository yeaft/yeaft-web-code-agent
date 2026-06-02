/**
 * debug-search.test.js — feat-6af5f9f1 PR C.
 *
 * Pure unit tests for the debug-panel search matcher.
 */

import { describe, it, expect } from 'vitest';
import { turnMatchesSearch } from '../../../../web/stores/helpers/debug-search.js';

function mkTurn(over = {}) {
  return {
    turnId: 'tA',
    userPrompt: 'hello world',
    vpId: 'vp-steve',
    groupId: 'grp_claude',
    ...over,
  };
}

function mkLoop(over = {}) {
  return {
    turnId: 'tA',
    loopNumber: 1,
    model: 'opus-4.7',
    systemPrompt: 'You are Steve.',
    response: 'I will help you.',
    toolCalls: [],
    messages: [],
    rawRequest: null,
    ...over,
  };
}

describe('turnMatchesSearch', () => {
  it('returns true for empty / null query (matches everything)', () => {
    expect(turnMatchesSearch(mkTurn(), [], [], '')).toBe(true);
    expect(turnMatchesSearch(mkTurn(), [], [], null)).toBe(true);
  });

  it('matches user prompt (case-insensitive)', () => {
    const t = mkTurn({ userPrompt: 'Investigate ENGINE drift' });
    expect(turnMatchesSearch(t, [], [], 'engine')).toBe(true);
  });

  it('matches vpId', () => {
    const t = mkTurn({ vpId: 'vp-linus' });
    expect(turnMatchesSearch(t, [], [], 'linus')).toBe(true);
  });

  it('matches groupId', () => {
    const t = mkTurn({ groupId: 'grp_alpha' });
    expect(turnMatchesSearch(t, [], [], 'grp_alpha')).toBe(true);
  });

  it('matches system prompt — but only the first loop (constant)', () => {
    const loops = [
      mkLoop({ systemPrompt: 'You are HelpfulAssistant.' }),
      mkLoop({ systemPrompt: '(should never be searched)' }),
    ];
    expect(turnMatchesSearch(mkTurn(), loops, [], 'helpfulassistant')).toBe(true);
    // Second-loop content should NOT match — first loop wins.
    expect(turnMatchesSearch(mkTurn(), loops, [], 'never be')).toBe(false);
  });

  it('matches assistant response across multiple loops', () => {
    const loops = [
      mkLoop({ response: 'First reply.' }),
      mkLoop({ response: 'Followup includes Greptastic.' }),
    ];
    expect(turnMatchesSearch(mkTurn(), loops, [], 'greptastic')).toBe(true);
  });

  it('matches tool name', () => {
    const loops = [mkLoop({
      toolCalls: [{ id: 'c1', name: 'Grep', input: {} }],
    })];
    expect(turnMatchesSearch(mkTurn(), loops, [], 'grep')).toBe(true);
  });

  it('matches tool input (JSON-serialized)', () => {
    const loops = [mkLoop({
      toolCalls: [{ id: 'c1', name: 'Grep', input: { pattern: 'yeaftDebugPanel' } }],
    })];
    expect(turnMatchesSearch(mkTurn(), loops, [], 'yeaftdebugpanel')).toBe(true);
  });

  it('matches tool output via tool message content', () => {
    const loops = [mkLoop({
      messages: [{ role: 'tool', toolCallId: 'c1', content: 'No matches found' }],
    })];
    expect(turnMatchesSearch(mkTurn(), loops, [], 'no matches')).toBe(true);
  });

  it('matches raw request URL', () => {
    const loops = [mkLoop({
      rawRequest: { method: 'POST', url: 'https://api.anthropic.com/v1/messages' },
    })];
    expect(turnMatchesSearch(mkTurn(), loops, [], 'anthropic')).toBe(true);
  });

  it('matches reflection content', () => {
    const reflections = [{ trigger: 't1', status: 'ready', content: '## Direction check\nstuck in a loop' }];
    expect(turnMatchesSearch(mkTurn(), [], reflections, 'direction check')).toBe(true);
  });

  it('matches reflection error message', () => {
    const reflections = [{ trigger: 't1', status: 'error', error: 'rate-limited by upstream' }];
    expect(turnMatchesSearch(mkTurn(), [], reflections, 'rate-limited')).toBe(true);
  });

  it('returns false when nothing matches', () => {
    const turn = mkTurn();
    const loops = [mkLoop({
      toolCalls: [{ id: 'c1', name: 'Read', input: { path: '/etc/hosts' } }],
    })];
    expect(turnMatchesSearch(turn, loops, [], 'definitely-not-present')).toBe(false);
  });

  it('handles missing optional fields without throwing', () => {
    expect(() => turnMatchesSearch({}, null, null, 'x')).not.toThrow();
    expect(turnMatchesSearch({}, null, null, 'x')).toBe(false);
  });

  it('matches numeric tool input via JSON serialization', () => {
    const loops = [mkLoop({
      toolCalls: [{ id: 'c1', name: 'Bash', input: { timeout: 60000 } }],
    })];
    expect(turnMatchesSearch(mkTurn(), loops, [], '60000')).toBe(true);
  });
});
