import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #260 — globalBlocks visibility fix.
 *
 * Bug: PM messages in center panel were pushed out of view when many
 * feature blocks existed because visibleBlocks/hiddenBlockCount/loadMore
 * counted ALL blocks (including feature blocks that are only rendered in
 * the right panel). Fix: introduce globalBlocks computed that filters
 * type==='global' and base all visibility window logic on it.
 *
 * Verification points:
 * 1) PM (global) messages always visible even with many feature blocks
 * 2) "Load older" works correctly against global blocks
 * 3) scrollToRoleLatest only adjusts visibleBlockCount for global targets
 * 4) Right panel (feature) content unaffected — featureBlocks still available
 * 5) Conversation switch resets visibleBlockCount
 */

let scrollSource;
let viewSource;

beforeAll(() => {
  const scrollPath = resolve(__dirname, '../../web/components/crew/crewScroll.js');
  scrollSource = readFileSync(scrollPath, 'utf-8');
  const viewPath = resolve(__dirname, '../../web/components/CrewChatView.js');
  viewSource = readFileSync(viewPath, 'utf-8');
});

function extractFunctionBody(source, fnName) {
  const lines = source.split('\n');
  let bestBody = '';
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (
      (trimmed.startsWith(`${fnName}(`) ||
        trimmed.startsWith(`function ${fnName}(`) ||
        trimmed.startsWith(`export function ${fnName}(`)) &&
      trimmed.endsWith('{')
    ) {
      const startIdx = source.indexOf(lines[i]);
      const braceStart = source.indexOf('{', startIdx);
      if (braceStart === -1) continue;
      let depth = 0;
      let end = braceStart;
      for (let j = braceStart; j < source.length; j++) {
        if (source[j] === '{') depth++;
        if (source[j] === '}') depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
      const body = source.substring(braceStart + 1, end).trim();
      if (body.length > bestBody.length) bestBody = body;
    }
  }
  return bestBody;
}

// =====================================================================
// 1. globalBlocks computed — filters global type only
// =====================================================================
describe('globalBlocks computed property', () => {
  it('exists and filters by type === global', () => {
    expect(scrollSource).toContain('const globalBlocks = Vue.computed');
    expect(scrollSource).toContain("b.type === 'global'");
  });

  it('sources from getFeatureBlocks and applies filter', () => {
    expect(scrollSource).toContain("getFeatureBlocks().filter(b => b.type === 'global')");
  });
});

// =====================================================================
// 2. visibleBlocks based on globalBlocks — PM messages not pushed out
// =====================================================================
describe('visibleBlocks uses globalBlocks (not all blocks)', () => {
  it('visibleBlocks reads from globalBlocks.value', () => {
    // visibleBlocks computed uses globalBlocks.value as its data source
    expect(scrollSource).toContain('const all = globalBlocks.value');
  });

  it('visibleBlocks does NOT directly call getFeatureBlocks()', () => {
    // Extract just the visibleBlocks computed — it's defined inline
    // The key assertion: visibleBlocks computed references globalBlocks.value
    // and the slice logic operates on globalBlocks, not getFeatureBlocks()
    const visibleBlocksStart = scrollSource.indexOf('const visibleBlocks = Vue.computed');
    const nextComputedStart = scrollSource.indexOf('const hiddenBlockCount', visibleBlocksStart);
    const visibleBlocksSection = scrollSource.substring(visibleBlocksStart, nextComputedStart);
    expect(visibleBlocksSection).toContain('globalBlocks.value');
    expect(visibleBlocksSection).not.toContain('getFeatureBlocks()');
  });

  it('slicing logic is preserved (show latest N blocks)', () => {
    expect(scrollSource).toContain('all.slice(all.length - visibleBlockCount.value)');
  });

  it('center panel template only renders global blocks from visibleBlocks', () => {
    expect(viewSource).toContain("v-if=\"block.type === 'global'\"");
  });
});

// =====================================================================
// 3. hiddenBlockCount based on globalBlocks
// =====================================================================
describe('hiddenBlockCount uses globalBlocks', () => {
  it('computes hidden count from globalBlocks length', () => {
    expect(scrollSource).toContain('globalBlocks.value.length - visibleBlockCount.value');
  });
});

// =====================================================================
// 4. loadMoreBlocks caps at globalBlocks length
// =====================================================================
describe('loadMoreBlocks uses globalBlocks', () => {
  it('caps visibleBlockCount at globalBlocks.value.length', () => {
    const body = extractFunctionBody(scrollSource, 'loadMoreBlocks');
    expect(body).toContain('globalBlocks.value.length');
  });

  it('increments by 10 per load', () => {
    const body = extractFunctionBody(scrollSource, 'loadMoreBlocks');
    expect(body).toContain('visibleBlockCount.value + 10');
  });
});

// =====================================================================
// 5. loadHistory resets visibleBlockCount to globalBlocks length
// =====================================================================
describe('loadHistory resets to globalBlocks length', () => {
  it('sets visibleBlockCount to globalBlocks.value.length after history load', () => {
    const body = extractFunctionBody(scrollSource, 'loadHistory');
    expect(body).toContain('visibleBlockCount.value = globalBlocks.value.length');
  });
});

// =====================================================================
// 6. scrollToRoleLatest — only adjusts for global targets
// =====================================================================
describe('scrollToRoleLatest adjusts visibleBlockCount for global targets only', () => {
  it('checks targetBlock.type === global before adjusting', () => {
    const body = extractFunctionBody(scrollSource, 'scrollToRoleLatest');
    expect(body).toContain("if (targetBlock.type === 'global')");
  });

  it('filters globals from blocks to compute needed count', () => {
    const body = extractFunctionBody(scrollSource, 'scrollToRoleLatest');
    expect(body).toContain("blocks.filter(b => b.type === 'global')");
  });

  it('calculates needed from global index, not all-blocks index', () => {
    const body = extractFunctionBody(scrollSource, 'scrollToRoleLatest');
    expect(body).toContain('globals.length - gIdx');
  });

  it('still expands feature blocks when target is a feature block', () => {
    const body = extractFunctionBody(scrollSource, 'scrollToRoleLatest');
    expect(body).toContain("targetBlock.type === 'feature'");
    expect(body).toContain('expandedFeatures[targetBlock.taskId] = true');
  });

  it('does not adjust visibleBlockCount for feature target blocks', () => {
    const body = extractFunctionBody(scrollSource, 'scrollToRoleLatest');
    // The visibleBlockCount adjustment is inside if (targetBlock.type === 'global')
    // Verify the guard structure: global check wraps the needed/visibleBlockCount logic
    const globalCheckIdx = body.indexOf("if (targetBlock.type === 'global')");
    const neededAssignIdx = body.indexOf('visibleBlockCount.value = needed', globalCheckIdx);
    // The needed assignment is inside the global check block
    expect(globalCheckIdx).toBeGreaterThan(-1);
    expect(neededAssignIdx).toBeGreaterThan(globalCheckIdx);
  });
});

// =====================================================================
// 7. Conversation switch resets visibleBlockCount
// =====================================================================
describe('conversation switch resets visibleBlockCount', () => {
  it('resets visibleBlockCount to 20 on conversation change', () => {
    expect(viewSource).toContain('this.scroll.visibleBlockCount.value = 20');
  });

  it('reset is triggered by watching effectiveConvId (conversationId prop fallback)', () => {
    // The watcher should exist — uses effectiveConvId computed (prop || store.currentConversation)
    expect(viewSource).toContain("'effectiveConvId'");
  });
});

// =====================================================================
// 8. featureBlocks still available for right panel
// =====================================================================
describe('right panel featureBlocks unaffected', () => {
  it('getFeatureBlocks is still passed to createCrewScroll', () => {
    expect(viewSource).toContain('getFeatureBlocks: () => this.featureBlocks');
  });

  it('globalBlocks filters from getFeatureBlocks, not replaces it', () => {
    // getFeatureBlocks() is called in globalBlocks, but the original
    // featureBlocks getter remains available for other consumers
    expect(scrollSource).toContain('getFeatureBlocks().filter');
  });

  it('feature blocks have type=feature and are separate from global', () => {
    // crewMessageGrouping creates both types
    const groupingPath = resolve(__dirname, '../../web/components/crew/crewMessageGrouping.js');
    const groupingSource = readFileSync(groupingPath, 'utf-8');
    expect(groupingSource).toContain("type: 'global'");
    expect(groupingSource).toContain("type: 'feature'");
  });
});

// =====================================================================
// 9. scrollToBottomAndReset — unchanged baseline behavior
// =====================================================================
describe('scrollToBottomAndReset baseline', () => {
  it('resets visibleBlockCount to 20 and scrolls to bottom', () => {
    const body = extractFunctionBody(scrollSource, 'scrollToBottomAndReset');
    expect(body).toContain('visibleBlockCount.value = 20');
    expect(body).toContain('scrollToBottom()');
  });
});
