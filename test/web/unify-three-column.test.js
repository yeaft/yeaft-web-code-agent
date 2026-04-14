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
    expect(unifyPageJs).toContain('Coming soon');
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
