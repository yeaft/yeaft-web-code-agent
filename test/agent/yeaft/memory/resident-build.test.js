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
import { buildResidentEntries } from '../../../../agent/yeaft/engine.js';
import { ActiveMemorySet } from '../../../../agent/yeaft/memory/ams.js';
import { buildSystemPrompt } from '../../../../agent/yeaft/prompts.js';
import { VP_STUB_MARKER } from '../../../../agent/yeaft/memory/seed-backfill.js';

const STUB_VP_SUMMARY = `${VP_STUB_MARKER}\n\n# Steve Jobs\n\n**Role:** Product Strategist`;
const REAL_VP_SUMMARY = '# Steve Jobs\n\nLast week: pushed back on AMS resident dedup. Prefers single-PR fixes.';

describe('buildResidentEntries', () => {
  it('returns empty array when no summaries are provided', () => {
    expect(buildResidentEntries({ summaries: {} })).toEqual([]);
  });

  it('emits user + session + vp when all three are real summaries', () => {
    const out = buildResidentEntries({
      sessionId: 'grp_claude',
      ownVpId: 'steve',
      summaries: {
        user: '# Operator notes',
        session: '# Claude — 4 members',
        vp: REAL_VP_SUMMARY,
      },
    });
    expect(out).toEqual([
      { scope: 'user', summary: '# Operator notes' },
      { scope: 'sessions/grp_claude', summary: '# Claude — 4 members' },
      // VP per-session isolation (2026-06-09): scope MUST be session-qualified
      // — bare `vp/<id>` was a structural bug that let the same persona leak
      // across different sessions via AMS rehydration. See engine.js:253.
      { scope: 'sessions/grp_claude/vp/steve', summary: REAL_VP_SUMMARY },
    ]);
  });

  it('skips vp/<ownVpId> when its summary is the seed-backfill stub', () => {
    const out = buildResidentEntries({
      sessionId: 'grp_claude',
      ownVpId: 'steve',
      summaries: {
        user: '# Operator notes',
        session: '# Claude — 4 members',
        vp: STUB_VP_SUMMARY,
      },
    });
    expect(out.find(e => e.scope.includes('/vp/'))).toBeUndefined();
    expect(out.find(e => e.scope.startsWith('vp/'))).toBeUndefined();
    expect(out.map(e => e.scope)).toEqual(['user', 'sessions/grp_claude']);
  });

  it('still emits user + session resident entries when the vp summary is a stub', () => {
    // Regression guard: skipping vp must NOT short-circuit the other scopes.
    const out = buildResidentEntries({
      sessionId: 'grp_claude',
      ownVpId: 'steve',
      summaries: {
        user: 'u',
        session: 'g',
        vp: STUB_VP_SUMMARY,
      },
    });
    expect(out.length).toBe(2);
  });

  it('omits session when sessionId is missing even if a session summary is present', () => {
    const out = buildResidentEntries({
      summaries: { session: '# orphan' },
    });
    expect(out).toEqual([]);
  });

  it('omits vp when ownVpId is missing even if a vp summary is present', () => {
    const out = buildResidentEntries({
      summaries: { vp: REAL_VP_SUMMARY },
    });
    expect(out).toEqual([]);
  });

  it('omits vp when sessionId is missing even if ownVpId is provided', () => {
    // Per-session isolation invariant: a VP summary without a session
    // context has no meaningful scope, so it MUST NOT enter the Resident
    // layer. (Pre-fix this would have emitted a bare `vp/<id>` entry.)
    const out = buildResidentEntries({
      ownVpId: 'steve',
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
      sessionId: 'grp_demo',
      ownVpId: 'steve',
      summaries: { vp: sneaky },
    });
    expect(out).toEqual([]);
  });

  it('carries a real Dream session summary into the next system prompt memory block', () => {
    const entries = buildResidentEntries({
      sessionId: 'grp_demo',
      ownVpId: 'linus',
      summaries: {
        session: 'summary for sessions/grp_demo',
      },
    });
    const ams = new ActiveMemorySet({
      ownVpId: 'linus',
      budget: { resident: 200, recent: 0, onDemand: 0 },
    });
    ams.setResident(entries);
    const snap = ams.snapshot();
    const memoryInjection = [
      '## Active Memory Set',
      '### Resident',
      ...snap.resident.map(r => `- **${r.scope}**: ${r.summary}`),
    ].join('\n');

    const prompt = buildSystemPrompt({
      language: 'en',
      mode: 'unified',
      memoryInjection,
    });

    expect(prompt).toContain('## Active Memory Set');
    expect(prompt).toContain('- **sessions/grp_demo**: summary for sessions/grp_demo');
  });
});
