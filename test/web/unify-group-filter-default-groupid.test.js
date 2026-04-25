/**
 * Regression test: every Unify message must carry a groupId so the group
 * filter can use strict equality without hiding "untagged" history.
 *
 * Bug repro: clicking a sidebar group blanked out an active conversation
 * because legacy/restored history messages had no groupId.
 *
 * Fix: addMessageToConversation stamps groupId on every message that
 * lands in the active Unify conversation (defaulting to 'grp_default'),
 * and the group-filter getters use strict equality.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { addMessageToConversation } from '../../web/stores/helpers/messages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const STORE_PATH = path.join(ROOT, 'web', 'stores', 'chat.js');
const HELPERS_PATH = path.join(ROOT, 'web', 'stores', 'helpers', 'messages.js');

function makeStore({ activeGroup = null } = {}) {
  return {
    currentView: 'unify',
    unifyConversationId: 'conv-1',
    unifyActiveGroupFilter: activeGroup,
    messagesMap: {},
  };
}

describe('unify group filter — uniform groupId stamping', () => {
  it('stamps grp_default on user messages when no group filter is active', () => {
    const store = makeStore();
    addMessageToConversation(store, 'conv-1', { type: 'user', content: 'hi' });
    const msgs = store.messagesMap['conv-1'];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].groupId).toBe('grp_default');
  });

  it('stamps the active group filter when one is set', () => {
    const store = makeStore({ activeGroup: 'g1' });
    addMessageToConversation(store, 'conv-1', { type: 'assistant', content: 'hello' });
    expect(store.messagesMap['conv-1'][0].groupId).toBe('g1');
  });

  it('does not overwrite an explicit groupId', () => {
    const store = makeStore({ activeGroup: 'g1' });
    addMessageToConversation(store, 'conv-1', {
      type: 'task-message', content: 'x', groupId: 'g2',
    });
    expect(store.messagesMap['conv-1'][0].groupId).toBe('g2');
  });

  it('does NOT stamp groupId on chat-mode (non-Unify) conversations', () => {
    const store = {
      currentView: 'chat',
      unifyConversationId: null,
      unifyActiveGroupFilter: null,
      messagesMap: {},
    };
    addMessageToConversation(store, 'chat-conv', { type: 'user', content: 'hi' });
    expect(store.messagesMap['chat-conv'][0].groupId).toBeUndefined();
  });

  it('does NOT stamp groupId on a different conversation than the active Unify one', () => {
    const store = makeStore();
    addMessageToConversation(store, 'other-conv', { type: 'user', content: 'hi' });
    expect(store.messagesMap['other-conv'][0].groupId).toBeUndefined();
  });

  it('store source uses strict `m.groupId === target` equality (no untagged escape hatch)', () => {
    const src = readFileSync(STORE_PATH, 'utf8');
    const lenient = src.match(/!m\.groupId\s*\|\|\s*m\.groupId\s*===\s*target/g) || [];
    expect(lenient.length).toBe(0);
    const strict = src.match(/m\.groupId\s*===\s*target/g) || [];
    expect(strict.length).toBeGreaterThanOrEqual(2);
  });

  it('helper source declares DEFAULT_GROUP_ID = grp_default', () => {
    const src = readFileSync(HELPERS_PATH, 'utf8');
    expect(src).toMatch(/DEFAULT_GROUP_ID\s*=\s*['"]grp_default['"]/);
  });
});
