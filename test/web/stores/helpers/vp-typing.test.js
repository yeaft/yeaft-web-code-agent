/**
 * Tests for the per-conversation, per-VP typing-indicator counter.
 *
 * The bug this guards against (Bug A in PR #698 follow-up):
 *   `unifyVpTyping` USED to be a flat `{ [vpId]: count }` map, shared
 *   across every conversation in the store. So while a Unify VP was
 *   streaming, the typing dot rendered for that VP NO MATTER which
 *   conversation the user was viewing — switching to a Chat tab still
 *   showed "Steve Jobs is typing" overlaid on the chat view.
 *
 *   Fix: nest by conversationId so the data structure itself encodes the
 *   isolation. Components look up only their own conversation's slice.
 *   When the user is in a Chat tab, the lookup yields an empty list and
 *   no Unify typing rows leak across the mode boundary.
 *
 *   Pure helpers — no Pinia / Vue reactivity required.
 */
import { describe, it, expect } from 'vitest';
import {
  incVpTyping,
  decVpTyping,
  getVpTyping,
  vpsTypingIn,
} from '../../../../web/stores/helpers/vp-typing.js';

describe('incVpTyping', () => {
  it('creates a fresh nested entry on first increment', () => {
    const next = incVpTyping({}, 'conv-1', 'vp-jobs');
    expect(next).toEqual({ 'conv-1': { 'vp-jobs': 1 } });
  });

  it('counts overlapping increments for the same (conv, vp) pair', () => {
    let s = incVpTyping({}, 'conv-1', 'vp-jobs');
    s = incVpTyping(s, 'conv-1', 'vp-jobs');
    s = incVpTyping(s, 'conv-1', 'vp-jobs');
    expect(s['conv-1']['vp-jobs']).toBe(3);
  });

  it('keeps separate counters for different conversations (isolation)', () => {
    let s = {};
    s = incVpTyping(s, 'unify-conv', 'vp-jobs');
    s = incVpTyping(s, 'chat-conv', 'vp-jobs');
    expect(s).toEqual({
      'unify-conv': { 'vp-jobs': 1 },
      'chat-conv': { 'vp-jobs': 1 },
    });
  });

  it('returns a NEW root reference (Vue reactivity friendly)', () => {
    const before = {};
    const after = incVpTyping(before, 'conv-1', 'vp-jobs');
    expect(after).not.toBe(before);
  });

  it('does not mutate the input object', () => {
    const before = { 'conv-1': { 'vp-jobs': 1 } };
    const snapshot = JSON.parse(JSON.stringify(before));
    incVpTyping(before, 'conv-1', 'vp-rams');
    expect(before).toEqual(snapshot);
  });
});

describe('decVpTyping', () => {
  it('decrements and prunes to 0 → removes the vpId key', () => {
    let s = incVpTyping({}, 'conv-1', 'vp-jobs');
    s = decVpTyping(s, 'conv-1', 'vp-jobs');
    expect(s).toEqual({});
  });

  it('keeps the vpId key when count is still positive', () => {
    let s = incVpTyping({}, 'conv-1', 'vp-jobs');
    s = incVpTyping(s, 'conv-1', 'vp-jobs');
    s = decVpTyping(s, 'conv-1', 'vp-jobs');
    expect(s).toEqual({ 'conv-1': { 'vp-jobs': 1 } });
  });

  it('removes the conversation branch entirely when last vpId is decremented', () => {
    let s = incVpTyping({}, 'conv-1', 'vp-jobs');
    s = incVpTyping(s, 'conv-1', 'vp-rams');
    s = decVpTyping(s, 'conv-1', 'vp-jobs');
    s = decVpTyping(s, 'conv-1', 'vp-rams');
    expect(s).toEqual({});
  });

  it('handles missing keys gracefully (no throw, no negatives)', () => {
    const after = decVpTyping({}, 'no-such-conv', 'no-such-vp');
    expect(after).toEqual({});
  });
});

describe('getVpTyping', () => {
  it('returns 0 for unknown conversation (Chat-side lookup case)', () => {
    const root = { 'unify-conv': { 'vp-jobs': 1 } };
    expect(getVpTyping(root, 'chat-conv', 'vp-jobs')).toBe(0);
  });

  it('returns the count for a known (conv, vp) pair', () => {
    const root = { 'unify-conv': { 'vp-jobs': 2 } };
    expect(getVpTyping(root, 'unify-conv', 'vp-jobs')).toBe(2);
  });

  it('returns 0 for null/undefined inputs', () => {
    expect(getVpTyping(null, 'c', 'v')).toBe(0);
    expect(getVpTyping({}, null, 'v')).toBe(0);
    expect(getVpTyping({}, 'c', null)).toBe(0);
  });
});

describe('vpsTypingIn — the Chat ↔ Unify isolation property', () => {
  it('returns vpIds typing in the requested conversation', () => {
    const root = {
      'unify-conv': { 'vp-jobs': 1, 'vp-rams': 1 },
      'chat-conv': {},
    };
    const ids = vpsTypingIn(root, 'unify-conv').sort();
    expect(ids).toEqual(['vp-jobs', 'vp-rams']);
  });

  it('returns [] for a conversation with no typing entries — Chat side stays quiet', () => {
    const root = { 'unify-conv': { 'vp-jobs': 1 } };
    expect(vpsTypingIn(root, 'chat-conv')).toEqual([]);
  });

  it('returns [] when conversationId is null', () => {
    const root = { 'unify-conv': { 'vp-jobs': 1 } };
    expect(vpsTypingIn(root, null)).toEqual([]);
  });

  it('full scenario: Unify mid-stream, user switches to Chat — no leak', () => {
    // Two-VP Unify dispatch starts: both typing.
    let s = {};
    s = incVpTyping(s, 'unify-conv', 'vp-jobs');
    s = incVpTyping(s, 'unify-conv', 'vp-rams');

    // While they're streaming, the Chat tab asks "anyone typing in MY conv?"
    // Bug A repro: under the old flat shape this returned both VPs.
    expect(vpsTypingIn(s, 'chat-conv')).toEqual([]);

    // Unify view sees them both.
    expect(vpsTypingIn(s, 'unify-conv').sort()).toEqual(['vp-jobs', 'vp-rams']);

    // One VP finishes — Chat view still sees nothing; Unify view sees one.
    s = decVpTyping(s, 'unify-conv', 'vp-jobs');
    expect(vpsTypingIn(s, 'chat-conv')).toEqual([]);
    expect(vpsTypingIn(s, 'unify-conv')).toEqual(['vp-rams']);
  });
});
