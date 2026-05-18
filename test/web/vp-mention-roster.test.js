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
 *   - Empty/missing roster -> full library (safe bootstrap fallback —
 *     never an empty dropdown).
 *   - Off-roster VPs are HIDDEN entirely, not grayed out. The previous
 *     UX surfaced them with an "_offRoster" badge and an invite-toast
 *     hint; we removed that whole branch when the user picked the
 *     simpler "hide entirely" option.
 */
import { describe, it, expect } from 'vitest';

// VpMentionAutocomplete -> VpAvatar -> vp store -> `Pinia.defineStore(...)`
// at module top-level. We only need the pure helper, not the Vue plumbing,
// so install a minimal Pinia shim before importing.
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = globalThis.Pinia.defineStore || (() => () => ({}));
// `Vue` is also referenced by VpMentionAutocomplete's setup() (Vue.computed),
// but it's only invoked when the component is instantiated. The pure
// helper is exported above setup() and never touches Vue, so no shim
// needed for that — module-load is what matters.

const { selectMentionCandidates } = await import('../../web/components/VpMentionAutocomplete.js');

const VPS = [
  { vpId: 'jobs',     displayName: 'Steve Jobs' },
  { vpId: 'linus',    displayName: 'Linus Torvalds' },
  { vpId: 'rams',     displayName: 'Dieter Rams' },
  { vpId: 'fowler',   displayName: 'Martin Fowler' },
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

  it('preserves the library order when filtering by roster', () => {
    // roster lists fowler first, but the dropdown should mirror the
    // library order so it stays stable across renders.
    const group = { id: 'g1', roster: ['fowler', 'linus'] };
    const out = selectMentionCandidates(VPS, group);
    expect(out.map(v => v.vpId)).toEqual(['linus', 'fowler']);
  });

  it('falls back to the full library when roster is empty', () => {
    // Empty roster is a transient bootstrap state — surfacing an empty
    // dropdown would be hostile UX, so we deliberately fail open.
    expect(selectMentionCandidates(VPS, { id: 'g1', roster: [] })).toEqual(VPS);
  });

  it('falls back to the full library when roster is missing', () => {
    expect(selectMentionCandidates(VPS, { id: 'g1' })).toEqual(VPS);
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
