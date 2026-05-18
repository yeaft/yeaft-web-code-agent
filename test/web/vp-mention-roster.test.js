/**
 * vp-mention-roster.test.js — pins the group-scoped `@` autocomplete to
 * the active group's roster.
 *
 * Bug it locks down: in a group conversation the `@` dropdown was
 * surfacing the ENTIRE predefined VP library, not just the people on the
 * group's roster. You can't @-mention someone who isn't in the
 * conversation, so the dropdown shouldn't tempt the user to try.
 *
 * What the helper guarantees:
 *   - No active group  -> full library (legacy single-agent path).
 *   - Group with roster -> only VPs whose vpId is on that roster.
 *   - Empty/missing roster -> empty result. Matches the VP timeline
 *     (`selectGroupRosterVpList`) and lets the autocomplete's
 *     `v-if="filteredList.length > 0"` hide the popover entirely.
 *   - Off-roster VPs are HIDDEN entirely, not grayed out. The previous
 *     UX surfaced them with an "_offRoster" badge and an invite-toast
 *     hint; we removed that whole branch when the user picked the
 *     simpler "hide entirely" option.
 */
import { describe, it, expect } from 'vitest';

// VpMentionAutocomplete -> VpAvatar -> vp store -> `Pinia.defineStore(...)`
// at module top-level. We only need the pure helper, not the Vue plumbing,
// so install a minimal Pinia shim before importing.
globalThis.Pinia ??= { defineStore: () => () => ({}) };

const { selectMentionCandidates } = await import('../../web/components/VpMentionAutocomplete.js');

const VPS = [
  { vpId: 'jobs',   displayName: 'Steve Jobs' },
  { vpId: 'linus',  displayName: 'Linus Torvalds' },
  { vpId: 'fowler', displayName: 'Martin Fowler' },
];

describe('selectMentionCandidates', () => {
  it('returns the full library when there is no active group', () => {
    expect(selectMentionCandidates(VPS, null)).toEqual(VPS);
    expect(selectMentionCandidates(VPS, undefined)).toEqual(VPS);
  });

  it('returns only roster VPs when the group has a non-empty roster', () => {
    const group = { id: 'g1', roster: ['linus', 'fowler'] };
    const out = selectMentionCandidates(VPS, group);
    expect(out.map(v => v.vpId)).toEqual(['linus', 'fowler']);
  });

  it('emits results in input (library) order, not roster order', () => {
    // The dropdown is stable across renders because the helper uses
    // Array.prototype.filter on the library list. If we ever switch to
    // roster-order output (matching UnifyPage's timeline), update this.
    const group = { id: 'g1', roster: ['fowler', 'linus'] };
    const out = selectMentionCandidates(VPS, group);
    expect(out.map(v => v.vpId)).toEqual(['linus', 'fowler']);
  });

  it('returns an empty list when the group has an empty roster', () => {
    // Matches the VP timeline (UnifyPage): a group with no members has
    // nothing to @-mention. The autocomplete's v-if hides the popover
    // when filteredList is empty, so the user sees no dropdown.
    expect(selectMentionCandidates(VPS, { id: 'g1', roster: [] })).toEqual([]);
  });

  it('returns an empty list when the group is missing the roster field', () => {
    expect(selectMentionCandidates(VPS, { id: 'g1' })).toEqual([]);
  });

  it('drops roster entries that no longer have a matching VP record', () => {
    // Roster references a VP that was deleted from the library — don't
    // pretend it exists.
    const group = { id: 'g1', roster: ['linus', 'ghost', 'fowler'] };
    const out = selectMentionCandidates(VPS, group);
    expect(out.map(v => v.vpId)).toEqual(['linus', 'fowler']);
  });

  it('tolerates a non-array vpList without throwing', () => {
    expect(selectMentionCandidates(null, { roster: ['linus'] })).toEqual([]);
    expect(selectMentionCandidates(undefined, { roster: ['linus'] })).toEqual([]);
  });

  it('does not tag off-roster VPs with _offRoster (the grayed-out path is gone)', () => {
    // Regression guard: an earlier design tagged off-roster VPs with
    // `_offRoster: true` so the dropdown could gray them out and emit
    // an invite-hint toast. The current design hides them entirely;
    // nothing in the returned list should carry that flag.
    const group = { id: 'g1', roster: ['linus'] };
    const out = selectMentionCandidates(VPS, group);
    expect(out.some(v => v._offRoster)).toBe(false);
  });
});
