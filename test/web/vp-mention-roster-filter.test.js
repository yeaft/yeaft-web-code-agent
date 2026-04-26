/**
 * Regression test: when an active group filter is set, the @-mention
 * autocomplete must only show VPs that are members of that group's
 * roster — not the entire VP library.
 *
 * Bug repro: user creates a Default group with 2 members, types `@`,
 * and the dropdown lists every VP in the library. Mentioning a VP not
 * in the roster has no routing effect, so the choice is misleading.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CHAT_INPUT = path.join(ROOT, 'web', 'components', 'ChatInput.js');

// Mirror of ChatInput's `mentionVpCandidates` computed — kept in lockstep
// with web/components/ChatInput.js. The source-pin assertion below trips
// this test if that computed is renamed or deleted.
function rosterFilteredCandidates({ fullList, activeGroupId, groups }) {
  if (!activeGroupId) return fullList;
  const group = groups?.[activeGroupId];
  const roster = group && Array.isArray(group.roster) ? group.roster : null;
  if (!roster || roster.length === 0) return fullList;
  const allowed = new Set(roster);
  return fullList.filter(vp => vp && vp.vpId && allowed.has(vp.vpId));
}

describe('vp @-mention autocomplete — roster filter', () => {
  const fullList = [
    { vpId: 'linus', displayName: 'Linus Torvalds' },
    { vpId: 'ken', displayName: 'Ken Thompson' },
    { vpId: 'grace', displayName: 'Grace Hopper' },
    { vpId: 'martin', displayName: 'Martin Fowler' },
    { vpId: 'don', displayName: 'Don Norman' },
  ];
  const groups = {
    grp_default: { id: 'grp_default', roster: ['linus', 'ken'] },
    grp_design: { id: 'grp_design', roster: ['don', 'grace'] },
  };

  it('returns the roster of the active group (not the full library)', () => {
    const out = rosterFilteredCandidates({
      fullList, activeGroupId: 'grp_default', groups,
    });
    expect(out).toHaveLength(2);
    expect(out.map(v => v.vpId).sort()).toEqual(['ken', 'linus']);
  });

  it('returns the full library when no group filter is active', () => {
    const out = rosterFilteredCandidates({ fullList, activeGroupId: null, groups });
    expect(out).toHaveLength(fullList.length);
  });

  it('returns the full library when the active group has an empty roster', () => {
    const out = rosterFilteredCandidates({
      fullList,
      activeGroupId: 'grp_empty',
      groups: { grp_empty: { id: 'grp_empty', roster: [] } },
    });
    expect(out).toHaveLength(fullList.length);
  });

  it('roster slice composes correctly with the existing query filter', () => {
    const candidates = rosterFilteredCandidates({
      fullList, activeGroupId: 'grp_default', groups,
    });
    // No external import — sanity-check the composition by name prefix.
    const out = candidates.filter(v => v.vpId.startsWith('lin'));
    expect(out).toHaveLength(1);
    expect(out[0].vpId).toBe('linus');
  });

  it('ChatInput.js wires mentionVpCandidates into VpMentionAutocomplete', () => {
    const src = readFileSync(CHAT_INPUT, 'utf8');
    expect(src).toMatch(/mentionVpCandidates\s*=\s*Vue\.computed/);
    expect(src).toMatch(/:vps="mentionVpCandidates"/);
    // The keyboard-nav path must use the same source so ↑↓/Enter stays in sync.
    expect(src).toMatch(/filterVpMentions\(mentionVpCandidates\.value/);
  });
});
