import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tests for task-257: Unify UI three-column redesign.
 *
 * Layout: left sidebar (240px) + center conversation + right detail (280px).
 * Conversation reuses standard MessageList + ChatInput with default 60% max-width.
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
// 2. Left sidebar content
// =====================================================================
describe('Left sidebar content', () => {
  it('has back button', () => {
    expect(unifyPageJs).toContain('unify-back-btn');
    expect(unifyPageJs).toContain('goBack');
  });

  it('has mode toggle (chat/work)', () => {
    expect(unifyPageJs).toContain('unify-mode-toggle');
    expect(unifyPageJs).toContain("setMode('chat')");
    expect(unifyPageJs).toContain("setMode('work')");
  });

  it('has agent info section (model, tools, skills)', () => {
    expect(unifyPageJs).toContain('unify-agent-info');
    expect(unifyPageJs).toContain('store.unifyModel');
    expect(unifyPageJs).toContain('store.unifyStatus');
  });

  it('has session status indicator', () => {
    expect(unifyPageJs).toContain('unify-session-status');
    expect(unifyPageJs).toContain('unify-status-dot');
  });

  it('sidebar is 240px wide', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\s*\{[^}]*width:\s*240px/);
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
    // The old .unify-page .input-area { max-width: 800px } should be removed
    expect(unifyCss).not.toContain('.unify-page .input-area');
    expect(unifyCss).not.toMatch(/\.input-area[^{]*\{[^}]*max-width:\s*800px/);
  });

  it('topbar is simplified (model badge + clear)', () => {
    expect(unifyPageJs).toContain('unify-topbar');
    expect(unifyPageJs).toContain('unify-model-badge');
    expect(unifyPageJs).toContain('unify-clear-btn');
  });

  it('topbar does NOT contain mode toggle (moved to sidebar)', () => {
    // The mode toggle should be in the sidebar section, not in unify-topbar
    const topbarMatch = unifyPageJs.match(/class="unify-topbar"[\s\S]*?<\/div>\s*\n\s*<!--/);
    if (topbarMatch) {
      expect(topbarMatch[0]).not.toContain('unify-mode-toggle');
    }
  });

  it('has sidebar toggle button in topbar', () => {
    expect(unifyPageJs).toContain('unify-sidebar-toggle');
  });
});

// =====================================================================
// 4. Right detail panel
// =====================================================================
describe('Right detail panel', () => {
  it('is 280px wide', () => {
    expect(unifyCss).toMatch(/\.unify-detail\s*\{[^}]*width:\s*280px/);
  });

  it('has placeholder content', () => {
    expect(unifyPageJs).toContain('unify-detail-placeholder');
  });

  it('has border-left', () => {
    expect(unifyCss).toMatch(/\.unify-detail\s*\{[^}]*border-left/);
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

  it('hides back text on mobile', () => {
    const mediaBlock = unifyCss.match(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\n\}/);
    expect(mediaBlock).not.toBeNull();
    expect(mediaBlock[0]).toContain('.unify-back-text');
    expect(mediaBlock[0]).toContain('display: none');
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

  it('does not have old .unify-page .input-area override', () => {
    expect(unifyCss).not.toContain('.unify-page .input-area');
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

  it('returns toggleSidebar function', () => {
    expect(unifyPageJs).toContain('toggleSidebar');
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
// 8. i18n — no hardcoded English labels in sidebar
// =====================================================================
describe('i18n — sidebar labels use $t()', () => {
  it('mode label uses $t()', () => {
    expect(unifyPageJs).toContain("$t('unify.mode')");
  });

  it('agent label uses $t()', () => {
    expect(unifyPageJs).toContain("$t('unify.agent')");
  });

  it('tools/skills/mcp labels use $t()', () => {
    expect(unifyPageJs).toContain("$t('unify.tools')");
    expect(unifyPageJs).toContain("$t('unify.skills')");
    expect(unifyPageJs).toContain("$t('unify.mcp')");
  });

  it('session status labels use $t()', () => {
    expect(unifyPageJs).toContain("$t('unify.connecting')");
    expect(unifyPageJs).toContain("$t('unify.ready')");
  });

  it('right panel placeholder uses $t()', () => {
    expect(unifyPageJs).toContain("$t('unify.tasksMemory')");
    expect(unifyPageJs).toContain("$t('unify.comingSoon')");
  });

  it('sidebar toggle titles use $t()', () => {
    expect(unifyPageJs).toContain("$t('unify.showSidebar')");
    expect(unifyPageJs).toContain("$t('unify.hideSidebar')");
  });

  it('no hardcoded English labels remain in sidebar sections', () => {
    // These strings should be replaced with $t() calls
    expect(unifyPageJs).not.toMatch(/>Mode</);
    expect(unifyPageJs).not.toMatch(/>Agent</);
    expect(unifyPageJs).not.toMatch(/>Connecting\.\.\.</);
    expect(unifyPageJs).not.toMatch(/>Ready</);
    expect(unifyPageJs).not.toMatch(/>Tasks & Memory</);
    expect(unifyPageJs).not.toMatch(/>Coming soon</);
  });

  it('en.js has all required unify i18n keys', () => {
    const requiredKeys = [
      'unify.mode', 'unify.agent', 'unify.connecting', 'unify.ready',
      'unify.tools', 'unify.skills', 'unify.mcp',
      'unify.tasksMemory', 'unify.comingSoon',
      'unify.showSidebar', 'unify.hideSidebar',
    ];
    for (const key of requiredKeys) {
      expect(enI18n).toContain(`'${key}'`);
    }
  });

  it('zh-CN.js has all required unify i18n keys', () => {
    const requiredKeys = [
      'unify.mode', 'unify.agent', 'unify.connecting', 'unify.ready',
      'unify.tools', 'unify.skills', 'unify.mcp',
      'unify.tasksMemory', 'unify.comingSoon',
      'unify.showSidebar', 'unify.hideSidebar',
    ];
    for (const key of requiredKeys) {
      expect(zhI18n).toContain(`'${key}'`);
    }
  });
});
