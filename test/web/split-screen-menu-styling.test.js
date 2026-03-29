import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Tests for PR #381: split-screen layout refactor — PaneTopBar + GlobalSidebar.
 *
 * Verifies:
 *   1. CSS layout — split-screen-layout is row, split-pane is column
 *   2. GlobalSidebar — narrow left column with split controls + settings + theme
 *   3. PaneTopBar — top bar per pane with session dropdown + actions
 *   4. PaneTopBar session dropdown — click-to-select sessions, Chat + Crew groups
 *   5. PaneTopBar action buttons — new chat/crew, close pane, agent status
 *   6. SplitPane integrates PaneTopBar (not PaneSidebar)
 *   7. app.js uses GlobalSidebar (not GlobalToolbar)
 *   8. Old components removed (GlobalToolbar.js, PaneSidebar.js)
 *   9. CSS variable correctness
 *  10. Empty pane state preserved
 *  11. ChatPage.js not modified (non-split mode unaffected)
 *  12. Outside click closes dropdown
 *  13. SplitPane close pane → store.removePane
 *  14. Session dropdown CSS (absolute, z-index, opaque)
 *  15. GlobalSidebar CSS structure
 */

const webDir = path.resolve(__dirname, '../../web');

function readFile(relativePath) {
  return fs.readFileSync(path.join(webDir, relativePath), 'utf-8');
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(webDir, relativePath));
}

// =====================================================================
// 1. CSS layout — split-screen-layout row, split-pane column
// =====================================================================
describe('CSS layout structure', () => {
  const css = readFile('styles/split-screen.css');

  it('should define .split-screen-layout with flex-direction: row', () => {
    const rule = css.match(/\.split-screen-layout\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('flex-direction: row');
  });

  it('should define .split-pane with flex-direction: column', () => {
    const rule = css.match(/\.split-pane\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('flex-direction: column');
  });

  it('should define .global-sidebar with 40px width', () => {
    const rule = css.match(/\.global-sidebar\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('width: 40px');
  });

  it('should define .pane-topbar with 36px height', () => {
    const rule = css.match(/\.pane-topbar\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('height: 36px');
  });

  it('should define .split-panes-container', () => {
    expect(css).toContain('.split-panes-container');
  });

  it('should have pane border separator', () => {
    expect(css).toContain('.split-pane + .split-pane');
    expect(css).toContain('border-left');
  });
});

// =====================================================================
// 2. GlobalSidebar component
// =====================================================================
describe('GlobalSidebar component', () => {
  const gsJs = readFile('components/GlobalSidebar.js');

  it('should use global-sidebar CSS class', () => {
    expect(gsJs).toContain('class="global-sidebar"');
  });

  it('should have add pane button', () => {
    expect(gsJs).toContain('store.addPane()');
  });

  it('should have merge button', () => {
    expect(gsJs).toContain('mergePanes');
  });

  it('should limit panes to 3', () => {
    expect(gsJs).toContain('store.splitPanes.length < 3');
  });

  it('should have settings button', () => {
    expect(gsJs).toContain('settingsOpen = true');
  });

  it('should import and render SettingsPanel', () => {
    expect(gsJs).toContain("import SettingsPanel from './SettingsPanel.js'");
    expect(gsJs).toContain('v-if="settingsOpen"');
  });

  it('should have theme toggle', () => {
    expect(gsJs).toContain('store.toggleTheme()');
  });

  it('should have connection warning indicator', () => {
    expect(gsJs).toContain('gs-connection-warn');
    expect(gsJs).toContain("store.connectionState !== 'connected'");
  });

  it('should use gs-icon-btn class', () => {
    expect(gsJs).toContain('class="gs-icon-btn"');
  });

  it('should have gs-top and gs-bottom sections', () => {
    expect(gsJs).toContain('class="gs-top"');
    expect(gsJs).toContain('class="gs-bottom"');
  });

  it('should properly merge panes by clearing splitPanes', () => {
    expect(gsJs).toContain('store.splitPanes = []');
  });
});

// =====================================================================
// 3. PaneTopBar component
// =====================================================================
describe('PaneTopBar component', () => {
  const ptbJs = readFile('components/PaneTopBar.js');

  it('should use pane-topbar CSS class', () => {
    expect(ptbJs).toContain('class="pane-topbar"');
  });

  it('should accept paneId and conversationId props', () => {
    expect(ptbJs).toContain("paneId: { type: String, required: true }");
    expect(ptbJs).toContain("conversationId: { type: String, default: null }");
  });

  it('should emit close-pane event', () => {
    expect(ptbJs).toContain("'close-pane'");
    expect(ptbJs).toContain("$emit('close-pane')");
  });

  it('should have session dropdown trigger', () => {
    expect(ptbJs).toContain('class="ptb-session-trigger"');
    expect(ptbJs).toContain('dropdownOpen');
  });

  it('should have session dropdown list', () => {
    expect(ptbJs).toContain('class="ptb-session-dropdown"');
    expect(ptbJs).toContain('v-if="dropdownOpen"');
  });

  it('should use setPaneConversation for session clicks', () => {
    expect(ptbJs).toContain('store.setPaneConversation(props.paneId');
  });

  it('should NOT use selectConversation', () => {
    expect(ptbJs).not.toContain('store.selectConversation');
  });

  it('should close dropdown after session click', () => {
    expect(ptbJs).toContain('dropdownOpen.value = false');
  });

  it('should guard session click for offline agents', () => {
    expect(ptbJs).toContain('if (conv.agentOnline === false) return');
  });
});

// =====================================================================
// 4. PaneTopBar session dropdown groups
// =====================================================================
describe('PaneTopBar session dropdown', () => {
  const ptbJs = readFile('components/PaneTopBar.js');

  it('should have chat sessions group', () => {
    expect(ptbJs).toContain('chatConversations');
    expect(ptbJs).toContain('ptb-dropdown-group');
    expect(ptbJs).toContain('ptb-dropdown-label');
  });

  it('should have crew sessions group', () => {
    expect(ptbJs).toContain('crewConversations');
  });

  it('should show active state for current session', () => {
    expect(ptbJs).toContain('active: conv.id === conversationId');
  });

  it('should show agent-offline state', () => {
    expect(ptbJs).toContain("'agent-offline': conv.agentOnline === false");
  });

  it('should display session time', () => {
    expect(ptbJs).toContain('ptb-item-time');
    expect(ptbJs).toContain('getConversationTime');
  });

  it('should have empty state when no sessions', () => {
    expect(ptbJs).toContain('ptb-dropdown-empty');
  });
});

// =====================================================================
// 5. PaneTopBar action buttons
// =====================================================================
describe('PaneTopBar action buttons', () => {
  const ptbJs = readFile('components/PaneTopBar.js');

  it('should have new chat button', () => {
    expect(ptbJs).toContain('@click="newChat"');
  });

  it('should have new crew button', () => {
    expect(ptbJs).toContain('@click="newCrewSession"');
  });

  it('should have close pane button', () => {
    expect(ptbJs).toContain('ptb-close-btn');
  });

  it('should disable new chat when no agents online', () => {
    expect(ptbJs).toContain(':disabled="onlineAgentCount === 0"');
  });

  it('should call store.createConversation for new chat', () => {
    expect(ptbJs).toContain('store.createConversation()');
  });

  it('should call store.enterCrewMode for new crew', () => {
    expect(ptbJs).toContain('store.enterCrewMode()');
  });

  it('should guard newChat when no agents online', () => {
    expect(ptbJs).toContain('if (onlineAgentCount.value === 0) return');
  });

  it('should have agent status indicator', () => {
    expect(ptbJs).toContain('ptb-agent-dot');
    expect(ptbJs).toContain('ptb-agent-label');
  });
});

// =====================================================================
// 6. SplitPane integrates PaneTopBar
// =====================================================================
describe('SplitPane integrates PaneTopBar', () => {
  const splitPaneJs = readFile('components/SplitPane.js');

  it('should import PaneTopBar', () => {
    expect(splitPaneJs).toContain("import PaneTopBar from './PaneTopBar.js'");
  });

  it('should register PaneTopBar as a component', () => {
    expect(splitPaneJs).toContain('PaneTopBar');
  });

  it('should render PaneTopBar in template', () => {
    expect(splitPaneJs).toContain('<PaneTopBar');
  });

  it('should pass paneId and conversationId to PaneTopBar', () => {
    expect(splitPaneJs).toContain(':paneId="paneId"');
    expect(splitPaneJs).toContain(':conversationId="conversationId"');
  });

  it('should NOT import PaneSidebar', () => {
    expect(splitPaneJs).not.toContain("import PaneSidebar");
  });

  it('should NOT have split-pane-content wrapper div', () => {
    expect(splitPaneJs).not.toContain('class="split-pane-content"');
  });

  it('should keep empty state', () => {
    expect(splitPaneJs).toContain('class="pane-empty-state"');
  });
});

// =====================================================================
// 7. app.js uses GlobalSidebar
// =====================================================================
describe('app.js uses GlobalSidebar', () => {
  const appJs = readFile('app.js');

  it('should import GlobalSidebar', () => {
    expect(appJs).toContain("import GlobalSidebar from './components/GlobalSidebar.js'");
  });

  it('should register GlobalSidebar component', () => {
    expect(appJs).toContain('GlobalSidebar');
  });

  it('should render GlobalSidebar in split mode', () => {
    expect(appJs).toContain('<GlobalSidebar');
  });

  it('should NOT import GlobalToolbar', () => {
    expect(appJs).not.toContain("import GlobalToolbar");
  });

  it('should NOT render GlobalToolbar', () => {
    expect(appJs).not.toContain('<GlobalToolbar');
  });

  it('should keep split-screen-layout wrapper', () => {
    expect(appJs).toContain('class="split-screen-layout"');
  });
});

// =====================================================================
// 8. Old components removed
// =====================================================================
describe('Old components removed', () => {
  it('should NOT have GlobalToolbar.js file', () => {
    expect(fileExists('components/GlobalToolbar.js')).toBe(false);
  });

  it('should NOT have PaneSidebar.js file', () => {
    expect(fileExists('components/PaneSidebar.js')).toBe(false);
  });

  const css = readFile('styles/split-screen.css');

  it('should NOT have .global-toolbar CSS rules', () => {
    expect(css).not.toMatch(/\.global-toolbar\s*\{/);
  });

  it('should NOT have .pane-sidebar CSS rules', () => {
    expect(css).not.toMatch(/\.pane-sidebar\s*\{/);
  });

  it('should NOT have .split-pane-content CSS rules', () => {
    expect(css).not.toMatch(/\.split-pane-content\s*\{/);
  });

  it('should NOT have .gt- prefix CSS rules', () => {
    expect(css).not.toMatch(/\.gt-/);
  });
});

// =====================================================================
// 9. CSS variable correctness
// =====================================================================
describe('CSS variable correctness', () => {
  const css = readFile('styles/split-screen.css');

  it('should use var(--bg-sidebar) for backgrounds', () => {
    const matches = css.match(/var\(--bg-sidebar\)/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('should use var(--border-color) for borders', () => {
    const matches = css.match(/var\(--border-color\)/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('should use var(--text-secondary) for secondary text', () => {
    expect(css).toContain('var(--text-secondary)');
  });

  it('should use var(--text-muted) for muted text', () => {
    expect(css).toContain('var(--text-muted)');
  });

  it('should use var(--sidebar-hover) for hover states', () => {
    expect(css).toContain('var(--sidebar-hover)');
  });

  it('should NOT use old variables (--bg-primary, --bg-secondary)', () => {
    expect(css).not.toContain('--bg-primary');
    expect(css).not.toContain('--bg-secondary');
  });
});

// =====================================================================
// 10. Empty pane state preserved
// =====================================================================
describe('Empty pane state', () => {
  const splitPaneJs = readFile('components/SplitPane.js');
  const css = readFile('styles/split-screen.css');

  it('should show pane-empty-state when no conversationId', () => {
    expect(splitPaneJs).toContain('class="pane-empty-state"');
  });

  it('should display selectSession text in empty state', () => {
    expect(splitPaneJs).toContain("$t('splitScreen.selectSession')");
  });

  it('should have CSS for pane-empty-state', () => {
    expect(css).toContain('.pane-empty-state');
  });

  it('should keep compact message styles', () => {
    expect(css).toContain('.split-pane .message');
    expect(css).toContain('.split-pane .chat-container');
  });

  it('should keep split-pane-messages styles', () => {
    expect(css).toContain('.split-pane-messages');
  });
});

// =====================================================================
// 11. Non-split mode not affected — ChatPage.js zero changes
// =====================================================================
describe('ChatPage.js not modified', () => {
  const chatPageJs = readFile('components/ChatPage.js');

  it('should NOT import PaneTopBar or GlobalSidebar', () => {
    expect(chatPageJs).not.toContain('PaneTopBar');
    expect(chatPageJs).not.toContain('GlobalSidebar');
  });

  it('should NOT reference splitPanes', () => {
    expect(chatPageJs).not.toContain('splitPanes');
  });

  it('should still use regular sidebar classes', () => {
    expect(chatPageJs).toContain('class="sidebar');
  });
});

// =====================================================================
// 12. PaneTopBar outside click closes dropdown
// =====================================================================
describe('PaneTopBar outside click behavior', () => {
  const ptbJs = readFile('components/PaneTopBar.js');

  it('should register document click listener on mount', () => {
    expect(ptbJs).toContain("document.addEventListener('click', handleOutsideClick)");
  });

  it('should remove document click listener on unmount', () => {
    expect(ptbJs).toContain("document.removeEventListener('click', handleOutsideClick)");
  });

  it('should close dropdown in handleOutsideClick', () => {
    expect(ptbJs).toContain('if (dropdownOpen.value)');
    expect(ptbJs).toContain('dropdownOpen.value = false');
  });

  it('should use click.stop on dropdown to prevent closing', () => {
    expect(ptbJs).toContain('class="ptb-session-dropdown" v-if="dropdownOpen" @click.stop');
  });
});

// =====================================================================
// 13. SplitPane close pane calls store.removePane
// =====================================================================
describe('SplitPane close pane', () => {
  const splitPaneJs = readFile('components/SplitPane.js');

  it('should call store.removePane with paneId', () => {
    expect(splitPaneJs).toContain('store.removePane(props.paneId)');
  });

  it('should emit close-pane from PaneTopBar to trigger closePane', () => {
    expect(splitPaneJs).toContain('@close-pane="closePane"');
  });
});

// =====================================================================
// 14. Dropdown CSS — absolute positioning, z-index, opaque background
// =====================================================================
describe('Session dropdown CSS', () => {
  const css = readFile('styles/split-screen.css');

  it('should position dropdown absolutely', () => {
    const dropdownRule = css.match(/\.ptb-session-dropdown\s*\{[^}]+\}/);
    expect(dropdownRule).not.toBeNull();
    expect(dropdownRule[0]).toContain('position: absolute');
  });

  it('should have z-index for dropdown overlay', () => {
    const dropdownRule = css.match(/\.ptb-session-dropdown\s*\{[^}]+\}/);
    expect(dropdownRule).not.toBeNull();
    expect(dropdownRule[0]).toContain('z-index:');
  });

  it('should have opaque background (not transparent)', () => {
    const dropdownRule = css.match(/\.ptb-session-dropdown\s*\{[^}]+\}/);
    expect(dropdownRule).not.toBeNull();
    expect(dropdownRule[0]).toContain('var(--bg-sidebar)');
  });

  it('should have box-shadow for visual separation', () => {
    const dropdownRule = css.match(/\.ptb-session-dropdown\s*\{[^}]+\}/);
    expect(dropdownRule).not.toBeNull();
    expect(dropdownRule[0]).toContain('box-shadow');
  });

  it('should have max-height with overflow scroll', () => {
    const dropdownRule = css.match(/\.ptb-session-dropdown\s*\{[^}]+\}/);
    expect(dropdownRule).not.toBeNull();
    expect(dropdownRule[0]).toContain('max-height');
    expect(dropdownRule[0]).toContain('overflow-y: auto');
  });

  it('should style .ptb-dropdown-empty for no-sessions state', () => {
    const emptyRule = css.match(/\.ptb-dropdown-empty\s*\{[^}]+\}/);
    expect(emptyRule).not.toBeNull();
    expect(emptyRule[0]).toContain('text-align: center');
    expect(emptyRule[0]).toContain('var(--text-muted)');
  });

  it('should style active dropdown item distinctly', () => {
    const activeRule = css.match(/\.ptb-dropdown-item\.active\s*\{[^}]+\}/);
    expect(activeRule).not.toBeNull();
    expect(activeRule[0]).toContain('var(--accent');
  });

  it('should style agent-offline dropdown items with reduced opacity', () => {
    const offlineRule = css.match(/\.ptb-dropdown-item\.agent-offline\s*\{[^}]+\}/);
    expect(offlineRule).not.toBeNull();
    expect(offlineRule[0]).toContain('opacity');
    expect(offlineRule[0]).toContain('cursor: not-allowed');
  });
});

// =====================================================================
// 15. GlobalSidebar CSS structure
// =====================================================================
describe('GlobalSidebar CSS', () => {
  const css = readFile('styles/split-screen.css');

  it('should define .global-sidebar as flex column', () => {
    const rule = css.match(/\.global-sidebar\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('flex-direction: column');
  });

  it('should justify space-between (top/bottom sections)', () => {
    const rule = css.match(/\.global-sidebar\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('justify-content: space-between');
  });

  it('should have background using --bg-sidebar', () => {
    const rule = css.match(/\.global-sidebar\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('var(--bg-sidebar)');
  });

  it('should have right border separator', () => {
    const rule = css.match(/\.global-sidebar\s*\{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule[0]).toContain('border-right');
  });

  it('should style gs-icon-btn with hover state', () => {
    const hoverRule = css.match(/\.gs-icon-btn:hover\s*\{[^}]+\}/);
    expect(hoverRule).not.toBeNull();
    expect(hoverRule[0]).toContain('var(--sidebar-hover)');
  });
});
