/**
 * Supplementary tests: Unify UI three-column layout.
 *
 * After task-279 sidebar redesign:
 * - Sidebar is minimal (56px): back button + bottom settings gear
 * - Mode toggle moved to topbar
 * - Model selector moved to topbar
 * - Skills/MCP counts removed
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');

let unifyPageJs;
let unifyCss;
let chatInputCss;

beforeAll(() => {
  unifyPageJs = read('web/components/UnifyPage.js');
  unifyCss = read('web/styles/unify.css');
  chatInputCss = read('web/styles/chat-input.css');
});

// =============================================================================
// 1. Unify conversation area uses wider width than Chat (90% vs 60%)
// =============================================================================
describe('Unify conversation area is wider than Chat default', () => {
  it('.unify-page .input-area override exists for tighter padding', () => {
    expect(unifyCss).toContain('.unify-page .input-area');
  });

  it('.unify-page .messages uses 90% max-width', () => {
    expect(unifyCss).toMatch(/\.unify-page\s+\.messages[^{]*\{[^}]*max-width:\s*90%/);
  });

  it('.unify-page .input-wrapper uses 90% max-width', () => {
    expect(unifyCss).toMatch(/\.unify-page\s+\.input-wrapper[^{]*\{[^}]*max-width:\s*90%/);
  });

  it('no max-width: 800px in unify.css', () => {
    expect(unifyCss).not.toContain('max-width: 800px');
  });

  it('chat-input.css defines the 60% max-width for input-wrapper', () => {
    expect(chatInputCss).toMatch(/\.input-wrapper[^{]*\{[^}]*max-width:\s*60%/);
  });

  it('MessageList component is used without wrapper constraints', () => {
    expect(unifyPageJs).toContain('<MessageList');
    const mainSection = unifyPageJs.match(/class="unify-main"[\s\S]*?<MessageList/);
    expect(mainSection).not.toBeNull();
    expect(mainSection[0]).not.toContain('max-width');
  });
});

// =============================================================================
// 2. Sidebar collapse CSS mechanism
// =============================================================================
describe('Sidebar collapse CSS mechanism', () => {
  it('collapsed sidebar has width: 0', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\.collapsed\s*\{[^}]*width:\s*0/);
  });

  it('collapsed sidebar has min-width: 0', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\.collapsed\s*\{[^}]*min-width:\s*0/);
  });

  it('collapsed sidebar has opacity: 0', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\.collapsed\s*\{[^}]*opacity:\s*0/);
  });

  it('collapsed sidebar has pointer-events: none', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\.collapsed\s*\{[^}]*pointer-events:\s*none/);
  });

  it('sidebar has CSS transition for smooth collapse', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\s*\{[^}]*transition:/);
    const sidebarRule = unifyCss.match(/\.unify-sidebar\s*\{[^}]*\}/);
    expect(sidebarRule).not.toBeNull();
    expect(sidebarRule[0]).toContain('width');
    expect(sidebarRule[0]).toContain('0.2s');
  });
});

// =============================================================================
// 3. Toggle button wiring
// =============================================================================
describe('Sidebar toggle button wiring', () => {
  it('template binds :class="{ collapsed: sidebarCollapsed }" on sidebar', () => {
    expect(unifyPageJs).toContain(':class="{ collapsed: sidebarCollapsed }"');
  });

  it('toggle button calls toggleSidebar', () => {
    expect(unifyPageJs).toContain('@click="toggleSidebar"');
  });

  it('sidebarCollapsed is a Vue ref initialized to false', () => {
    expect(unifyPageJs).toContain('Vue.ref(false)');
    expect(unifyPageJs).toContain('sidebarCollapsed');
  });

  it('toggleSidebar flips sidebarCollapsed value', () => {
    expect(unifyPageJs).toContain('sidebarCollapsed.value = !sidebarCollapsed.value');
  });

  it('toggle button is inside unify-topbar (center area)', () => {
    const topbarMatch = unifyPageJs.match(/class="unify-topbar"[\s\S]*?<\/div>\s*\n/);
    expect(topbarMatch).not.toBeNull();
    expect(topbarMatch[0]).toContain('unify-sidebar-toggle');
  });

  it('toggle button has hamburger icon SVG', () => {
    expect(unifyPageJs).toMatch(/unify-sidebar-toggle[\s\S]*?<svg/);
  });
});

// =============================================================================
// 4. Three-column CSS specifics
// =============================================================================
describe('Three-column CSS layout details', () => {
  it('sidebar is flex-shrink: 0 (fixed width)', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\s*\{[^}]*flex-shrink:\s*0/);
  });

  it('sidebar has min-width: 56px', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\s*\{[^}]*min-width:\s*56px/);
  });

  it('detail panel is flex-shrink: 0 (fixed width)', () => {
    expect(unifyCss).toMatch(/\.unify-detail\s*\{[^}]*flex-shrink:\s*0/);
  });

  it('detail panel has min-width using CSS variable', () => {
    expect(unifyCss).toMatch(/\.unify-detail\s*\{[^}]*min-width:\s*var\(--unify-detail-width/);
  });

  it('main area has min-width: 0 (prevents overflow)', () => {
    expect(unifyCss).toMatch(/\.unify-main\s*\{[^}]*min-width:\s*0/);
  });

  it('main area has overflow: hidden', () => {
    expect(unifyCss).toMatch(/\.unify-main\s*\{[^}]*overflow:\s*hidden/);
  });

  it('sidebar uses bg-sidebar background', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\s*\{[^}]*var\(--bg-sidebar\)/);
  });

  it('detail panel uses bg-sidebar background', () => {
    expect(unifyCss).toMatch(/\.unify-detail\s*\{[^}]*var\(--bg-sidebar\)/);
  });

  it('sidebar does NOT have border-right (no divider lines)', () => {
    expect(unifyCss).not.toMatch(/\.unify-sidebar\s*\{[^}]*border-right/);
  });
});

// =============================================================================
// 5. Dark mode: all CSS uses CSS variables
// =============================================================================
describe('Dark mode: CSS variables throughout', () => {
  it('page background uses var(--bg-main)', () => {
    expect(unifyCss).toMatch(/\.unify-page\s*\{[^}]*var\(--bg-main\)/);
  });

  it('page text uses var(--text-primary)', () => {
    expect(unifyCss).toMatch(/\.unify-page\s*\{[^}]*var\(--text-primary\)/);
  });

  it('back button uses var(--text-secondary)', () => {
    expect(unifyCss).toMatch(/\.unify-back-btn\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('section labels use var(--text-muted)', () => {
    expect(unifyCss).toMatch(/\.unify-section-label\s*\{[^}]*var\(--text-muted\)/);
  });

  it('topbar background uses var(--bg-main)', () => {
    expect(unifyCss).toMatch(/\.unify-topbar\s*\{[^}]*var\(--bg-main\)/);
  });
});

// =============================================================================
// 6. Sidebar content ordering: back at top, settings at bottom
// =============================================================================
describe('Sidebar content ordering', () => {
  it('sidebar-header (back) comes before sidebar-footer (settings)', () => {
    const sidebarStart = unifyPageJs.indexOf('class="unify-sidebar"');
    const headerIdx = unifyPageJs.indexOf('unify-sidebar-header', sidebarStart);
    const spacerIdx = unifyPageJs.indexOf('unify-sidebar-spacer', sidebarStart);
    const footerIdx = unifyPageJs.indexOf('unify-sidebar-footer', sidebarStart);

    expect(headerIdx).toBeGreaterThan(-1);
    expect(spacerIdx).toBeGreaterThan(-1);
    expect(footerIdx).toBeGreaterThan(-1);

    expect(headerIdx).toBeLessThan(spacerIdx);
    expect(spacerIdx).toBeLessThan(footerIdx);
  });

  it('session status is removed from sidebar', () => {
    expect(unifyPageJs).not.toContain('unify-session-status');
    expect(unifyPageJs).not.toContain('unify-status-dot');
  });
});

// =============================================================================
// 7. Mode toggle is in topbar (not sidebar)
// =============================================================================
describe('Mode toggle in topbar', () => {
  it('mode toggle is inside topbar', () => {
    const topbarStart = unifyPageJs.indexOf('class="unify-topbar"');
    const topbarSection = unifyPageJs.slice(topbarStart, topbarStart + 1500);
    expect(topbarSection).toContain('unify-topbar-mode');
  });

  it('mode toggle is NOT in sidebar', () => {
    const sidebarStart = unifyPageJs.indexOf('class="unify-sidebar"');
    const sidebarEnd = unifyPageJs.indexOf('</aside>', sidebarStart);
    const sidebarContent = unifyPageJs.slice(sidebarStart, sidebarEnd);
    expect(sidebarContent).not.toContain('unify-topbar-mode');
    expect(sidebarContent).not.toContain('unify-mode-toggle');
  });

  it('topbar mode toggle CSS has compact styling', () => {
    expect(unifyCss).toContain('.unify-topbar-mode');
    expect(unifyCss).toContain('.unify-topbar-mode-btn');
  });
});

// =============================================================================
// 8. Mobile overlay behavior
// =============================================================================
describe('Mobile overlay behavior', () => {
  it('sidebar becomes position: fixed on mobile', () => {
    const mobileBlock = unifyCss.match(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\n\}/);
    expect(mobileBlock).not.toBeNull();
    expect(mobileBlock[0]).toContain('.unify-sidebar');
    expect(mobileBlock[0]).toContain('position: fixed');
  });

  it('mobile sidebar has z-index: 100 (above content)', () => {
    const mobileBlock = unifyCss.match(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\n\}/);
    expect(mobileBlock).not.toBeNull();
    expect(mobileBlock[0]).toContain('z-index: 100');
  });

  it('mobile sidebar has box-shadow for overlay effect', () => {
    const mobileBlock = unifyCss.match(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\n\}/);
    expect(mobileBlock).not.toBeNull();
    expect(mobileBlock[0]).toContain('box-shadow');
  });

  it('mobile sidebar covers full height (100vh/100dvh)', () => {
    const mobileBlock = unifyCss.match(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\n\}/);
    expect(mobileBlock).not.toBeNull();
    expect(mobileBlock[0]).toContain('height: 100vh');
  });

  it('mobile collapsed sidebar removes box-shadow', () => {
    const mobileBlock = unifyCss.match(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\n\}/);
    expect(mobileBlock).not.toBeNull();
    expect(mobileBlock[0]).toContain('.unify-sidebar.collapsed');
    expect(mobileBlock[0]).toContain('box-shadow: none');
  });

  it('detail panel hidden at tablet breakpoint (1024px)', () => {
    const tabletBlock = unifyCss.match(/@media\s*\(max-width:\s*1024px\)\s*\{[\s\S]*?\n\}/);
    expect(tabletBlock).not.toBeNull();
    expect(tabletBlock[0]).toContain('.unify-detail');
    expect(tabletBlock[0]).toContain('display: none');
  });
});

// =============================================================================
// 9. Template DOM ordering: sidebar → main → detail
// =============================================================================
describe('Template DOM ordering', () => {
  it('sidebar (aside) comes before main (div)', () => {
    const sidebarIdx = unifyPageJs.indexOf('class="unify-sidebar"');
    const mainIdx = unifyPageJs.indexOf('class="unify-main"');
    expect(sidebarIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeGreaterThan(-1);
    expect(sidebarIdx).toBeLessThan(mainIdx);
  });

  it('main comes before detail (aside)', () => {
    const mainIdx = unifyPageJs.indexOf('class="unify-main"');
    const detailIdx = unifyPageJs.indexOf('class="unify-detail"');
    expect(mainIdx).toBeGreaterThan(-1);
    expect(detailIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeLessThan(detailIdx);
  });

  it('sidebar uses <aside> element', () => {
    expect(unifyPageJs).toMatch(/<aside\s+class="unify-sidebar"/);
  });

  it('detail uses <aside> element', () => {
    expect(unifyPageJs).toMatch(/<aside\s+class="unify-detail"/);
  });

  it('main uses <div> element', () => {
    expect(unifyPageJs).toMatch(/<div\s+class="unify-main"/);
  });
});

// =============================================================================
// 10. Model selector in topbar
// =============================================================================
describe('Model selector in topbar', () => {
  it('shows model name from store.unifyModel', () => {
    expect(unifyPageJs).toContain('store.unifyModel');
  });

  it('model selector is in topbar (not sidebar)', () => {
    const topbarStart = unifyPageJs.indexOf('class="unify-topbar"');
    const topbarSection = unifyPageJs.slice(topbarStart, topbarStart + 1500);
    expect(topbarSection).toContain('unify-topbar-model');
  });

  it('model dropdown opens on click', () => {
    expect(unifyPageJs).toContain('toggleModelDropdown');
    expect(unifyPageJs).toContain('modelDropdownOpen');
  });

  it('model dropdown shows available models', () => {
    expect(unifyPageJs).toContain('store.unifyAvailableModels');
    expect(unifyPageJs).toContain('selectModel');
  });

  it('has CSS for topbar model selector', () => {
    expect(unifyCss).toContain('.unify-topbar-model');
    expect(unifyCss).toContain('.unify-topbar-model-name');
    expect(unifyCss).toContain('.unify-topbar-model-dropdown');
  });
});

// =============================================================================
// 11. Detail panel collapse + toggle
// =============================================================================
describe('Detail panel collapse + toggle', () => {
  it('detail panel has :class binding for collapsed', () => {
    expect(unifyPageJs).toContain('collapsed: detailCollapsed');
  });

  it('topbar has detail toggle button', () => {
    expect(unifyPageJs).toContain('unify-detail-toggle');
    expect(unifyPageJs).toContain('toggleDetail');
  });

  it('detail toggle uses i18n titles', () => {
    expect(unifyPageJs).toContain("$t('unify.showDetail')");
    expect(unifyPageJs).toContain("$t('unify.hideDetail')");
  });

  it('detailCollapsed is a Vue ref', () => {
    expect(unifyPageJs).toContain('detailCollapsed');
  });

  it('toggleDetail flips detailCollapsed value', () => {
    expect(unifyPageJs).toContain('detailCollapsed.value = !detailCollapsed.value');
  });

  it('collapsed detail panel has CSS with width: 0', () => {
    expect(unifyCss).toMatch(/\.unify-detail\.collapsed\s*\{[^}]*width:\s*0/);
  });

  it('collapsed detail panel has opacity: 0', () => {
    expect(unifyCss).toMatch(/\.unify-detail\.collapsed\s*\{[^}]*opacity:\s*0/);
  });

  it('detail panel has smooth transition', () => {
    expect(unifyCss).toMatch(/\.unify-detail\s*\{[^}]*transition:/);
  });

  it('detail toggle button has CSS style', () => {
    expect(unifyCss).toContain('.unify-detail-toggle');
  });
});

// =============================================================================
// 12. CSS section spacing (no borders, consistent with Chat)
// =============================================================================
describe('CSS section spacing (no borders)', () => {
  it('sidebar header does NOT have border-bottom', () => {
    expect(unifyCss).not.toMatch(/\.unify-sidebar-header\s*\{[^}]*border-bottom/);
  });

  it('sidebar sections do NOT have border-bottom', () => {
    expect(unifyCss).not.toMatch(/\.unify-sidebar-section\s*\{[^}]*border-bottom/);
  });

  it('sidebar does NOT have border-right', () => {
    expect(unifyCss).not.toMatch(/\.unify-sidebar\s*\{[^}]*border-right/);
  });

  it('topbar does NOT have border-bottom', () => {
    expect(unifyCss).not.toMatch(/\.unify-topbar\s*\{[^}]*border-bottom/);
  });

  it('detail panel does NOT have border-left', () => {
    expect(unifyCss).not.toMatch(/\.unify-detail\s*\{[^}]*border-left/);
  });

  it('debug header does NOT have border-bottom', () => {
    expect(unifyCss).not.toMatch(/\.unify-debug-header\s*\{[^}]*border-bottom/);
  });

  it('debug turn body does NOT have border-top', () => {
    expect(unifyCss).not.toMatch(/\.unify-debug-turn-body\s*\{[^}]*border-top/);
  });

  it('NO directional borders exist anywhere in unify.css', () => {
    expect(unifyCss).not.toMatch(/border-(top|bottom|left|right):\s*1px/);
  });

  it('sidebar sections have padding', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar-section\s*\{[^}]*padding/);
  });

  it('section labels have uppercase text transform', () => {
    expect(unifyCss).toMatch(/\.unify-section-label\s*\{[^}]*text-transform:\s*uppercase/);
  });

  it('section labels have letter-spacing', () => {
    expect(unifyCss).toMatch(/\.unify-section-label\s*\{[^}]*letter-spacing/);
  });

  it('session status CSS is fully removed', () => {
    expect(unifyCss).not.toContain('.unify-session-status');
    expect(unifyCss).not.toContain('.unify-status-dot');
    expect(unifyCss).not.toContain('unify-pulse');
  });
});
