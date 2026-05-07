/**
 * resident-build.test.js — Pin the rules that decide which Layer-A
 * summaries become Resident AMS entries on every turn.
 *
 * The single non-trivial rule: skip the own-VP summary when it's just
 * the seed-backfill stub. Section 1 (`renderVpPersona`) is already the
 * source of truth for own-VP identity; surfacing the stub as Resident
 * doubles the same `# Name / Role` text under "Active Memory Set" — the
 * visible follow-up bug to PR #722's persona-dup fix. Real Dream-v2
 * summaries lack the marker and MUST be surfaced.
 */

import { describe, it, expect } from 'vitest';
import { buildResidentEntries } from '../../../../agent/unify/engine.js';
import { VP_STUB_MARKER } from '../../../../agent/unify/memory/seed-backfill.js';

const STUB_VP_SUMMARY = `${VP_STUB_MARKER}\n\n# Steve Jobs\n\n**Role:** Product Strategist`;
const REAL_VP_SUMMARY = '# Steve Jobs\n\nLast week: pushed back on AMS resident dedup. Prefers single-PR fixes.';

describe('buildResidentEntries', () => {
  it('returns empty array when no summaries are provided', () => {
    expect(buildResidentEntries({ summaries: {} })).toEqual([]);
  });

  it('emits user + group + vp when all three are real summaries', () => {
    const out = buildResidentEntries({
      groupId: 'grp_claude',
      ownVpId: 'steve',
      summaries: {
        user: '# Operator notes',
        group: '# Claude — 4 members',
        vp: REAL_VP_SUMMARY,
      },
    });
    expect(out).toEqual([
      { scope: 'user', summary: '# Operator notes' },
      { scope: 'group/grp_claude', summary: '# Claude — 4 members' },
      { scope: 'vp/steve', summary: REAL_VP_SUMMARY },
    ]);
  });

  it('skips vp/<ownVpId> when its summary is the seed-backfill stub', () => {
    const out = buildResidentEntries({
      groupId: 'grp_claude',
      ownVpId: 'steve',
      summaries: {
        user: '# Operator notes',
        group: '# Claude — 4 members',
        vp: STUB_VP_SUMMARY,
      },
    });
    expect(out.find(e => e.scope.startsWith('vp/'))).toBeUndefined();
    expect(out.map(e => e.scope)).toEqual(['user', 'group/grp_claude']);
  });

  it('still emits user + group resident entries when the vp summary is a stub', () => {
    // Regression guard: skipping vp must NOT short-circuit the other scopes.
    const out = buildResidentEntries({
      groupId: 'grp_claude',
      ownVpId: 'steve',
      summaries: {
        user: 'u',
        group: 'g',
        vp: STUB_VP_SUMMARY,
      },
    });
    expect(out.length).toBe(2);
  });

  it('omits group when groupId is missing even if a group summary is present', () => {
    const out = buildResidentEntries({
      summaries: { group: '# orphan' },
    });
    expect(out).toEqual([]);
  });

  it('omits vp when ownVpId is missing even if a vp summary is present', () => {
    const out = buildResidentEntries({
      summaries: { vp: REAL_VP_SUMMARY },
    });
    expect(out).toEqual([]);
  });

  it('treats a Dream-v2 summary that happens to mention the marker LITERAL as a stub', () => {
    // Defensive note: this is the documented behavior of the marker-based
    // detection. If Dream-v2 ever embeds the marker comment as quoted text
    // it MUST be normalized upstream. Pinning this so the contract is
    // explicit — change-detection rather than a hidden surprise.
    const sneaky = `# Steve\n\nQuoted: \`${VP_STUB_MARKER}\``;
    const out = buildResidentEntries({
      ownVpId: 'steve',
      summaries: { vp: sneaky },
    });
    expect(out).toEqual([]);
  });
});
