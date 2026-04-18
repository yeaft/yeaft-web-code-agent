import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import UnifySidebarV2 from '../../web/components/UnifySidebarV2.js';

/**
 * task-301 Part 2 — real-store wiring + store→UI sync + i18n polish.
 *
 *   E3. store-driven rendering — threads/tasks come from store, not mock
 *   E4. store→UI sync — thread_list_updated event populates store.unifyThreads
 *   Plus: i18n dictionary (no hardcoded strings in component template);
 *        agent web-bridge emits thread_list_updated on relevant hooks;
 *        UnifyPage handlers delegate directly to store actions (no guard).
 */

const rootDir = join(import.meta.dirname, '..', '..');
const storeSrc = readFileSync(join(rootDir, 'web/stores/chat.js'), 'utf8');
const pageSrc = readFileSync(join(rootDir, 'web/components/UnifyPage.js'), 'utf8');
const componentSrc = readFileSync(join(rootDir, 'web/components/UnifySidebarV2.js'), 'utf8');
const enSrc = readFileSync(join(rootDir, 'web/i18n/en.js'), 'utf8');
const zhSrc = readFileSync(join(rootDir, 'web/i18n/zh-CN.js'), 'utf8');
const bridgeSrc = readFileSync(join(rootDir, 'agent/unify/web-bridge.js'), 'utf8');
const cssSrc = readFileSync(join(rootDir, 'web/styles/unify-sidebar-v2.css'), 'utf8');

// --- Store: new state + actions + event handlers ----------------------------
describe('store real-thread state (task-301 Part 2)', () => {
  it('declares unifyThreads / unifyTasks arrays in state', () => {
    expect(storeSrc).toMatch(/unifyThreads:\s*\[\]/);
    expect(storeSrc).toMatch(/unifyTasks:\s*\[\]/);
  });

  it('declares unifyActiveThreadId / unifyActiveTaskId selection state', () => {
    expect(storeSrc).toMatch(/unifyActiveThreadId:\s*null/);
    expect(storeSrc).toMatch(/unifyActiveTaskId:\s*null/);
  });

  it('exposes setActiveThread action that writes both selection + filter', () => {
    expect(storeSrc).toMatch(/setActiveThread\s*\(\s*threadId\s*\)\s*\{/);
    expect(storeSrc).toMatch(/this\.unifyActiveThreadId\s*=/);
    // Clicking a thread narrows task-303 chat stream to that thread
    expect(storeSrc).toMatch(/this\.unifyActiveThreadFilter\s*=/);
  });

  it('exposes setActiveTaskUi action', () => {
    expect(storeSrc).toMatch(/setActiveTaskUi\s*\(\s*taskId\s*\)\s*\{/);
    expect(storeSrc).toMatch(/this\.unifyActiveTaskId\s*=/);
  });

  it('handleUnifyOutput switch routes thread_list_updated event', () => {
    expect(storeSrc).toMatch(/case\s*'thread_list_updated'/);
    expect(storeSrc).toMatch(/this\.unifyThreads\s*=/);
  });

  it('handleUnifyOutput switch routes task_list_updated event', () => {
    expect(storeSrc).toMatch(/case\s*'task_list_updated'/);
    expect(storeSrc).toMatch(/this\.unifyTasks\s*=/);
  });

  it('clearUnifyMessages resets sidebar v2 state', () => {
    expect(storeSrc).toMatch(/this\.unifyThreads\s*=\s*\[\]/);
    expect(storeSrc).toMatch(/this\.unifyTasks\s*=\s*\[\]/);
    expect(storeSrc).toMatch(/this\.unifyActiveThreadId\s*=\s*null/);
  });
});

// --- UnifyPage: stub guards removed -----------------------------------------
describe('UnifyPage handlers delegate directly (no typeof guard)', () => {
  it('onSelectThreadV2 calls store.setActiveThread unconditionally', () => {
    expect(pageSrc).toMatch(/onSelectThreadV2\s*=\s*\(threadId\)\s*=>\s*\{\s*(?:\/\/[^\n]*\n\s*)*store\.setActiveThread\(threadId\);/);
    // No typeof === 'function' fallback
    expect(pageSrc).not.toMatch(/typeof store\.setActiveThread === 'function'/);
  });

  it('onSelectTaskV2 enters the task detail view (task-315 supersedes setActiveTaskUi)', () => {
    // task-315: clicking a task now enters the Task Detail View instead of
    // just setting a UI highlight. enterTaskDetailView internally updates
    // the active-task state.
    expect(pageSrc).toMatch(/onSelectTaskV2\s*=\s*\(taskId\)\s*=>\s*\{[\s\S]*?store\.enterTaskDetailView\(taskId\)/);
    expect(pageSrc).not.toMatch(/typeof store\.enterTaskDetailView === 'function'/);
  });
});

// --- Agent web-bridge: thread_list_updated emission -------------------------
describe('agent web-bridge emits thread_list_updated (task-301 Part 2)', () => {
  it('imports getThreadStore from the threads store module', () => {
    expect(bridgeSrc).toMatch(/import\s+\{\s*getThreadStore\s*\}\s+from\s+['"]\.\/threads\/store\.js['"]/);
  });

  it('defines sendThreadListUpdate helper that emits thread_list_updated', () => {
    expect(bridgeSrc).toMatch(/function\s+sendThreadListUpdate\s*\(\)/);
    expect(bridgeSrc).toMatch(/type:\s*'thread_list_updated'/);
  });

  it('maintains a THREAD_MUTATING_TOOLS set covering the canonical tools', () => {
    expect(bridgeSrc).toMatch(/THREAD_MUTATING_TOOLS/);
    expect(bridgeSrc).toMatch(/'SpawnThread'/);
    expect(bridgeSrc).toMatch(/'SwitchThread'/);
    expect(bridgeSrc).toMatch(/'ArchiveThread'/);
    expect(bridgeSrc).toMatch(/'AttachThreadToTask'/);
  });

  it('calls sendThreadListUpdate inside tool_end branch for mutating tools', () => {
    expect(bridgeSrc).toMatch(/THREAD_MUTATING_TOOLS\.has\(event\.name\)[\s\S]{0,80}sendThreadListUpdate\(\)/);
  });

  it('calls sendThreadListUpdate after session_ready (initial snapshot)', () => {
    // Multiple session_ready sites; at least one must push an update right after.
    const sessionReadySites = bridgeSrc.match(/type:\s*'session_ready'/g) || [];
    expect(sessionReadySites.length).toBeGreaterThanOrEqual(2);
    // At least one call to sendThreadListUpdate() appears after a session_ready block.
    expect(bridgeSrc).toMatch(/type:\s*'session_ready'[\s\S]{0,500}sendThreadListUpdate\(\)/);
  });
});

// --- i18n: dormant sidebarV2.* keys fully wired -----------------------------
describe('sidebar v2 i18n — no hardcoded group labels', () => {
  const keys = [
    'unify.sidebar.activeThreads',
    'unify.sidebar.idleThreads',
    'unify.sidebar.archivedThreads',
    'unify.sidebar.tasks',
    'unify.sidebar.emptyActive',
    'unify.sidebar.emptyIdle',
    'unify.sidebar.emptyArchived',
    'unify.sidebar.emptyTasks',
  ];

  it('all group keys present in en.js', () => {
    for (const k of keys) {
      expect(enSrc).toContain(`'${k}'`);
    }
  });

  it('all group keys present in zh-CN.js', () => {
    for (const k of keys) {
      expect(zhSrc).toContain(`'${k}'`);
    }
  });

  it('component uses label() helper for group labels (no raw English)', () => {
    // Template no longer contains the bare words "Active" / "Idle" / "Archived" / "Tasks"
    // as child text of a <span>. It uses the label() helper.
    expect(componentSrc).toMatch(/label\('activeThreads'\)/);
    expect(componentSrc).toMatch(/label\('idleThreads'\)/);
    expect(componentSrc).toMatch(/label\('archivedThreads'\)/);
    expect(componentSrc).toMatch(/label\('tasks'\)/);
    // Empty-state strings also go through label()
    expect(componentSrc).toMatch(/label\('emptyActive'\)/);
    expect(componentSrc).toMatch(/label\('emptyIdle'\)/);
    expect(componentSrc).toMatch(/label\('emptyArchived'\)/);
    expect(componentSrc).toMatch(/label\('emptyTasks'\)/);
    // And no hardcoded ">Active<" in template span text (regression guard)
    expect(componentSrc).not.toMatch(/>Active<\/span>/);
    expect(componentSrc).not.toMatch(/>Idle<\/span>/);
    expect(componentSrc).not.toMatch(/>Archived<\/span>/);
    // No hardcoded empty-state text inside a <div class="usv2-empty">
    expect(componentSrc).not.toMatch(/class="usv2-empty"[^>]*>\s*No active threads\s*</);
    expect(componentSrc).not.toMatch(/class="usv2-empty"[^>]*>\s*No idle threads\s*</);
    expect(componentSrc).not.toMatch(/class="usv2-empty"[^>]*>\s*No archived threads\s*</);
    expect(componentSrc).not.toMatch(/class="usv2-empty"[^>]*>\s*No tasks match\s*</);
  });

  it('label() returns $t() result when available', () => {
    const ctx = { $t: (k) => `T:${k}` };
    const out = UnifySidebarV2.methods.label.call(ctx, 'activeThreads');
    expect(out).toBe('T:unify.sidebar.activeThreads');
  });

  it('label() falls back to English when $t is missing', () => {
    const ctx = { $t: null };
    expect(UnifySidebarV2.methods.label.call(ctx, 'activeThreads')).toBe('Active');
    expect(UnifySidebarV2.methods.label.call(ctx, 'emptyTasks')).toBe('No tasks match');
  });
});

// --- E3: real-store rendering (no mock data inside component) --------------
describe('E3 — UnifySidebarV2 reads from store, not mock arrays', () => {
  it('component has NO buildMockThreads / buildMockTasks functions', () => {
    expect(componentSrc).not.toMatch(/buildMockThreads/);
    expect(componentSrc).not.toMatch(/buildMockTasks/);
  });

  it('component declares `threads` as a computed reading store.unifyThreads', () => {
    expect(componentSrc).toMatch(/threads\s*\(\)\s*\{[\s\S]*?unifyThreads/);
  });

  it('component declares `tasks` as a computed reading store.unifyTasks', () => {
    expect(componentSrc).toMatch(/tasks\s*\(\)\s*\{[\s\S]*?unifyTasks/);
  });

  it('component exposes threadsSource / tasksSource test-injection props', () => {
    expect(UnifySidebarV2.props).toBeTruthy();
    expect(UnifySidebarV2.props.threadsSource).toBeDefined();
    expect(UnifySidebarV2.props.tasksSource).toBeDefined();
  });

  it('grouped computed classifies injected threads into active/idle/archived', () => {
    const now = Date.now();
    const injectedThreads = [
      { id: 'main', name: 'main', title: 'Main', running: true, archived: false, lastActivityAt: now },
      { id: 't-a', name: 'a', title: 'Alpha', running: false, archived: false, lastActivityAt: now - 3 * 24 * 60 * 60 * 1000 }, // 3 days → idle
      { id: 't-b', name: 'b', title: 'Beta', running: false, archived: true, lastActivityAt: now - 10 * 24 * 60 * 60 * 1000 },
    ];
    const ctx = {
      threadsSource: injectedThreads,
      tasksSource: [],
      threads: injectedThreads,
      searchQuery: '',
      now,
      parsedQuery: { keyword: '', threadPrefix: null },
      filteredThreads: injectedThreads,
    };
    const grouped = UnifySidebarV2.computed.grouped.call(ctx);
    expect(grouped.active.length).toBe(1);
    expect(grouped.active[0].id).toBe('main');
    expect(grouped.idle.length).toBe(1);
    expect(grouped.idle[0].id).toBe('t-a');
    expect(grouped.archived.length).toBe(1);
    expect(grouped.archived[0].id).toBe('t-b');
  });

  it('filteredThreads on #prefix query filters by thread name', () => {
    const injectedThreads = [
      { id: 'main', name: 'main', archived: false, lastActivityAt: Date.now() },
      { id: 't-design', name: 'design', archived: false, lastActivityAt: Date.now() },
    ];
    const ctx = {
      threadsSource: injectedThreads,
      threads: injectedThreads,
      parsedQuery: { keyword: '', threadPrefix: 'des' },
    };
    const filtered = UnifySidebarV2.computed.filteredThreads.call(ctx);
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe('t-design');
  });
});

// --- E4: store→UI event sync -----------------------------------------------
describe('E4 — thread_list_updated event → store.unifyThreads → UI', () => {
  // Simulate the handleUnifyOutput switch branch behaviour directly by
  // checking that the case writes `this.unifyThreads = event.threads`.
  it('handleUnifyOutput thread_list_updated writes threads array to state', () => {
    // Tight regex pinned on the Part-2 case body.
    expect(storeSrc).toMatch(
      /case\s+'thread_list_updated':[\s\S]{0,200}this\.unifyThreads\s*=\s*Array\.isArray\(event\.threads\)\s*\?\s*event\.threads\s*:\s*\[\]/
    );
  });

  it('handleUnifyOutput task_list_updated writes tasks array to state', () => {
    expect(storeSrc).toMatch(
      /case\s+'task_list_updated':[\s\S]{0,200}this\.unifyTasks\s*=\s*Array\.isArray\(event\.tasks\)\s*\?\s*event\.tasks\s*:\s*\[\]/
    );
  });

  it('click on a thread row emits select-thread with id payload (Part-2 contract)', () => {
    const emitted = [];
    const ctx = {
      $emit: (name, payload) => emitted.push({ name, payload }),
    };
    UnifySidebarV2.methods.onSelectThread.call(ctx, { id: 't-foo', name: 'foo' });
    expect(emitted).toEqual([{ name: 'select-thread', payload: 't-foo' }]);
  });

  it('click on a task row emits select-task with id payload', () => {
    const emitted = [];
    const ctx = {
      $emit: (name, payload) => emitted.push({ name, payload }),
    };
    UnifySidebarV2.methods.onSelectTask.call(ctx, { id: 'task-42', title: 'X' });
    expect(emitted).toEqual([{ name: 'select-task', payload: 'task-42' }]);
  });

  it('UnifyPage wires emitted select-thread to store.setActiveThread(threadId)', () => {
    // The v2 aside emits; UnifyPage uses onSelectThreadV2 → store.setActiveThread
    expect(pageSrc).toMatch(/@select-thread="onSelectThreadV2"/);
    expect(pageSrc).toMatch(/store\.setActiveThread\(threadId\)/);
  });

  it('UnifyPage wires emitted select-task to store.enterTaskDetailView(taskId) (task-315)', () => {
    expect(pageSrc).toMatch(/@select-task="onSelectTaskV2"/);
    expect(pageSrc).toMatch(/store\.enterTaskDetailView\(taskId\)/);
  });
});

// --- E4b: .selected visual feedback CSS (prev-1 blocker regression guard) ---
describe('E4b — .selected rows have visual feedback in CSS', () => {
  it('css defines a .usv2-thread.selected rule (background highlight)', () => {
    expect(cssSrc).toMatch(/\.usv2-thread\.selected\s*\{[^}]*background\s*:/);
  });

  it('css defines a .usv2-task.selected rule (background highlight)', () => {
    expect(cssSrc).toMatch(/\.usv2-task\.selected\s*\{[^}]*background\s*:/);
  });
});
