import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import UnifySidebarV2 from '../../web/components/UnifySidebarV2.js';

/**
 * task-312 — sidebar search enhancements:
 *   - `in:title foo` / `in:summary foo` field-scoped keyword
 *   - full-text match across title / goal / preview / summary / description
 *   - searchResults flat list (threads + tasks) with snippets
 *   - onSelectResult emits select-thread + jump-to-message for thread hits,
 *     select-task for task hits
 *   - onSearchEscape clears query and emits search-escape
 *
 * Same ctx-based test pattern as the task-300 shape tests; no Pinia mount.
 */

const rootDir = join(import.meta.dirname, '..', '..');
const componentSrc = readFileSync(join(rootDir, 'web/components/UnifySidebarV2.js'), 'utf8');

function threads() {
  const now = Date.now();
  return [
    { id: 'main', name: 'main', title: 'Inbox', goal: 'catch-all', preview: 'hello world',
      running: false, archived: false, lastActivityAt: now - 60_000 },
    { id: 't-a', name: 'alpha', title: 'Alpha thread', goal: 'design polish',
      preview: 'we need to polish the sidebar', running: true, archived: false,
      lastActivityAt: now - 120_000 },
    { id: 't-b', name: 'beta', title: 'Beta fix', goal: 'nothing interesting', preview: '',
      running: false, archived: false, lastActivityAt: now - 120_000 },
  ];
}

function tasks() {
  return [
    { id: 'task-1', title: 'Build search', summary: 'polish the sidebar filter', status: 'in_progress', children: [] },
    { id: 'task-2', title: 'Unrelated', summary: '', description: 'nothing', status: 'todo', children: [
      { id: 'task-2.1', title: 'nested polish', summary: '', children: [] },
    ] },
  ];
}

function makeCtx(overrides = {}) {
  const data = UnifySidebarV2.data();
  const emitted = [];
  const ctx = {
    now: Date.now(),
    ...data,
    threadsSource: threads(),
    tasksSource: tasks(),
    ...overrides,
    $emit: (name, payload) => emitted.push([name, payload]),
  };
  for (const [k, fn] of Object.entries(UnifySidebarV2.computed)) {
    Object.defineProperty(ctx, k, { get: () => fn.call(ctx), configurable: true });
  }
  // Bind methods so computed helpers (pickThreadSnippet etc.) resolve.
  for (const [k, fn] of Object.entries(UnifySidebarV2.methods)) {
    if (typeof fn === 'function' && ctx[k] === undefined) {
      ctx[k] = fn.bind(ctx);
    }
  }
  ctx.__emitted = emitted;
  return ctx;
}

describe('task-312 — prefix parser', () => {
  it('plain keyword → { keyword, threadPrefix:null, scopedField:null }', () => {
    const ctx = makeCtx({ searchQuery: 'Polish' });
    expect(ctx.parsedQuery).toEqual(expect.objectContaining({ keyword: 'polish', threadPrefix: null, scopedField: null }));
  });

  it('#name → threadPrefix set, keyword empty', () => {
    const ctx = makeCtx({ searchQuery: '#alp' });
    expect(ctx.parsedQuery.threadPrefix).toBe('alp');
    expect(ctx.parsedQuery.keyword).toBe('');
  });

  it('in:title foo → scopedField=title', () => {
    const ctx = makeCtx({ searchQuery: 'in:title Alpha' });
    expect(ctx.parsedQuery).toEqual(expect.objectContaining({ keyword: 'alpha', threadPrefix: null, scopedField: 'title' }));
  });

  it('in:summary foo → scopedField=summary', () => {
    const ctx = makeCtx({ searchQuery: 'in:summary polish' });
    expect(ctx.parsedQuery.scopedField).toBe('summary');
    expect(ctx.parsedQuery.keyword).toBe('polish');
  });

  it('in:bogus foo falls back to plain keyword (safety)', () => {
    const ctx = makeCtx({ searchQuery: 'in:bogus x' });
    expect(ctx.parsedQuery.scopedField).toBe(null);
    // stored as plain (keyword is whole string lowercased).
    expect(ctx.parsedQuery.keyword).toBe('in:bogus x');
  });
});

describe('task-312 — scoped thread filter', () => {
  it('in:title alpha keeps only threads matching title field', () => {
    const ctx = makeCtx({ searchQuery: 'in:title alpha' });
    const names = ctx.filteredThreads.map(t => t.name);
    expect(names).toContain('alpha');
    // "main" title is "Inbox", should not match "alpha"
    expect(names).not.toContain('main');
    expect(names).not.toContain('beta');
  });

  it('in:summary polish matches via goal/preview, not title', () => {
    const ctx = makeCtx({ searchQuery: 'in:summary polish' });
    const names = ctx.filteredThreads.map(t => t.name);
    expect(names).toContain('alpha'); // goal: 'design polish'
    expect(names).not.toContain('beta');
  });

  it('plain keyword also matches preview field (full-text)', () => {
    const ctx = makeCtx({ searchQuery: 'hello' });
    const names = ctx.filteredThreads.map(t => t.name);
    expect(names).toContain('main'); // preview: 'hello world'
  });
});

describe('task-312 — scoped task filter', () => {
  it('in:title search restricts to task.title / task.id', () => {
    const ctx = makeCtx({ searchQuery: 'in:title Build' });
    const ids = ctx.filteredTasks.map(t => t.id);
    expect(ids).toContain('task-1');
    expect(ids).not.toContain('task-2');
  });

  it('in:summary search uses task.summary', () => {
    const ctx = makeCtx({ searchQuery: 'in:summary polish' });
    const ids = ctx.filteredTasks.map(t => t.id);
    expect(ids).toContain('task-1'); // summary: 'polish the sidebar filter'
  });
});

describe('task-312 — searchResults flat list', () => {
  it('inactive when query is empty', () => {
    const ctx = makeCtx();
    expect(ctx.searchActive).toBe(false);
    expect(ctx.searchResults).toEqual([]);
  });

  it('plain keyword yields thread entries first, then tasks', () => {
    const ctx = makeCtx({ searchQuery: 'polish' });
    expect(ctx.searchActive).toBe(true);
    const results = ctx.searchResults;
    expect(results.length).toBeGreaterThan(0);
    const firstThread = results.findIndex(r => r.kind === 'thread');
    const firstTask = results.findIndex(r => r.kind === 'task');
    if (firstThread !== -1 && firstTask !== -1) {
      expect(firstThread).toBeLessThan(firstTask);
    }
  });

  it('#prefix → only thread entries in results (tasks hidden)', () => {
    const ctx = makeCtx({ searchQuery: '#alp' });
    const kinds = ctx.searchResults.map(r => r.kind);
    expect(kinds.every(k => k === 'thread')).toBe(true);
  });

  it('each result carries a snippet when a match occurs', () => {
    const ctx = makeCtx({ searchQuery: 'polish' });
    const threadHit = ctx.searchResults.find(r => r.kind === 'thread' && r.id === 't-a');
    expect(threadHit?.snippet).toContain('polish');
  });
});

describe('task-312 — onSelectResult emits', () => {
  it('thread hit emits select-thread AND jump-to-message with keyword', () => {
    const ctx = makeCtx({ searchQuery: 'hello' });
    UnifySidebarV2.methods.onSelectResult.call(ctx, {
      kind: 'thread', id: 'main', title: 'Inbox', snippet: 'hello world',
    });
    const names = ctx.__emitted.map(e => e[0]);
    expect(names).toContain('select-thread');
    expect(names).toContain('jump-to-message');
    const jump = ctx.__emitted.find(e => e[0] === 'jump-to-message');
    expect(jump[1]).toEqual({ threadId: 'main', keyword: 'hello' });
  });

  it('task hit emits only select-task', () => {
    const ctx = makeCtx({ searchQuery: 'polish' });
    UnifySidebarV2.methods.onSelectResult.call(ctx, {
      kind: 'task', id: 'task-1', title: 'Build search',
    });
    expect(ctx.__emitted).toEqual([['select-task', 'task-1']]);
  });

  it('#prefix thread hit does not emit jump-to-message (no keyword)', () => {
    const ctx = makeCtx({ searchQuery: '#alp' });
    UnifySidebarV2.methods.onSelectResult.call(ctx, {
      kind: 'thread', id: 't-a', title: 'Alpha',
    });
    const names = ctx.__emitted.map(e => e[0]);
    expect(names).toContain('select-thread');
    expect(names).not.toContain('jump-to-message');
  });
});

describe('task-312 — Esc handling', () => {
  it('onSearchEscape clears query and emits search-escape', () => {
    const ctx = makeCtx({ searchQuery: 'anything' });
    UnifySidebarV2.methods.onSearchEscape.call(ctx);
    expect(ctx.searchQuery).toBe('');
    expect(ctx.__emitted.map(e => e[0])).toContain('search-escape');
  });
});

describe('task-312 — component shape additions', () => {
  it('template wires results-header label + empty-result empty state', () => {
    expect(componentSrc).toMatch(/label\('resultsThreads'\)/);
    expect(componentSrc).toMatch(/label\('emptyResults'\)/);
  });

  it('declares jump-to-message + search-escape emits', () => {
    expect(UnifySidebarV2.emits).toEqual(
      expect.arrayContaining(['jump-to-message', 'search-escape'])
    );
  });
});
