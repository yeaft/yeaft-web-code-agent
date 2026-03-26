import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Tests for PR #332: Conductor V5 UI refactor.
 *
 * The refactor removes ConductorConfigPanel, removes the sidebar Conductor
 * section, adds per-agent Conductor button in the agent dropdown, moves
 * header duties to ChatHeader, and introduces the 1:1 openConductor model.
 *
 * Test approach: behavioral simulation + source code verification (same
 * pattern as crew-text-merge-taskid.test.js, btw-server.test.js).
 */

// =====================================================================
// Source files loaded once for verification tests
// =====================================================================

let chatHeaderSource;
let chatPageSource;
let conductorChatViewSource;
let conductorActivePanelSource;
let conductorHelperSource;
let chatStoreSource;
let conductorCssSource;
let conductorConfigCssSource;

beforeAll(() => {
  const base = resolve(__dirname, '../../web');
  chatHeaderSource = readFileSync(resolve(base, 'components/ChatHeader.js'), 'utf-8');
  chatPageSource = readFileSync(resolve(base, 'components/ChatPage.js'), 'utf-8');
  conductorChatViewSource = readFileSync(resolve(base, 'components/conductor/ConductorChatView.js'), 'utf-8');
  conductorActivePanelSource = readFileSync(resolve(base, 'components/conductor/ConductorActivePanel.js'), 'utf-8');
  conductorHelperSource = readFileSync(resolve(base, 'stores/helpers/conductor.js'), 'utf-8');
  chatStoreSource = readFileSync(resolve(base, 'stores/chat.js'), 'utf-8');
  conductorCssSource = readFileSync(resolve(base, 'styles/conductor.css'), 'utf-8');
  conductorConfigCssSource = readFileSync(resolve(base, 'styles/conductor-config.css'), 'utf-8');
});

// =====================================================================
// 1. Agent dropdown: per-agent Conductor button with disabled states
// =====================================================================

describe('agent dropdown Conductor button', () => {
  it('ChatPage should contain agent-dropdown-conductor-btn per agent', () => {
    expect(chatPageSource).toContain('agent-dropdown-conductor-btn');
    // The button is inside the v-for agent loop
    expect(chatPageSource).toContain('@click.stop="openConductor(agent.id)"');
  });

  it('button should be disabled when agent is offline or lacks crew capability', () => {
    // :disabled="!agent.online || !agent.capabilities?.includes('crew')"
    expect(chatPageSource).toContain("!agent.online || !agent.capabilities?.includes('crew')");
  });

  it('should simulate disabled logic: offline agent', () => {
    const agent = { id: 'a1', online: false, capabilities: ['crew'] };
    const disabled = !agent.online || !agent.capabilities?.includes('crew');
    expect(disabled).toBe(true);
  });

  it('should simulate disabled logic: no crew capability', () => {
    const agent = { id: 'a2', online: true, capabilities: ['terminal'] };
    const disabled = !agent.online || !agent.capabilities?.includes('crew');
    expect(disabled).toBe(true);
  });

  it('should simulate disabled logic: online with crew → enabled', () => {
    const agent = { id: 'a3', online: true, capabilities: ['terminal', 'crew'] };
    const disabled = !agent.online || !agent.capabilities?.includes('crew');
    expect(disabled).toBe(false);
  });

  it('should simulate disabled logic: null capabilities → disabled', () => {
    const agent = { id: 'a4', online: true, capabilities: null };
    const disabled = !agent.online || !agent.capabilities?.includes('crew');
    expect(disabled).toBe(true);
  });

  it('CSS should define .agent-dropdown-conductor-btn styles', () => {
    expect(conductorCssSource).toContain('.agent-dropdown-conductor-btn');
    expect(conductorCssSource).toContain('.agent-dropdown-conductor-btn:disabled');
  });
});

// =====================================================================
// 2. openConductor 1:1 model: resume existing or create new
// =====================================================================

describe('openConductor 1:1 model', () => {
  // Simulate the openConductor logic from conductor.js
  function simulateOpenConductor(store, agentId) {
    const existing = store.conversations.find(
      c => c.type === 'conductor' && c.agentId === agentId
    );

    if (existing) {
      store.selectedConversation = existing.id;
      store.selectedAgent = agentId;
      return { action: 'resumed', sessionId: existing.id };
    }

    const sessionId = 'cond_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    store.conductorMessages[sessionId] = [];
    store.conductorTasks[sessionId] = {};
    store.conductorActors[sessionId] = {};
    store.sentMessages.push({
      type: 'create_conductor_session',
      sessionId,
      agentId
    });
    return { action: 'created', sessionId };
  }

  it('should resume existing conductor conversation for same agent', () => {
    const store = {
      conversations: [
        { id: 'cond_existing', type: 'conductor', agentId: 'agent1' },
        { id: 'conv_normal', type: 'chat', agentId: 'agent1' }
      ],
      conductorMessages: {},
      conductorTasks: {},
      conductorActors: {},
      sentMessages: [],
      selectedConversation: null,
      selectedAgent: null
    };

    const result = simulateOpenConductor(store, 'agent1');
    expect(result.action).toBe('resumed');
    expect(result.sessionId).toBe('cond_existing');
    expect(store.selectedConversation).toBe('cond_existing');
    expect(store.sentMessages).toHaveLength(0); // no ws message sent
  });

  it('should create new conductor session when none exists', () => {
    const store = {
      conversations: [
        { id: 'conv_chat', type: 'chat', agentId: 'agent2' }
      ],
      conductorMessages: {},
      conductorTasks: {},
      conductorActors: {},
      sentMessages: []
    };

    const result = simulateOpenConductor(store, 'agent2');
    expect(result.action).toBe('created');
    expect(result.sessionId).toMatch(/^cond_/);
    expect(store.conductorMessages[result.sessionId]).toEqual([]);
    expect(store.conductorTasks[result.sessionId]).toEqual({});
    expect(store.conductorActors[result.sessionId]).toEqual({});
    expect(store.sentMessages).toHaveLength(1);
    expect(store.sentMessages[0].type).toBe('create_conductor_session');
    expect(store.sentMessages[0].agentId).toBe('agent2');
  });

  it('should not resume conductor of a different agent', () => {
    const store = {
      conversations: [
        { id: 'cond_agent1', type: 'conductor', agentId: 'agent1' }
      ],
      conductorMessages: {},
      conductorTasks: {},
      conductorActors: {},
      sentMessages: []
    };

    const result = simulateOpenConductor(store, 'agent2');
    expect(result.action).toBe('created');
    expect(store.sentMessages[0].agentId).toBe('agent2');
  });

  it('source: conductor.js should export openConductor function', () => {
    expect(conductorHelperSource).toContain('export function openConductor(store, agentId)');
  });

  it('source: chat.js should wire openConductor action', () => {
    expect(chatStoreSource).toContain('openConductor(agentId)');
    expect(chatStoreSource).toContain('conductorHelpers.openConductor');
  });
});

// =====================================================================
// 3. ChatHeader: "Agent · Conductor" title, cost label, Tasks toggle
// =====================================================================

describe('ChatHeader conductor enhancements', () => {
  // Simulate the headerTitle logic for conductor
  function simulateHeaderTitle(store) {
    if (!store.currentConversation) return 'Claude Web Chat';
    if (store.currentConversationIsConductor) {
      const agent = store.agents.find(a => a.id === store.currentAgent);
      return (agent?.name || 'Agent') + ' · Conductor';
    }
    return 'Some Chat Title';
  }

  it('should return "AgentName · Conductor" when agent has a name', () => {
    const store = {
      currentConversation: 'cond_123',
      currentConversationIsConductor: true,
      currentAgent: 'a1',
      agents: [{ id: 'a1', name: 'Worker-1' }]
    };
    expect(simulateHeaderTitle(store)).toBe('Worker-1 · Conductor');
  });

  it('should fallback to "Agent · Conductor" when agent has no name', () => {
    const store = {
      currentConversation: 'cond_456',
      currentConversationIsConductor: true,
      currentAgent: 'a2',
      agents: [{ id: 'a2' }] // no name
    };
    expect(simulateHeaderTitle(store)).toBe('Agent · Conductor');
  });

  it('should fallback to "Agent · Conductor" when agent not found', () => {
    const store = {
      currentConversation: 'cond_789',
      currentConversationIsConductor: true,
      currentAgent: 'a_missing',
      agents: []
    };
    expect(simulateHeaderTitle(store)).toBe('Agent · Conductor');
  });

  it('source: ChatHeader template should have conductor-header-actions div', () => {
    expect(chatHeaderSource).toContain('conductor-header-actions');
    expect(chatHeaderSource).toContain('currentConversationIsConductor');
  });

  it('source: ChatHeader should display conductor cost label', () => {
    expect(chatHeaderSource).toContain('conductor-cost-label');
    expect(chatHeaderSource).toContain('conductorCost');
  });

  // Simulate conductorCost computed
  function simulateConductorCost(store) {
    const sid = store.currentConversation;
    if (!sid || !store.currentConversationIsConductor) return null;
    const status = store.conductorStatuses[sid];
    return status?.costUsd ? status.costUsd.toFixed(2) : null;
  }

  it('should return formatted cost when available', () => {
    const store = {
      currentConversation: 'cond_1',
      currentConversationIsConductor: true,
      conductorStatuses: { cond_1: { costUsd: 1.2345 } }
    };
    expect(simulateConductorCost(store)).toBe('1.23');
  });

  it('should return null when no cost data', () => {
    const store = {
      currentConversation: 'cond_1',
      currentConversationIsConductor: true,
      conductorStatuses: {}
    };
    expect(simulateConductorCost(store)).toBeNull();
  });

  it('should return null when not a conductor conversation', () => {
    const store = {
      currentConversation: 'chat_1',
      currentConversationIsConductor: false,
      conductorStatuses: { chat_1: { costUsd: 5.0 } }
    };
    expect(simulateConductorCost(store)).toBeNull();
  });
});

// =====================================================================
// 4. Tasks toggle controls ActivePanel visibility
// =====================================================================

describe('Tasks toggle and ActivePanel visibility', () => {
  // Simulate conductorActiveTaskCount
  function simulateActiveTaskCount(tasks) {
    if (!tasks) return 0;
    return Object.values(tasks).filter(
      t => t.status === 'active' || t.status === 'executing' || t.status === 'planning'
    ).length;
  }

  it('should count active/executing/planning tasks', () => {
    const tasks = {
      t1: { status: 'active' },
      t2: { status: 'executing' },
      t3: { status: 'planning' },
      t4: { status: 'completed' },
      t5: { status: 'failed' }
    };
    expect(simulateActiveTaskCount(tasks)).toBe(3);
  });

  it('should return 0 when no tasks', () => {
    expect(simulateActiveTaskCount(null)).toBe(0);
    expect(simulateActiveTaskCount({})).toBe(0);
  });

  it('should return 0 when all tasks completed', () => {
    const tasks = {
      t1: { status: 'completed' },
      t2: { status: 'failed' }
    };
    expect(simulateActiveTaskCount(tasks)).toBe(0);
  });

  it('source: ChatHeader should have Tasks toggle button with badge', () => {
    expect(chatHeaderSource).toContain('conductorActivePanelVisible');
    expect(chatHeaderSource).toContain('conductorActiveTaskCount');
    expect(chatHeaderSource).toContain('nav-badge');
  });

  it('source: chat.js store should have conductorActivePanelVisible state', () => {
    expect(chatStoreSource).toContain('conductorActivePanelVisible');
  });

  it('source: ConductorChatView showActivePanel should read from store', () => {
    expect(conductorChatViewSource).toContain('store.conductorActivePanelVisible');
  });
});

// =====================================================================
// 5. ActivePanel task card: workDir short path + scenario label
// =====================================================================

describe('ActivePanel task card meta', () => {
  // Mirror the shortenPath method from ConductorActivePanel.js
  function shortenPath(path) {
    if (!path) return '';
    const parts = path.replace(/\\/g, '/').split('/');
    if (parts.length <= 2) return path;
    return '~/' + parts.slice(-2).join('/');
  }

  it('should shorten long Unix path to last 2 segments', () => {
    expect(shortenPath('/home/user/projects/my-app')).toBe('~/projects/my-app');
  });

  it('should shorten Windows-style path', () => {
    expect(shortenPath('C:\\Users\\dev\\code\\project')).toBe('~/code/project');
  });

  it('should return original if path has ≤ 2 segments', () => {
    expect(shortenPath('project')).toBe('project');
    expect(shortenPath('dir/project')).toBe('dir/project');
  });

  it('should return empty string for falsy input', () => {
    expect(shortenPath(null)).toBe('');
    expect(shortenPath(undefined)).toBe('');
    expect(shortenPath('')).toBe('');
  });

  it('should handle root-relative paths', () => {
    expect(shortenPath('/single')).toBe('/single');
    // /single splits to ['', 'single'] → 2 segments, returns original
  });

  it('should handle deeply nested path', () => {
    expect(shortenPath('/a/b/c/d/e/f')).toBe('~/e/f');
  });

  it('source: ConductorActivePanel should have conductor-task-card-meta', () => {
    expect(conductorActivePanelSource).toContain('conductor-task-card-meta');
    expect(conductorActivePanelSource).toContain('shortenPath');
    expect(conductorActivePanelSource).toContain('task.scenario');
  });

  it('source: CSS should have task card meta styles', () => {
    expect(conductorCssSource).toContain('.conductor-task-card-meta');
    expect(conductorCssSource).toContain('.conductor-task-card-workdir');
    expect(conductorCssSource).toContain('.conductor-task-card-scenario');
  });
});

// =====================================================================
// 6. Sidebar no longer has Conductor section
// =====================================================================

describe('sidebar Conductor section removed', () => {
  it('ChatPage should NOT have conductor-sidebar-section', () => {
    expect(chatPageSource).not.toContain('conductor-sidebar-section');
  });

  it('ChatPage should NOT have conductorConversations computed', () => {
    // The old code had: conductorConversations() { ... }
    expect(chatPageSource).not.toContain("conductorConversations()");
  });

  it('ChatPage should NOT have conductor-session-list', () => {
    expect(chatPageSource).not.toContain('conductor-session-list');
    expect(chatPageSource).not.toContain('conductor-session-item');
  });

  it('ChatPage should NOT have conductorGroupCollapsed data', () => {
    expect(chatPageSource).not.toContain('conductorGroupCollapsed');
  });

  it('CSS: conductor-sidebar-section should not exist in conductor.css', () => {
    expect(conductorCssSource).not.toContain('.conductor-sidebar-section');
    expect(conductorCssSource).not.toContain('.conductor-session-list');
  });
});

// =====================================================================
// 7. No ConductorConfigPanel
// =====================================================================

describe('ConductorConfigPanel removed', () => {
  it('ChatPage should NOT import ConductorConfigPanel', () => {
    expect(chatPageSource).not.toContain("import ConductorConfigPanel");
  });

  it('ChatPage should NOT have conductorConfigOpen data', () => {
    expect(chatPageSource).not.toContain('conductorConfigOpen');
  });

  it('ChatPage should NOT have openConductorConfig method', () => {
    expect(chatPageSource).not.toContain('openConductorConfig');
  });

  it('ChatPage should NOT have startConductorSession method', () => {
    expect(chatPageSource).not.toContain('startConductorSession');
  });

  it('conductor-config.css should be gutted (no panel styles)', () => {
    // File kept as placeholder, should NOT contain panel class selectors
    expect(conductorConfigCssSource).not.toContain('.conductor-config-panel');
    expect(conductorConfigCssSource).not.toContain('.conductor-config-overlay');
    expect(conductorConfigCssSource).not.toContain('.conductor-scenario-card');
  });
});

// =====================================================================
// 8. ConductorChatView: custom header removed, uses ChatHeader
// =====================================================================

describe('ConductorChatView V5 header cleanup', () => {
  it('should NOT have conductor-header element in template', () => {
    // The old template had class="conductor-header" which is now removed
    expect(conductorChatViewSource).not.toContain('class="conductor-header"');
  });

  it('should NOT have workdir menu code', () => {
    expect(conductorChatViewSource).not.toContain('showWorkDirMenu');
    expect(conductorChatViewSource).not.toContain('conductor-workdir-menu');
    expect(conductorChatViewSource).not.toContain('switchWorkDir');
    expect(conductorChatViewSource).not.toContain('switchToCustom');
    expect(conductorChatViewSource).not.toContain('customWorkDir');
    expect(conductorChatViewSource).not.toContain('loadFolders');
  });

  it('should NOT have statusInfo computed (cost moved to ChatHeader)', () => {
    expect(conductorChatViewSource).not.toContain('statusInfo()');
  });

  it('ChatPage should render ChatHeader above ConductorChatView for conductor', () => {
    // In the template: <ChatHeader /> then <ConductorChatView />
    expect(chatPageSource).toContain('isCurrentConductorConversation');
    const conductorBlock = chatPageSource.substring(
      chatPageSource.indexOf('isCurrentConductorConversation'),
      chatPageSource.indexOf('</template>', chatPageSource.indexOf('isCurrentConductorConversation'))
    );
    expect(conductorBlock).toContain('ChatHeader');
    expect(conductorBlock).toContain('ConductorChatView');
  });

  it('CSS: old conductor-header styles removed', () => {
    expect(conductorCssSource).not.toContain('.conductor-header {');
    expect(conductorCssSource).not.toContain('.conductor-header-left');
    expect(conductorCssSource).not.toContain('.conductor-workdir {');
    expect(conductorCssSource).not.toContain('.conductor-workdir-menu');
  });

  it('CSS: new conductor-header-actions styles present', () => {
    expect(conductorCssSource).toContain('.conductor-header-actions');
    expect(conductorCssSource).toContain('.conductor-cost-label');
  });
});

// =====================================================================
// 9. Mobile ≤768px: overlay + absolute panel + full-width TaskPanel
// =====================================================================

describe('mobile responsive behavior', () => {
  it('CSS: conductor-mobile-overlay is hidden by default, shown at ≤768px', () => {
    // Default: display: none
    expect(conductorCssSource).toContain('.conductor-mobile-overlay');
    expect(conductorCssSource).toMatch(/\.conductor-mobile-overlay\s*\{[^}]*display:\s*none/);
    // At ≤768px: display: block + position absolute + overlay background
    const mobileBlock = conductorCssSource.substring(
      conductorCssSource.indexOf('@media (max-width: 768px)'),
      conductorCssSource.indexOf('@media (max-width: 480px)')
    );
    expect(mobileBlock).toContain('.conductor-mobile-overlay');
    expect(mobileBlock).toContain('display: block');
  });

  it('CSS: ActivePanel becomes absolute overlay at ≤768px', () => {
    const mobileBlock = conductorCssSource.substring(
      conductorCssSource.indexOf('@media (max-width: 768px)'),
      conductorCssSource.indexOf('@media (max-width: 480px)')
    );
    expect(mobileBlock).toContain('.conductor-active-panel');
    expect(mobileBlock).toContain('position: absolute');
    expect(mobileBlock).toContain('z-index: 20');
  });

  it('CSS: TaskPanel is full width at ≤768px', () => {
    const mobileBlock = conductorCssSource.substring(
      conductorCssSource.indexOf('@media (max-width: 768px)'),
      conductorCssSource.indexOf('@media (max-width: 480px)')
    );
    expect(mobileBlock).toContain('.conductor-task-panel');
    expect(mobileBlock).toContain('width: 100%');
  });

  it('template: mobile overlay click closes ActivePanel via store', () => {
    expect(conductorChatViewSource).toContain('conductor-mobile-overlay');
    expect(conductorChatViewSource).toContain('showActivePanel && isMobile');
    expect(conductorChatViewSource).toContain('store.conductorActivePanelVisible = false');
  });

  it('ConductorChatView tracks isMobile via window.innerWidth', () => {
    expect(conductorChatViewSource).toContain('window.innerWidth < 768');
    expect(conductorChatViewSource).toContain('resize');
  });

  it('CSS: old conductor-header responsive rules removed', () => {
    const mobileBlock = conductorCssSource.substring(
      conductorCssSource.indexOf('@media (max-width: 768px)')
    );
    expect(mobileBlock).not.toContain('.conductor-header ');
    expect(mobileBlock).not.toContain('.conductor-header-center');
    expect(mobileBlock).not.toContain('.conductor-header-name');
    expect(mobileBlock).not.toContain('.conductor-header-cost');
  });
});

// =====================================================================
// 10. P0 fix: openConductor sets currentAgent before sendWsMessage,
//     conductor_session_created uses msg.agentId with store fallback
// =====================================================================

describe('P0 fix: openConductor agentId binding', () => {
  // Simulate the FIXED openConductor logic (mirrors conductor.js lines 77-104)
  function simulateFixedOpenConductor(store, agentId) {
    const existing = store.conversations.find(
      c => c.type === 'conductor' && c.agentId === agentId
    );

    if (existing) {
      store.selectConversation(existing.id, agentId);
      return { action: 'resumed' };
    }

    // P0 FIX: set currentAgent BEFORE sending WS message
    store.currentAgent = agentId;

    const sessionId = 'cond_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    store.conductorMessages[sessionId] = [];
    store.conductorTasks[sessionId] = {};
    store.conductorActors[sessionId] = {};

    store.sentMessages.push({
      type: 'create_conductor_session',
      sessionId,
      agentId
    });
    return { action: 'created', sessionId };
  }

  // Simulate conductor_session_created handler (mirrors conductor.js lines 184-233)
  function simulateSessionCreatedHandler(store, msg) {
    const sid = msg.sessionId;
    // P0 FIX: prefer msg.agentId over store.currentAgent
    const agentId = msg.agentId || store.currentAgent;

    let conv = store.conversations.find(c => c.id === sid);
    if (!conv) {
      const agent = store.agents.find(a => a.id === agentId);
      conv = {
        id: sid,
        agentId,
        agentName: agent?.name || agentId,
        type: 'conductor'
      };
      store.conversations.push(conv);
    } else {
      conv.agentId = agentId;
    }
    return conv;
  }

  it('openConductor should set store.currentAgent before WS message', () => {
    const store = {
      conversations: [],
      conductorMessages: {},
      conductorTasks: {},
      conductorActors: {},
      sentMessages: [],
      currentAgent: 'old-agent' // starts as a different agent
    };

    simulateFixedOpenConductor(store, 'new-agent');
    // currentAgent must be updated BEFORE the WS message is sent
    expect(store.currentAgent).toBe('new-agent');
    expect(store.sentMessages[0].agentId).toBe('new-agent');
  });

  it('source: conductor.js sets currentAgent before sendWsMessage', () => {
    // Line: store.currentAgent = agentId;
    // Must appear BEFORE store.sendWsMessage in openConductor
    // V5: resumeConductorSession no longer exists, use sendConductorMessage as end marker
    const startIdx = conductorHelperSource.indexOf('export function openConductor');
    const endIdx = conductorHelperSource.indexOf('export function sendConductorMessage');
    const openFn = conductorHelperSource.substring(startIdx, endIdx);
    const setAgentIdx = openFn.indexOf('store.currentAgent = agentId');
    const sendWsIdx = openFn.indexOf('store.sendWsMessage');
    expect(setAgentIdx).toBeGreaterThan(-1);
    expect(sendWsIdx).toBeGreaterThan(-1);
    expect(setAgentIdx).toBeLessThan(sendWsIdx); // set BEFORE send
  });

  it('conductor_session_created handler prefers msg.agentId over store.currentAgent', () => {
    const store = {
      conversations: [],
      agents: [{ id: 'agent-B', name: 'Worker-B' }],
      currentAgent: 'agent-A' // store has stale value
    };
    const msg = {
      type: 'conductor_session_created',
      sessionId: 'cond_test',
      agentId: 'agent-B' // server echoes correct agentId
    };

    const conv = simulateSessionCreatedHandler(store, msg);
    // Should use msg.agentId, NOT store.currentAgent
    expect(conv.agentId).toBe('agent-B');
    expect(conv.agentName).toBe('Worker-B');
  });

  it('conductor_session_created handler falls back to store.currentAgent when msg has no agentId', () => {
    const store = {
      conversations: [],
      agents: [],
      currentAgent: 'agent-fallback'
    };
    const msg = {
      type: 'conductor_session_created',
      sessionId: 'cond_fb'
      // no agentId in msg
    };

    const conv = simulateSessionCreatedHandler(store, msg);
    expect(conv.agentId).toBe('agent-fallback');
  });

  it('source: handler uses msg.agentId || store.currentAgent pattern', () => {
    // V5: conductor_opened handler (not conductor_session_created) uses
    // msg.agentId || store.currentAgent to derive agentId
    expect(conductorHelperSource).toContain('msg.agentId || store.currentAgent');
  });

  it('dead createConductorSession removed from store', () => {
    // P1 fix: the old createConductorSession function should not exist
    expect(chatStoreSource).not.toContain('createConductorSession(config)');
  });
});

// =====================================================================
// 11. Boundary conditions (supplementary)
// =====================================================================

describe('boundary conditions', () => {
  // headerTitle fallback when agent has no name
  it('headerTitle: agent with empty string name should fallback', () => {
    const agent = { id: 'a1', name: '' };
    const title = (agent?.name || 'Agent') + ' · Conductor';
    expect(title).toBe('Agent · Conductor');
  });

  // task with no workDir/scenario → meta row hidden (v-if="task.workDir || task.scenario")
  it('task meta: v-if guard hides row when both workDir and scenario are absent', () => {
    const task = { id: 't1', title: 'Task', status: 'active' };
    const showMeta = !!(task.workDir || task.scenario);
    expect(showMeta).toBe(false);
  });

  it('task meta: shows when only workDir is present', () => {
    const task = { id: 't2', workDir: '/home/user/project' };
    const showMeta = !!(task.workDir || task.scenario);
    expect(showMeta).toBe(true);
  });

  it('task meta: shows when only scenario is present', () => {
    const task = { id: 't3', scenario: 'fullstack' };
    const showMeta = !!(task.workDir || task.scenario);
    expect(showMeta).toBe(true);
  });

  it('conductorMessages empty → empty state shown', () => {
    // The template uses v-if="conductorMessages.length === 0"
    expect(conductorChatViewSource).toContain('conductorMessages.length === 0');
    expect(conductorChatViewSource).toContain('conductor-empty');
    expect(conductorChatViewSource).toContain("$t('conductor.ready')");
  });

  it('openConductor: agent with no existing conversations creates fresh session', () => {
    // Simulate with empty conversations array
    const conversations = [];
    const existing = conversations.find(
      c => c.type === 'conductor' && c.agentId === 'brand-new'
    );
    expect(existing).toBeUndefined();
  });
});
