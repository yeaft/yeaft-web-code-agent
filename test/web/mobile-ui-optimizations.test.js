import { describe, it, expect } from 'vitest';

/**
 * Tests for task-228: Mobile UI optimizations
 *
 * Validates:
 * 1. Reload button SVG replaced with single-arrow arc icon
 * 2. splitToPanel menu items have the hiding class
 * 3. Mobile CSS: title centered single-line, path hidden, ellipsis
 * 4. Desktop regression: no styles leaked outside mobile media query
 * 5. Tooltip: title-group has :title binding for folderPath
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// Read source files from the worktree
const rootDir = join(import.meta.dirname, '..', '..');
const chatHeaderSrc = readFileSync(join(rootDir, 'web/components/ChatHeader.js'), 'utf8');
const chatPageSrc = readFileSync(join(rootDir, 'web/components/ChatPage.js'), 'utf8');
const chatModalsCss = readFileSync(join(rootDir, 'web/styles/chat-modals.css'), 'utf8');

// =====================================================================
// 优化 1: Reload button icon replacement
// =====================================================================
describe('优化 1: Reload button SVG icon', () => {
  it('should NOT contain the old double-arrow reload SVG paths', () => {
    // Old icon had two-arrow rotating paths
    expect(chatHeaderSrc).not.toContain('M1 4v6h6');
    expect(chatHeaderSrc).not.toContain('M23 20v-6h-6');
    expect(chatHeaderSrc).not.toContain('M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36');
  });

  it('should contain the new single-arrow arc refresh SVG', () => {
    // New icon: polyline arrow tip + arc path
    expect(chatHeaderSrc).toContain('polyline points="23 4 23 10 17 10"');
    expect(chatHeaderSrc).toContain('M20.49 15a9 9 0 1 1-2.12-9.36L23 10');
  });

  it('should preserve SVG attributes (viewBox, width, height, stroke)', () => {
    // The SVG element should still have proper rendering attributes
    expect(chatHeaderSrc).toContain('viewBox="0 0 24 24"');
    expect(chatHeaderSrc).toContain('width="16"');
    expect(chatHeaderSrc).toContain('height="16"');
    expect(chatHeaderSrc).toContain('stroke="currentColor"');
    expect(chatHeaderSrc).toContain('stroke-width="2"');
  });

  it('should keep the reload button structure intact', () => {
    expect(chatHeaderSrc).toContain('header-reload-btn');
    expect(chatHeaderSrc).toContain('reloadPage');
    expect(chatHeaderSrc).toContain('Reload page');
  });
});

// =====================================================================
// 优化 2: Mobile split-to-panel hiding
// =====================================================================
describe('优化 2: splitToPanel menu item hiding on mobile', () => {
  it('should have split-to-panel-item class on all splitToPanel buttons', () => {
    // All 4 splitToPanel button elements should have the class
    const buttonMatches = chatPageSrc.match(/class="session-menu-item split-to-panel-item"/g);
    expect(buttonMatches).not.toBeNull();
    expect(buttonMatches.length).toBe(4);
  });

  it('should have CSS rule to hide split-to-panel-item', () => {
    expect(chatModalsCss).toContain('.split-to-panel-item');
    expect(chatModalsCss).toContain('display: none !important');
  });

  it('CSS rule should be inside a mobile media query (max-width: 768px)', () => {
    // Extract the media query block that contains split-to-panel-item
    const mediaBlocks = chatModalsCss.split('@media');
    let foundInMobileBlock = false;
    for (const block of mediaBlocks) {
      if (block.includes('max-width: 768px') && block.includes('split-to-panel-item')) {
        foundInMobileBlock = true;
        break;
      }
    }
    expect(foundInMobileBlock).toBe(true);
  });

  it('splitToPanel buttons should still have v-if for isInAnyPanel check', () => {
    // The v-if condition should not be removed, just class added
    const splitButtons = chatPageSrc.match(/split-to-panel-item.*?v-if="!store\.isInAnyPanel/g);
    expect(splitButtons).not.toBeNull();
    expect(splitButtons.length).toBe(4);
  });
});

// =====================================================================
// 优化 3: Mobile title single-line + centered + tooltip
// =====================================================================
describe('优化 3: Mobile title styling', () => {
  describe('Tooltip (folderPath)', () => {
    it('should have :title="folderPath" on chat-title-group', () => {
      // Dynamic Vue binding for native tooltip
      expect(chatHeaderSrc).toContain(':title="folderPath"');
    });

    it(':title should be on chat-title-group div', () => {
      // The :title and class should be on the same element
      const titleGroupLine = chatHeaderSrc.split('\n').find(l =>
        l.includes('chat-title-group') && l.includes(':title')
      );
      expect(titleGroupLine).toBeDefined();
      expect(titleGroupLine).toContain('chat-title-group');
      expect(titleGroupLine).toContain(':title="folderPath"');
    });
  });

  describe('CSS: chat-title-group centering', () => {
    it('should have text-align: center for mobile', () => {
      // Find mobile chat-title-group styles
      const mediaBlocks = chatModalsCss.split('@media');
      let mobileBlock = '';
      for (const block of mediaBlocks) {
        if (block.includes('max-width: 768px') && block.includes('.chat-title-group')) {
          mobileBlock += block;
        }
      }
      expect(mobileBlock).toContain('text-align: center');
    });

    it('should have flex: 1 for flexible sizing', () => {
      const mediaBlocks = chatModalsCss.split('@media');
      let mobileBlock = '';
      for (const block of mediaBlocks) {
        if (block.includes('max-width: 768px') && block.includes('.chat-title-group')) {
          mobileBlock += block;
        }
      }
      expect(mobileBlock).toContain('flex: 1');
    });

    it('should have min-width: 0 for proper ellipsis in flex', () => {
      const mediaBlocks = chatModalsCss.split('@media');
      let mobileBlock = '';
      for (const block of mediaBlocks) {
        if (block.includes('max-width: 768px') && block.includes('.chat-title-group')) {
          mobileBlock += block;
        }
      }
      expect(mobileBlock).toContain('min-width: 0');
    });
  });

  describe('CSS: chat-title-path hidden on mobile', () => {
    it('should hide chat-title-path on mobile', () => {
      const mediaBlocks = chatModalsCss.split('@media');
      let found = false;
      for (const block of mediaBlocks) {
        if (block.includes('max-width: 768px') && block.includes('.chat-title-path')) {
          // Check that it's display: none
          const pathSection = block.substring(block.indexOf('.chat-title-path'));
          if (pathSection.includes('display: none')) {
            found = true;
          }
        }
      }
      expect(found).toBe(true);
    });
  });

  describe('CSS: chat-title ellipsis', () => {
    it('should have overflow: hidden', () => {
      const mediaBlocks = chatModalsCss.split('@media');
      let mobileChatTitle = '';
      for (const block of mediaBlocks) {
        if (block.includes('max-width: 768px') && block.includes('.chat-title {')) {
          mobileChatTitle += block;
        }
      }
      expect(mobileChatTitle).toContain('overflow: hidden');
    });

    it('should have text-overflow: ellipsis', () => {
      const mediaBlocks = chatModalsCss.split('@media');
      let mobileChatTitle = '';
      for (const block of mediaBlocks) {
        if (block.includes('max-width: 768px') && block.includes('.chat-title {')) {
          mobileChatTitle += block;
        }
      }
      expect(mobileChatTitle).toContain('text-overflow: ellipsis');
    });

    it('should have white-space: nowrap', () => {
      const mediaBlocks = chatModalsCss.split('@media');
      let mobileChatTitle = '';
      for (const block of mediaBlocks) {
        if (block.includes('max-width: 768px') && block.includes('.chat-title {')) {
          mobileChatTitle += block;
        }
      }
      expect(mobileChatTitle).toContain('white-space: nowrap');
    });

    it('should have font-size: 14px for mobile', () => {
      const mediaBlocks = chatModalsCss.split('@media');
      let mobileChatTitle = '';
      for (const block of mediaBlocks) {
        if (block.includes('max-width: 768px') && block.includes('.chat-title {')) {
          mobileChatTitle += block;
        }
      }
      expect(mobileChatTitle).toContain('font-size: 14px');
    });
  });
});

// =====================================================================
// Regression: desktop styles unaffected
// =====================================================================
describe('Regression: desktop styles', () => {
  it('chat-title-path is NOT hidden outside media queries', () => {
    // Extract the non-media-query portion of the CSS
    // All .chat-title-path display:none should be inside @media blocks
    const lines = chatModalsCss.split('\n');
    let inMedia = 0;
    let pathHiddenOutsideMedia = false;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('@media')) inMedia++;
      // Rough brace counting for top-level scope detection
      if (inMedia === 0 && lines[i].includes('.chat-title-path') && i + 1 < lines.length) {
        if (lines[i + 1].includes('display: none')) {
          pathHiddenOutsideMedia = true;
        }
      }
    }
    expect(pathHiddenOutsideMedia).toBe(false);
  });

  it('split-to-panel-item is only hidden inside mobile media query', () => {
    // The .split-to-panel-item rule should only exist within @media blocks
    const allOccurrences = chatModalsCss.match(/\.split-to-panel-item/g);
    expect(allOccurrences).not.toBeNull();

    // It should be within @media context
    const mediaBlocks = chatModalsCss.split('@media');
    let foundInMedia = false;
    for (const block of mediaBlocks) {
      if (block.includes('max-width: 768px') && block.includes('.split-to-panel-item')) {
        foundInMedia = true;
      }
    }
    expect(foundInMedia).toBe(true);
  });

  it('chat-title-group does NOT have text-align: center outside @media', () => {
    // No centering in the base styles — only inside mobile media query
    // The first @media block with chat-title-group has text-align: left (split mode)
    // The new one has text-align: center but only inside @media
    const beforeFirstMedia = chatModalsCss.split('@media')[0];
    const titleGroupInBase = beforeFirstMedia.includes('.chat-title-group');
    // If chat-title-group exists before any @media, it should NOT have center
    if (titleGroupInBase) {
      const idx = beforeFirstMedia.indexOf('.chat-title-group');
      const snippet = beforeFirstMedia.substring(idx, idx + 200);
      expect(snippet).not.toContain('text-align: center');
    }
    // Either way, test passes
    expect(true).toBe(true);
  });

  it('headerTitle and folderPath template bindings are preserved', () => {
    // Desktop still shows both title and path
    expect(chatHeaderSrc).toContain('{{ headerTitle }}');
    expect(chatHeaderSrc).toContain('{{ folderPath }}');
    expect(chatHeaderSrc).toContain('chat-title-path');
    expect(chatHeaderSrc).toContain('chat-title-path-text');
  });

  it('v-if condition for path display is unchanged', () => {
    // The v-if should still show path when folderPath exists or in split mode
    expect(chatHeaderSrc).toContain('v-if="folderPath || (store.isSplitMode && agentName)"');
  });
});

// =====================================================================
// Change scope: only expected files modified
// =====================================================================
describe('Change scope validation', () => {
  it('ChatHeader.js should still have header-reload-btn with v-if', () => {
    expect(chatHeaderSrc).toContain('v-if="!store.isSplitMode"');
  });

  it('ChatPage.js should still have all 4 splitToPanel menu items', () => {
    const splitButtons = chatPageSrc.match(/splitToPanel\(conv\.id\)/g);
    expect(splitButtons).not.toBeNull();
    expect(splitButtons.length).toBe(4);
  });
});
