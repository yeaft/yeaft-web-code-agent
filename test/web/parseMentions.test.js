/**
 * test/web/parseMentions.test.js — task-334j
 *
 * Covers the 8 boundary cases specified in the 334j impl spec §3 / §9.
 * Pure unit tests — no DOM, no Vue, no Pinia.
 */
import { describe, it, expect } from 'vitest';
import { parseMentions, MAX_MENTIONS } from '../../web/utils/parseMentions.js';

describe('parseMentions', () => {
  it('extracts single @vpId from plain text', () => {
    const { mentions } = parseMentions('hey @alice how are you');
    expect(mentions).toEqual(['alice']);
  });

  it('extracts multiple @vpIds preserving first-seen order', () => {
    const { mentions } = parseMentions('cc @bob and @alice then @charlie');
    expect(mentions).toEqual(['bob', 'alice', 'charlie']);
  });

  it('dedups identical mentions keeping the first occurrence', () => {
    const { mentions } = parseMentions('@alice? @alice! and again @alice.');
    expect(mentions).toEqual(['alice']);
  });

  it('caps at MAX_MENTIONS=32 (R6 §Δ26.3 alignment)', () => {
    // Build 40 unique ids: vp01 .. vp40
    const tokens = [];
    for (let i = 1; i <= 40; i++) {
      tokens.push('@vp' + String(i).padStart(2, '0'));
    }
    const { mentions } = parseMentions(tokens.join(' '));
    expect(MAX_MENTIONS).toBe(32);
    expect(mentions.length).toBe(32);
    expect(mentions[0]).toBe('vp01');
    expect(mentions[31]).toBe('vp32');
  });

  it('does NOT match email addresses (foo@bar.com)', () => {
    const { mentions } = parseMentions('contact me at foo@example.com please');
    expect(mentions).toEqual([]);
  });

  it('does NOT match @ mid-identifier (word@word)', () => {
    // `hello@world` has no whitespace / punctuation before @ → no match.
    const { mentions } = parseMentions('literal hello@world token here');
    expect(mentions).toEqual([]);
  });

  it('matches after whitespace, punctuation, and at start-of-string', () => {
    // Start of string: `@alice`; after period: `.@bob`; after comma: `,@charlie`
    const { mentions } = parseMentions('@alice end.@bob,@charlie');
    expect(mentions.sort()).toEqual(['alice', 'bob', 'charlie'].sort());
  });

  it('filters out reserved vpIds (all/user/system/everyone) and pure-digit / underscore-prefix tokens', () => {
    const { mentions } = parseMentions(
      'hi @all please ping @user and @system but not @everyone or @_admin or @123'
    );
    // None of these pass the vpId rules: reserved, `_` prefix, all-digits.
    expect(mentions).toEqual([]);
  });
});
