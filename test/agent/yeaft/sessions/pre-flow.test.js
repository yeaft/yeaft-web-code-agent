import { describe, expect, it } from 'vitest';

import { buildRelevantScopes, runMemoryPreflow } from '../../../../agent/yeaft/sessions/pre-flow.js';

function fakeIndex(rows) {
  return {
    search({ scopeFilter }) {
      return rows
        .filter(row => scopeFilter.includes(row.scope))
        .map((row, index) => ({
          id: row.id || `seg-${index}`,
          scope: row.scope,
          kind: row.kind || 'context',
          tags: row.tags || [],
          body: row.body,
          sourceMessages: row.sourceMessages || [],
          rank: row.rank ?? 0,
          createdAt: row.createdAt || '2026-06-25T00:00:00.000Z',
          updatedAt: row.updatedAt || '2026-06-25T00:00:00.000Z',
        }));
    },
  };
}

describe('Yeaft memory pre-flow scopes', () => {
  it('includes current sessions/* Dream scopes plus legacy aliases', () => {
    expect(buildRelevantScopes({ sessionId: 's1', vpId: 'linus' })).toEqual([
      'user',
      'sessions/s1',
      'sessions/s1/user',
      'session/s1',
      'session/s1/user',
      'group/s1',
      'group/s1/user',
      'sessions/s1/vp/linus',
      'session/s1/vp/linus',
      'group/s1/vp/linus',
    ]);
  });

  it('recalls FTS rows written under the current sessions/* Dream path', () => {
    const result = runMemoryPreflow(fakeIndex([
      { scope: 'sessions/s1', body: 'Dream remembers the Sydney project preference.' },
      { scope: 'sessions/s1/vp/linus', body: 'Linus should keep the Dream fix minimal.' },
      { scope: 'sessions/other', body: 'This session must not leak into s1.' },
    ]), {
      sessionId: 's1',
      vpId: 'linus',
      userMsg: 'Sydney Dream minimal project',
      budgetTokens: 1000,
    });

    expect(result.entries.map(entry => entry.scope)).toEqual([
      'sessions/s1',
      'sessions/s1/vp/linus',
    ]);
    expect(result.formatted).toContain('Dream remembers the Sydney project preference.');
    expect(result.formatted).toContain('Linus should keep the Dream fix minimal.');
    expect(result.formatted).not.toContain('This session must not leak into s1.');
  });
});
