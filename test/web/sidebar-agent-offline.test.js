import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Tests for task-231: Agent offline → hide sidebar sessions.
 *
 * The fix adds `c.agentOnline !== false` to all 4 sidebar session computed properties:
 *   - pinnedChatConversations
 *   - unpinnedChatConversations
 *   - pinnedCrewConversations
 *   - unpinnedCrewConversations
 *
 * Validates:
 * 1. Agent online: sessions displayed normally
 * 2. Agent offline: sessions hidden (including pinned)
 * 3. Agent back online: sessions restored
 * 4. Multi-agent: only offline agent's sessions hidden
 * 5. Both chat and crew session types
 * 6. `agentOnline !== false` semantics (undefined = visible)
 */

// =============================================================================
// Helpers: replicate ChatPage.js computed property filter logic
// =============================================================================

/**
 * Simulate isSessionPinned using a pinnedSessions array.
 */
function createStore(conversations, pinnedSessions = []) {
  return {
    conversations,
    pinnedSessions,
    isSessionPinned(id) {
      return pinnedSessions.includes(id);
    }
  };
}

function pinnedChatConversations(store) {
  const pinned = store.conversations.filter(
    c => c.type !== 'crew' && c.agentOnline !== false && store.isSessionPinned(c.id)
  );
  return pinned.sort((a, b) =>
    store.pinnedSessions.indexOf(a.id) - store.pinnedSessions.indexOf(b.id)
  );
}

function unpinnedChatConversations(store) {
  return store.conversations.filter(
    c => c.type !== 'crew' && c.agentOnline !== false && !store.isSessionPinned(c.id)
  );
}

function pinnedCrewConversations(store) {
  const pinned = store.conversations.filter(
    c => c.type === 'crew' && c.agentOnline !== false && store.isSessionPinned(c.id)
  );
  return pinned.sort((a, b) =>
    store.pinnedSessions.indexOf(a.id) - store.pinnedSessions.indexOf(b.id)
  );
}

function unpinnedCrewConversations(store) {
  return store.conversations.filter(
    c => c.type === 'crew' && c.agentOnline !== false && !store.isSessionPinned(c.id)
  );
}

// =============================================================================
// 1. Agent online: all sessions visible
// =============================================================================
describe('Agent online: all sessions visible (task-231)', () => {
  it('shows chat sessions with agentOnline=true', () => {
    const store = createStore([
      { id: 'c1', type: 'chat', agentOnline: true, agentId: 'a1' },
      { id: 'c2', type: 'chat', agentOnline: true, agentId: 'a1' },
    ]);
    expect(unpinnedChatConversations(store).length).toBe(2);
  });

  it('shows crew sessions with agentOnline=true', () => {
    const store = createStore([
      { id: 'cr1', type: 'crew', agentOnline: true, agentId: 'a1' },
    ]);
    expect(unpinnedCrewConversations(store).length).toBe(1);
  });

  it('shows sessions with agentOnline=undefined (default visible)', () => {
    const store = createStore([
      { id: 'c1', type: 'chat', agentId: 'a1' },
      { id: 'cr1', type: 'crew', agentId: 'a1' },
    ]);
    // agentOnline not set → should still be visible (undefined !== false is true)
    expect(unpinnedChatConversations(store).length).toBe(1);
    expect(unpinnedCrewConversations(store).length).toBe(1);
  });

  it('shows pinned chat sessions with agentOnline=true', () => {
    const store = createStore(
      [{ id: 'c1', type: 'chat', agentOnline: true, agentId: 'a1' }],
      ['c1']
    );
    expect(pinnedChatConversations(store).length).toBe(1);
  });

  it('shows pinned crew sessions with agentOnline=true', () => {
    const store = createStore(
      [{ id: 'cr1', type: 'crew', agentOnline: true, agentId: 'a1' }],
      ['cr1']
    );
    expect(pinnedCrewConversations(store).length).toBe(1);
  });
});

// =============================================================================
// 2. Agent offline: sessions hidden (including pinned)
// =============================================================================
describe('Agent offline: sessions hidden (task-231)', () => {
  it('hides chat sessions with agentOnline=false', () => {
    const store = createStore([
      { id: 'c1', type: 'chat', agentOnline: false, agentId: 'a1' },
      { id: 'c2', type: 'chat', agentOnline: false, agentId: 'a1' },
    ]);
    expect(unpinnedChatConversations(store).length).toBe(0);
  });

  it('hides crew sessions with agentOnline=false', () => {
    const store = createStore([
      { id: 'cr1', type: 'crew', agentOnline: false, agentId: 'a1' },
    ]);
    expect(unpinnedCrewConversations(store).length).toBe(0);
  });

  it('hides pinned chat sessions with agentOnline=false', () => {
    const store = createStore(
      [{ id: 'c1', type: 'chat', agentOnline: false, agentId: 'a1' }],
      ['c1']
    );
    expect(pinnedChatConversations(store).length).toBe(0);
  });

  it('hides pinned crew sessions with agentOnline=false', () => {
    const store = createStore(
      [{ id: 'cr1', type: 'crew', agentOnline: false, agentId: 'a1' }],
      ['cr1']
    );
    expect(pinnedCrewConversations(store).length).toBe(0);
  });
});

// =============================================================================
// 3. Agent back online: sessions restored
// =============================================================================
describe('Agent back online: sessions restored (task-231)', () => {
  it('restores chat sessions when agentOnline changes from false to true', () => {
    const conversations = [
      { id: 'c1', type: 'chat', agentOnline: false, agentId: 'a1' },
      { id: 'c2', type: 'chat', agentOnline: false, agentId: 'a1' },
    ];
    const store = createStore(conversations);

    // Initially hidden
    expect(unpinnedChatConversations(store).length).toBe(0);

    // Agent comes back online
    conversations[0].agentOnline = true;
    conversations[1].agentOnline = true;

    expect(unpinnedChatConversations(store).length).toBe(2);
  });

  it('restores crew sessions when agentOnline changes from false to true', () => {
    const conversations = [
      { id: 'cr1', type: 'crew', agentOnline: false, agentId: 'a1' },
    ];
    const store = createStore(conversations);

    expect(unpinnedCrewConversations(store).length).toBe(0);

    conversations[0].agentOnline = true;
    expect(unpinnedCrewConversations(store).length).toBe(1);
  });

  it('restores pinned sessions when agent reconnects', () => {
    const conversations = [
      { id: 'c1', type: 'chat', agentOnline: false, agentId: 'a1' },
    ];
    const store = createStore(conversations, ['c1']);

    expect(pinnedChatConversations(store).length).toBe(0);

    conversations[0].agentOnline = true;
    expect(pinnedChatConversations(store).length).toBe(1);
  });
});

// =============================================================================
// 4. Multi-agent: only offline agent's sessions hidden
// =============================================================================
describe('Multi-agent: only offline agent sessions hidden (task-231)', () => {
  it('hides only offline agent chat sessions, keeps online agent sessions', () => {
    const store = createStore([
      { id: 'c1', type: 'chat', agentOnline: true, agentId: 'agent-A' },
      { id: 'c2', type: 'chat', agentOnline: false, agentId: 'agent-B' },
      { id: 'c3', type: 'chat', agentOnline: true, agentId: 'agent-A' },
    ]);
    const visible = unpinnedChatConversations(store);
    expect(visible.length).toBe(2);
    expect(visible.map(c => c.id)).toEqual(['c1', 'c3']);
  });

  it('hides only offline agent crew sessions, keeps online agent sessions', () => {
    const store = createStore([
      { id: 'cr1', type: 'crew', agentOnline: true, agentId: 'agent-A' },
      { id: 'cr2', type: 'crew', agentOnline: false, agentId: 'agent-B' },
    ]);
    const visible = unpinnedCrewConversations(store);
    expect(visible.length).toBe(1);
    expect(visible[0].id).toBe('cr1');
  });

  it('pinned sessions from offline agent are hidden while online agent pinned stay', () => {
    const store = createStore(
      [
        { id: 'c1', type: 'chat', agentOnline: true, agentId: 'agent-A' },
        { id: 'c2', type: 'chat', agentOnline: false, agentId: 'agent-B' },
      ],
      ['c1', 'c2']
    );
    const visible = pinnedChatConversations(store);
    expect(visible.length).toBe(1);
    expect(visible[0].id).toBe('c1');
  });

  it('mixed types: hides offline agent sessions across both chat and crew', () => {
    const store = createStore([
      { id: 'c1', type: 'chat', agentOnline: false, agentId: 'agent-offline' },
      { id: 'c2', type: 'chat', agentOnline: true, agentId: 'agent-online' },
      { id: 'cr1', type: 'crew', agentOnline: false, agentId: 'agent-offline' },
      { id: 'cr2', type: 'crew', agentOnline: true, agentId: 'agent-online' },
    ]);
    expect(unpinnedChatConversations(store).length).toBe(1);
    expect(unpinnedCrewConversations(store).length).toBe(1);
    expect(unpinnedChatConversations(store)[0].agentId).toBe('agent-online');
    expect(unpinnedCrewConversations(store)[0].agentId).toBe('agent-online');
  });
});

// =============================================================================
// 5. agentOnline !== false semantics
// =============================================================================
describe('agentOnline !== false semantics (task-231)', () => {
  it('agentOnline=true → visible', () => {
    const store = createStore([{ id: 'c1', type: 'chat', agentOnline: true }]);
    expect(unpinnedChatConversations(store).length).toBe(1);
  });

  it('agentOnline=undefined → visible (new session default)', () => {
    const store = createStore([{ id: 'c1', type: 'chat' }]);
    expect(unpinnedChatConversations(store).length).toBe(1);
  });

  it('agentOnline=null → visible', () => {
    const store = createStore([{ id: 'c1', type: 'chat', agentOnline: null }]);
    expect(unpinnedChatConversations(store).length).toBe(1);
  });

  it('agentOnline=false → hidden', () => {
    const store = createStore([{ id: 'c1', type: 'chat', agentOnline: false }]);
    expect(unpinnedChatConversations(store).length).toBe(0);
  });

  it('agentOnline=0 → visible (only strict false hides)', () => {
    // 0 !== false is true, so this session should be visible
    const store = createStore([{ id: 'c1', type: 'chat', agentOnline: 0 }]);
    // Note: 0 !== false is false in JS (== coercion), but !== is strict
    // Actually: 0 !== false → true (strict inequality), so session IS visible
    expect(unpinnedChatConversations(store).length).toBe(1);
  });
});

// =============================================================================
// 6. Source-level verification: ChatPage.js has the filter
// =============================================================================
describe('Source-level: ChatPage.js filter correctness (task-231)', () => {
  let chatPageSource;
  beforeAll(async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const base = resolve(import.meta.dirname, '../..');
    chatPageSource = readFileSync(resolve(base, 'web/components/ChatPage.js'), 'utf-8');
  });

  it('pinnedChatConversations has agentOnline !== false filter', () => {
    const match = chatPageSource.match(/pinnedChatConversations\(\)\s*\{[^}]+/);
    expect(match).not.toBeNull();
    expect(match[0]).toContain('agentOnline !== false');
  });

  it('unpinnedChatConversations has agentOnline !== false filter', () => {
    const match = chatPageSource.match(/unpinnedChatConversations\(\)\s*\{[^}]+/);
    expect(match).not.toBeNull();
    expect(match[0]).toContain('agentOnline !== false');
  });

  it('pinnedCrewConversations has agentOnline !== false filter', () => {
    const match = chatPageSource.match(/pinnedCrewConversations\(\)\s*\{[^}]+/);
    expect(match).not.toBeNull();
    expect(match[0]).toContain('agentOnline !== false');
  });

  it('unpinnedCrewConversations has agentOnline !== false filter', () => {
    const match = chatPageSource.match(/unpinnedCrewConversations\(\)\s*\{[^}]+/);
    expect(match).not.toBeNull();
    expect(match[0]).toContain('agentOnline !== false');
  });
});

// Need beforeAll for the source-level tests — imported at top
