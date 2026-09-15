// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest';
import { nextTick, reactive } from 'vue';
import { workbenchWorkspaceGeneration } from '../../../web/utils/workbench-route.js';

// chat.js reads `Pinia.defineStore` at import time, so install a minimal
// store factory before importing the real store definition. We only need
// the chat store instance; sibling stores are stubbed as empty objects.
let useChatStore;
let sessionsStore;

beforeAll(async () => {
  globalThis.Vue = { nextTick };
  globalThis.Pinia = {
    defineStore: (id, def) => {
      if (id !== 'chat') return () => ({});
      return () => {
        const store = reactive(def.state());
        for (const [key, fn] of Object.entries(def.actions || {})) {
          store[key] = fn.bind(store);
        }
        return store;
      };
    },
  };
  ({ useChatStore } = await import('../../../web/stores/chat.js'));
});

let store;

beforeEach(() => {
  store = useChatStore();
  store.currentAgent = 'agent-1';
  store.activeSessionRoute = {
    runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-1',
  };
  store.effectiveWorkDir = '/workspace/a';
  store.yeaftConversationId = 'session-1-conversation';
  sessionsStore = {
    activeSessionKey: 'agent-1\u001fsession-1',
    sessions: {
      'agent-1\u001fsession-1': { id: 'session-1', agentId: 'agent-1' },
    },
    sessionById(id, agentId) {
      return Object.values(this.sessions).find(session => session.id === id && (!agentId || session.agentId === agentId)) || null;
    },
  };
  globalThis.window.Pinia = {
    ...(globalThis.window.Pinia || {}),
    useSessionsStore: () => sessionsStore,
  };
  store.loadYeaftDebugHistory = vi.fn();
});

describe('YeaftDebugPanel store actions', () => {
  it('opens turn-scoped panel with loading status and issues a detail fetch', () => {
    store.workbenchExpanded = true;
    store.workbenchMaximized = true;

    store.openYeaftTurnDebug({ sessionId: 'session-1', turnId: 'turn-abc' });

    expect(store.workbenchExpanded).toBe(false);
    expect(store.workbenchMaximized).toBe(false);
    expect(store.yeaftDebugPanel.open).toBe(true);
    expect(store.yeaftDebugPanel.status).toBe('loading');
    expect(store.yeaftDebugPanel.agentId).toBe('agent-1');
    expect(store.yeaftDebugPanel.sessionId).toBe('session-1');
    expect(store.yeaftDebugPanel.turnId).toBe('turn-abc');
    expect(store.yeaftDebugPanel.error).toBeNull();
    expect(store.loadYeaftDebugHistory).toHaveBeenCalledWith({
      groupId: 'session-1',
      limit: 1,
      dreamLimit: 5,
      detailTurnId: 'turn-abc',
    });
  });

  it('restores Workbench visibility independently for each Agent Session route', () => {
    const sessionOne = { runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-1' };
    const sessionTwo = { runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-2' };

    store.restoreWorkbenchPanelState(sessionOne);
    expect(store.workbenchExpanded).toBe(false);
    expect(store.workbenchMaximized).toBe(false);

    store.workbenchExpanded = true;
    store.workbenchMaximized = true;
    expect(store.rememberWorkbenchPanelState(sessionOne, 640.4)).toBe(true);
    expect(store.workbenchPanelWidthForRoute(sessionOne)).toBe(640);

    store.restoreWorkbenchPanelState(sessionTwo);
    expect(store.workbenchExpanded).toBe(false);
    expect(store.workbenchMaximized).toBe(false);

    store.workbenchExpanded = true;
    store.workbenchMaximized = false;
    expect(store.rememberWorkbenchPanelState(sessionTwo, 480)).toBe(true);

    store.restoreWorkbenchPanelState(sessionOne);
    expect(store.workbenchExpanded).toBe(true);
    expect(store.workbenchMaximized).toBe(true);
    expect(store.workbenchPanelWidthForRoute(sessionOne)).toBe(640);
    store.restoreWorkbenchPanelState(sessionTwo);
    expect(store.workbenchExpanded).toBe(true);
    expect(store.workbenchMaximized).toBe(false);
    expect(store.workbenchPanelWidthForRoute(sessionTwo)).toBe(480);
  });

  it('closes debug when Workbench opens', () => {
    store.yeaftDebugPanel = {
      open: true,
      status: 'idle',
      requestId: null,
      agentId: 'agent-1',
      sessionId: 'session-1',
      turnId: null,
      error: null,
    };

    store.toggleWorkbench();

    expect(store.workbenchExpanded).toBe(true);
    expect(store.yeaftDebugPanel.open).toBe(false);
  });

  it('closes debug and releases its cached turn when a file opens Workbench directly', async () => {
    store.currentConversation = 'session-1';
    store.workbenchRouteProtocolSupported = true;
    store.agents = [{ id: 'agent-1', capabilities: ['file_editor', 'workbench_session_routes'] }];
    store.yeaftDebugPanel = {
      open: true,
      status: 'idle',
      requestId: null,
      agentId: 'agent-1',
      sessionId: 'session-1',
      turnId: 'turn-abc',
      error: null,
    };
    store.yeaftDebugTurnsById = { 'turn-abc': { turnId: 'turn-abc', loops: [] } };
    store.yeaftDebugTurnOrder = ['turn-abc'];
    store.yeaftDebugLoops = [{ turnId: 'turn-abc' }, { turnId: 'other' }];
    const dispatched = [];
    const listener = event => dispatched.push(event.detail);
    window.addEventListener('open-file-in-explorer', listener);

    expect(store.openFileInExplorer('docs/readme.md', { line: 12 })).toBe(true);
    await nextTick();

    window.removeEventListener('open-file-in-explorer', listener);
    expect(store.workbenchExpanded).toBe(true);
    expect(store.yeaftDebugPanel.open).toBe(false);
    expect(store.yeaftDebugTurnsById['turn-abc']).toBeUndefined();
    expect(store.yeaftDebugTurnOrder).not.toContain('turn-abc');
    expect(store.yeaftDebugLoops).toEqual([{ turnId: 'other' }]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      filePath: 'docs/readme.md',
      line: 12,
      workDir: '/workspace/a',
      workbenchRouteKey: 'yeaft:agent-1:session-1',
      workspaceGeneration: workbenchWorkspaceGeneration('yeaft:agent-1:session-1', '/workspace/a'),
    });
  });

  it('opens a Yeaft file against the route owner and its Agent-scoped conversation', async () => {
    store.currentAgent = 'agent-1';
    store.currentAgentInfo = { id: 'agent-1', capabilities: ['terminal'] };
    store.activeSessionRoute = {
      runtimeProvider: 'yeaft', agentId: 'agent-2', sessionId: 'session-2',
    };
    store.currentConversation = 'wrong-page-conversation';
    store.yeaftConversationId = 'wrong-global-conversation';
    store.yeaftConversationIdsByAgent = { 'agent-2': 'yeaft-agent-2' };
    store.workbenchRouteProtocolSupported = true;
    store.agents = [
      { id: 'agent-1', capabilities: ['terminal'] },
      { id: 'agent-2', capabilities: ['file_editor', 'workbench_session_routes'] },
    ];
    store.workbenchExpanded = true;
    const listener = vi.fn();
    window.addEventListener('open-file-in-explorer', listener);

    expect(store.openFileInExplorer(' docs/owned.md ', { hideTree: true, line: 7 })).toBe(true);

    window.removeEventListener('open-file-in-explorer', listener);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].detail).toMatchObject({
      filePath: 'docs/owned.md',
      agentId: 'agent-2',
      conversationId: 'yeaft-agent-2',
      workbenchRouteKey: 'yeaft:agent-2:session-2',
      hideTree: true,
      line: 7,
    });
  });

  it('uses the CLI conversation identity and returns false without route-owner file capabilities', () => {
    store.currentAgent = 'agent-1';
    store.activeSessionRoute = {
      runtimeProvider: 'claude-code', agentId: 'agent-2', sessionId: 'cli-2',
    };
    store.currentConversation = 'cli-2';
    store.workbenchRouteProtocolSupported = true;
    store.agents = [{ id: 'agent-2', capabilities: ['file_editor', 'workbench_session_routes'] }];
    store.workbenchExpanded = true;
    const listener = vi.fn();
    window.addEventListener('open-file-in-explorer', listener);

    expect(store.openFileInExplorer('src/cli.js')).toBe(true);
    expect(listener.mock.calls[0][0].detail).toMatchObject({
      agentId: 'agent-2', conversationId: 'cli-2',
      workbenchRouteKey: 'claude-code:agent-2:cli-2',
    });

    store.agents = [{ id: 'agent-2', capabilities: ['terminal'] }];
    expect(store.openFileInExplorer('src/rejected.js')).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener('open-file-in-explorer', listener);
  });

  it('resolves references using the route capability inventory and only when Files can open them', () => {
    store.currentConversation = 'session-1';
    store.currentAgentInfo = { id: 'agent-1', capabilities: ['terminal'] };
    store.workbenchRouteProtocolSupported = true;
    store.agents = [{ id: 'agent-1', capabilities: ['file_editor', 'file_reference_resolution', 'workbench_session_routes'] }];
    store.sendWsMessage = vi.fn(() => true);
    expect(store.resolveMessageFileReferences(['src/file.js'])).toEqual(expect.any(String));
    expect(store.sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resolve_file_references', agentId: 'agent-1', references: ['src/file.js'],
      workbenchRoute: { runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-1' },
    }));

    store.agents = [{ id: 'agent-1', capabilities: ['file_reference_resolution', 'workbench_session_routes'] }];
    expect(store.resolveMessageFileReferences(['src/file.js'])).toBeNull();
    expect(store.sendWsMessage).toHaveBeenCalledOnce();
  });

  it('drops a deferred file open when its frozen Session workspace drifts', async () => {
    store.currentConversation = 'session-1';
    store.workbenchRouteProtocolSupported = true;
    store.agents = [{ id: 'agent-1', capabilities: ['file_editor', 'workbench_session_routes'] }];
    store.workbenchExpanded = false;
    store.effectiveWorkDir = '/workspace/a';
    const dispatched = [];
    const listener = event => dispatched.push(event.detail);
    window.addEventListener('open-file-in-explorer', listener);

    expect(store.openFileInExplorer('docs/stale.md')).toBe(true);
    sessionsStore.activeSessionKey = 'agent-1\u001fsession-2';
    sessionsStore.sessions['agent-1\u001fsession-2'] = {
      id: 'session-2', agentId: 'agent-1', workDir: '/workspace/b',
    };
    store.activeSessionRoute = {
      runtimeProvider: 'yeaft', agentId: 'agent-1', sessionId: 'session-2',
    };
    store.currentConversation = 'session-2';
    store.effectiveWorkDir = '/workspace/b';
    await nextTick();

    window.removeEventListener('open-file-in-explorer', listener);
    expect(dispatched).toEqual([]);
  });

  it('uses the Session owner rather than a stale page-level Agent pointer', () => {
    sessionsStore.activeSessionKey = 'agent-2\u001fsession-1';
    sessionsStore.sessions = {
      'agent-2\u001fsession-1': { id: 'session-1', agentId: 'agent-2' },
    };
    store.currentAgent = 'agent-1';

    store.openYeaftTurnDebug({ sessionId: 'session-1', turnId: 'turn-abc' });

    expect(store.yeaftDebugPanel.agentId).toBe('agent-2');
    expect(store.loadYeaftDebugHistory).toHaveBeenCalledWith({
      groupId: 'session-1',
      limit: 1,
      dreamLimit: 5,
      detailTurnId: 'turn-abc',
    });
  });

  it('is a no-op without a resolvable agent', () => {
    store.currentAgent = null;
    sessionsStore.activeSessionKey = null;
    sessionsStore.sessions = {};
    store.yeaftDebugPanel = {
      open: false,
      status: 'idle',
      requestId: null,
      agentId: null,
      sessionId: null,
      turnId: null,
      error: null,
    };

    store.openYeaftTurnDebug({ sessionId: 'session-1', turnId: 'turn-abc' });

    expect(store.yeaftDebugPanel.open).toBe(false);
    expect(store.loadYeaftDebugHistory).not.toHaveBeenCalled();
  });

  it('closing a turn-scoped panel releases the cached turn payload', () => {
    store.openYeaftTurnDebug({ sessionId: 'session-1', turnId: 'turn-abc' });
    store.yeaftDebugTurnsById = { 'turn-abc': { turnId: 'turn-abc', loops: [] } };
    store.yeaftDebugTurnOrder = ['turn-abc'];
    store.yeaftDebugLoops = [{ turnId: 'turn-abc' }, { turnId: 'other' }];

    store.closeYeaftDebugPanel();

    expect(store.yeaftDebugPanel.open).toBe(false);
    expect(store.yeaftDebugPanel.turnId).toBeNull();
    expect(store.yeaftDebugTurnsById['turn-abc']).toBeUndefined();
    expect(store.yeaftDebugTurnOrder).not.toContain('turn-abc');
    expect(store.yeaftDebugLoops.some(l => l && l.turnId === 'turn-abc')).toBe(false);
    expect(store.yeaftDebugLoops.some(l => l && l.turnId === 'other')).toBe(true);
  });

  it('closing an already empty panel leaves the turn cache untouched', () => {
    store.yeaftDebugPanel = {
      open: true,
      status: 'idle',
      requestId: null,
      agentId: 'agent-1',
      sessionId: null,
      turnId: null,
      error: null,
    };
    store.yeaftDebugTurnsById = { 'turn-xyz': { turnId: 'turn-xyz', loops: [] } };
    store.yeaftDebugTurnOrder = ['turn-xyz'];
    store.yeaftDebugLoops = [{ turnId: 'turn-xyz' }];

    store.closeYeaftDebugPanel();

    expect(store.yeaftDebugPanel.open).toBe(false);
    expect(store.yeaftDebugTurnsById['turn-xyz']).toBeDefined();
    expect(store.yeaftDebugTurnOrder).toContain('turn-xyz');
  });
});
