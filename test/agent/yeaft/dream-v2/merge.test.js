/**
 * dream-v2/merge.test.js — §15
 *
 * mergeByTarget collapses per-group actions into per-target sources.
 */

import { describe, it, expect } from 'vitest';
import { mergeByTarget } from '../../../../agent/yeaft/dream-v2/merge.js';

describe('mergeByTarget', () => {
  it('returns [] for empty input', () => {
    expect(mergeByTarget([])).toEqual([]);
    expect(mergeByTarget(undefined)).toEqual([]);
  });
  it('merges identical targets across groups, sorted', () => {
    const merged = mergeByTarget([
      {
        groupId: 'g-life',
        diff: [{ id: 'L1' }],
        actions: [
          { kind: 'update', scope: 'user' },
          { kind: 'update', scope: 'group/g-life' },
        ],
      },
      {
        groupId: 'g-eng',
        diff: [{ id: 'E1' }],
        actions: [
          { kind: 'update', scope: 'user' },
          { kind: 'update', scope: 'group/g-eng' },
          { kind: 'update', scope: 'vp/zhang-san' },
        ],
      },
    ]);
    const targets = merged.map(m => m.target);
    expect(targets).toEqual(['group/g-eng', 'group/g-life', 'user', 'vp/zhang-san']);
    const userEntry = merged.find(m => m.target === 'user');
    expect(userEntry.sources.map(s => s.groupId)).toEqual(['g-eng', 'g-life']);
    expect(userEntry.kind).toBe('update');
  });
  it('update beats create when groups disagree', () => {
    const merged = mergeByTarget([
      { groupId: 'g1', diff: [], actions: [{ kind: 'create', scope: 'topic/x' }] },
      { groupId: 'g2', diff: [], actions: [{ kind: 'update', scope: 'topic/x' }] },
    ]);
    expect(merged[0].kind).toBe('update');
  });
  it('keeps create when every group says create', () => {
    const merged = mergeByTarget([
      { groupId: 'g1', diff: [], actions: [{ kind: 'create', scope: 'topic/y' }] },
      { groupId: 'g2', diff: [], actions: [{ kind: 'create', scope: 'topic/y' }] },
    ]);
    expect(merged[0].kind).toBe('create');
    expect(merged[0].sources.length).toBe(2);
  });
  it('dedupes (target, group) pairs', () => {
    const merged = mergeByTarget([
      {
        groupId: 'g1',
        diff: [],
        actions: [
          { kind: 'update', scope: 'user' },
          { kind: 'update', scope: 'user' }, // duplicate
        ],
      },
    ]);
    expect(merged[0].sources.length).toBe(1);
  });
});
