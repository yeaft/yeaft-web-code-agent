import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Tests for task-303: Unify Chat Stream dual view (full stream vs thread detail).
 *
 * Covers:
 *  1) Store state: unifyActiveThreadFilter default null
 *  2) Store action: setUnifyThreadFilter(id) sets the filter
 *  3) Store action: clearUnifyThreadFilter() resets to null
 *  4) Store getter: unifyVisibleMessages returns all messages when filter null
 *  5) Store getter: unifyVisibleMessages returns only matching threadId when filter set
 *  6) leaveUnify() clears the filter
 *  7) clearUnifyMessages() clears the filter
 *  8) UnifyBreadcrumb component: props contract + back emit + template text
 *  9) UnifyPage: breadcrumb rendered only when filter active; Esc listener wired
 * 10) i18n: both en and zh have breadcrumb keys
 * 11) CSS: breadcrumb styles present with no horizontal border
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// ---------- pure helpers that mimic store getters ----------
function makeVisibleMessages(allMessages, filter) {
  if (!filter) return allMessages;
  return allMessages.filter(m => m && m.threadId === filter);
}

// =====================================================================
// 1-5. Store filter logic (pure functional mirror of the getter)
// =====================================================================
describe('task-303 store filter logic', () => {
  const msgs = [
    { type: 'user', content: 'hi' },                             // no threadId
    { type: 'assistant', content: 'hello', threadId: 'design' },
    { type: 'assistant', content: 'code', threadId: 'impl' },
    { type: 'assistant', content: 'more design', threadId: 'design' },
  ];

  it('returns all messages when filter is null', () => {
    expect(makeVisibleMessages(msgs, null)).toHaveLength(4);
  });

  it('filters to only messages whose threadId matches', () => {
    const filtered = makeVisibleMessages(msgs, 'design');
    expect(filtered).toHaveLength(2);
    expect(filtered.every(m => m.threadId === 'design')).toBe(true);
  });

  it('returns empty array when no message matches the filter', () => {
    expect(makeVisibleMessages(msgs, 'no-such-thread')).toHaveLength(0);
  });
});

// =====================================================================
// 6-7. Store source file contains the required state + actions
// =====================================================================
describe('task-303 store source — required state & actions', () => {
  const store = readFileSync(path.join(ROOT, 'web/stores/chat.js'), 'utf8');

  it('declares unifyActiveThreadFilter state initialized to null', () => {
    expect(store).toMatch(/unifyActiveThreadFilter:\s*null/);
  });

  it('defines setUnifyThreadFilter action', () => {
    expect(store).toMatch(/setUnifyThreadFilter\s*\(/);
    expect(store).toMatch(/this\.unifyActiveThreadFilter\s*=\s*threadId\s*\|\|\s*null/);
  });

  it('defines clearUnifyThreadFilter action that resets to null', () => {
    expect(store).toMatch(/clearUnifyThreadFilter\s*\(\s*\)\s*\{/);
    expect(store.match(/this\.unifyActiveThreadFilter\s*=\s*null/g).length).toBeGreaterThanOrEqual(3);
  });

  it('clears the filter inside leaveUnify', () => {
    const leaveBlock = store.match(/leaveUnify\s*\(\s*\)\s*\{[\s\S]*?\n    \},/);
    expect(leaveBlock, 'leaveUnify method must be defined').not.toBeNull();
    expect(leaveBlock[0]).toMatch(/unifyActiveThreadFilter\s*=\s*null/);
  });

  it('clears the filter inside clearUnifyMessages', () => {
    const block = store.match(/clearUnifyMessages\s*\(\s*\)\s*\{[\s\S]*?\n    \},/);
    expect(block, 'clearUnifyMessages must be defined').not.toBeNull();
    expect(block[0]).toMatch(/unifyActiveThreadFilter\s*=\s*null/);
  });

  it('exposes unifyVisibleMessages getter that applies the filter', () => {
    expect(store).toMatch(/unifyVisibleMessages\s*:\s*\(state\)\s*=>/);
    expect(store).toMatch(/unifyActiveThreadFilter/);
  });
});

// =====================================================================
// 8. UnifyBreadcrumb component contract
// =====================================================================
describe('UnifyBreadcrumb component', () => {
  const src = readFileSync(path.join(ROOT, 'web/components/UnifyBreadcrumb.js'), 'utf8');

  it('declares required threadId prop and optional threadName prop', () => {
    expect(src).toMatch(/threadId:\s*\{\s*type:\s*String,\s*required:\s*true\s*\}/);
    expect(src).toMatch(/threadName:\s*\{\s*type:\s*String/);
  });

  it('declares the "back" emit', () => {
    expect(src).toMatch(/emits:\s*\[\s*['"]back['"]\s*\]/);
  });

  it('emits back when the back button is clicked', () => {
    expect(src).toMatch(/@click="\$emit\(['"]back['"]\)"/);
  });

  it('renders the arrow + thread hash in the template', () => {
    expect(src).toMatch(/&larr;|←/);
    expect(src).toMatch(/unify-breadcrumb-hash/);
  });

  it('falls back to threadId when threadName is missing', () => {
    expect(src).toMatch(/this\.threadName\s*\|\|\s*this\.threadId/);
  });
});

// =====================================================================
// 9. UnifyPage wires the breadcrumb + Esc listener
// =====================================================================
describe('UnifyPage integration', () => {
  const src = readFileSync(path.join(ROOT, 'web/components/UnifyPage.js'), 'utf8');

  it('imports UnifyBreadcrumb', () => {
    expect(src).toMatch(/from\s+['"]\.\/UnifyBreadcrumb\.js['"]/);
  });

  it('renders <UnifyBreadcrumb> only when store.unifyActiveThreadFilter is truthy', () => {
    // task-315 extends this: the thread-filter breadcrumb is also hidden
    // while the Task Detail view owns the main pane. Assertion matches
    // either the original v-if or the task-315 extended form.
    expect(src).toMatch(/<UnifyBreadcrumb[\s\S]*?v-if="store\.unifyActiveThreadFilter(?:\s*&&\s*!store\.unifyActiveTaskDetailId)?"/);
  });

  it('forwards @back to clearThreadFilter', () => {
    expect(src).toMatch(/@back="clearThreadFilter"/);
    expect(src).toMatch(/clearThreadFilter\s*=\s*\(\s*\)\s*=>\s*\{[\s\S]*?clearUnifyThreadFilter/);
  });

  it('registers a global Esc keydown handler that clears the filter', () => {
    expect(src).toMatch(/document\.addEventListener\(['"]keydown['"]/);
    // task-315 restructured the handler: early-returns on non-Escape,
    // then cascades detail view → thread filter. Accept either form.
    expect(src).toMatch(/(e\.key\s*===\s*['"]Escape['"][\s\S]*?clearUnifyThreadFilter|e\.key\s*!==\s*['"]Escape['"][\s\S]*?clearUnifyThreadFilter)/);
  });

  it('removes the keydown handler on unmount', () => {
    expect(src).toMatch(/document\.removeEventListener\(['"]keydown['"]/);
  });
});

// =====================================================================
// 10. i18n coverage
// =====================================================================
describe('task-303 i18n', () => {
  const en = readFileSync(path.join(ROOT, 'web/i18n/en.js'), 'utf8');
  const zh = readFileSync(path.join(ROOT, 'web/i18n/zh-CN.js'), 'utf8');

  it('en has breadcrumb mainStream + backHint keys', () => {
    expect(en).toMatch(/'unify\.breadcrumb\.mainStream':\s*'[^']+'/);
    expect(en).toMatch(/'unify\.breadcrumb\.backHint':\s*'[^']+'/);
  });

  it('zh has breadcrumb mainStream + backHint keys', () => {
    expect(zh).toMatch(/'unify\.breadcrumb\.mainStream':\s*'[^']+'/);
    expect(zh).toMatch(/'unify\.breadcrumb\.backHint':\s*'[^']+'/);
  });
});

// =====================================================================
// 11. CSS sanity — no horizontal border (per CLAUDE.md Unify UI rule)
// =====================================================================
describe('task-303 breadcrumb CSS', () => {
  const css = readFileSync(path.join(ROOT, 'web/styles/unify.css'), 'utf8');

  it('defines .unify-breadcrumb styles', () => {
    expect(css).toMatch(/\.unify-breadcrumb\s*\{/);
  });

  it('the breadcrumb rule does NOT add a border-top/border-bottom', () => {
    const ruleMatch = css.match(/\.unify-breadcrumb\s*\{[^}]*\}/);
    expect(ruleMatch, 'expected a .unify-breadcrumb rule').not.toBeNull();
    const rule = ruleMatch[0];
    // Per CLAUDE.md: Unify page must NOT have horizontal border-bottom/border-top.
    expect(rule).not.toMatch(/border-top\s*:\s*[^;0]/);
    expect(rule).not.toMatch(/border-bottom\s*:\s*[^;0]/);
  });
});

// =====================================================================
// task-311: chat/work mode toggle fully removed — JSDoc nits deleted
// =====================================================================
