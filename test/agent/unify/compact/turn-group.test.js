/**
 * Phase 4 — turn-group atomicity (DESIGN.md §9.2).
 *
 * The unit of archiving is a turn-group anchored on `user`. Tool results
 * never get separated from the assistant message that produced them.
 */

import { describe, it, expect } from 'vitest';
import {
  groupTurns,
  pickCoolingGroups,
  indicesFromGroups,
} from '../../../../agent/unify/compact/turn-group.js';

describe('groupTurns', () => {
  it('returns empty array on empty input', () => {
    expect(groupTurns([])).toEqual([]);
    expect(groupTurns(undefined)).toEqual([]);
  });

  it('one user-assistant pair → one group', () => {
    const groups = groupTurns([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
    expect(groups).toEqual([{ start: 0, end: 2, role: 'user' }]);
  });

  it('keeps assistant + tool messages with their user', () => {
    const messages = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'thinking', toolCalls: [{ id: 'tc_1' }] },
      { role: 'tool', toolCallId: 'tc_1', content: 'r' },
      { role: 'assistant', content: 'final' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ];
    const groups = groupTurns(messages);
    expect(groups).toEqual([
      { start: 0, end: 4, role: 'user' },
      { start: 4, end: 6, role: 'user' },
    ]);
  });

  it('captures leading non-user prelude as its own group', () => {
    const messages = [
      { role: 'system', content: 'init' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ];
    const groups = groupTurns(messages);
    expect(groups).toEqual([
      { start: 0, end: 1, role: 'system' },
      { start: 1, end: 3, role: 'user' },
    ]);
  });

  it('trailing assistant without follow-up user belongs to last group', () => {
    const messages = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'thinking', toolCalls: [{ id: 'tc_1' }] },
      { role: 'tool', toolCallId: 'tc_1', content: 'r' },
    ];
    expect(groupTurns(messages)).toEqual([{ start: 0, end: 3, role: 'user' }]);
  });
});

describe('pickCoolingGroups', () => {
  const groups = [0, 1, 2, 3, 4].map(i => ({ start: i * 2, end: i * 2 + 2, role: 'user' }));

  it('keeps the newest keepHot groups hot', () => {
    const { hot, cooling } = pickCoolingGroups(groups, 2);
    expect(cooling).toEqual(groups.slice(0, 3));
    expect(hot).toEqual(groups.slice(3));
  });

  it('cooling is empty when groups <= keepHot', () => {
    expect(pickCoolingGroups(groups, 5).cooling).toEqual([]);
    expect(pickCoolingGroups(groups, 10).cooling).toEqual([]);
  });

  it('keepHot=0 means everything cools', () => {
    expect(pickCoolingGroups(groups, 0)).toEqual({ hot: [], cooling: groups });
  });
});

describe('indicesFromGroups', () => {
  it('flattens groups back to raw indices', () => {
    const out = indicesFromGroups([
      { start: 0, end: 3 },
      { start: 5, end: 7 },
    ]);
    expect(out).toEqual([0, 1, 2, 5, 6]);
  });

  it('empty input → empty output', () => {
    expect(indicesFromGroups([])).toEqual([]);
  });
});
