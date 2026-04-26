/**
 * R6 G4 — VpMentionAutocomplete cross-group grayed state + invite hint.
 *
 * D4: never auto-invite. When the user @-mentions a VP that is NOT on
 * the active group's roster, we render the row grayed/disabled and
 * surface a non-blocking toast asking the user to add them via the
 * group editor first. The LLM must NOT infer that mentioning auto-
 * invites — this is the user's call (mirrors backend TaskCreate's
 * not_in_roster behaviour).
 *
 * Static source-level acceptance:
 *   S1 ChatInput.mentionVpCandidates returns BOTH in-roster (un-tagged)
 *      and off-roster (tagged `_offRoster: true`) VPs when an active
 *      group filter is set, in-roster first.
 *   S2 ChatInput.selectVpMention short-circuits when `_offRoster` is
 *      true, calling chatStore.flashInviteHint instead of inserting.
 *   S3 VpMentionAutocomplete renders a `vp-mention-off-roster` class +
 *      offRosterBadge when `_offRoster` is set, with aria-disabled.
 *   S4 chatStore exposes `unifyMentionInviteHints` state + flashInviteHint
 *      action + dismissInviteHint action.
 *   S5 i18n (en + zh-CN) carry offRosterBadge / offRosterHint / inviteToast.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const chatInputSrc     = read('web/components/ChatInput.js');
const autocompleteSrc  = read('web/components/VpMentionAutocomplete.js');
const chatStoreSrc     = read('web/stores/chat.js');
const enI18nSrc        = read('web/i18n/en.js');
const zhI18nSrc        = read('web/i18n/zh-CN.js');

describe('R6 G4 — ChatInput.mentionVpCandidates surfaces off-roster VPs', () => {
  it('keeps off-roster VPs in the list and tags them _offRoster', () => {
    expect(chatInputSrc).toMatch(/_offRoster:\s*true/);
  });

  it('orders in-roster before off-roster', () => {
    // The const declarations + spread make ordering grep-able without an AST.
    expect(chatInputSrc).toMatch(/inRoster\s*=\s*\[\]/);
    expect(chatInputSrc).toMatch(/offRoster\s*=\s*\[\]/);
    expect(chatInputSrc).toMatch(/\[\.\.\.inRoster,\s*\.\.\.offRoster\]/);
  });
});

describe('R6 G4 — selectVpMention short-circuits for off-roster', () => {
  it('checks vp._offRoster and bails without inserting', () => {
    // The short-circuit runs flashInviteHint then returns. We verify the
    // _offRoster guard sits BEFORE the applyMentionSelection call.
    const selectFn = chatInputSrc.match(
      /const selectVpMention = \(vp\) => \{[\s\S]*?\n    \};/
    );
    expect(selectFn).toBeTruthy();
    const body = selectFn[0];
    expect(body).toMatch(/vp\._offRoster/);
    expect(body).toMatch(/flashInviteHint/);
    // The guard must precede the mention insertion.
    expect(body.indexOf('vp._offRoster')).toBeLessThan(
      body.indexOf('applyMentionSelection'),
    );
  });
});

describe('R6 G4 — VpMentionAutocomplete renders grayed off-roster row', () => {
  it('applies vp-mention-off-roster class when _offRoster is set', () => {
    expect(autocompleteSrc).toMatch(/'vp-mention-off-roster':\s*vp\._offRoster/);
  });

  it('marks aria-disabled true for off-roster items', () => {
    expect(autocompleteSrc).toMatch(/aria-disabled="vp\._offRoster \? 'true' : null"/);
  });

  it('shows the off-roster badge with i18n key', () => {
    expect(autocompleteSrc).toMatch(/unify\.vp\.mention\.offRosterBadge/);
    expect(autocompleteSrc).toMatch(/unify\.vp\.mention\.offRosterHint/);
  });

  it('hides the role chip for off-roster (badge replaces it)', () => {
    expect(autocompleteSrc).toMatch(/v-if="vp\.role && !vp\._offRoster"/);
  });
});

describe('R6 G4 — chatStore invite hint surface', () => {
  it('declares unifyMentionInviteHints state', () => {
    expect(chatStoreSrc).toMatch(/unifyMentionInviteHints:\s*\[\]/);
  });

  it('exposes flashInviteHint action that pushes a hint with vpId + at', () => {
    expect(chatStoreSrc).toMatch(/flashInviteHint\s*\(\s*vpId\s*\)/);
    expect(chatStoreSrc).toMatch(/unifyMentionInviteHints,\s*\{ id, vpId, at: Date\.now\(\) \}/);
  });

  it('exposes dismissInviteHint action', () => {
    expect(chatStoreSrc).toMatch(/dismissInviteHint\s*\(\s*id\s*\)/);
  });
});

describe('R6 G4 — i18n keys present in en + zh', () => {
  const requiredKeys = [
    'unify.vp.mention.offRosterBadge',
    'unify.vp.mention.offRosterHint',
    'unify.vp.mention.inviteToast',
  ];
  for (const key of requiredKeys) {
    it(`en carries ${key}`, () => {
      expect(enI18nSrc).toContain(`'${key}'`);
    });
    it(`zh-CN carries ${key}`, () => {
      expect(zhI18nSrc).toContain(`'${key}'`);
    });
  }
});
