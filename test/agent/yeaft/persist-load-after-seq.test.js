import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';

describe('ConversationStore.loadAfterSeqByGroup', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yeaft-after-seq-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns messages strictly greater than afterSeq, ordered ascending', () => {
    const store = new ConversationStore(dir);
    for (let i = 1; i <= 10; i++) {
      store.append({ role: i % 2 === 1 ? 'user' : 'assistant', content: `m${i}`, sessionId: 'grpA' });
    }
    const all = store.loadRecentBySession('grpA', Infinity);
    expect(all.length).toBe(10);
    const cursor = store.getMessageSeqById(all[4].id); // seq of m5
    const { messages, latestSeq } = store.loadAfterSeqByGroup('grpA', cursor);
    expect(messages.map(m => m.content)).toEqual(['m6', 'm7', 'm8', 'm9', 'm10']);
    expect(latestSeq).toBe(store.getMessageSeqById(all[9].id));
  });

  it('returns empty when afterSeq is null', () => {
    const store = new ConversationStore(dir);
    store.append({ role: 'user', content: 'hi', sessionId: 'grpA' });
    expect(store.loadAfterSeqByGroup('grpA', null)).toEqual({ messages: [], latestSeq: null });
  });

  it('respects limit', () => {
    const store = new ConversationStore(dir);
    for (let i = 1; i <= 8; i++) {
      store.append({ role: i % 2 === 1 ? 'user' : 'assistant', content: `m${i}`, sessionId: 'grpA' });
    }
    const all = store.loadRecentBySession('grpA', Infinity);
    const cursor = store.getMessageSeqById(all[0].id); // seq of m1 → expect m2..m8
    const { messages } = store.loadAfterSeqByGroup('grpA', cursor, { limit: 3 });
    expect(messages.map(m => m.content)).toEqual(['m2', 'm3', 'm4']);
  });

  it('does not bleed across sessions', () => {
    const store = new ConversationStore(dir);
    store.append({ role: 'user', content: 'A1', sessionId: 'grpA' });
    store.append({ role: 'user', content: 'B1', sessionId: 'grpB' });
    store.append({ role: 'user', content: 'A2', sessionId: 'grpA' });
    const { messages } = store.loadAfterSeqByGroup('grpA', 0);
    expect(messages.every(m => m.sessionId === 'grpA')).toBe(true);
    expect(messages.map(m => m.content)).toEqual(['A1', 'A2']);
  });

  it('getMessageSeqById returns null for invalid ids', () => {
    const store = new ConversationStore(dir);
    expect(store.getMessageSeqById(null)).toBe(null);
    expect(store.getMessageSeqById('')).toBe(null);
    expect(store.getMessageSeqById('not-a-seq-id')).toBe(null);
  });
});

describe('ConversationStore.loadVisibleBySession', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yeaft-visible-history-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('keeps VP assistant text when visible replay excludes tool-result rows', () => {
    const store = new ConversationStore(dir);
    store.append({ role: 'user', content: 'question', sessionId: 'grp_tools' });
    store.append({
      role: 'assistant',
      content: 'answer after using a tool',
      sessionId: 'grp_tools',
      speakerVpId: 'vp_linus',
      toolCalls: [{ id: 'tc1', name: 'Read', input: { file: 'x' } }],
    });
    store.append({ role: 'tool', content: 'tool output', sessionId: 'grp_tools', speakerVpId: 'vp_linus', toolCallId: 'tc1' });

    const page = store.loadVisibleBySession('grp_tools', null, 5);

    expect(page.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(page.messages[1]).toEqual(expect.objectContaining({
      content: 'answer after using a tool',
      speakerVpId: 'vp_linus',
    }));
    expect(page.messages[1]).not.toHaveProperty('toolCalls');
  });
});
