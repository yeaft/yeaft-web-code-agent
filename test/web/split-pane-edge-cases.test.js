import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Tests for PR #371: split-pane edge cases — closeSession, conversation_created,
 * selectConversation.
 *
 * 8 test areas: closeSession linkage, deleteConversation linkage,
 * handleConversationDeleted linkage, conversation_created split mode,
 * conversation_resumed split mode, selectConversation no-op,
 * non-split regression, source code verification.
 */

// =====================================================================
// Behavioral simulation helpers
// =====================================================================

function createStore(overrides = {}) {
  return {
    panels: [],
    activeConversations: [],
    conversations: [],
    messagesMap: {},
    processingConversations: {},
    executionStatusMap: {},
    crewSessions: {},
    crewMessagesMap: {},
    crewOlderMessages: {},
    crewStatuses: {},
    conversationTitles: {},
    subagents: {},
    currentAgent: 'agent-1',
    currentAgentInfo: { id: 'agent-1', name: 'Agent 1' },
    currentConversation: null,
    currentWorkDir: '/home/user',
    agents: [{ id: 'agent-1', name: 'Agent 1' }],
    lastViewedConversation: null,
    hasMoreMessages: false,
    loadingMoreMessages: false,
    _closedAt: {},
    _wsSent: [],
    sendWsMessage(msg) { this._wsSent.push(msg); return true; },
    addMessage() {},
    addMessageToConversation() {},
    saveOpenSessions() {},
    getOrCreateExecutionStatus() {},
    finishStreamingForConversation() {},
    formatDbMessage(m) { return [m]; },
    ...overrides
  };
}

// Simulate closeSession's splitPane cleanup logic
function simulateCloseSession(store, conversationId) {
  // Remove from conversations
  store.conversations = store.conversations.filter(c => c.id !== conversationId);
  delete store.messagesMap[conversationId];
  delete store.processingConversations[conversationId];

  // Remove from activeConversations
  const activeIdx = store.activeConversations.indexOf(conversationId);
  if (activeIdx >= 0) {
    store.activeConversations.splice(activeIdx, 1);
  }

  // KEY FIX: Clear from panels if present
  for (const pane of store.panels) {
    if (pane.conversationId === conversationId) {
      pane.conversationId = null;
    }
  }
}

// Simulate deleteConversation's splitPane cleanup logic
function simulateDeleteConversation(store, conversationId) {
  store.conversations = store.conversations.filter(c => c.id !== conversationId);
  const delIdx = store.activeConversations.indexOf(conversationId);
  if (delIdx >= 0) {
    store.activeConversations.splice(delIdx, 1);
  }

  // KEY FIX: Clear from panels if present
  for (const pane of store.panels) {
    if (pane.conversationId === conversationId) {
      pane.conversationId = null;
    }
  }
}

// Simulate handleConversationDeleted's splitPane cleanup logic
function simulateHandleConversationDeleted(store, msg) {
  store.conversations = store.conversations.filter(c => c.id !== msg.conversationId);
  delete store.messagesMap[msg.conversationId];
  delete store.conversationTitles[msg.conversationId];
  delete store.processingConversations[msg.conversationId];

  const delIdx = store.activeConversations.indexOf(msg.conversationId);
  if (delIdx >= 0) {
    store.activeConversations.splice(delIdx, 1);
  }

  // KEY FIX: Clear from panels if present
  for (const pane of store.panels) {
    if (pane.conversationId === msg.conversationId) {
      pane.conversationId = null;
    }
  }
}

// Simulate handleConversationCreated with split mode logic
function simulateConversationCreated(store, msg) {
  store.conversations.push({
    id: msg.conversationId,
    agentId: msg.agentId,
    workDir: msg.workDir,
    type: 'chat'
  });

  // KEY FIX: Split mode logic
  if (store.panels.length > 1) {
    const emptyPane = store.panels.find(p => !p.conversationId);
    if (emptyPane) {
      emptyPane.conversationId = msg.conversationId;
    }
    if (!store.activeConversations.includes(msg.conversationId)) {
      store.activeConversations.push(msg.conversationId);
    }
  } else {
    store.activeConversations = [msg.conversationId];
  }
  store.messagesMap[msg.conversationId] = [];
}

// Simulate handleConversationResumed with split mode logic
function simulateConversationResumed(store, msg) {
  store.conversations.push({
    id: msg.conversationId,
    agentId: msg.agentId,
    workDir: msg.workDir,
    claudeSessionId: msg.claudeSessionId,
    type: 'chat'
  });

  // KEY FIX: Split mode logic
  if (store.panels.length > 1) {
    const emptyPane = store.panels.find(p => !p.conversationId);
    if (emptyPane) {
      emptyPane.conversationId = msg.conversationId;
    }
    if (!store.activeConversations.includes(msg.conversationId)) {
      store.activeConversations.push(msg.conversationId);
    }
  } else {
    store.activeConversations = [msg.conversationId];
  }
  store.messagesMap[msg.conversationId] = [];
}

// Simulate selectConversation with split mode routing to active panel
function simulateSelectConversation(store, conversationId) {
  // In split mode, route to active panel instead of being a no-op
  if (store.panels.length > 1) {
    const targetPanelId = store.activePanelId || store.panels[0]?.id;
    if (targetPanelId) {
      const targetPane = store.panels.find(p => p.id === targetPanelId);
      if (targetPane) targetPane.conversationId = conversationId;
    }
    return;
  }

  if (conversationId === store.currentConversation) return;
  store.activeConversations = [conversationId];
}

// =====================================================================
// 1. closeSession clears panels
// =====================================================================

describe('closeSession — panels cleanup', () => {
  it('should set pane.conversationId to null when matching session is closed', () => {
    const store = createStore({
      panels: [
        { conversationId: 'conv-1' },
        { conversationId: 'conv-2' }
      ],
      activeConversations: ['conv-1', 'conv-2'],
      conversations: [{ id: 'conv-1' }, { id: 'conv-2' }],
      messagesMap: { 'conv-1': [], 'conv-2': [] }
    });

    simulateCloseSession(store, 'conv-1');

    expect(store.panels[0].conversationId).toBeNull();
    expect(store.panels[1].conversationId).toBe('conv-2');
  });

  it('should not affect panes with different conversationId', () => {
    const store = createStore({
      panels: [
        { conversationId: 'conv-1' },
        { conversationId: 'conv-2' }
      ],
      activeConversations: ['conv-1', 'conv-2'],
      conversations: [{ id: 'conv-1' }, { id: 'conv-2' }, { id: 'conv-3' }],
      messagesMap: { 'conv-1': [], 'conv-2': [], 'conv-3': [] }
    });

    simulateCloseSession(store, 'conv-3');

    expect(store.panels[0].conversationId).toBe('conv-1');
    expect(store.panels[1].conversationId).toBe('conv-2');
  });

  it('should handle closing session that appears in multiple panes', () => {
    const store = createStore({
      panels: [
        { conversationId: 'conv-1' },
        { conversationId: 'conv-1' }
      ],
      activeConversations: ['conv-1'],
      conversations: [{ id: 'conv-1' }],
      messagesMap: { 'conv-1': [] }
    });

    simulateCloseSession(store, 'conv-1');

    expect(store.panels[0].conversationId).toBeNull();
    expect(store.panels[1].conversationId).toBeNull();
  });

  it('should work with empty panels array (non-split mode)', () => {
    const store = createStore({
      panels: [],
      activeConversations: ['conv-1'],
      conversations: [{ id: 'conv-1' }],
      messagesMap: { 'conv-1': [] }
    });

    simulateCloseSession(store, 'conv-1');

    expect(store.panels).toEqual([]);
    expect(store.activeConversations).toEqual([]);
  });
});

// =====================================================================
// 2. deleteConversation clears panels
// =====================================================================

describe('deleteConversation — panels cleanup', () => {
  it('should set pane.conversationId to null when matching conversation is deleted', () => {
    const store = createStore({
      panels: [
        { conversationId: 'conv-1' },
        { conversationId: 'conv-2' }
      ],
      activeConversations: ['conv-1', 'conv-2'],
      conversations: [{ id: 'conv-1' }, { id: 'conv-2' }]
    });

    simulateDeleteConversation(store, 'conv-2');

    expect(store.panels[0].conversationId).toBe('conv-1');
    expect(store.panels[1].conversationId).toBeNull();
  });

  it('should remove from activeConversations AND clear panels', () => {
    const store = createStore({
      panels: [
        { conversationId: 'conv-1' },
        { conversationId: 'conv-2' }
      ],
      activeConversations: ['conv-1', 'conv-2'],
      conversations: [{ id: 'conv-1' }, { id: 'conv-2' }]
    });

    simulateDeleteConversation(store, 'conv-1');

    expect(store.activeConversations).toEqual(['conv-2']);
    expect(store.panels[0].conversationId).toBeNull();
  });
});

// =====================================================================
// 3. handleConversationDeleted clears panels
// =====================================================================

describe('handleConversationDeleted — panels cleanup', () => {
  it('should set pane.conversationId to null on server-side delete notification', () => {
    const store = createStore({
      panels: [
        { conversationId: 'conv-1' },
        { conversationId: 'conv-2' }
      ],
      activeConversations: ['conv-1', 'conv-2'],
      conversations: [{ id: 'conv-1' }, { id: 'conv-2' }],
      messagesMap: { 'conv-1': [], 'conv-2': [] }
    });

    simulateHandleConversationDeleted(store, { conversationId: 'conv-1' });

    expect(store.panels[0].conversationId).toBeNull();
    expect(store.panels[1].conversationId).toBe('conv-2');
  });

  it('should handle deleting conversation not in any pane', () => {
    const store = createStore({
      panels: [
        { conversationId: 'conv-1' },
        { conversationId: 'conv-2' }
      ],
      activeConversations: ['conv-1', 'conv-2', 'conv-3'],
      conversations: [{ id: 'conv-1' }, { id: 'conv-2' }, { id: 'conv-3' }],
      messagesMap: { 'conv-3': [] }
    });

    simulateHandleConversationDeleted(store, { conversationId: 'conv-3' });

    expect(store.panels[0].conversationId).toBe('conv-1');
    expect(store.panels[1].conversationId).toBe('conv-2');
  });
});

// =====================================================================
// 4. conversation_created in split mode
// =====================================================================

describe('conversation_created — split mode', () => {
  it('should fill first empty pane instead of overwriting activeConversations', () => {
    const store = createStore({
      panels: [
        { conversationId: 'conv-1' },
        { conversationId: null }
      ],
      activeConversations: ['conv-1']
    });

    simulateConversationCreated(store, {
      conversationId: 'conv-new',
      agentId: 'agent-1',
      workDir: '/home'
    });

    expect(store.panels[1].conversationId).toBe('conv-new');
    expect(store.activeConversations).toContain('conv-1');
    expect(store.activeConversations).toContain('conv-new');
  });

  it('should not overwrite existing pane conversations', () => {
    const store = createStore({
      panels: [
        { conversationId: 'conv-1' },
        { conversationId: null }
      ],
      activeConversations: ['conv-1']
    });

    simulateConversationCreated(store, {
      conversationId: 'conv-new',
      agentId: 'agent-1',
      workDir: '/home'
    });

    expect(store.panels[0].conversationId).toBe('conv-1');
  });

  it('should push to activeConversations, not replace', () => {
    const store = createStore({
      panels: [
        { conversationId: 'conv-1' },
        { conversationId: null }
      ],
      activeConversations: ['conv-1']
    });

    simulateConversationCreated(store, {
      conversationId: 'conv-new',
      agentId: 'agent-1',
      workDir: '/home'
    });

    expect(store.activeConversations.length).toBe(2);
    expect(store.activeConversations[0]).toBe('conv-1');
    expect(store.activeConversations[1]).toBe('conv-new');
  });

  it('should not crash when all panes are occupied', () => {
    const store = createStore({
      panels: [
        { conversationId: 'conv-1' },
        { conversationId: 'conv-2' }
      ],
      activeConversations: ['conv-1', 'conv-2']
    });

    simulateConversationCreated(store, {
      conversationId: 'conv-new',
      agentId: 'agent-1',
      workDir: '/home'
    });

    // No empty pane found — still adds to activeConversations
    expect(store.activeConversations).toContain('conv-new');
    // Both existing panes should be unchanged
    expect(store.panels[0].conversationId).toBe('conv-1');
    expect(store.panels[1].conversationId).toBe('conv-2');
  });

  it('should not duplicate in activeConversations if already present', () => {
    const store = createStore({
      panels: [
        { conversationId: 'conv-1' },
        { conversationId: null }
      ],
      activeConversations: ['conv-1', 'conv-new'] // already present
    });

    simulateConversationCreated(store, {
      conversationId: 'conv-new',
      agentId: 'agent-1',
      workDir: '/home'
    });

    const count = store.activeConversations.filter(id => id === 'conv-new').length;
    expect(count).toBe(1);
  });
});

// =====================================================================
// 5. conversation_resumed in split mode
// =====================================================================

describe('conversation_resumed — split mode', () => {
  it('should fill first empty pane on resume', () => {
    const store = createStore({
      panels: [
        { conversationId: 'conv-1' },
        { conversationId: null }
      ],
      activeConversations: ['conv-1']
    });

    simulateConversationResumed(store, {
      conversationId: 'conv-resumed',
      agentId: 'agent-1',
      workDir: '/home',
      claudeSessionId: 'session-abc'
    });

    expect(store.panels[1].conversationId).toBe('conv-resumed');
    expect(store.activeConversations).toContain('conv-resumed');
    expect(store.activeConversations).toContain('conv-1');
  });

  it('should push to activeConversations without replacing', () => {
    const store = createStore({
      panels: [
        { conversationId: 'conv-1' },
        { conversationId: null }
      ],
      activeConversations: ['conv-1']
    });

    simulateConversationResumed(store, {
      conversationId: 'conv-resumed',
      agentId: 'agent-1',
      workDir: '/home',
      claudeSessionId: 'session-abc'
    });

    expect(store.activeConversations.length).toBe(2);
  });

  it('should not crash when no empty pane available', () => {
    const store = createStore({
      panels: [
        { conversationId: 'conv-1' },
        { conversationId: 'conv-2' }
      ],
      activeConversations: ['conv-1', 'conv-2']
    });

    simulateConversationResumed(store, {
      conversationId: 'conv-resumed',
      agentId: 'agent-1',
      workDir: '/home',
      claudeSessionId: 'session-abc'
    });

    // Should not crash, adds to activeConversations
    expect(store.activeConversations).toContain('conv-resumed');
    expect(store.panels[0].conversationId).toBe('conv-1');
    expect(store.panels[1].conversationId).toBe('conv-2');
  });
});

// =====================================================================
// 6. selectConversation routes to active panel in split mode
// =====================================================================

describe('selectConversation — split mode panel routing', () => {
  it('should route conversation to active panel in split mode', () => {
    const store = createStore({
      panels: [
        { id: 'panel-0', conversationId: 'conv-1' },
        { id: 'panel-1', conversationId: 'conv-2' }
      ],
      activePanelId: 'panel-1',
      activeConversations: ['conv-1', 'conv-2'],
      currentConversation: 'conv-1'
    });

    simulateSelectConversation(store, 'conv-3');

    // Should route conv-3 to the active panel (panel-1)
    expect(store.panels[1].conversationId).toBe('conv-3');
    // Panel-0 should be unchanged
    expect(store.panels[0].conversationId).toBe('conv-1');
  });

  it('should fall back to first panel when no activePanelId', () => {
    const store = createStore({
      panels: [
        { id: 'panel-0', conversationId: 'conv-1' },
        { id: 'panel-1', conversationId: 'conv-2' }
      ],
      activePanelId: null,
      activeConversations: ['conv-1', 'conv-2'],
      currentConversation: 'conv-1'
    });

    simulateSelectConversation(store, 'conv-new');

    expect(store.panels[0].conversationId).toBe('conv-new');
  });

  it('should work normally when panels has only 1 pane (not split mode)', () => {
    const store = createStore({
      panels: [{ id: 'panel-0', conversationId: 'conv-1' }],
      activeConversations: ['conv-1'],
      currentConversation: 'conv-1'
    });

    simulateSelectConversation(store, 'conv-new');

    expect(store.activeConversations).toEqual(['conv-new']);
  });
});

// =====================================================================
// 7. Non-split mode regression
// =====================================================================

describe('non-split mode — regression', () => {
  it('conversation_created should overwrite activeConversations (single pane)', () => {
    const store = createStore({
      panels: [{ conversationId: 'conv-1' }],
      activeConversations: ['conv-1']
    });

    simulateConversationCreated(store, {
      conversationId: 'conv-new',
      agentId: 'agent-1',
      workDir: '/home'
    });

    expect(store.activeConversations).toEqual(['conv-new']);
  });

  it('conversation_created should overwrite activeConversations (empty splitPanes)', () => {
    const store = createStore({
      panels: [],
      activeConversations: ['conv-1']
    });

    simulateConversationCreated(store, {
      conversationId: 'conv-new',
      agentId: 'agent-1',
      workDir: '/home'
    });

    expect(store.activeConversations).toEqual(['conv-new']);
  });

  it('conversation_resumed should overwrite activeConversations in non-split mode', () => {
    const store = createStore({
      panels: [],
      activeConversations: ['conv-1']
    });

    simulateConversationResumed(store, {
      conversationId: 'conv-resumed',
      agentId: 'agent-1',
      workDir: '/home',
      claudeSessionId: 'session-xyz'
    });

    expect(store.activeConversations).toEqual(['conv-resumed']);
  });

  it('selectConversation should work normally in non-split mode', () => {
    const store = createStore({
      panels: [],
      activeConversations: ['conv-1'],
      currentConversation: 'conv-1'
    });

    simulateSelectConversation(store, 'conv-2');

    expect(store.activeConversations).toEqual(['conv-2']);
  });

  it('closeSession should work normally without panels', () => {
    const store = createStore({
      panels: [],
      activeConversations: ['conv-1'],
      conversations: [{ id: 'conv-1' }],
      messagesMap: { 'conv-1': [] }
    });

    simulateCloseSession(store, 'conv-1');

    expect(store.conversations).toEqual([]);
    expect(store.activeConversations).toEqual([]);
  });
});

// =====================================================================
// 8. Source code verification
// =====================================================================

describe('source code verification', () => {
  let convSource;
  let handlerSource;

  beforeEach(() => {
    convSource = fs.readFileSync(
      path.join(process.cwd(), 'web/stores/helpers/conversation.js'),
      'utf-8'
    );
    handlerSource = fs.readFileSync(
      path.join(process.cwd(), 'web/stores/helpers/handlers/conversationHandler.js'),
      'utf-8'
    );
  });

  // closeSession panels cleanup
  it('closeSession should iterate panels to clear matching conversationId', () => {
    const fnStart = convSource.indexOf('export function closeSession');
    const fnEnd = convSource.indexOf('export function deleteConversation');
    const fn = convSource.slice(fnStart, fnEnd);
    expect(fn).toContain('for (const pane of store.panels)');
    expect(fn).toContain('pane.conversationId === conversationId');
    expect(fn).toContain('pane.conversationId = null');
  });

  // deleteConversation panels cleanup
  it('deleteConversation should iterate panels to clear matching conversationId', () => {
    const fnStart = convSource.indexOf('export function deleteConversation');
    const fnEnd = convSource.indexOf('export function sendMessage');
    const fn = convSource.slice(fnStart, fnEnd);
    expect(fn).toContain('for (const pane of store.panels)');
    expect(fn).toContain('pane.conversationId === conversationId');
    expect(fn).toContain('pane.conversationId = null');
  });

  // selectConversation split mode — routes to active panel
  it('selectConversation should route to active panel when panels.length > 1', () => {
    const fnStart = convSource.indexOf('export function selectConversation');
    const fnEnd = convSource.indexOf('export function updateConversationSettings');
    const fn = convSource.slice(fnStart, fnEnd);
    expect(fn).toContain('store.panels.length > 1');
    expect(fn).toContain('setPanelConversation');
    expect(fn).toContain('return');
  });

  // handleConversationCreated split mode
  it('handleConversationCreated should check panels.length > 1', () => {
    const fnStart = handlerSource.indexOf('export function handleConversationCreated');
    const fnEnd = handlerSource.indexOf('export function handleConversationResumed');
    const fn = handlerSource.slice(fnStart, fnEnd);
    expect(fn).toContain('store.panels.length > 1');
    expect(fn).toContain('emptyPane = store.panels.find');
    expect(fn).toContain('activeConversations.push');
  });

  // handleConversationResumed split mode
  it('handleConversationResumed should check panels.length > 1', () => {
    const fnStart = handlerSource.indexOf('export function handleConversationResumed');
    const fnEnd = handlerSource.indexOf('export function handleConversationDeleted');
    const fn = handlerSource.slice(fnStart, fnEnd);
    expect(fn).toContain('store.panels.length > 1');
    expect(fn).toContain('emptyPane = store.panels.find');
    expect(fn).toContain('activeConversations.push');
  });

  // handleConversationDeleted panels cleanup
  it('handleConversationDeleted should iterate panels to clear matching conversationId', () => {
    const fnStart = handlerSource.indexOf('export function handleConversationDeleted');
    const fnEnd = handlerSource.indexOf('export function handleTurnCompleted');
    const fn = handlerSource.slice(fnStart, fnEnd);
    expect(fn).toContain('for (const pane of store.panels)');
    expect(fn).toContain('pane.conversationId === msg.conversationId');
    expect(fn).toContain('pane.conversationId = null');
  });

  // Non-split mode: conversation_created still overwrites activeConversations
  it('handleConversationCreated should overwrite activeConversations in non-split (else branch)', () => {
    const fnStart = handlerSource.indexOf('export function handleConversationCreated');
    const fnEnd = handlerSource.indexOf('export function handleConversationResumed');
    const fn = handlerSource.slice(fnStart, fnEnd);
    expect(fn).toContain('store.activeConversations = [msg.conversationId]');
  });

  // Non-split mode: conversation_resumed still overwrites activeConversations
  it('handleConversationResumed should overwrite activeConversations in non-split (else branch)', () => {
    const fnStart = handlerSource.indexOf('export function handleConversationResumed');
    const fnEnd = handlerSource.indexOf('export function handleConversationDeleted');
    const fn = handlerSource.slice(fnStart, fnEnd);
    expect(fn).toContain('store.activeConversations = [msg.conversationId]');
  });

  // All 3 delete paths have panels cleanup
  it('all delete paths (closeSession, deleteConversation, handleConversationDeleted) have panels cleanup', () => {
    // closeSession
    const cs = convSource.slice(
      convSource.indexOf('export function closeSession'),
      convSource.indexOf('export function deleteConversation')
    );
    expect(cs).toContain('store.panels');

    // deleteConversation
    const dc = convSource.slice(
      convSource.indexOf('export function deleteConversation'),
      convSource.indexOf('export function sendMessage')
    );
    expect(dc).toContain('store.panels');

    // handleConversationDeleted
    const hcd = handlerSource.slice(
      handlerSource.indexOf('export function handleConversationDeleted'),
      handlerSource.indexOf('export function handleTurnCompleted')
    );
    expect(hcd).toContain('store.panels');
  });
});
