import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import UnifySidebarV2 from '../../web/components/UnifySidebarV2.js';

/**
 * task-300 Phase 1 — UnifySidebarV2 skeleton + mock filter + click events.
 *
 * Tests avoid a DOM by exercising the component object directly:
 *   - template string inspection for structure
 *   - data() for initial state
 *   - computed.call(ctx) for filtering / grouping
 *   - methods.call(ctx) for event emission (ctx.$emit is a spy)
 */

const rootDir = join(import.meta.dirname, '..', '..');
const componentSrc = readFileSync(join(rootDir, 'web/components/UnifySidebarV2.js'), 'utf8');
const cssSrc = readFileSync(join(rootDir, 'web/styles/unify-sidebar-v2.css'), 'utf8');

// Minimal fake Vue context for invoking computed / methods.
function makeCtx(overrides = {}) {
  const data = UnifySidebarV2.data();
  const emitted = [];
  const ctx = {
    ...data,
    ...overrides,
    $emit: (name, payload) => emitted.push([name, payload])
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
    const d = UnifySidebarV2.data();
    expect(Array.isArray(d.threads)).toBe(true);
    expect(d.threads.length).toBeGreaterThan(0);
  });

  it('declares select-thread and select-task as emits', () => {
    expect(UnifySidebarV2.emits).toEqual(expect.arrayContaining(['select-thread', 'select-task']));
  });
});

// 2 — three group headers rendered
describe('group headers', () => {
  it('template renders Active, Idle, Archived group labels', () => {
    expect(componentSrc).toMatch(/>Active<\/span>/);
    expect(componentSrc).toMatch(/>Idle<\/span>/);
    expect(componentSrc).toMatch(/>Archived<\/span>/);
  });

  it('template renders Tasks group', () => {
    expect(componentSrc).toMatch(/>Tasks<\/span>/);
  });
});

// 3 — Active group uses solid dot, Idle uses hollow
describe('status dot styling', () => {
  it('css has solid (filled) active dot and hollow idle dot', () => {
    expect(cssSrc).toMatch(/\.usv2-dot-active\s*\{[^}]*background:\s*#34c759/);
    expect(cssSrc).toMatch(/\.usv2-dot-idle\s*\{[^}]*background:\s*transparent[\s\S]*?border:\s*1\.5px\s+solid/);
  });

  it('template assigns dot-active to active threads and dot-idle to idle threads', () => {
    const activeBlock = componentSrc.match(/Active[\s\S]*?usv2-group-body[\s\S]*?<\/section>/);
    const idleBlock = componentSrc.match(/>Idle<\/span>[\s\S]*?<\/section>/);
    expect(activeBlock && activeBlock[0]).toMatch(/usv2-dot-active/);
    expect(idleBlock && idleBlock[0]).toMatch(/usv2-dot-idle/);
  });
});

// 4 — main thread is first in Active
describe('main-first pinning', () => {
  it('grouped.active[0].id === "main"', () => {
    const ctx = makeCtx();
    expect(ctx.grouped.active[0].id).toBe('main');
  });

  it('main stays first even when another thread is newer+running', () => {
    const now = Date.now();
    const ctx = makeCtx({
      now,
      threads: [
        { id: 't-design', name: 'design', title: 'x', running: true, unread: 0, archived: false, lastActivityAt: now },
        { id: 'main', name: 'main', title: 'Main', running: false, unread: 0, archived: false, lastActivityAt: now - 60 * 60 * 1000 }
      ]
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

  it('default data has task-297 expanded so subtasks are visible', () => {
    const d = UnifySidebarV2.data();
    expect(d.expandedTasks['task-297']).toBe(true);
  });
});
