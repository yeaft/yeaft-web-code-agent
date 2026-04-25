/**
 * Regression test: Unify group filter must NOT hide messages that have
 * no groupId (legacy chat/assistant turns, history restored from the
 * conversation store). Only messages tagged with a different groupId
 * should be excluded.
 *
 * Bug repro: clicking a sidebar group blanked out an active conversation
 * because every restored history message lacks a groupId field.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const STORE_PATH = path.join(ROOT, 'web', 'stores', 'chat.js');

// Pure functional mirror of the chat.js getter logic for currentChatMessages
// and unifyVisibleMessages when a group filter is active. Kept in lockstep
// with web/stores/chat.js — the assertion below pins the source string so
// drift trips this test rather than silently falling back to the stale
// behaviour.
function applyGroupFilter(raw, target) {
  return raw.filter(m => m && (!m.groupId || m.groupId === target));
}

describe('unify group filter — keep untagged messages', () => {
  const msgs = [
    { type: 'user', content: 'hi' },                         // no groupId — legacy
    { type: 'assistant', content: 'hello' },                 // no groupId — legacy
    { type: 'task-message', content: 'a', groupId: 'g1' },
    { type: 'task-message', content: 'b', groupId: 'g2' },
  ];

  it('returns untagged + same-group messages when group filter is active', () => {
    const out = applyGroupFilter(msgs, 'g1');
    expect(out).toHaveLength(3);
    expect(out.find(m => m.content === 'hi')).toBeTruthy();
    expect(out.find(m => m.content === 'hello')).toBeTruthy();
    expect(out.find(m => m.content === 'a')).toBeTruthy();
    expect(out.find(m => m.content === 'b')).toBeUndefined();
  });

  it('store source uses the (!m.groupId || m.groupId === target) form', () => {
    const src = readFileSync(STORE_PATH, 'utf8');
    // Both currentChatMessages and unifyVisibleMessages getters must use
    // the lenient form. Counting occurrences guards against a future
    // change that re-adds the strict form to one branch only.
    const matches = src.match(/!m\.groupId\s*\|\|\s*m\.groupId\s*===\s*target/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('store source no longer contains the strict form `m.groupId === target` without the untagged escape hatch', () => {
    const src = readFileSync(STORE_PATH, 'utf8');
    // The strict pattern that caused the bug: a filter line where groupId
    // is compared to target with no `!m.groupId ||` prefix on the same line.
    const strict = src.match(/filter\(m\s*=>\s*m\s*&&\s*m\.groupId\s*===\s*target\)/g) || [];
    expect(strict.length).toBe(0);
  });
});
