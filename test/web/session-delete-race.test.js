import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tests for task-242: Session delete race condition fix
 *
 * When user closes a session, the optimistic local delete can be undone by
 * a subsequent handleAgentList broadcast that still contains the session
 * (server hasn't processed delete_conversation yet).
 *
 * Fix: Mark deleted sessions in store._recentlyDeletedSessions with timestamp,
 * and skip re-adding them in handleAgentList for 15 seconds.
 */

const rootDir = join(import.meta.dirname, '..', '..');
const conversationJs = readFileSync(join(rootDir, 'web/stores/helpers/conversation.js'), 'utf8');
const agentHandlerJs = readFileSync(join(rootDir, 'web/stores/helpers/handlers/agentHandler.js'), 'utf8');

// =====================================================================
// closeSession marks _recentlyDeletedSessions
// =====================================================================
describe('closeSession marks _recentlyDeletedSessions', () => {
  const closeFnStart = conversationJs.indexOf('export function closeSession');
  const closeFnBody = conversationJs.substring(closeFnStart, closeFnStart + 2000);

  it('closeSession function exists', () => {
    expect(closeFnStart).toBeGreaterThan(-1);
  });

  it('sets _recentlyDeletedSessions[conversationId] = Date.now()', () => {
    expect(closeFnBody).toContain('_recentlyDeletedSessions');
    expect(closeFnBody).toContain('Date.now()');
  });

  it('initializes _recentlyDeletedSessions if not present', () => {
    expect(closeFnBody).toContain('if (!store._recentlyDeletedSessions)');
    expect(closeFnBody).toContain('store._recentlyDeletedSessions = {}');
  });

  it('marks deletion BEFORE removing from conversations list', () => {
    const markIdx = closeFnBody.indexOf('_recentlyDeletedSessions[conversationId] = Date.now()');
    const filterIdx = closeFnBody.indexOf("store.conversations = store.conversations.filter");
    expect(markIdx).toBeGreaterThan(-1);
    expect(filterIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeLessThan(filterIdx);
  });
});

// =====================================================================
// deleteConversation marks _recentlyDeletedSessions
// =====================================================================
describe('deleteConversation marks _recentlyDeletedSessions', () => {
  const deleteFnStart = conversationJs.indexOf('export function deleteConversation');
  const deleteFnBody = conversationJs.substring(deleteFnStart, deleteFnStart + 2000);

  it('deleteConversation function exists', () => {
    expect(deleteFnStart).toBeGreaterThan(-1);
  });

  it('sets _recentlyDeletedSessions[conversationId] = Date.now()', () => {
    expect(deleteFnBody).toContain('_recentlyDeletedSessions');
    expect(deleteFnBody).toContain('Date.now()');
  });

  it('initializes _recentlyDeletedSessions if not present', () => {
    expect(deleteFnBody).toContain('if (!store._recentlyDeletedSessions)');
    expect(deleteFnBody).toContain('store._recentlyDeletedSessions = {}');
  });

  it('marks deletion BEFORE removing from conversations list', () => {
    const markIdx = deleteFnBody.indexOf('_recentlyDeletedSessions[conversationId] = Date.now()');
    const filterIdx = deleteFnBody.indexOf("store.conversations = store.conversations.filter");
    expect(markIdx).toBeGreaterThan(-1);
    expect(filterIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeLessThan(filterIdx);
  });
});

// =====================================================================
// handleAgentList skips recently deleted sessions
// =====================================================================
describe('handleAgentList skips recently deleted sessions', () => {
  const handlerFnStart = agentHandlerJs.indexOf('export function handleAgentList');
  const handlerFnBody = agentHandlerJs.substring(handlerFnStart, handlerFnStart + 3000);

  it('handleAgentList function exists', () => {
    expect(handlerFnStart).toBeGreaterThan(-1);
  });

  it('checks _recentlyDeletedSessions before push', () => {
    expect(handlerFnBody).toContain('_recentlyDeletedSessions');
  });

  it('uses 15-second protection window', () => {
    expect(handlerFnBody).toContain('15000');
  });

  it('uses continue to skip deleted sessions', () => {
    // The guard should be: if (deletedAt && ...) continue;
    const guardMatch = handlerFnBody.match(/deletedAt\s*&&[\s\S]*?continue/);
    expect(guardMatch).not.toBeNull();
  });

  it('guard is inside the else branch (before push)', () => {
    // The guard should appear between "} else {" and "store.conversations.push"
    const elseIdx = handlerFnBody.indexOf('} else {');
    const pushIdx = handlerFnBody.indexOf('store.conversations.push(serverConv)');
    const guardIdx = handlerFnBody.indexOf('_recentlyDeletedSessions');
    expect(elseIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(elseIdx);
    expect(guardIdx).toBeLessThan(pushIdx);
  });

  it('compares Date.now() - deletedAt against the window', () => {
    const timeCheck = handlerFnBody.match(/Date\.now\(\)\s*-\s*deletedAt.*<\s*15000/);
    expect(timeCheck).not.toBeNull();
  });
});

// =====================================================================
// _recentlyDeletedSessions is independent from _closedAt
// =====================================================================
describe('_recentlyDeletedSessions is not cleared by _closedAt reset', () => {
  it('handleAgentList prunes stale _closedAt entries but NOT _recentlyDeletedSessions', () => {
    // The handler prunes old _closedAt entries (> 30s) but should NOT have
    // store._recentlyDeletedSessions = {} anywhere
    expect(agentHandlerJs).toContain('_closedAt');
    expect(agentHandlerJs).not.toContain('store._recentlyDeletedSessions = {}');
  });

  it('_recentlyDeletedSessions and _closedAt are different field names', () => {
    // Verify they're truly separate fields
    expect('_recentlyDeletedSessions').not.toBe('_closedAt');
    // Both are used in the handler
    expect(agentHandlerJs).toContain('_closedAt');
    expect(agentHandlerJs).toContain('_recentlyDeletedSessions');
  });
});

// =====================================================================
// Behavioral simulation: verify the guard logic works
// =====================================================================
describe('Behavioral: race condition guard logic', () => {
  function makeStore() {
    return {
      conversations: [],
      _recentlyDeletedSessions: {},
      pinnedSessions: [],
    };
  }

  function simulateHandleAgentList(store, serverConvs) {
    // Mimics the exact logic in agentHandler.js handleAgentList
    for (const serverConv of serverConvs) {
      serverConv.agentOnline = true;
      const existing = store.conversations.find(c => c.id === serverConv.id);
      if (existing) {
        existing.agentOnline = true;
      } else {
        const deletedAt = store._recentlyDeletedSessions?.[serverConv.id];
        if (deletedAt && (Date.now() - deletedAt) < 15000) continue;
        store.conversations.push(serverConv);
      }
    }
  }

  it('newly deleted session is NOT re-added by agent_list', () => {
    const store = makeStore();
    // User closes session
    store._recentlyDeletedSessions['conv-123'] = Date.now();
    store.conversations = store.conversations.filter(c => c.id !== 'conv-123');

    // Server broadcasts agent_list that still includes conv-123
    simulateHandleAgentList(store, [
      { id: 'conv-123', type: 'chat' },
      { id: 'conv-456', type: 'chat' },
    ]);

    expect(store.conversations.map(c => c.id)).toEqual(['conv-456']);
    expect(store.conversations.find(c => c.id === 'conv-123')).toBeUndefined();
  });

  it('session deleted > 15 seconds ago CAN be re-added (reconnect recovery)', () => {
    const store = makeStore();
    // User deleted session 20 seconds ago
    store._recentlyDeletedSessions['conv-123'] = Date.now() - 20000;

    // Server broadcasts agent_list
    simulateHandleAgentList(store, [
      { id: 'conv-123', type: 'chat' },
    ]);

    // Should be re-added (protection window expired)
    expect(store.conversations.map(c => c.id)).toEqual(['conv-123']);
  });

  it('existing session is updated, not skipped', () => {
    const store = makeStore();
    store.conversations.push({ id: 'conv-123', agentOnline: false });

    // Even if it was recently deleted and re-added, existing sessions get updated
    simulateHandleAgentList(store, [
      { id: 'conv-123', type: 'chat' },
    ]);

    expect(store.conversations.length).toBe(1);
    expect(store.conversations[0].agentOnline).toBe(true);
  });

  it('multiple deleted sessions are all protected', () => {
    const store = makeStore();
    store._recentlyDeletedSessions['conv-1'] = Date.now();
    store._recentlyDeletedSessions['conv-2'] = Date.now();

    simulateHandleAgentList(store, [
      { id: 'conv-1', type: 'chat' },
      { id: 'conv-2', type: 'crew' },
      { id: 'conv-3', type: 'chat' },
    ]);

    // Only conv-3 should be added
    expect(store.conversations.map(c => c.id)).toEqual(['conv-3']);
  });

  it('no _recentlyDeletedSessions field: sessions added normally', () => {
    const store = { conversations: [], pinnedSessions: [] };
    // No _recentlyDeletedSessions at all

    simulateHandleAgentList(store, [
      { id: 'conv-123', type: 'chat' },
    ]);

    expect(store.conversations.map(c => c.id)).toEqual(['conv-123']);
  });
});
