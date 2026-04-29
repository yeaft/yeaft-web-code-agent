/**
 * Tests for agent/unify/memory/keywords.js — pure-rule keyword extractor.
 * Extracted from the deleted R5 recall.js test cases that exercised
 * extractKeywords specifically.
 */

import { describe, it, expect } from 'vitest';
import { extractKeywords } from '../../../../agent/unify/memory/keywords.js';

describe('extractKeywords', () => {
  it('returns [] for empty / whitespace input', () => {
    expect(extractKeywords('')).toEqual([]);
    expect(extractKeywords('   ')).toEqual([]);
    expect(extractKeywords(null)).toEqual([]);
  });

  it('filters stop words', () => {
    const out = extractKeywords('the quick brown fox is in the box');
    expect(out).toContain('quick');
    expect(out).toContain('brown');
    expect(out).toContain('fox');
    expect(out).toContain('box');
    expect(out).not.toContain('the');
    expect(out).not.toContain('is');
    expect(out).not.toContain('in');
  });

  it('sorts by frequency descending then alpha', () => {
    const out = extractKeywords('alpha beta beta gamma gamma gamma');
    expect(out[0]).toBe('gamma');
    expect(out[1]).toBe('beta');
    expect(out[2]).toBe('alpha');
  });

  it('handles CJK text', () => {
    const out = extractKeywords('帮我写一个排序算法 排序 排序');
    expect(out).toContain('排序');
    // stop words like '帮', '帮我', '一个' should be filtered
    expect(out).not.toContain('帮');
    expect(out).not.toContain('帮我');
  });

  it('lowercases tokens', () => {
    const out = extractKeywords('Hello WORLD World');
    expect(out).toContain('world');
    expect(out).toContain('hello');
  });

  it('skips single-character tokens', () => {
    const out = extractKeywords('a b cat');
    expect(out).toEqual(['cat']);
  });
});
