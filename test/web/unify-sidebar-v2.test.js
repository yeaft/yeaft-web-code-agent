import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import UnifySidebarV2 from '../../web/components/UnifySidebarV2.js';

/**
 * task-300 Phase 1 skeleton tests — updated post task-301 Part 2.
 *
 * Part 2 replaced the in-component mock data with store-driven computed
 * props (store.unifyThreads / store.unifyTasks) and routed all user-facing
 * labels through the $t() i18n helper. These tests retain the original
 * structural intent (group rendering, dot styling, #prefix filter,
 * click→emit, task-tree toggle) but feed threads/tasks via the
 * threadsSource / tasksSource test-injection props.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const rootDir = join(import.meta.dirname, '..', '..');
const componentSrc = readFileSync(join(rootDir, 'web/components/UnifySidebarV2.js'), 'utf8');
const cssSrc = readFileSync(join(rootDir, 'web/styles/unify-sidebar-v2.css'), 'utf8');

function mockThreads(now = Date.now()) {
  return [
    { id: 'main', name: 'main', title: 'Main thread', running: false, unread: 0, archived: false, lastActivityAt: now - 2 * 60 * 1000, preview: 'Ready.' },
    { id: 't-design', name: 'design', title: 'Sidebar redesign discussion', running: true, unread: 3, archived: false, lastActivityAt: now - 30 * 60 * 1000 },
    { id: 't-fix-ui', name: 'fix-ui', title: 'Fix mobile drawer glitch', running: false, unread: 1, archived: false, lastActivityAt: now - 4 * HOUR_MS },
    { id: 't-old-refactor', name: 'old-refactor', title: 'Refactor memory store', running: false, unread: 0, archived: false, lastActivityAt: now - 3 * DAY_MS },
    { id: 't-done-01', name: 'done-migration', title: 'Archived', running: false, unread: 0, archived: true, lastActivityAt: now - 14 * DAY_MS },
  ];
}

function mockTasks() {
  return [
    { id: 'task-297', title: 'Unify refactor', status: 'in_progress', threadLink: 't-design',
      children: [
        { id: 'task-297.1', title: 'Drop toggle', status: 'in_progress', children: [] },
      ]
    },
    { id: 'task-298', title: 'Data layer', status: 'in_progress', threadLink: null, children: [] },
  ];
}

// Minimal fake Vue context for invoking computed / methods.
function makeCtx(overrides = {}) {
  const data = UnifySidebarV2.data();
  const emitted = [];
  const now = Date.now();
  const ctx = {
    now,
    ...data,
    // Inject source arrays explicitly (simulating props) unless overridden.
    threadsSource: mockThreads(now),
    tasksSource: mockTasks(),
    ...overrides,
    $emit: (name, payload) => emitted.push([name, payload]),
  };
  // Wire computed as getters that run in ctx.
  for (const [k, fn] of Object.entries(UnifySidebarV2.computed)) {
    Object.defineProperty(ctx, k, { get: () => fn.call(ctx), configurable: true });
  }
  ctx.__emitted = emitted;
  return ctx;
}

// 1 — component mounts cleanly (has expected shape).
describe('UnifySidebarV2 shape', () => {
  it('exports a Vue component object with name + template + data', () => {
    expect(UnifySidebarV2.name).toBe('UnifySidebarV2');
    expect(typeof UnifySidebarV2.template).toBe('string');
    expect(typeof UnifySidebarV2.data).toBe('function');
  });

  it('declares select-thread and select-task as emits', () => {
    expect(UnifySidebarV2.emits).toEqual(expect.arrayContaining(['select-thread', 'select-task']));
  });

  it('declares threadsSource / tasksSource test-injection props', () => {
    expect(UnifySidebarV2.props.threadsSource).toBeDefined();
    expect(UnifySidebarV2.props.tasksSource).toBeDefined();
  });
});

// 2 — three group headers rendered (i18n-aware)
describe('group headers', () => {
  it('template wires all group labels through label() helper', () => {
    expect(componentSrc).toMatch(/label\('activeThreads'\)/);
    expect(componentSrc).toMatch(/label\('idleThreads'\)/);
    expect(componentSrc).toMatch(/label\('archivedThreads'\)/);
    expect(componentSrc).toMatch(/label\('tasks'\)/);
  });
});

// 3 — Active group uses solid dot, Idle uses hollow, Archived dashed.
describe('status dot styling', () => {
  it('css has solid active dot, hollow idle dot, and dashed archived dot', () => {
    expect(cssSrc).toMatch(/\.usv2-dot-active\s*\{[^}]*background:\s*#34c759/);
    expect(cssSrc).toMatch(/\.usv2-dot-idle\s*\{[^}]*background:\s*transparent[\s\S]*?border:\s*1\.5px\s+solid/);
    expect(cssSrc).toMatch(/\.usv2-dot-archived\s*\{[^}]*background:\s*transparent[\s\S]*?border:\s*1\.5px\s+dashed/);
  });

  it('template assigns dot-active, dot-idle and dot-archived in each group body', () => {
    expect(componentSrc).toMatch(/usv2-dot-active/);
    expect(componentSrc).toMatch(/usv2-dot-idle/);
    expect(componentSrc).toMatch(/usv2-dot-archived/);
  });
});

// 4 — main thread is first in Active
describe('main-first pinning', () => {
  it('grouped.active[0].id === "main" with default injected threads', () => {
    const ctx = makeCtx();
    expect(ctx.grouped.active[0].id).toBe('main');
  });

  it('main stays first even when another thread is newer+running', () => {
    const now = Date.now();
    const ctx = makeCtx({
      now,
      threadsSource: [
        { id: 't-design', name: 'design', title: 'x', running: true, archived: false, lastActivityAt: now },
        { id: 'main', name: 'main', title: 'Main', running: false, archived: false, lastActivityAt: now - HOUR_MS },
      ],
    });
    expect(ctx.grouped.active[0].id).toBe('main');
  });
});

// 5 — keyword search filters
describe('keyword search', () => {
  it('"design" only keeps threads with "design" in name or title', () => {
    const ctx = makeCtx({ searchQuery: 'design' });
    const names = ctx.filteredThreads.map((t) => t.name);
    expect(names).toContain('design');
    expect(names).not.toContain('fix-ui');
    expect(names).not.toContain('old-refactor');
  });
});

// 6 — #prefix is thread-only (hides tasks)
describe('#thread prefix', () => {
  it('"#fix" matches fix-ui thread and hides tasks section', () => {
    const ctx = makeCtx({ searchQuery: '#fix' });
    const names = ctx.filteredThreads.map((t) => t.name);
    expect(names).toContain('fix-ui');
    expect(names).not.toContain('design');
    expect(ctx.threadOnlyQuery).toBe(true);
    expect(ctx.filteredTasks).toEqual([]);
  });
});

// 7 — click thread emits select-thread with id
describe('click emits events', () => {
  it('onSelectThread emits select-thread with thread id', () => {
    const ctx = makeCtx();
    UnifySidebarV2.methods.onSelectThread.call(ctx, { id: 't-design' });
    expect(ctx.__emitted).toEqual([['select-thread', 't-design']]);
  });

  it('onSelectTask emits select-task with task id', () => {
    const ctx = makeCtx();
    UnifySidebarV2.methods.onSelectTask.call(ctx, { id: 'task-297' });
    expect(ctx.__emitted).toEqual([['select-task', 'task-297']]);
  });
});

// 8 — task tree expand/collapse toggle
describe('task tree toggle', () => {
  it('toggleTask flips expandedTasks[id]', () => {
    const ctx = makeCtx({ expandedTasks: {} });
    UnifySidebarV2.methods.toggleTask.call(ctx, 'task-297');
    expect(ctx.expandedTasks['task-297']).toBe(true);
    UnifySidebarV2.methods.toggleTask.call(ctx, 'task-297');
    expect(ctx.expandedTasks['task-297']).toBe(false);
  });

  it('isTaskExpanded returns boolean from expandedTasks map', () => {
    const ctx = makeCtx({ expandedTasks: { 'task-297': true } });
    expect(UnifySidebarV2.methods.isTaskExpanded.call(ctx, 'task-297')).toBe(true);
    expect(UnifySidebarV2.methods.isTaskExpanded.call(ctx, 'task-298')).toBe(false);
  });
});
