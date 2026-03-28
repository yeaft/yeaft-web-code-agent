import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Tests for split-screen styling and architecture.
 *
 * Verifies that:
 *   1. split-screen.css uses correct CSS variables (no undefined tokens)
 *   2. PaneSidebar reuses sidebar CSS classes
 *   3. SplitPane integrates PaneSidebar with horizontal layout
 *   4. GlobalToolbar is simplified (split controls only)
 *   5. CSS correctly defines pane-sidebar and split-pane-content
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
