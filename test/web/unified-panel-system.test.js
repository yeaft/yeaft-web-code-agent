import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Tests for PR #406 (task-190): Unified panel system refactor.
 *
 * 9 test areas:
 *   1. splitToPanel — enters split mode from single mode
 *   2. splitToPanel — adds panel in existing split mode
 *   3. splitToPanel — max 3 panels (replaces last when at limit)
 *   4. activePanelId tracking — set on split, updated on remove
 *   5. removePanel — active panel tracking after removal
 *   6. isInAnyPanel — checks conversation presence in panels
 *   7. selectConversation — routes to active panel in split mode
 *   8. Source verification — splitPanes→panels rename completeness
 *   9. CSS/Template — split button, active-panel highlight, mobile hide
 */

const webDir = path.resolve(__dirname, '../../web');

function readFile(relativePath) {
  return fs.readFileSync(path.join(webDir, relativePath), 'utf-8');
}

// Helper: create a store-like object for behavioral testing
function makePanelState(id, conversationId) {
  return {
    id,
    conversationId,
    crewPanelVisible: { roles: true, features: true },
    activeRightPanel: null,
    crewMobilePanel: null
  };
}

function createStore(overrides = {}) {
  return {
    panels: [],
    activePanelId: null,
    activeConversations: [],
    conversations: [],
    messagesMap: {},
    crewMessagesMap: {},
    currentConversation: null,
    _pendingPaneId: null,
    sendWsMessage: () => {},
    saveOpenSessions: () => {},
    ...overrides
  };
}

// Replicate splitToPanel logic for behavioral testing
function splitToPanel(store, conversationId) {
  if (!conversationId) return;
  if (store.panels.length === 0) {
    store.panels = [
      makePanelState('panel-0', store.currentConversation),
      makePanelState('panel-new', conversationId)
    ];
    store.activePanelId = store.panels[1].id;
  } else if (store.panels.length >= 3) {
    store.panels[store.panels.length - 1].conversationId = conversationId;
    store.activePanelId = store.panels[store.panels.length - 1].id;
  } else {
    const newId = 'panel-' + Date.now();
    store.panels.push(makePanelState(newId, conversationId));
    store.activePanelId = newId;
  }
  if (!store.activeConversations.includes(conversationId)) {
    store.activeConversations.push(conversationId);
  }
  if (!store.messagesMap[conversationId]) {
    store.messagesMap[conversationId] = [];
  }
}

// Replicate removePanel logic for behavioral testing
function removePanel(store, panelId) {
  const idx = store.panels.findIndex(p => p.id === panelId);
  if (idx < 0) return;
  store.panels.splice(idx, 1);
  if (store.panels.length <= 1) {
    const remaining = store.panels[0];
    if (remaining?.conversationId) {
      store.activeConversations = [remaining.conversationId];
    }
    store.panels = [];
    store.activePanelId = null;
  } else if (store.activePanelId === panelId) {
    store.activePanelId = store.panels[0]?.id || null;
  }
}

// Replicate isInAnyPanel
function isInAnyPanel(store, conversationId) {
  return store.panels.some(p => p.conversationId === conversationId);
}

// =====================================================================
// 1. splitToPanel — enters split mode from single mode
// =====================================================================
describe('splitToPanel — enter split mode', () => {
  it('should create 2 panels when called from single mode', () => {
    const store = createStore({ currentConversation: 'conv-1', activeConversations: ['conv-1'] });
    splitToPanel(store, 'conv-2');
    expect(store.panels.length).toBe(2);
  });

  it('should put current conversation in first panel', () => {
    const store = createStore({ currentConversation: 'conv-1', activeConversations: ['conv-1'] });
    splitToPanel(store, 'conv-2');
    expect(store.panels[0].conversationId).toBe('conv-1');
  });

  it('should put target conversation in second panel', () => {
    const store = createStore({ currentConversation: 'conv-1', activeConversations: ['conv-1'] });
    splitToPanel(store, 'conv-2');
    expect(store.panels[1].conversationId).toBe('conv-2');
  });

  it('should set activePanelId to the new (second) panel', () => {
    const store = createStore({ currentConversation: 'conv-1', activeConversations: ['conv-1'] });
    splitToPanel(store, 'conv-2');
    expect(store.activePanelId).toBe(store.panels[1].id);
  });

  it('should add target conversation to activeConversations', () => {
    const store = createStore({ currentConversation: 'conv-1', activeConversations: ['conv-1'] });
    splitToPanel(store, 'conv-2');
    expect(store.activeConversations).toContain('conv-2');
  });

  it('should do nothing when conversationId is null', () => {
    const store = createStore({ currentConversation: 'conv-1' });
    splitToPanel(store, null);
    expect(store.panels.length).toBe(0);
  });
});

// =====================================================================
// 2. splitToPanel — adds panel in existing split mode
// =====================================================================
describe('splitToPanel — add panel in existing split mode', () => {
  it('should add a third panel when 2 panels exist', () => {
    const store = createStore({
      panels: [
        makePanelState('panel-0', 'conv-1'),
        makePanelState('panel-1', 'conv-2')
      ],
      activePanelId: 'panel-0',
      activeConversations: ['conv-1', 'conv-2']
    });
    splitToPanel(store, 'conv-3');
    expect(store.panels.length).toBe(3);
    expect(store.panels[2].conversationId).toBe('conv-3');
  });

  it('should set activePanelId to the new third panel', () => {
    const store = createStore({
      panels: [
        makePanelState('panel-0', 'conv-1'),
        makePanelState('panel-1', 'conv-2')
      ],
      activePanelId: 'panel-0',
      activeConversations: ['conv-1', 'conv-2']
    });
    splitToPanel(store, 'conv-3');
    expect(store.activePanelId).toBe(store.panels[2].id);
  });
});

// =====================================================================
// 3. splitToPanel — max 3 panels (replaces last when at limit)
// =====================================================================
describe('splitToPanel — max 3 panels limit', () => {
  it('should not add a 4th panel when 3 panels exist', () => {
    const store = createStore({
      panels: [
        makePanelState('panel-0', 'conv-1'),
        makePanelState('panel-1', 'conv-2'),
        makePanelState('panel-2', 'conv-3')
      ],
      activePanelId: 'panel-0',
      activeConversations: ['conv-1', 'conv-2', 'conv-3']
    });
    splitToPanel(store, 'conv-4');
    expect(store.panels.length).toBe(3);
  });

  it('should replace last panel conversation when at 3-panel limit', () => {
    const store = createStore({
      panels: [
        makePanelState('panel-0', 'conv-1'),
        makePanelState('panel-1', 'conv-2'),
        makePanelState('panel-2', 'conv-3')
      ],
      activePanelId: 'panel-0',
      activeConversations: ['conv-1', 'conv-2', 'conv-3']
    });
    splitToPanel(store, 'conv-4');
    expect(store.panels[2].conversationId).toBe('conv-4');
  });

  it('should set activePanelId to last panel after replacement', () => {
    const store = createStore({
      panels: [
        makePanelState('panel-0', 'conv-1'),
        makePanelState('panel-1', 'conv-2'),
        makePanelState('panel-2', 'conv-3')
      ],
      activePanelId: 'panel-0',
      activeConversations: ['conv-1', 'conv-2', 'conv-3']
    });
    splitToPanel(store, 'conv-4');
    expect(store.activePanelId).toBe('panel-2');
  });
});

// =====================================================================
// 4. activePanelId tracking
// =====================================================================
describe('activePanelId tracking', () => {
  it('should be set to panel-0 when entering split mode via addPanel', () => {
    // Source verification: addPanel sets activePanelId = 'panel-0'
    const chatJs = readFile('stores/chat.js');
    expect(chatJs).toContain("this.activePanelId = 'panel-0'");
  });

  it('should have setActivePanel action in store', () => {
    const chatJs = readFile('stores/chat.js');
    expect(chatJs).toContain('setActivePanel(panelId)');
    expect(chatJs).toContain('this.activePanelId = panelId');
  });

  it('should be null when not in split mode', () => {
    const store = createStore();
    expect(store.activePanelId).toBeNull();
  });
});

// =====================================================================
// 5. removePanel — active panel tracking after removal
// =====================================================================
describe('removePanel — active panel tracking', () => {
  it('should exit split mode when removing down to 1 panel', () => {
    const store = createStore({
      panels: [
        makePanelState('panel-0', 'conv-1'),
        makePanelState('panel-1', 'conv-2')
      ],
      activePanelId: 'panel-0',
      activeConversations: ['conv-1', 'conv-2']
    });
    removePanel(store, 'panel-1');
    expect(store.panels.length).toBe(0);
    expect(store.activePanelId).toBeNull();
  });

  it('should set activeConversations to remaining conversation when exiting split', () => {
    const store = createStore({
      panels: [
        makePanelState('panel-0', 'conv-1'),
        makePanelState('panel-1', 'conv-2')
      ],
      activePanelId: 'panel-1',
      activeConversations: ['conv-1', 'conv-2']
    });
    removePanel(store, 'panel-1');
    expect(store.activeConversations).toEqual(['conv-1']);
  });

  it('should switch activePanelId to first remaining when active panel is removed (3→2)', () => {
    const store = createStore({
      panels: [
        makePanelState('panel-0', 'conv-1'),
        makePanelState('panel-1', 'conv-2'),
        makePanelState('panel-2', 'conv-3')
      ],
      activePanelId: 'panel-1',
      activeConversations: ['conv-1', 'conv-2', 'conv-3']
    });
    removePanel(store, 'panel-1');
    expect(store.panels.length).toBe(2);
    expect(store.activePanelId).toBe('panel-0');
  });

  it('should keep activePanelId unchanged when non-active panel is removed', () => {
    const store = createStore({
      panels: [
        makePanelState('panel-0', 'conv-1'),
        makePanelState('panel-1', 'conv-2'),
        makePanelState('panel-2', 'conv-3')
      ],
      activePanelId: 'panel-0',
      activeConversations: ['conv-1', 'conv-2', 'conv-3']
    });
    removePanel(store, 'panel-2');
    expect(store.panels.length).toBe(2);
    expect(store.activePanelId).toBe('panel-0');
  });

  it('should do nothing when panelId does not exist', () => {
    const store = createStore({
      panels: [
        makePanelState('panel-0', 'conv-1'),
        makePanelState('panel-1', 'conv-2')
      ],
      activePanelId: 'panel-0'
    });
    removePanel(store, 'panel-nonexistent');
    expect(store.panels.length).toBe(2);
  });
});

// =====================================================================
// 6. isInAnyPanel
// =====================================================================
describe('isInAnyPanel', () => {
  it('should return true if conversation is in a panel', () => {
    const store = createStore({
      panels: [makePanelState('panel-0', 'conv-1'), makePanelState('panel-1', 'conv-2')]
    });
    expect(isInAnyPanel(store, 'conv-1')).toBe(true);
  });

  it('should return false if conversation is not in any panel', () => {
    const store = createStore({
      panels: [makePanelState('panel-0', 'conv-1'), makePanelState('panel-1', 'conv-2')]
    });
    expect(isInAnyPanel(store, 'conv-3')).toBe(false);
  });

  it('should return false for empty panels', () => {
    const store = createStore({ panels: [] });
    expect(isInAnyPanel(store, 'conv-1')).toBe(false);
  });

  it('should exist in the store source code', () => {
    const chatJs = readFile('stores/chat.js');
    expect(chatJs).toContain('isInAnyPanel(conversationId)');
    expect(chatJs).toContain('this.panels.some(p => p.conversationId === conversationId)');
  });
});

// =====================================================================
// 7. selectConversation — routes to active panel in split mode
// =====================================================================
describe('selectConversation — active panel routing', () => {
  it('should route conversation to activePanelId panel in source', () => {
    const convSource = readFile('stores/helpers/conversation.js');
    const fnStart = convSource.indexOf('export function selectConversation');
    const fnEnd = convSource.indexOf('export function updateConversationSettings');
    const fn = convSource.slice(fnStart, fnEnd);
    expect(fn).toContain('store.activePanelId');
    expect(fn).toContain('setPanelConversation');
  });

  it('should fall back to panels[0] when activePanelId is null', () => {
    const convSource = readFile('stores/helpers/conversation.js');
    expect(convSource).toContain("store.activePanelId || store.panels[0]?.id");
  });
});

// =====================================================================
// 8. Source verification — splitPanes→panels rename completeness
// =====================================================================
describe('splitPanes→panels rename completeness', () => {
  const filesToCheck = [
    'stores/chat.js',
    'stores/helpers/session.js',
    'stores/helpers/conversation.js',
    'stores/helpers/crew.js',
    'stores/helpers/handlers/conversationHandler.js',
    'components/ChatPage.js',
    'components/SplitPane.js',
    'app.js'
  ];

  for (const file of filesToCheck) {
    it(`should have no "splitPanes" references in ${file}`, () => {
      const content = readFile(file);
      // Allow string literals like 'splitPanes' in localStorage keys, but no store.splitPanes
      const matches = content.match(/store\.splitPanes|this\.splitPanes|state\.splitPanes/g);
      expect(matches).toBeNull();
    });
  }

  it('should use panels (not splitPanes) in state declaration', () => {
    const chatJs = readFile('stores/chat.js');
    expect(chatJs).toContain('panels: [],');
  });

  it('should use panels in isSplitMode getter', () => {
    const chatJs = readFile('stores/chat.js');
    expect(chatJs).toContain('state.panels.length > 1');
  });

  it('should have addPanel (not addPane) action', () => {
    const chatJs = readFile('stores/chat.js');
    expect(chatJs).toContain('addPanel()');
    expect(chatJs).not.toMatch(/\baddPane\b\(\)/);
  });

  it('should have removePanel (not removePane) action', () => {
    const chatJs = readFile('stores/chat.js');
    expect(chatJs).toContain('removePanel(panelId)');
    expect(chatJs).not.toMatch(/\bremovePane\b\(paneId\)/);
  });

  it('should have setPanelConversation (not setPaneConversation)', () => {
    const chatJs = readFile('stores/chat.js');
    expect(chatJs).toContain('setPanelConversation(panelId');
    expect(chatJs).not.toMatch(/\bsetPaneConversation\b/);
  });

  it('should save panels to localStorage with key "panels"', () => {
    const sessionJs = readFile('stores/helpers/session.js');
    expect(sessionJs).toContain("localStorage.setItem('panels'");
    expect(sessionJs).toContain("localStorage.getItem('panels')");
  });
});

// =====================================================================
// 9. CSS/Template — split button, active-panel highlight, mobile hide
// =====================================================================
describe('CSS/Template — split button and active panel', () => {
  const splitScreenCss = readFile('styles/split-screen.css');
  const chatPageJs = readFile('components/ChatPage.js');
  const splitPaneJs = readFile('components/SplitPane.js');

  it('should define .session-split-btn CSS rule', () => {
    expect(splitScreenCss).toMatch(/\.session-split-btn\s*\{/);
  });

  it('should start split button with opacity: 0 (hidden until hover)', () => {
    const rule = splitScreenCss.match(/\.session-split-btn\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('opacity: 0');
  });

  it('should show split button on session-item hover', () => {
    expect(splitScreenCss).toMatch(/\.session-item:hover\s+\.session-split-btn/);
  });

  it('should NOT have active-panel visual style (removed for equal pane heights)', () => {
    expect(splitScreenCss).not.toMatch(/\.split-pane\.active-panel/);
  });

  it('should have session-split-btn in ChatPage template for Chat sessions', () => {
    expect(chatPageJs).toContain('class="session-split-btn"');
  });

  it('should have session-split-btn-crew in ChatPage template for Crew sessions', () => {
    expect(chatPageJs).toContain('class="session-split-btn session-split-btn-crew"');
  });

  it('should guard split button with v-if="!store.isInAnyPanel(conv.id)"', () => {
    expect(chatPageJs).toContain('v-if="!store.isInAnyPanel(conv.id)"');
  });

  it('should call splitToPanel on split button click', () => {
    expect(chatPageJs).toContain('@click.stop="splitToPanel(conv.id)"');
  });

  it('should have panels-container in ChatPage for multi-panel mode', () => {
    expect(chatPageJs).toContain('class="panels-container"');
  });

  it('should define .panels-container in CSS', () => {
    expect(splitScreenCss).toContain('.panels-container');
  });

  it('should render SplitPane v-for over store.panels in ChatPage', () => {
    expect(chatPageJs).toContain('v-for="(panel, idx) in store.panels"');
  });

  it('should set active panel on SplitPane click (without visual style)', () => {
    // active-panel class removed for equal pane heights; click handler remains for focus routing
    expect(splitPaneJs).not.toContain("'active-panel': isActivePanel");
    expect(splitPaneJs).toContain('@click="setActive"');
  });

  it('should call store.removePanel in SplitPane close handler', () => {
    expect(splitPaneJs).toContain('store.removePanel(props.paneId)');
  });

  it('should NOT have pane-sidebar overlay in simplified SplitPane', () => {
    expect(splitPaneJs).not.toContain('pane-sidebar-overlay');
    expect(splitPaneJs).not.toContain('pane-sidebar-body');
  });
});

// =====================================================================
// 10. i18n — new keys added
// =====================================================================
describe('i18n — new split screen keys', () => {
  const enJs = readFile('i18n/en.js');
  const zhCnJs = readFile('i18n/zh-CN.js');

  it('should have splitToPanel key in en.js', () => {
    expect(enJs).toContain("'splitScreen.splitToPanel'");
  });

  it('should have splitToPanel key in zh-CN.js', () => {
    expect(zhCnJs).toContain("'splitScreen.splitToPanel'");
  });

  it('should have selectFromSidebar key in en.js', () => {
    expect(enJs).toContain("'splitScreen.selectFromSidebar'");
  });

  it('should have selectFromSidebar key in zh-CN.js', () => {
    expect(zhCnJs).toContain("'splitScreen.selectFromSidebar'");
  });
});

// =====================================================================
// 11. App.js — GlobalSidebar removed from split mode
// =====================================================================
describe('App.js — GlobalSidebar cleanup', () => {
  const appJs = readFile('app.js');

  it('should NOT import GlobalSidebar', () => {
    expect(appJs).not.toContain("import GlobalSidebar");
  });

  it('should NOT render GlobalSidebar', () => {
    expect(appJs).not.toContain('<GlobalSidebar');
  });

  it('should NOT have split-screen-layout wrapper', () => {
    expect(appJs).not.toContain('split-screen-layout');
  });

  it('should render ChatPage as the sole layout component', () => {
    expect(appJs).toContain('<ChatPage');
  });
});
