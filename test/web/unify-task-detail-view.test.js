/**
 * task-315 — Unify Task Detail View (cross-thread message aggregation).
 *
 * Covers:
 *   1) Aggregation logic: messages belonging to a task (via thread→taskId
 *      attachment) are grouped and sorted by createdAt ascending.
 *   2) Store state: unifyActiveTaskDetailId / unifyTaskReplyThreadId
 *      lifecycle — enter/leave/reset on leaveUnify + clearUnifyMessages.
 *   3) Store action: enterTaskDetailView defaults reply thread to the
 *      most-recently-active non-archived attached thread, or null when
 *      there is none (UI prompts to fork).
 *   4) sendUnifyChat prepends `@thread-<id>` when in task-detail view
 *      and a reply thread is selected (routes via dispatcher override).
 *   5) UnifyTaskDetailView component source contract: props-less, uses
 *      store getters, emits back + switch-to-thread, renders thread
 *      pill per message, reply thread selector or fork hint.
 *   6) UnifyPage wiring: renders UnifyTaskDetailView when active,
 *      hides MessageList while in detail view, Esc cascades
 *      detail→filter→nothing.
 *   7) i18n + CSS + agent bridge taskId serialisation coverage.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// ──────────────────────────────────────────────────────────────
// 1. Aggregation logic — pure mirror of the store getter
// ──────────────────────────────────────────────────────────────
function aggregateForTask(messages, threads, taskId) {
  if (!taskId) return [];
  const threadTask = new Map();
  const threadName = new Map();
  for (const t of threads || []) {
    if (!t || !t.id) continue;
    if (t.taskId) threadTask.set(t.id, t.taskId);
    threadName.set(t.id, t.name || t.id);
  }
  const out = [];
  for (const m of messages || []) {
    if (!m || !m.threadId) continue;
    if (threadTask.get(m.threadId) !== taskId) continue;
    out.push({
      ...m,
      _sourceThreadId: m.threadId,
      _sourceThreadName: threadName.get(m.threadId) || m.threadId,
    });
  }
  out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return out;
}

describe('task-315 — cross-thread aggregation by taskId', () => {
  const threads = [
    { id: 'main', name: 'Inbox', taskId: null },
    { id: 'thr-a', name: 'Design', taskId: 'task-99' },
    { id: 'thr-b', name: 'Build', taskId: 'task-99' },
    { id: 'thr-c', name: 'Other', taskId: 'task-100' },
  ];
  const msgs = [
    { id: 'm1', type: 'user', content: 'start', threadId: 'main',  createdAt: 1000 },
    { id: 'm2', type: 'assistant', content: 'plan', threadId: 'thr-a', createdAt: 2000 },
    { id: 'm3', type: 'assistant', content: 'draft', threadId: 'thr-b', createdAt: 3000 },
    { id: 'm4', type: 'assistant', content: 'unrelated', threadId: 'thr-c', createdAt: 2500 },
    { id: 'm5', type: 'assistant', content: 'follow-up', threadId: 'thr-a', createdAt: 4000 },
  ];

  it('returns empty array when taskId is null', () => {
    expect(aggregateForTask(msgs, threads, null)).toEqual([]);
  });

  it('collects messages from every thread attached to the task', () => {
    const out = aggregateForTask(msgs, threads, 'task-99');
    expect(out.map(m => m.id)).toEqual(['m2', 'm3', 'm5']);
  });

  it('excludes messages whose thread has a different taskId', () => {
    const out = aggregateForTask(msgs, threads, 'task-99');
    expect(out.some(m => m.id === 'm4')).toBe(false);
  });

  it('excludes messages from threads with no taskId attachment (e.g. main)', () => {
    const out = aggregateForTask(msgs, threads, 'task-99');
    expect(out.some(m => m.id === 'm1')).toBe(false);
  });

  it('sorts messages by createdAt ascending regardless of input order', () => {
    const shuffled = [msgs[4], msgs[2], msgs[1], msgs[0], msgs[3]];
    const out = aggregateForTask(shuffled, threads, 'task-99');
    expect(out.map(m => m.createdAt)).toEqual([2000, 3000, 4000]);
  });

  it('tags each message with _sourceThreadId and _sourceThreadName', () => {
    const out = aggregateForTask(msgs, threads, 'task-99');
    const m2 = out.find(m => m.id === 'm2');
    expect(m2._sourceThreadId).toBe('thr-a');
    expect(m2._sourceThreadName).toBe('Design');
  });

  it('falls back to threadId when thread has no name', () => {
    const anon = [{ id: 'thr-x', taskId: 'task-5' }];
    const m = [{ id: 'z', type: 'user', content: 'hi', threadId: 'thr-x', createdAt: 1 }];
    const out = aggregateForTask(m, anon, 'task-5');
    expect(out[0]._sourceThreadName).toBe('thr-x');
  });

  it('handles missing messages / threads input safely', () => {
    expect(aggregateForTask(null, threads, 'task-99')).toEqual([]);
    expect(aggregateForTask(msgs, null, 'task-99')).toEqual([]);
    expect(aggregateForTask([], [], 'task-99')).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────
// 2-4. Store source — state + actions + getters + sendUnifyChat
// ──────────────────────────────────────────────────────────────
describe('task-315 store source — state + actions', () => {
  const store = readFileSync(path.join(ROOT, 'web/stores/chat.js'), 'utf8');

  it('declares unifyActiveTaskDetailId state (default null)', () => {
    expect(store).toMatch(/unifyActiveTaskDetailId:\s*null/);
  });

  it('declares unifyTaskReplyThreadId state (default null)', () => {
    expect(store).toMatch(/unifyTaskReplyThreadId:\s*null/);
  });

  it('defines enterTaskDetailView action that sets id and clears thread filter', () => {
    expect(store).toMatch(/enterTaskDetailView\s*\(\s*taskId\s*\)\s*\{/);
    const block = store.match(/enterTaskDetailView[\s\S]*?\n    \},/);
    expect(block, 'enterTaskDetailView block').not.toBeNull();
    expect(block[0]).toMatch(/unifyActiveTaskDetailId\s*=\s*taskId/);
    expect(block[0]).toMatch(/unifyActiveThreadFilter\s*=\s*null/);
    expect(block[0]).toMatch(/unifyTaskReplyThreadId/);
  });

  it('enterTaskDetailView picks most-recently-active non-archived thread as default reply target', () => {
    const block = store.match(/enterTaskDetailView[\s\S]*?\n    \},/)[0];
    expect(block).toMatch(/!t\.archived/);
    expect(block).toMatch(/lastActivityAt|lastMessageAt/);
  });

  it('defines leaveTaskDetailView that resets both ids', () => {
    expect(store).toMatch(/leaveTaskDetailView\s*\(\s*\)\s*\{/);
    const block = store.match(/leaveTaskDetailView[\s\S]*?\n    \},/)[0];
    expect(block).toMatch(/unifyActiveTaskDetailId\s*=\s*null/);
    expect(block).toMatch(/unifyTaskReplyThreadId\s*=\s*null/);
  });

  it('defines setUnifyTaskReplyThreadId setter', () => {
    expect(store).toMatch(/setUnifyTaskReplyThreadId\s*\(\s*threadId\s*\)\s*\{/);
  });

  it('unifyTaskDetailMessages getter exists and references unifyActiveTaskDetailId', () => {
    expect(store).toMatch(/unifyTaskDetailMessages\s*:\s*\(state\)\s*=>/);
    const block = store.match(/unifyTaskDetailMessages[\s\S]*?return out;\s*\},/);
    expect(block, 'unifyTaskDetailMessages getter').not.toBeNull();
    expect(block[0]).toMatch(/unifyActiveTaskDetailId/);
    expect(block[0]).toMatch(/sort\(/);
  });

  it('unifyTaskDetailThreads getter filters by taskId + !archived + sorts by activity', () => {
    expect(store).toMatch(/unifyTaskDetailThreads\s*:\s*\(state\)\s*=>/);
    const block = store.match(/unifyTaskDetailThreads[\s\S]*?return matches;\s*\},/);
    expect(block, 'unifyTaskDetailThreads getter').not.toBeNull();
    expect(block[0]).toMatch(/!\s*t\.archived/);
    expect(block[0]).toMatch(/taskId\s*===\s*taskId/);
  });

  it('unifyActiveTaskMeta getter falls back to { id, title: id } when task not yet loaded', () => {
    expect(store).toMatch(/unifyActiveTaskMeta\s*:\s*\(state\)\s*=>/);
    const block = store.match(/unifyActiveTaskMeta[\s\S]*?\},\s*\n/);
    expect(block[0]).toMatch(/title:\s*taskId/);
  });

  it('leaveUnify clears both task-detail fields', () => {
    const block = store.match(/leaveUnify\s*\(\s*\)\s*\{[\s\S]*?\n    \},/)[0];
    expect(block).toMatch(/unifyActiveTaskDetailId\s*=\s*null/);
    expect(block).toMatch(/unifyTaskReplyThreadId\s*=\s*null/);
  });

  it('clearUnifyMessages clears both task-detail fields', () => {
    const block = store.match(/clearUnifyMessages\s*\(\s*\)\s*\{[\s\S]*?\n    \},/)[0];
    expect(block).toMatch(/unifyActiveTaskDetailId\s*=\s*null/);
    expect(block).toMatch(/unifyTaskReplyThreadId\s*=\s*null/);
  });

  it('sendUnifyChat prepends @thread-<id> prefix when task detail view is active and reply thread is set', () => {
    const block = store.match(/sendUnifyChat\s*\(\s*prompt\s*\)\s*\{[\s\S]*?\n    \},/)[0];
    expect(block).toMatch(/unifyActiveTaskDetailId/);
    expect(block).toMatch(/unifyTaskReplyThreadId/);
    expect(block).toMatch(/@thread-/);
    // Must avoid double-prefixing if user already typed one.
    expect(block).toMatch(/\^\\s\*@thread-/);
  });
});

// ──────────────────────────────────────────────────────────────
// 5. UnifyTaskDetailView component source contract
// ──────────────────────────────────────────────────────────────
describe('task-315 UnifyTaskDetailView component', () => {
  const src = readFileSync(path.join(ROOT, 'web/components/UnifyTaskDetailView.js'), 'utf8');

  it('declares the back and switch-to-thread emits', () => {
    expect(src).toMatch(/emits:\s*\[[\s\S]*?['"]back['"][\s\S]*?['"]switch-to-thread['"]/);
  });

  it('reads aggregated messages from the store getter', () => {
    expect(src).toMatch(/store\.unifyTaskDetailMessages/);
  });

  it('reads reply thread options from the store getter', () => {
    expect(src).toMatch(/store\.unifyTaskDetailThreads/);
  });

  it('reads current reply target from the store', () => {
    expect(src).toMatch(/store\.unifyTaskReplyThreadId/);
  });

  it('reads active task meta (id + title + status) from the store', () => {
    expect(src).toMatch(/store\.unifyActiveTaskMeta/);
  });

  it('emits back when the breadcrumb back button is clicked', () => {
    expect(src).toMatch(/@click="\$emit\(['"]back['"]\)"/);
  });

  it('emits switch-to-thread with the source thread id from the pill', () => {
    expect(src).toMatch(/@click="\$emit\(['"]switch-to-thread['"],\s*m\._sourceThreadId\)"/);
  });

  it('renders the fork hint when replyThreadOptions is empty', () => {
    expect(src).toMatch(/unify-task-detail-fork-hint/);
    expect(src).toMatch(/v-else/);
  });

  it('calls setUnifyTaskReplyThreadId when the user picks a thread', () => {
    expect(src).toMatch(/store\.setUnifyTaskReplyThreadId/);
  });

  it('renders the task id + title in the breadcrumb', () => {
    expect(src).toMatch(/Task #\{\{\s*displayTaskId\s*\}\}/);
    expect(src).toMatch(/\{\{\s*displayTitle\s*\}\}/);
  });
});

// ──────────────────────────────────────────────────────────────
// 6. UnifyPage wiring
// ──────────────────────────────────────────────────────────────
describe('task-315 UnifyPage wiring', () => {
  const src = readFileSync(path.join(ROOT, 'web/components/UnifyPage.js'), 'utf8');

  it('imports UnifyTaskDetailView', () => {
    expect(src).toMatch(/from\s+['"]\.\/UnifyTaskDetailView\.js['"]/);
  });

  it('registers UnifyTaskDetailView as a child component', () => {
    expect(src).toMatch(/components:\s*\{[^}]*UnifyTaskDetailView[^}]*\}/);
  });

  it('renders UnifyTaskDetailView only when store.unifyActiveTaskDetailId is truthy and settings closed', () => {
    expect(src).toMatch(/<UnifyTaskDetailView[\s\S]*?v-if="!showSettings && store\.unifyActiveTaskDetailId(?:[^"]*)"/);
  });

  it('hides MessageList when task detail view is active', () => {
    expect(src).toMatch(/<MessageList[\s\S]*?v-if="!showSettings && (?:[^"]*?)!store\.unifyActiveTaskDetailId(?:[^"]*)"/);
  });

  it('hides the thread-filter breadcrumb while task detail view is active', () => {
    expect(src).toMatch(/<UnifyBreadcrumb[\s\S]*?v-if="store\.unifyActiveThreadFilter && !store\.unifyActiveTaskDetailId"/);
  });

  it('forwards detail-view back event to leaveTaskDetailView (via exitTaskDetailView handler)', () => {
    expect(src).toMatch(/@back="exitTaskDetailView"/);
    expect(src).toMatch(/exitTaskDetailView[\s\S]*?store\.leaveTaskDetailView/);
  });

  it('select-task emits enter the task detail view', () => {
    expect(src).toMatch(/onSelectTaskV2[\s\S]*?store\.enterTaskDetailView/);
  });

  it('switch-to-thread pill handler exits detail view + activates thread filter', () => {
    expect(src).toMatch(/@switch-to-thread="onSwitchToThreadFromTaskDetail"/);
    expect(src).toMatch(/onSwitchToThreadFromTaskDetail[\s\S]*?leaveTaskDetailView[\s\S]*?setActiveThread/);
  });

  it('Esc cascades: task detail first, then thread filter', () => {
    const block = src.match(/const onKeyDown\s*=\s*\(e\)\s*=>\s*\{[\s\S]*?\};/)[0];
    expect(block).toMatch(/unifyActiveTaskDetailId[\s\S]*?leaveTaskDetailView[\s\S]*?return/);
    expect(block).toMatch(/unifyActiveThreadFilter[\s\S]*?clearUnifyThreadFilter/);
    // The detail-view branch must `return` before falling through to the
    // filter branch so a single Esc never pops two layers.
    const detailIdx = block.indexOf('leaveTaskDetailView');
    const filterIdx = block.indexOf('clearUnifyThreadFilter');
    const returnIdx = block.indexOf('return', detailIdx);
    expect(returnIdx).toBeGreaterThan(detailIdx);
    expect(returnIdx).toBeLessThan(filterIdx);
  });
});

// ──────────────────────────────────────────────────────────────
// 7. Agent bridge — taskId propagates on thread list
// ──────────────────────────────────────────────────────────────
describe('task-315 agent bridge — thread serialisation includes taskId', () => {
  const src = readFileSync(path.join(ROOT, 'agent/unify/web-bridge.js'), 'utf8');

  it('sendThreadListUpdate attaches taskId via store.attachedTask', () => {
    expect(src).toMatch(/attachedTask/);
    // The taskId field must be included in the serialised shape.
    expect(src).toMatch(/taskId:\s*\(/);
  });
});

// ──────────────────────────────────────────────────────────────
// 8. i18n coverage
// ──────────────────────────────────────────────────────────────
describe('task-315 i18n', () => {
  const en = readFileSync(path.join(ROOT, 'web/i18n/en.js'), 'utf8');
  const zh = readFileSync(path.join(ROOT, 'web/i18n/zh-CN.js'), 'utf8');

  for (const key of [
    'unify.taskDetail.ariaLabel',
    'unify.taskDetail.replyTo',
    'unify.taskDetail.forkHint',
    'unify.taskDetail.empty',
    'unify.taskDetail.threadPillHint',
  ]) {
    it(`en has ${key}`, () => {
      expect(en).toContain(`'${key}'`);
    });
    it(`zh has ${key}`, () => {
      expect(zh).toContain(`'${key}'`);
    });
  }
});

// ──────────────────────────────────────────────────────────────
// 9. CSS — detail view styles present, no horizontal borders
// ──────────────────────────────────────────────────────────────
describe('task-315 CSS', () => {
  const css = readFileSync(path.join(ROOT, 'web/styles/unify.css'), 'utf8');

  it('defines .unify-task-detail and child class rules', () => {
    expect(css).toMatch(/\.unify-task-detail\s*\{/);
    expect(css).toMatch(/\.unify-task-detail-breadcrumb\s*\{/);
    expect(css).toMatch(/\.unify-task-detail-messages\s*\{/);
    expect(css).toMatch(/\.unify-task-detail-thread-pill\s*\{/);
    expect(css).toMatch(/\.unify-task-detail-reply\s*\{/);
    expect(css).toMatch(/\.unify-task-detail-fork-hint\s*\{/);
  });

  it('breadcrumb rule does NOT add a horizontal border (per CLAUDE.md Unify rule)', () => {
    const ruleMatch = css.match(/\.unify-task-detail-breadcrumb\s*\{[^}]*\}/);
    expect(ruleMatch).not.toBeNull();
    expect(ruleMatch[0]).not.toMatch(/border-top\s*:\s*[^;0]/);
    expect(ruleMatch[0]).not.toMatch(/border-bottom\s*:\s*[^;0]/);
  });
});
