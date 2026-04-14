/**
 * task-257 supplementary tests: Unify UI three-column layout redesign.
 *
 * Supplements dev's unify-three-column.test.js with:
 * 1. Message width: 60% max-width default not overridden
 * 2. Sidebar collapse CSS: transition, opacity, pointer-events, width:0
 * 3. Toggle button wiring: toggleSidebar function + :class binding
 * 4. Three-column CSS specifics: flex-shrink, min-width, overflow
 * 5. Dark mode: all CSS uses CSS variables, no hardcoded colors
 * 6. Sidebar content ordering: back → mode → agent
 * 7. Mode toggle structural location: inside sidebar, not topbar
 * 8. Mobile overlay: z-index, box-shadow, fixed positioning
 * 9. Template DOM ordering: sidebar → main → detail
 * 10. Desktop panel dimensions consistency
 * 11. Detail panel collapse + toggle
 * 12. CSS section spacing (no borders, consistent with Chat)
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
// 1. Message width: 60% default not overridden by Unify
// =============================================================================
describe('Message width matches Chat mode (60% max-width)', () => {
  it('no .unify-page .input-area override exists', () => {
    expect(unifyCss).not.toContain('.unify-page .input-area');
  });

  it('no max-width: 800px in unify.css', () => {
    expect(unifyCss).not.toContain('max-width: 800px');
  });

  it('no .unify-page .message-list width override', () => {
    expect(unifyCss).not.toMatch(/\.unify-page\s+\.message-list/);
  });

  it('no .unify-page .turn-content width override', () => {
    expect(unifyCss).not.toMatch(/\.unify-page\s+\.turn-content/);
  });

  it('chat-input.css defines the 60% max-width for input-wrapper', () => {
    expect(chatInputCss).toMatch(/\.input-wrapper[^{]*\{[^}]*max-width:\s*60%/);
  });

  it('MessageList component is used without wrapper constraints', () => {
    // MessageList is directly inside unify-main, not wrapped in a constrained div
    expect(unifyPageJs).toContain('<MessageList');
    // Check it's not wrapped in a max-width div
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

  it('collapsed sidebar has overflow: hidden', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\.collapsed\s*\{[^}]*overflow:\s*hidden/);
  });

  it('collapsed sidebar has opacity: 0', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\.collapsed\s*\{[^}]*opacity:\s*0/);
  });

  it('collapsed sidebar has pointer-events: none', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\.collapsed\s*\{[^}]*pointer-events:\s*none/);
  });

  it('collapsed sidebar removes border-right', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\.collapsed\s*\{[^}]*border-right:\s*none/);
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

  it('sidebar has min-width: 240px', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\s*\{[^}]*min-width:\s*240px/);
  });

  it('detail panel is flex-shrink: 0 (fixed width)', () => {
    expect(unifyCss).toMatch(/\.unify-detail\s*\{[^}]*flex-shrink:\s*0/);
  });

  it('detail panel has min-width: 280px', () => {
    expect(unifyCss).toMatch(/\.unify-detail\s*\{[^}]*min-width:\s*280px/);
  });

  it('main area has min-width: 0 (prevents overflow)', () => {
    expect(unifyCss).toMatch(/\.unify-main\s*\{[^}]*min-width:\s*0/);
  });

  it('main area has overflow: hidden', () => {
    expect(unifyCss).toMatch(/\.unify-main\s*\{[^}]*overflow:\s*hidden/);
  });

  it('sidebar has overflow-y: auto (scrollable content)', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\s*\{[^}]*overflow-y:\s*auto/);
  });

  it('sidebar uses bg-sidebar background', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\s*\{[^}]*var\(--bg-sidebar\)/);
  });

  it('detail panel uses bg-sidebar background', () => {
    expect(unifyCss).toMatch(/\.unify-detail\s*\{[^}]*var\(--bg-sidebar\)/);
  });

  it('sidebar has border-right', () => {
    expect(unifyCss).toMatch(/\.unify-sidebar\s*\{[^}]*border-right.*var\(--border-color\)/);
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

  it('no hardcoded hex colors in layout rules', () => {
    // Check for hex colors in non-shadow/non-rgba contexts
    const layoutRules = unifyCss.match(/\.unify-(?:page|sidebar|main|detail|topbar)[^{]*\{[^}]*\}/g);
    expect(layoutRules).not.toBeNull();
    for (const rule of layoutRules) {
      // Allow rgba in box-shadow, skip if it's a shadow
      if (rule.includes('box-shadow')) continue;
      const hexColors = rule.match(/(?:color|background|border):\s*#[0-9a-fA-F]+/g);
      expect(hexColors).toBeNull();
    }
  });

  it('back button uses var(--text-secondary)', () => {
    expect(unifyCss).toMatch(/\.unify-back-btn\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('section labels use var(--text-muted)', () => {
    expect(unifyCss).toMatch(/\.unify-section-label\s*\{[^}]*var\(--text-muted\)/);
  });

  it('agent info text uses var(--text-secondary)', () => {
    expect(unifyCss).toMatch(/\.unify-agent-row\s*\{[^}]*var\(--text-secondary\)/);
  });

  it('topbar background uses var(--bg-main)', () => {
    expect(unifyCss).toMatch(/\.unify-topbar\s*\{[^}]*var\(--bg-main\)/);
  });
});

// =============================================================================
// 6. Sidebar content ordering: back → mode → agent
// =============================================================================
describe('Sidebar content ordering', () => {
  it('sidebar-header (back) comes first, then mode, then agent', () => {
    const sidebarStart = unifyPageJs.indexOf('class="unify-sidebar"');
    const headerIdx = unifyPageJs.indexOf('unify-sidebar-header', sidebarStart);
    const modeIdx = unifyPageJs.indexOf('unify-mode-toggle', sidebarStart);
    const agentIdx = unifyPageJs.indexOf('unify-agent-info', sidebarStart);

    expect(headerIdx).toBeGreaterThan(-1);
    expect(modeIdx).toBeGreaterThan(-1);
    expect(agentIdx).toBeGreaterThan(-1);

    expect(headerIdx).toBeLessThan(modeIdx);
    expect(modeIdx).toBeLessThan(agentIdx);
  });

  it('session status is removed from sidebar', () => {
    expect(unifyPageJs).not.toContain('unify-session-status');
    expect(unifyPageJs).not.toContain('unify-status-dot');
  });

  it('each section is wrapped in unify-sidebar-section', () => {
    const sectionMatches = unifyPageJs.match(/class="unify-sidebar-section"/g);
    expect(sectionMatches).not.toBeNull();
    // 2 sections: mode, agent
    expect(sectionMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('section labels use unify-section-label class', () => {
    expect(unifyPageJs).toContain('unify-section-label');
    // Should have Mode and Agent labels
    const labels = unifyPageJs.match(/class="unify-section-label"[^>]*>([^<]*)</g);
    expect(labels).not.toBeNull();
    expect(labels.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// 7. Mode toggle is in sidebar, not topbar
// =============================================================================
describe('Mode toggle in sidebar (not topbar)', () => {
  it('mode toggle is inside sidebar section', () => {
    const sidebarStart = unifyPageJs.indexOf('class="unify-sidebar"');
    const sidebarEnd = unifyPageJs.indexOf('</aside>', sidebarStart);
    const modeToggleIdx = unifyPageJs.indexOf('unify-mode-toggle', sidebarStart);

    expect(modeToggleIdx).toBeGreaterThan(sidebarStart);
    expect(modeToggleIdx).toBeLessThan(sidebarEnd);
  });

  it('topbar does NOT contain mode toggle', () => {
    const topbarStart = unifyPageJs.indexOf('class="unify-topbar"');
    const topbarEnd = unifyPageJs.indexOf('</div>', topbarStart + 50);
    // Find the closest </div> that closes the topbar
    const topbarSection = unifyPageJs.slice(topbarStart, topbarStart + 500);
    expect(topbarSection).not.toContain('unify-mode-toggle');
  });

  it('mode toggle CSS has flex: 1 on buttons (fill width)', () => {
    expect(unifyCss).toMatch(/\.unify-mode-btn\s*\{[^}]*flex:\s*1/);
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
// 10. Agent info display
// =============================================================================
describe('Agent info in sidebar', () => {
  it('shows model name from store.unifyModel', () => {
    expect(unifyPageJs).toContain('store.unifyModel');
  });

  it('shows tools count from store.unifyStatus.tools', () => {
    expect(unifyPageJs).toContain('store.unifyStatus.tools');
  });

  it('shows skills count from store.unifyStatus.skills', () => {
    expect(unifyPageJs).toContain('store.unifyStatus.skills');
  });

  it('shows MCP servers count from store.unifyStatus.mcpServers', () => {
    expect(unifyPageJs).toContain('store.unifyStatus.mcpServers');
  });

  it('agent info conditionally renders when model or tools exist', () => {
    expect(unifyPageJs).toMatch(
      /v-if="store\.unifyModel\s*\|\|\s*\(store\.unifyStatus\s*&&\s*store\.unifyStatus\.tools\s*>\s*0\)"/
    );
  });

  it('each agent row has an SVG icon', () => {
    const agentSection = unifyPageJs.match(/unify-agent-info[\s\S]*?<\/div>\s*<\/div>/);
    expect(agentSection).not.toBeNull();
    const svgCount = (agentSection[0].match(/<svg/g) || []).length;
    // At least 3 SVGs for model, tools, skills
    expect(svgCount).toBeGreaterThanOrEqual(3);
  });
});

// =============================================================================
// 11. Detail panel collapse + toggle
// =============================================================================
describe('Detail panel collapse + toggle', () => {
  it('detail panel has :class binding for collapsed', () => {
    expect(unifyPageJs).toContain(':class="{ collapsed: detailCollapsed }"');
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
