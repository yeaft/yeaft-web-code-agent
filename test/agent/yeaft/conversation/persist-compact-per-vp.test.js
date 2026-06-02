/**
 * persist-compact-per-vp.test.js — isolation tests for per-(groupId, vpId)
 * compact summary + the VP-scoped hot-history loader.
 *
 * Regression: before 2026-06-01, `readCompactSummary` / `replaceCompactSummary`
 * pointed at a single session-global compact.md, so every group + every VP
 * in a session shared (and clobbered) the same file. We now want:
 *   - per-(group, vp) summaries are isolated
 *   - loadGroupHistoryForVp scopes by groupId AND filters tool transcripts
 *     of OTHER VPs while keeping their assistant text + this VP's tool arcs
 *   - hasAnyCompactSummaryForGroup is per-group
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConversationStore } from '../../../../agent/yeaft/conversation/persist.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-compact-per-vp-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => { mkdirSync(TEST_DIR, { recursive: true }); });
afterEach(() => { if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true }); });

describe('compact summary per-(groupId, vpId) isolation', () => {
  it('returns empty when neither file nor pair has been written', () => {
    const store = new ConversationStore(TEST_DIR);
    expect(store.readCompactSummaryFor('g1', 'vpA')).toBe('');
    expect(store.hasAnyCompactSummaryForGroup('g1')).toBe(false);
  });

  it('isolates summaries between (group, vp) pairs', () => {
    const store = new ConversationStore(TEST_DIR);
    store.replaceCompactSummaryFor('g1', 'vpA', 'A in g1 says hi');
    store.replaceCompactSummaryFor('g1', 'vpB', 'B in g1 says bye');
    store.replaceCompactSummaryFor('g2', 'vpA', 'A in g2 different group');

    expect(store.readCompactSummaryFor('g1', 'vpA')).toContain('A in g1 says hi');
    expect(store.readCompactSummaryFor('g1', 'vpA')).not.toContain('B in g1');
    expect(store.readCompactSummaryFor('g1', 'vpA')).not.toContain('A in g2');

    expect(store.readCompactSummaryFor('g1', 'vpB')).toContain('B in g1 says bye');
    expect(store.readCompactSummaryFor('g2', 'vpA')).toContain('A in g2 different group');
  });

  it('overwrites on each call (rewrite-in-place semantics)', () => {
    const store = new ConversationStore(TEST_DIR);
    store.replaceCompactSummaryFor('g1', 'vpA', 'first entry');
    store.replaceCompactSummaryFor('g1', 'vpA', 'second entry');
    const out = store.readCompactSummaryFor('g1', 'vpA');
    expect(out).not.toContain('first entry');
    expect(out).toContain('second entry');
  });

  it('hasAnyCompactSummaryForGroup is per-group, not session-global', () => {
    const store = new ConversationStore(TEST_DIR);
    store.replaceCompactSummaryFor('g1', 'vpA', 'hi');
    expect(store.hasAnyCompactSummaryForGroup('g1')).toBe(true);
    expect(store.hasAnyCompactSummaryForGroup('g2')).toBe(false);
  });

  it('returns empty when groupId or vpId missing (legacy callers)', () => {
    const store = new ConversationStore(TEST_DIR);
    store.replaceCompactSummaryFor('g1', 'vpA', 'real');
    expect(store.readCompactSummaryFor(null, 'vpA')).toBe('');
    expect(store.readCompactSummaryFor('g1', null)).toBe('');
    store.replaceCompactSummaryFor(null, 'vpA', 'ignored');
    expect(store.readCompactSummaryFor('g1', 'vpA')).not.toContain('ignored');
  });

  it('sanitizes unsafe characters in ids without collapsing distinct pairs', () => {
    const store = new ConversationStore(TEST_DIR);
    // Both "../" attempts and weird whitespace should land in the scoped
    // dir (not escape it) and remain distinct from a normal pair.
    store.replaceCompactSummaryFor('../weird', 'vp', 'A');
    store.replaceCompactSummaryFor('plain', 'vp', 'B');
    expect(store.readCompactSummaryFor('../weird', 'vp')).toContain('A');
    expect(store.readCompactSummaryFor('plain', 'vp')).toContain('B');
    expect(store.readCompactSummaryFor('../weird', 'vp')).not.toContain('B');
  });
});

describe('loadGroupHistoryForVp', () => {
  function seed(store) {
    // g1, multi-VP fan-out arc
    store.append({ role: 'user', content: 'hello team', groupId: 'g1' });
    store.append({
      role: 'assistant',
      content: 'A reply',
      groupId: 'g1',
      speakerVpId: 'vpA',
      toolCalls: [{ id: 'tA1', name: 'bash', input: { cmd: 'ls' } }],
    });
    store.append({
      role: 'tool', content: 'A tool result', groupId: 'g1',
      speakerVpId: 'vpA', toolCallId: 'tA1',
    });
    store.append({
      role: 'assistant',
      content: 'B reply',
      groupId: 'g1',
      speakerVpId: 'vpB',
      toolCalls: [{ id: 'tB1', name: 'bash', input: { cmd: 'pwd' } }],
    });
    store.append({
      role: 'tool', content: 'B tool result', groupId: 'g1',
      speakerVpId: 'vpB', toolCallId: 'tB1',
    });
    // Other group — must not leak in.
    store.append({ role: 'user', content: 'g2 prompt', groupId: 'g2' });
    store.append({ role: 'assistant', content: 'g2 reply', groupId: 'g2', speakerVpId: 'vpA' });
    // Internal/reflection row — must always be dropped.
    store.append({
      role: 'assistant', content: 'reflection chatter',
      groupId: 'g1', speakerVpId: 'vpA', _reflection: true,
    });
  }

  it('returns empty for missing args', () => {
    const store = new ConversationStore(TEST_DIR);
    seed(store);
    expect(store.loadGroupHistoryForVp(null, 'vpA')).toEqual([]);
    expect(store.loadGroupHistoryForVp('g1', null)).toEqual([]);
  });

  it('scopes by groupId — other groups never leak in', () => {
    const store = new ConversationStore(TEST_DIR);
    seed(store);
    const out = store.loadGroupHistoryForVp('g1', 'vpA');
    expect(out.every(m => m.groupId === 'g1')).toBe(true);
    expect(out.find(m => m.content === 'g2 prompt')).toBeUndefined();
    expect(out.find(m => m.content === 'g2 reply')).toBeUndefined();
  });

  it('keeps THIS VP assistant + tool arc, strips OTHER VPs tool arc', () => {
    const store = new ConversationStore(TEST_DIR);
    seed(store);
    const out = store.loadGroupHistoryForVp('g1', 'vpA');

    const aAsst = out.find(m => m.role === 'assistant' && m.speakerVpId === 'vpA');
    expect(aAsst).toBeTruthy();
    expect(aAsst.toolCalls).toBeTruthy();
    expect(aAsst.toolCalls[0].id).toBe('tA1');

    const aTool = out.find(m => m.role === 'tool' && m.speakerVpId === 'vpA');
    expect(aTool).toBeTruthy();
    expect(aTool.content).toBe('A tool result');

    const bAsst = out.find(m => m.role === 'assistant' && m.speakerVpId === 'vpB');
    expect(bAsst).toBeTruthy();
    expect(bAsst.content).toBe('B reply');
    // Other VP's toolCalls stripped.
    expect(bAsst.toolCalls).toBeUndefined();
    // Other VP's tool results dropped entirely.
    expect(out.find(m => m.role === 'tool' && m.speakerVpId === 'vpB')).toBeUndefined();
  });

  it('drops reflection/internal/systemOnly rows', () => {
    const store = new ConversationStore(TEST_DIR);
    seed(store);
    const out = store.loadGroupHistoryForVp('g1', 'vpA');
    expect(out.find(m => m.content === 'reflection chatter')).toBeUndefined();
  });

  it('keeps user prompts (they have no speakerVpId)', () => {
    const store = new ConversationStore(TEST_DIR);
    seed(store);
    const out = store.loadGroupHistoryForVp('g1', 'vpA');
    expect(out.find(m => m.role === 'user' && m.content === 'hello team')).toBeTruthy();
    // Same for vpB.
    const outB = store.loadGroupHistoryForVp('g1', 'vpB');
    expect(outB.find(m => m.role === 'user' && m.content === 'hello team')).toBeTruthy();
  });
});
