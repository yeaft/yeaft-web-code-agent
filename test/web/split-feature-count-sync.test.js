/**
 * task-229: Split-pane feature badge count should be independent per conversation.
 *
 * Bug: In split mode, left and right pane feature badges synced to the same value
 * because `crewInProgressCount` was a single global number. Fix changes it to
 * `crewInProgressCounts: {}` map keyed by conversationId.
 *
 * Test scenarios:
 * 1. Left pane has N features, right pane has M features (N ≠ M) → badges show N and M independently
 * 2. Switching right pane to another conversation → left pane badge unchanged
 * 3. crewFeatureCount computed reads from map per effectiveConvId
 * 4. Old global crewInProgressCount is fully removed
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');

let chatStoreSrc;
let crewChatViewSrc;
let chatHeaderSrc;

beforeAll(() => {
  chatStoreSrc = read('web/stores/chat.js');
  crewChatViewSrc = read('web/components/CrewChatView.js');
  chatHeaderSrc = read('web/components/ChatHeader.js');
});

// =============================================================================
// 1. Store: crewInProgressCounts is a map, old global removed
// =============================================================================
describe('task-229: chat.js store state', () => {
  it('defines crewInProgressCounts as empty object (map)', () => {
    expect(chatStoreSrc).toContain('crewInProgressCounts: {}');
  });

  it('old crewInProgressCount (singular) no longer exists', () => {
    // The old line was: crewInProgressCount: 0
    expect(chatStoreSrc).not.toMatch(/crewInProgressCount:\s*0/);
  });

  it('crewInProgressCounts has per-conversation doc comment', () => {
    // Should have { [conversationId]: number } notation in comment
    expect(chatStoreSrc).toMatch(/crewInProgressCounts.*\[conversationId\].*number/);
  });
});

// =============================================================================
// 2. CrewChatView: watcher writes to map keyed by convId
// =============================================================================
describe('task-229: CrewChatView kanbanFeatureCount watcher', () => {
  it('kanbanFeatureCount watcher uses effectiveConvId to key into map', () => {
    // Extract the watcher body
    const watcherIdx = crewChatViewSrc.indexOf('kanbanFeatureCount(val)');
    expect(watcherIdx).toBeGreaterThan(-1);
    const watcherEnd = crewChatViewSrc.indexOf('}', watcherIdx);
    const watcherBody = crewChatViewSrc.slice(watcherIdx, watcherEnd + 1);

    expect(watcherBody).toContain('this.effectiveConvId');
    expect(watcherBody).toContain('this.store.crewInProgressCounts[convId]');
  });

  it('guards against null convId', () => {
    const watcherIdx = crewChatViewSrc.indexOf('kanbanFeatureCount(val)');
    const watcherEnd = crewChatViewSrc.indexOf('}', watcherIdx);
    const watcherBody = crewChatViewSrc.slice(watcherIdx, watcherEnd + 1);
    expect(watcherBody).toContain('if (convId)');
  });

  it('does NOT write to old global crewInProgressCount', () => {
    // Search around the kanbanFeatureCount watcher
    const watcherIdx = crewChatViewSrc.indexOf('kanbanFeatureCount(val)');
    const watcherEnd = crewChatViewSrc.indexOf('}', watcherIdx);
    const watcherBody = crewChatViewSrc.slice(watcherIdx, watcherEnd + 1);
    expect(watcherBody).not.toMatch(/crewInProgressCount\s*=/);
  });

  it('effectiveConvId computed exists and reads conversationId prop or store', () => {
    expect(crewChatViewSrc).toContain('effectiveConvId()');
    const idx = crewChatViewSrc.indexOf('effectiveConvId()');
    const block = crewChatViewSrc.slice(idx, crewChatViewSrc.indexOf('}', idx) + 1);
    expect(block).toContain('this.conversationId');
    expect(block).toContain('this.store.currentConversation');
  });
});

// =============================================================================
// 3. ChatHeader: crewFeatureCount computed reads from map
// =============================================================================
describe('task-229: ChatHeader crewFeatureCount computed', () => {
  it('defines crewFeatureCount as a Vue.computed', () => {
    expect(chatHeaderSrc).toContain('const crewFeatureCount = Vue.computed');
  });

  it('reads from store.crewInProgressCounts[convId]', () => {
    const idx = chatHeaderSrc.indexOf('const crewFeatureCount = Vue.computed');
    const block = chatHeaderSrc.slice(idx, chatHeaderSrc.indexOf('});', idx) + 3);
    expect(block).toContain('store.crewInProgressCounts[convId]');
  });

  it('uses effectiveConvId.value for per-pane resolution', () => {
    const idx = chatHeaderSrc.indexOf('const crewFeatureCount = Vue.computed');
    const block = chatHeaderSrc.slice(idx, chatHeaderSrc.indexOf('});', idx) + 3);
    expect(block).toContain('effectiveConvId.value');
  });

  it('defaults to 0 when convId has no entry', () => {
    const idx = chatHeaderSrc.indexOf('const crewFeatureCount = Vue.computed');
    const block = chatHeaderSrc.slice(idx, chatHeaderSrc.indexOf('});', idx) + 3);
    expect(block).toContain('|| 0');
  });

  it('returns 0 when no convId', () => {
    const idx = chatHeaderSrc.indexOf('const crewFeatureCount = Vue.computed');
    const block = chatHeaderSrc.slice(idx, chatHeaderSrc.indexOf('});', idx) + 3);
    // Pattern: convId ? (store.crewInProgressCounts[convId] || 0) : 0
    expect(block).toContain(': 0');
  });

  it('crewFeatureCount is included in return object', () => {
    const returnIdx = chatHeaderSrc.lastIndexOf('return {');
    const returnBlock = chatHeaderSrc.slice(returnIdx);
    expect(returnBlock).toContain('crewFeatureCount');
  });

  it('does NOT reference old global crewInProgressCount in return', () => {
    const returnIdx = chatHeaderSrc.lastIndexOf('return {');
    const returnBlock = chatHeaderSrc.slice(returnIdx);
    expect(returnBlock).not.toMatch(/crewInProgressCount[^s]/);
  });
});

// =============================================================================
// 4. Template: badge reads crewFeatureCount (local computed, not store global)
// =============================================================================
describe('task-229: ChatHeader template badge', () => {
  it('badge v-if uses crewFeatureCount (local computed)', () => {
    expect(chatHeaderSrc).toContain('v-if="crewFeatureCount > 0"');
  });

  it('badge interpolation uses crewFeatureCount', () => {
    expect(chatHeaderSrc).toContain('{{ crewFeatureCount }}');
  });

  it('does NOT reference store.crewInProgressCount in template', () => {
    // Extract template
    const templateMatch = chatHeaderSrc.match(/template:\s*`([\s\S]*?)`\s*,/);
    expect(templateMatch).toBeTruthy();
    const template = templateMatch[1];
    expect(template).not.toContain('store.crewInProgressCount');
  });
});

// =============================================================================
// 5. Functional: crewFeatureCount logic (simulated)
// =============================================================================
describe('task-229: crewFeatureCount logic (behavioral)', () => {
  function crewFeatureCount(crewInProgressCounts, convId) {
    return convId ? (crewInProgressCounts[convId] || 0) : 0;
  }

  it('returns 0 when convId is null', () => {
    expect(crewFeatureCount({ 'conv-1': 3 }, null)).toBe(0);
  });

  it('returns 0 when convId is undefined', () => {
    expect(crewFeatureCount({ 'conv-1': 3 }, undefined)).toBe(0);
  });

  it('returns 0 when convId is empty string', () => {
    expect(crewFeatureCount({ 'conv-1': 3 }, '')).toBe(0);
  });

  it('returns 0 when convId not in map', () => {
    expect(crewFeatureCount({ 'conv-1': 3 }, 'conv-2')).toBe(0);
  });

  it('returns correct count for matching convId', () => {
    expect(crewFeatureCount({ 'conv-1': 3, 'conv-2': 7 }, 'conv-1')).toBe(3);
    expect(crewFeatureCount({ 'conv-1': 3, 'conv-2': 7 }, 'conv-2')).toBe(7);
  });

  it('two panes with different convIds get independent counts', () => {
    const counts = { 'conv-left': 4, 'conv-right': 9 };
    const leftBadge = crewFeatureCount(counts, 'conv-left');
    const rightBadge = crewFeatureCount(counts, 'conv-right');
    expect(leftBadge).toBe(4);
    expect(rightBadge).toBe(9);
    expect(leftBadge).not.toBe(rightBadge);
  });
});

// =============================================================================
// 6. Functional: watcher write logic (simulated)
// =============================================================================
describe('task-229: kanbanFeatureCount watcher logic (behavioral)', () => {
  function writeFeatureCount(crewInProgressCounts, convId, val) {
    if (convId) crewInProgressCounts[convId] = val;
  }

  it('writes to map under correct convId', () => {
    const counts = {};
    writeFeatureCount(counts, 'conv-1', 5);
    expect(counts['conv-1']).toBe(5);
  });

  it('does not write when convId is null', () => {
    const counts = {};
    writeFeatureCount(counts, null, 5);
    expect(Object.keys(counts)).toHaveLength(0);
  });

  it('two panes write independently', () => {
    const counts = {};
    writeFeatureCount(counts, 'conv-left', 3);
    writeFeatureCount(counts, 'conv-right', 8);
    expect(counts['conv-left']).toBe(3);
    expect(counts['conv-right']).toBe(8);
  });

  it('updating right pane does not affect left pane', () => {
    const counts = { 'conv-left': 3, 'conv-right': 5 };
    writeFeatureCount(counts, 'conv-right', 12);
    expect(counts['conv-left']).toBe(3);
    expect(counts['conv-right']).toBe(12);
  });

  it('switching right pane to new conv creates new entry, old entry stays', () => {
    const counts = { 'conv-left': 3, 'conv-right-old': 5 };
    // Right pane switches to conv-right-new
    writeFeatureCount(counts, 'conv-right-new', 2);
    expect(counts['conv-left']).toBe(3);
    expect(counts['conv-right-old']).toBe(5); // old entry preserved
    expect(counts['conv-right-new']).toBe(2);
  });
});

// =============================================================================
// 7. Integration: effectiveConvId in ChatHeader uses prop for per-pane isolation
// =============================================================================
describe('task-229: ChatHeader effectiveConvId per-pane', () => {
  it('effectiveConvId computed uses props.conversationId with fallback', () => {
    const idx = chatHeaderSrc.indexOf('const effectiveConvId = Vue.computed');
    expect(idx).toBeGreaterThan(-1);
    const block = chatHeaderSrc.slice(idx, chatHeaderSrc.indexOf('});', idx) + 3);
    expect(block).toContain('props.conversationId');
    expect(block).toContain('store.currentConversation');
  });

  it('ChatHeader accepts conversationId as a prop', () => {
    // Check props definition
    expect(chatHeaderSrc).toMatch(/props:\s*\{[^}]*conversationId/);
  });
});

// =============================================================================
// 8. Full codebase: no remaining references to old singular crewInProgressCount
// =============================================================================
describe('task-229: old crewInProgressCount fully removed', () => {
  it('chat.js has no crewInProgressCount (singular)', () => {
    expect(chatStoreSrc).not.toMatch(/crewInProgressCount[^s]/);
  });

  it('CrewChatView has no crewInProgressCount (singular)', () => {
    expect(crewChatViewSrc).not.toMatch(/crewInProgressCount[^s]/);
  });

  it('ChatHeader has no store.crewInProgressCount (singular)', () => {
    expect(chatHeaderSrc).not.toMatch(/crewInProgressCount[^s]/);
  });
});
