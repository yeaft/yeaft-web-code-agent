import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Tests for PR #377: split-screen collapsible sidebar.
 *
 * Verifies that:
 *   1. split-screen.css uses correct CSS variables (no undefined tokens)
 *   2. PaneSidebar reuses sidebar CSS classes
 *   3. PaneSidebar uses pane-local state (not global)
 *   4. SplitPane integrates PaneSidebar with horizontal layout
 *   5. GlobalToolbar is simplified (split controls only)
 *   6. CSS layout: pane-sidebar + split-pane-content
 *   7. Collapsed sidebar has all required icons
 *   8. New Chat/Crew auto-assigns to current pane
 *   9. Close session removes from list
 *  10. Settings panel opens from pane sidebar
 *  11. Theme toggle from sidebar
 *  12. Empty pane state
 *  13. Agent-offline guards (disabled buttons)
 *  14. Removed old components (SessionSelector, PaneHeader)
 */

const webDir = path.resolve(__dirname, '../../web');

function readFile(relativePath) {
  return fs.readFileSync(path.join(webDir, relativePath), 'utf-8');
}

// =====================================================================
// 1. CSS variable correctness — no undefined/old variables
// =====================================================================
describe('CSS variable correctness in split-screen.css', () => {
  const css = readFile('styles/split-screen.css');

  it('should NOT use --bg-primary (old variable)', () => {
    expect(css).not.toContain('--bg-primary');
  });

  it('should NOT use --bg-secondary (old variable)', () => {
    expect(css).not.toContain('--bg-secondary');
  });

  it('should NOT use bare --border (should be --border-color)', () => {
    const bareMatches = css.match(/var\(--border\b(?!-)/g);
    expect(bareMatches).toBeNull();
  });

  it('should NOT use bare --hover (should be --sidebar-hover)', () => {
    const hoverMatches = css.match(/var\(--hover\b(?!-)/g);
    expect(hoverMatches).toBeNull();
  });

  it('should use var(--bg-sidebar) for toolbar background', () => {
    const bgSidebarUsages = css.match(/var\(--bg-sidebar\)/g);
    expect(bgSidebarUsages).not.toBeNull();
    expect(bgSidebarUsages.length).toBeGreaterThanOrEqual(1);
  });

  it('should use var(--border-color) for borders', () => {
    const borderColorUsages = css.match(/var\(--border-color\)/g);
    expect(borderColorUsages).not.toBeNull();
    expect(borderColorUsages.length).toBeGreaterThanOrEqual(1);
  });
});

// =====================================================================
// 2. PaneSidebar — reuses sidebar CSS classes
// =====================================================================
describe('PaneSidebar reuses sidebar CSS classes', () => {
  const paneSidebarJs = readFile('components/PaneSidebar.js');

  it('should use "sidebar" and "pane-sidebar" CSS classes', () => {
    expect(paneSidebarJs).toContain('class="sidebar pane-sidebar"');
  });

  it('should use sidebar-collapsed-bar for collapsed state', () => {
    expect(paneSidebarJs).toContain('class="sidebar-collapsed-bar"');
  });

  it('should use collapsed-icon-btn on collapsed bar buttons', () => {
    const matches = paneSidebarJs.match(/class="collapsed-icon-btn"/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it('should use session-group-header for session panels', () => {
    expect(paneSidebarJs).toContain('class="session-group-header"');
  });

  it('should use session-item class on conversation items', () => {
    expect(paneSidebarJs).toContain('class="session-item"');
  });

  it('should use session-panel-list for session lists', () => {
    expect(paneSidebarJs).toContain('class="session-panel-list"');
  });

  it('should use sidebar-header-row for expanded header', () => {
    expect(paneSidebarJs).toContain('class="sidebar-header-row"');
  });

  it('should use sidebar-brand for agent status', () => {
    expect(paneSidebarJs).toContain('class="sidebar-brand agent-dropdown-trigger"');
  });

  it('should use sidebar-bottom for bottom nav', () => {
    expect(paneSidebarJs).toContain('class="sidebar-bottom"');
  });

  it('should use agent-dropdown for agent list', () => {
    expect(paneSidebarJs).toContain('class="agent-dropdown"');
  });
});

// =====================================================================
// 3. PaneSidebar behavior — pane-local state, not global
// =====================================================================
describe('PaneSidebar pane-local state', () => {
  const paneSidebarJs = readFile('components/PaneSidebar.js');

  it('should have localCollapsed state defaulting to true', () => {
    expect(paneSidebarJs).toContain('const localCollapsed = Vue.ref(true)');
  });

  it('should NOT reference store.sidebarCollapsed', () => {
    expect(paneSidebarJs).not.toContain('store.sidebarCollapsed');
  });

  it('should use setPaneConversation for session clicks (not selectConversation)', () => {
    expect(paneSidebarJs).toContain('store.setPaneConversation(props.paneId');
    expect(paneSidebarJs).not.toContain('store.selectConversation');
  });

  it('should accept paneId and conversationId props', () => {
    expect(paneSidebarJs).toContain("paneId: { type: String, required: true }");
    expect(paneSidebarJs).toContain("conversationId: { type: String, default: null }");
  });

  it('should highlight active session using conversationId prop (not store.currentConversation)', () => {
    expect(paneSidebarJs).toContain('conv.id === conversationId');
    expect(paneSidebarJs).not.toContain('store.currentConversation');
  });
});

// =====================================================================
// 4. SplitPane integrates PaneSidebar
// =====================================================================
describe('SplitPane integrates PaneSidebar', () => {
  const splitPaneJs = readFile('components/SplitPane.js');

  it('should import PaneSidebar', () => {
    expect(splitPaneJs).toContain("import PaneSidebar from './PaneSidebar.js'");
  });

  it('should register PaneSidebar as a component', () => {
    expect(splitPaneJs).toContain('PaneSidebar');
  });

  it('should render PaneSidebar in template', () => {
    expect(splitPaneJs).toContain('<PaneSidebar');
  });

  it('should pass paneId and conversationId to PaneSidebar', () => {
    expect(splitPaneJs).toContain(':paneId="paneId"');
    expect(splitPaneJs).toContain(':conversationId="conversationId"');
  });

  it('should wrap content in split-pane-content div', () => {
    expect(splitPaneJs).toContain('class="split-pane-content"');
  });
});

// =====================================================================
// 5. GlobalToolbar is simplified
// =====================================================================
describe('GlobalToolbar simplified to split controls only', () => {
  const toolbarJs = readFile('components/GlobalToolbar.js');

  it('should use sidebar-icon-btn on control buttons', () => {
    const matches = toolbarJs.match(/class="sidebar-icon-btn/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('should NOT have agent status dropdown', () => {
    expect(toolbarJs).not.toContain('gt-agent-dropdown');
    expect(toolbarJs).not.toContain('gt-agent-status');
  });

  it('should NOT have session selector', () => {
    expect(toolbarJs).not.toContain('gt-session-selector');
    expect(toolbarJs).not.toContain('gt-session-dropdown');
  });

  it('should NOT have theme toggle or settings', () => {
    expect(toolbarJs).not.toContain('settingsOpen');
    expect(toolbarJs).not.toContain('SettingsPanel');
  });

  it('should keep gt-btn-add and gt-btn-merge classes', () => {
    expect(toolbarJs).toContain('gt-btn-add');
    expect(toolbarJs).toContain('gt-btn-merge');
  });

  it('should have connection warning', () => {
    expect(toolbarJs).toContain('gt-connection-warn');
  });
});

// =====================================================================
// 6. CSS layout — pane sidebar + content
// =====================================================================
describe('CSS layout for pane sidebar', () => {
  const css = readFile('styles/split-screen.css');

  it('should define .split-pane with flex-direction: row', () => {
    const paneRule = css.match(/\.split-pane\s*\{[^}]+\}/);
    expect(paneRule).not.toBeNull();
    expect(paneRule[0]).toContain('flex-direction: row');
  });

  it('should define .pane-sidebar width', () => {
    const sidebarRule = css.match(/\.pane-sidebar\s*\{[^}]+\}/);
    expect(sidebarRule).not.toBeNull();
    expect(sidebarRule[0]).toContain('width:');
  });

  it('should define .pane-sidebar.collapsed with 48px width', () => {
    const collapsedRule = css.match(/\.pane-sidebar\.collapsed\s*\{[^}]+\}/);
    expect(collapsedRule).not.toBeNull();
    expect(collapsedRule[0]).toContain('48px');
  });

  it('should define .split-pane-content as flex column', () => {
    const contentRule = css.match(/\.split-pane-content\s*\{[^}]+\}/);
    expect(contentRule).not.toBeNull();
    expect(contentRule[0]).toContain('flex-direction: column');
    expect(contentRule[0]).toContain('flex: 1');
  });
});

// =====================================================================
// 7. Collapsed sidebar — all required icons present
// =====================================================================
describe('PaneSidebar collapsed bar has required icons', () => {
  const paneSidebarJs = readFile('components/PaneSidebar.js');

  it('should have expand button in collapsed bar', () => {
    // Expand button sets localCollapsed = false
    expect(paneSidebarJs).toContain('localCollapsed = false');
  });

  it('should have new chat button in collapsed bar', () => {
    expect(paneSidebarJs).toContain('@click="newChat"');
  });

  it('should have crew button in collapsed bar', () => {
    expect(paneSidebarJs).toContain('@click="newCrewSession"');
  });

  it('should have close-pane button in collapsed bar', () => {
    // close-pane emit from collapsed bar
    expect(paneSidebarJs).toContain("@click=\"$emit('close-pane')\"");
  });

  it('should have theme toggle button in collapsed bar', () => {
    expect(paneSidebarJs).toContain('store.toggleTheme()');
  });

  it('should render collapsed bar only when localCollapsed is true', () => {
    expect(paneSidebarJs).toContain('v-if="localCollapsed"');
  });
});

// =====================================================================
// 8. New Chat/Crew auto-assignment to current pane
// =====================================================================
describe('PaneSidebar new session auto-assigns to pane', () => {
  const paneSidebarJs = readFile('components/PaneSidebar.js');

  it('should call store.createConversation() for new chat', () => {
    expect(paneSidebarJs).toContain('store.createConversation()');
  });

  it('should call store.enterCrewMode() for new crew', () => {
    expect(paneSidebarJs).toContain('store.enterCrewMode()');
  });

  it('should NOT use Vue.nextTick for pane assignment (race condition fix)', () => {
    // newChat/newCrewSession must NOT use Vue.nextTick — createConversation is async WebSocket.
    // handleConversationCreated in the store auto-assigns to empty panes in split mode.
    const newChatMatch = paneSidebarJs.match(/function newChat\(\)[^}]*\}/s);
    if (newChatMatch) {
      expect(newChatMatch[0]).not.toContain('Vue.nextTick');
    }
    const newCrewMatch = paneSidebarJs.match(/function newCrewSession\(\)[^}]*\}/s);
    if (newCrewMatch) {
      expect(newCrewMatch[0]).not.toContain('Vue.nextTick');
    }
  });

  it('should guard newChat when no agents online', () => {
    expect(paneSidebarJs).toContain('if (onlineAgentCount.value === 0) return');
  });
});

// =====================================================================
// 9. Close session — removesfrom list via store
// =====================================================================
describe('PaneSidebar close session behavior', () => {
  const paneSidebarJs = readFile('components/PaneSidebar.js');

  it('should call store.closeSession with conversationId and agentId', () => {
    expect(paneSidebarJs).toContain('store.closeSession(conversationId, agentId)');
  });

  it('should have delete button on session items with click.stop', () => {
    expect(paneSidebarJs).toContain('@click.stop="closeSession(conv.id, conv.agentId)"');
  });

  it('should use session-delete-btn class matching sidebar style', () => {
    expect(paneSidebarJs).toContain('class="session-delete-btn"');
  });
});

// =====================================================================
// 10. Settings panel opens from pane sidebar
// =====================================================================
describe('PaneSidebar opens settings panel', () => {
  const paneSidebarJs = readFile('components/PaneSidebar.js');

  it('should import SettingsPanel component', () => {
    expect(paneSidebarJs).toContain("import SettingsPanel from './SettingsPanel.js'");
  });

  it('should have settingsOpen ref', () => {
    expect(paneSidebarJs).toContain('const settingsOpen = Vue.ref(false)');
  });

  it('should render SettingsPanel when settingsOpen is true', () => {
    expect(paneSidebarJs).toContain('v-if="settingsOpen"');
    expect(paneSidebarJs).toContain('@close="settingsOpen = false"');
  });

  it('should have settings button in sidebar-bottom', () => {
    expect(paneSidebarJs).toContain('@click="settingsOpen = true"');
  });
});

// =====================================================================
// 11. Theme toggle from pane sidebar
// =====================================================================
describe('PaneSidebar theme toggle', () => {
  const paneSidebarJs = readFile('components/PaneSidebar.js');

  it('should call store.toggleTheme() on click', () => {
    expect(paneSidebarJs).toContain('@click="store.toggleTheme()"');
  });

  it('should show sun icon for dark theme and moon icon for light', () => {
    // v-if for dark → sun icon, v-else → moon icon (same as ChatPage sidebar)
    expect(paneSidebarJs).toContain('v-if="store.theme === \'dark\'"');
  });
});

// =====================================================================
// 12. Empty pane state — no conversation selected
// =====================================================================
describe('SplitPane empty state', () => {
  const splitPaneJs = readFile('components/SplitPane.js');

  it('should show pane-empty-state when no conversationId', () => {
    expect(splitPaneJs).toContain('class="pane-empty-state"');
  });

  it('should display selectSession text in empty state', () => {
    expect(splitPaneJs).toContain("$t('splitScreen.selectSession')");
  });

  it('should display selectHint text in empty state', () => {
    expect(splitPaneJs).toContain("$t('splitScreen.selectHint')");
  });

  it('should NOT have close button in empty state (sidebar handles close)', () => {
    // Old: had pane-empty-close button. New: PaneSidebar handles close-pane
    expect(splitPaneJs).not.toContain('pane-empty-close');
  });
});

// =====================================================================
// 13. Agent offline — new chat button disabled
// =====================================================================
describe('PaneSidebar agent-offline guards', () => {
  const paneSidebarJs = readFile('components/PaneSidebar.js');

  it('should disable new chat button when no agents online', () => {
    expect(paneSidebarJs).toContain(':disabled="onlineAgentCount === 0"');
  });

  it('should compute onlineAgentCount from store.agents', () => {
    expect(paneSidebarJs).toContain("store.agents.filter(a => a.online).length");
  });

  it('should skip session click when agent is offline', () => {
    expect(paneSidebarJs).toContain("if (conv.agentOnline === false) return");
  });

  it('should apply agent-offline class on session items', () => {
    expect(paneSidebarJs).toContain("'agent-offline': conv.agentOnline === false");
  });
});

// =====================================================================
// 14. Removed components — SessionSelector and PaneHeader no longer used
// =====================================================================
describe('Removed split-screen components', () => {
  const css = readFile('styles/split-screen.css');
  const splitPaneJs = readFile('components/SplitPane.js');

  it('should NOT import SessionSelector in SplitPane', () => {
    expect(splitPaneJs).not.toContain('SessionSelector');
  });

  it('should NOT import PaneHeader in SplitPane', () => {
    expect(splitPaneJs).not.toContain('PaneHeader');
  });

  it('should NOT define .session-selector CSS rules', () => {
    expect(css).not.toMatch(/\.session-selector\s*\{/);
  });

  it('should NOT define .pane-header CSS rules', () => {
    expect(css).not.toMatch(/\.pane-header\s*\{/);
  });

  it('should NOT define .gt-agent-dropdown CSS rules', () => {
    expect(css).not.toMatch(/\.gt-agent-dropdown\s*\{/);
  });

  it('should NOT define .gt-session-selector CSS rules', () => {
    expect(css).not.toMatch(/\.gt-session-selector\s*\{/);
  });
});
