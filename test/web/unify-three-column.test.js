import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tests for Unify UI three-column layout.
 *
 * Layout: left sidebar (56px, minimal) + center conversation + right detail (280px).
 * Sidebar is minimal: back button + bottom settings gear.
 * Mode toggle and model selector are in the topbar.
 */

const rootDir = join(import.meta.dirname, '..', '..');
const unifyPageJs = readFileSync(join(rootDir, 'web/components/UnifyPage.js'), 'utf8');
const unifyCss = readFileSync(join(rootDir, 'web/styles/unify.css'), 'utf8');
const enI18n = readFileSync(join(rootDir, 'web/i18n/en.js'), 'utf8');
const zhI18n = readFileSync(join(rootDir, 'web/i18n/zh-CN.js'), 'utf8');

// =====================================================================
// 1. Three-column layout structure
// =====================================================================
describe('UnifyPage three-column structure', () => {
  it('has left sidebar (unify-sidebar)', () => {
    expect(unifyPageJs).toContain('class="unify-sidebar"');
  });

  it('has center conversation area (unify-main)', () => {
    expect(unifyPageJs).toContain('class="unify-main"');
  });

  it('has right detail panel (unify-detail)', () => {
    expect(unifyPageJs).toContain('class="unify-detail"');
  });

  it('root is flex row (not column)', () => {
    expect(unifyCss).toMatch(/\.unify-page\s*\{[^}]*flex-direction:\s*row/);
  });

  it('page takes full viewport height', () => {
    expect(unifyCss).toMatch(/\.unify-page\s*\{[^}]*height:\s*100vh/);
    expect(unifyCss).toMatch(/\.unify-page\s*\{[^}]*height:\s*100dvh/);
  });
});

// =====================================================================
// 2. Left sidebar content (minimal: back + settings)
// =====================================================================
describe('Left sidebar content', () => {
  it('has back button', () => {
    expect(unifyPageJs).toContain('unify-back-btn');
    expect(unifyPageJs).toContain('goBack');
  });

  it('has settings button at bottom', () => {
    expect(unifyPageJs).toContain('unify-settings-btn');
    expect(unifyPageJs).toContain('toggleSettings');
  });

  it('has spacer to push settings to bottom', () => {
    expect(unifyPageJs).toContain('unify-sidebar-spacer');
  });

  it('sidebar is 56px wide (minimal)', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\s*\{[^}]*width:\s*56px/);
  });

  it('does NOT have mode toggle in sidebar (moved to topbar)', () => {
    const sidebarStart = unifyPageJs.indexOf('class="unify-sidebar"');
    const sidebarEnd = unifyPageJs.indexOf('</aside>', sidebarStart);
    const sidebarContent = unifyPageJs.slice(sidebarStart, sidebarEnd);
    expect(sidebarContent).not.toContain('unify-mode-toggle');
    expect(sidebarContent).not.toContain('unify-topbar-mode');
  });

  it('does NOT have agent info section (removed)', () => {
    expect(unifyPageJs).not.toContain('unify-agent-info');
  });

  it('does NOT show skills count', () => {
    expect(unifyPageJs).not.toContain("store.unifyStatus.skills");
  });

  it('does NOT show MCP servers count', () => {
    expect(unifyPageJs).not.toContain("store.unifyStatus.mcpServers");
  });

  it('does NOT have session status indicator', () => {
    expect(unifyPageJs).not.toContain('unify-session-status');
    expect(unifyPageJs).not.toContain('unify-status-dot');
  });

  it('sidebar has collapsible support', () => {
    expect(unifyPageJs).toContain("sidebarCollapsed");
    expect(unifyPageJs).toContain("toggleSidebar");
    expect(unifyCss).toContain('.unify-sidebar.collapsed');
  });
});

// =====================================================================
// 3. Center conversation area
// =====================================================================
describe('Center conversation area', () => {
  it('uses standard MessageList component', () => {
    expect(unifyPageJs).toContain('<MessageList');
  });

  it('uses standard ChatInput component', () => {
    expect(unifyPageJs).toContain('<ChatInput');
  });

  it('unify-main is flex column with flex: 1', () => {
    expect(unifyCss).toMatch(/\.unify-main\s*\{[^}]*flex:\s*1/);
    expect(unifyCss).toMatch(/\.unify-main\s*\{[^}]*flex-direction:\s*column/);
  });

  it('does NOT override input-area max-width (uses default 60%)', () => {
    expect(unifyCss).not.toContain('.unify-page .input-area');
    expect(unifyCss).not.toMatch(/\.input-area[^{]*\{[^}]*max-width:\s*800px/);
  });

  it('topbar has model selector dropdown', () => {
    expect(unifyPageJs).toContain('unify-topbar-model');
    expect(unifyPageJs).toContain('toggleModelDropdown');
  });

  it('topbar has mode toggle', () => {
    expect(unifyPageJs).toContain('unify-topbar-mode');
    expect(unifyPageJs).toContain("setMode('chat')");
    expect(unifyPageJs).toContain("setMode('work')");
  });

  it('topbar has clear, debug, and detail toggle buttons', () => {
    expect(unifyPageJs).toContain('unify-clear-btn');
    expect(unifyPageJs).toContain('unify-debug-btn');
    expect(unifyPageJs).toContain('unify-detail-toggle');
  });

  it('has sidebar toggle button in topbar', () => {
    expect(unifyPageJs).toContain('unify-sidebar-toggle');
  });
});

// =====================================================================
// 4. Right detail panel
// =====================================================================
describe('Right detail panel', () => {
  it('uses CSS variable for width (default 500px)', () => {
    expect(unifyCss).toMatch(/\.unify-detail\s*\{[^}]*width:\s*var\(--unify-detail-width/);
  });

  it('has placeholder content', () => {
    expect(unifyPageJs).toContain('unify-detail-placeholder');
  });

  it('does NOT have border-left (no divider lines)', () => {
    expect(unifyCss).not.toMatch(/\.unify-detail\s*\{[^}]*border-left/);
  });
});

// =====================================================================
// 5. Mobile responsive
// =====================================================================
describe('Mobile responsive', () => {
  it('hides right panel on narrow screens (max-width: 1024px)', () => {
    const mediaBlock = unifyCss.match(/@media\s*\(max-width:\s*1024px\)\s*\{[\s\S]*?\n\}/);
    expect(mediaBlock).not.toBeNull();
    expect(mediaBlock[0]).toContain('.unify-detail');
    expect(mediaBlock[0]).toContain('display: none');
  });

  it('hides right panel on mobile (max-width: 768px)', () => {
    const mediaBlock = unifyCss.match(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\n\}/);
    expect(mediaBlock).not.toBeNull();
    expect(mediaBlock[0]).toContain('.unify-detail');
  });

  it('sidebar becomes fixed overlay on mobile', () => {
    const mediaBlock = unifyCss.match(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\n\}/);
    expect(mediaBlock).not.toBeNull();
    expect(mediaBlock[0]).toContain('.unify-sidebar');
    expect(mediaBlock[0]).toContain('position: fixed');
  });

  it('has sidebar overlay element in template', () => {
    expect(unifyPageJs).toContain('unify-sidebar-overlay');
  });

  it('overlay closes sidebar on click', () => {
    expect(unifyPageJs).toMatch(/unify-sidebar-overlay.*@click.*sidebarCollapsed\s*=\s*true/s);
  });

  it('overlay is shown only on mobile when sidebar is open', () => {
    expect(unifyPageJs).toContain('v-if="!sidebarCollapsed && isMobile"');
  });

  it('has overlay CSS with semi-transparent background', () => {
    expect(unifyCss).toContain('.unify-sidebar-overlay');
    expect(unifyCss).toMatch(/\.unify-sidebar-overlay\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*0\.5\)/);
  });

  it('overlay is display:block on mobile (768px)', () => {
    const mediaBlock = unifyCss.match(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\n\}/);
    expect(mediaBlock).not.toBeNull();
    expect(mediaBlock[0]).toContain('.unify-sidebar-overlay');
    expect(mediaBlock[0]).toContain('display: block');
  });

  it('has isMobile reactive ref with resize listener', () => {
    expect(unifyPageJs).toContain('isMobile');
    expect(unifyPageJs).toContain("window.innerWidth <= 768");
    expect(unifyPageJs).toContain("addEventListener('resize'");
    expect(unifyPageJs).toContain("removeEventListener('resize'");
  });
});

// =====================================================================
// 6. CSS cleanup — no stale overrides
// =====================================================================
describe('CSS cleanup', () => {
  it('does not have old .unify-status-badge class', () => {
    expect(unifyCss).not.toContain('.unify-status-badge');
  });

  it('has .unify-page .input-area override for tighter padding', () => {
    expect(unifyCss).toContain('.unify-page .input-area');
  });

  it('sidebar sections do NOT have border-bottom (consistent with Chat)', () => {
    expect(unifyCss).not.toMatch(/\.unify-sidebar-section\s*\{[^}]*border-bottom/);
  });

  it('sidebar header does NOT have border-bottom (consistent with Chat)', () => {
    expect(unifyCss).not.toMatch(/\.unify-sidebar-header\s*\{[^}]*border-bottom/);
  });

  it('session status CSS is removed', () => {
    expect(unifyCss).not.toContain('.unify-session-status');
    expect(unifyCss).not.toContain('.unify-status-dot');
    expect(unifyCss).not.toContain('unify-pulse');
  });
});

// =====================================================================
// 7. Setup logic
// =====================================================================
describe('Setup logic', () => {
  it('has sidebarCollapsed ref', () => {
    expect(unifyPageJs).toContain('sidebarCollapsed');
    expect(unifyPageJs).toContain('Vue.ref(false)');
  });

  it('has detailCollapsed ref', () => {
    expect(unifyPageJs).toContain('detailCollapsed');
  });

  it('returns toggleSidebar function', () => {
    expect(unifyPageJs).toContain('toggleSidebar');
  });

  it('returns toggleDetail function', () => {
    expect(unifyPageJs).toContain('toggleDetail');
  });

  it('returns all necessary functions and state', () => {
    expect(unifyPageJs).toContain('goBack');
    expect(unifyPageJs).toContain('sendMessage');
    expect(unifyPageJs).toContain('setMode');
    expect(unifyPageJs).toContain('clearMessages');
    expect(unifyPageJs).toContain('hasMessages');
    expect(unifyPageJs).toContain('isProcessing');
  });
});

// =====================================================================
// 8. i18n — labels use $t()
// =====================================================================
describe('i18n — labels use $t()', () => {
  it('right panel placeholder uses $t()', () => {
    expect(unifyPageJs).toContain("$t('unify.tasksMemory')");
    expect(unifyPageJs).toContain("$t('unify.comingSoon')");
  });

  it('sidebar toggle titles use $t()', () => {
    expect(unifyPageJs).toContain("$t('unify.showSidebar')");
    expect(unifyPageJs).toContain("$t('unify.hideSidebar')");
  });

  it('detail toggle titles use $t()', () => {
    expect(unifyPageJs).toContain("$t('unify.showDetail')");
    expect(unifyPageJs).toContain("$t('unify.hideDetail')");
  });

  it('mode toggle uses $t()', () => {
    expect(unifyPageJs).toContain("$t('unify.chat')");
    expect(unifyPageJs).toContain("$t('unify.work')");
  });

  it('model switch uses $t()', () => {
    expect(unifyPageJs).toContain("$t('unify.switchModel')");
  });

  it('settings uses $t()', () => {
    expect(unifyPageJs).toContain("$t('unify.settings.title')");
  });

  it('no hardcoded English labels remain in sidebar sections', () => {
    expect(unifyPageJs).not.toMatch(/>Mode</);
    expect(unifyPageJs).not.toMatch(/>Agent</);
    expect(unifyPageJs).not.toMatch(/>Tasks & Memory</);
    expect(unifyPageJs).not.toMatch(/>Coming soon</);
  });

  it('en.js has all required unify i18n keys', () => {
    const requiredKeys = [
      'unify.chat', 'unify.work',
      'unify.tasksMemory', 'unify.comingSoon',
      'unify.showSidebar', 'unify.hideSidebar',
      'unify.showDetail', 'unify.hideDetail',
      'unify.switchModel',
    ];
    for (const key of requiredKeys) {
      expect(enI18n).toContain(`'${key}'`);
    }
  });

  it('zh-CN.js has all required unify i18n keys', () => {
    const requiredKeys = [
      'unify.chat', 'unify.work',
      'unify.tasksMemory', 'unify.comingSoon',
      'unify.showSidebar', 'unify.hideSidebar',
      'unify.showDetail', 'unify.hideDetail',
      'unify.switchModel',
    ];
    for (const key of requiredKeys) {
      expect(zhI18n).toContain(`'${key}'`);
    }
  });
});
