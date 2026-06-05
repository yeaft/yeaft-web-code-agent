/**
 * dedup.test.js — pins the `sameUserMessage` contract.
 *
 * Background: fix-usermsg-dup. The rule "prefer clientMessageId equality;
 * fall back to content-equality only when neither side carries an id"
 * used to live as inline boolean expressions in four places — the
 * claudeOutput echo dedup, the conversationHandler sync-replay
 * orphan-merge, the per-call-site mirror in tests, and an early test
 * helper. Fowler's review of PR #904 (I2) called out the duplication
 * as a drift risk: a regression in one call site silently slips past
 * the others. The helper now lives in `web/stores/helpers/dedup.js`
 * and these tests pin its three branches so a future change to one
 * branch can't quietly weaken the contract everywhere.
 */
import { describe, it, expect } from 'vitest';

const { sameUserMessage } = await import('../../../../web/stores/helpers/dedup.js');

describe('sameUserMessage — strong path (both sides have clientMessageId)', () => {
  it('matches when ids are equal', () => {
    const a = { type: 'user', clientMessageId: 'cm_abc', content: 'hello' };
    const b = { type: 'user', clientMessageId: 'cm_abc', content: 'hello' };
    expect(sameUserMessage(a, b)).toBe(true);
  });

  it('does NOT match when ids differ — even with identical content', () => {
    // Two distinct sends of the same text are NOT the same logical message.
    const a = { type: 'user', clientMessageId: 'cm_abc', content: 'hello' };
    const b = { type: 'user', clientMessageId: 'cm_xyz', content: 'hello' };
    expect(sameUserMessage(a, b)).toBe(false);
  });

  it('matches by id alone — content drift does not break identity', () => {
    // Defensive: if a later layer mutates content, id still matches.
    const a = { type: 'user', clientMessageId: 'cm_abc', content: 'hello' };
    const b = { type: 'user', clientMessageId: 'cm_abc', content: 'hello (edited)' };
    expect(sameUserMessage(a, b)).toBe(true);
  });
});

describe('sameUserMessage — mixed path (only one side has clientMessageId)', () => {
  it('refuses to match when only `a` has an id', () => {
    const a = { type: 'user', clientMessageId: 'cm_abc', content: 'hello' };
    const b = { type: 'user', content: 'hello' };
    expect(sameUserMessage(a, b)).toBe(false);
  });

  it('refuses to match when only `b` has an id', () => {
    const a = { type: 'user', content: 'hello' };
    const b = { type: 'user', clientMessageId: 'cm_abc', content: 'hello' };
    expect(sameUserMessage(a, b)).toBe(false);
  });

  it('treats null/empty clientMessageId on one side as "no id"', () => {
    // Empty / null on one side ≠ id on the other. Don't false-positive.
    const a = { type: 'user', clientMessageId: '', content: 'hello' };
    const b = { type: 'user', clientMessageId: 'cm_abc', content: 'hello' };
    expect(sameUserMessage(a, b)).toBe(false);
  });
});

describe('sameUserMessage — legacy path (neither side has clientMessageId)', () => {
  it('matches identical content', () => {
    const a = { type: 'user', content: 'hello' };
    const b = { type: 'user', content: 'hello' };
    expect(sameUserMessage(a, b)).toBe(true);
  });

  it('does NOT match different content', () => {
    const a = { type: 'user', content: 'hello' };
    const b = { type: 'user', content: 'world' };
    expect(sameUserMessage(a, b)).toBe(false);
  });

  it('treats null and undefined clientMessageId as "no id" (legacy fallback applies)', () => {
    const a = { type: 'user', clientMessageId: null, content: 'hello' };
    const b = { type: 'user', clientMessageId: undefined, content: 'hello' };
    expect(sameUserMessage(a, b)).toBe(true);
  });
});

describe('sameUserMessage — guards', () => {
  it('returns false on null inputs', () => {
    expect(sameUserMessage(null, { type: 'user', content: 'x' })).toBe(false);
    expect(sameUserMessage({ type: 'user', content: 'x' }, null)).toBe(false);
    expect(sameUserMessage(null, null)).toBe(false);
  });

  it('returns false on undefined inputs', () => {
    expect(sameUserMessage(undefined, { type: 'user', content: 'x' })).toBe(false);
    expect(sameUserMessage({ type: 'user', content: 'x' }, undefined)).toBe(false);
  });

  it('returns false when either side is not a user message', () => {
    const user = { type: 'user', content: 'hello' };
    const assistant = { type: 'assistant', content: 'hello' };
    expect(sameUserMessage(user, assistant)).toBe(false);
    expect(sameUserMessage(assistant, user)).toBe(false);
  });

  it('returns false when both sides are assistant rows even with same id', () => {
    // The contract is user-only by design. Assistant rows have their
    // own dedup path (dbMessageId in conversationHandler).
    const a = { type: 'assistant', clientMessageId: 'cm_abc', content: 'x' };
    const b = { type: 'assistant', clientMessageId: 'cm_abc', content: 'x' };
    expect(sameUserMessage(a, b)).toBe(false);
  });
});
