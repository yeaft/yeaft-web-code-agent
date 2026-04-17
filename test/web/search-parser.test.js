import { describe, it, expect } from 'vitest';
import {
  parseSearchQuery,
  hasActiveQuery,
  threadMatches,
  taskMatches,
  messageMatches,
  __testing__,
} from '../../web/utils/search-parser.js';

/**
 * task-316 — parser + pure matcher unit tests.
 *
 * The parser is the single source of truth for the sidebar search UI;
 * every supported token is exercised below. Matcher tests use fixture
 * threads / tasks / messages shaped like the real serialised wire
 * format from agent/unify/web-bridge.js.
 */

describe('parseSearchQuery — empty / whitespace', () => {
  it('empty string returns empty ParsedQuery with no tokens', () => {
    const q = parseSearchQuery('');
    expect(q.keyword).toBe('');
    expect(q.threadPrefix).toBe(null);
    expect(q.taskId).toBe(null);
    expect(q.status).toBe(null);
    expect(q.scopedField).toBe(null);
    expect(q.rawTokens).toEqual([]);
  });

  it('whitespace-only treated as empty', () => {
    const q = parseSearchQuery('   \t  ');
    expect(hasActiveQuery(q)).toBe(false);
  });
});

describe('parseSearchQuery — single tokens', () => {
  it('#name sets threadPrefix (lowercased)', () => {
    const q = parseSearchQuery('#Alpha');
    expect(q.threadPrefix).toBe('alpha');
    expect(q.keyword).toBe('');
  });

  it('task:42 normalises to task-42', () => {
    const q = parseSearchQuery('task:42');
    expect(q.taskId).toBe('task-42');
  });

  it('task:task-17 keeps existing prefix', () => {
    const q = parseSearchQuery('task:task-17');
    expect(q.taskId).toBe('task-17');
  });

  it('status:open sets status', () => {
    const q = parseSearchQuery('status:open');
    expect(q.status).toBe('open');
  });

  it('status:bogus falls back to keyword fragment (no silent drop)', () => {
    const q = parseSearchQuery('status:bogus');
    expect(q.status).toBe(null);
    expect(q.keyword).toBe('status:bogus');
  });

  it('in:body sets scopedField', () => {
    const q = parseSearchQuery('in:body');
    expect(q.scopedField).toBe('body');
  });

  it('in:bogus falls back to keyword fragment', () => {
    const q = parseSearchQuery('in:bogus');
    expect(q.scopedField).toBe(null);
    expect(q.keyword).toBe('in:bogus');
  });

  it('bare word becomes keyword', () => {
    const q = parseSearchQuery('Hello');
    expect(q.keyword).toBe('hello');
  });
});

describe('parseSearchQuery — multi-token AND', () => {
  it('task:42 status:open foo combines all three', () => {
    const q = parseSearchQuery('task:42 status:open foo');
    expect(q.taskId).toBe('task-42');
    expect(q.status).toBe('open');
    expect(q.keyword).toBe('foo');
  });

  it('in:title foo bar joins bare words into one keyword', () => {
    const q = parseSearchQuery('in:title foo bar');
    expect(q.scopedField).toBe('title');
    expect(q.keyword).toBe('foo bar');
  });

  it('#alpha task:1 combines thread prefix with task filter', () => {
    const q = parseSearchQuery('#alpha task:1');
    expect(q.threadPrefix).toBe('alpha');
    expect(q.taskId).toBe('task-1');
  });
});

describe('parseSearchQuery — normaliseTaskId helper', () => {
  it('accepts bare numbers', () => {
    expect(__testing__.normaliseTaskId('7')).toBe('task-7');
  });
  it('lowercases existing task-N', () => {
    expect(__testing__.normaliseTaskId('Task-9')).toBe('task-9');
  });
  it('falls through on odd input', () => {
    expect(__testing__.normaliseTaskId('foo')).toBe('foo');
  });
});

describe('hasActiveQuery', () => {
  it('false on empty parse', () => {
    expect(hasActiveQuery(parseSearchQuery(''))).toBe(false);
  });
  it('true when any filter is set', () => {
    expect(hasActiveQuery(parseSearchQuery('task:1'))).toBe(true);
    expect(hasActiveQuery(parseSearchQuery('status:open'))).toBe(true);
    expect(hasActiveQuery(parseSearchQuery('foo'))).toBe(true);
  });
});

describe('threadMatches — pure matcher', () => {
  const threads = [
    { id: 'main', name: 'main', title: 'Inbox', goal: '', preview: '', running: false, archived: false },
    { id: 't-a', name: 'alpha', title: 'Alpha stuff', goal: 'polish', preview: 'work in progress', running: true, archived: false, taskId: 'task-42' },
    { id: 't-b', name: 'beta', title: 'Beta', goal: '', preview: '', archived: true, status: 'archived' },
  ];

  it('plain keyword full-text matches title', () => {
    const q = parseSearchQuery('alpha');
    expect(threadMatches(threads[1], q)).toBe(true);
    expect(threadMatches(threads[0], q)).toBe(false);
  });

  it('#prefix only matches by name', () => {
    const q = parseSearchQuery('#bet');
    expect(threadMatches(threads[2], q)).toBe(true);
    expect(threadMatches(threads[1], q)).toBe(false);
  });

  it('status:archived filters archived threads', () => {
    const q = parseSearchQuery('status:archived');
    expect(threadMatches(threads[2], q)).toBe(true);
    expect(threadMatches(threads[0], q)).toBe(false);
  });

  it('status:open excludes archived', () => {
    const q = parseSearchQuery('status:open');
    expect(threadMatches(threads[2], q)).toBe(false);
    expect(threadMatches(threads[0], q)).toBe(true);
  });

  it('task:42 matches thread via linked taskId', () => {
    const q = parseSearchQuery('task:42');
    expect(threadMatches(threads[1], q)).toBe(true);
    expect(threadMatches(threads[0], q)).toBe(false);
  });

  it('task:42 + in:title polish combines AND', () => {
    const q = parseSearchQuery('task:42 in:title polish');
    // t-a has taskId=task-42 but title is "Alpha stuff" — no polish.
    expect(threadMatches(threads[1], q)).toBe(false);
  });

  it('task:42 + in:summary polish matches (goal contains polish)', () => {
    const q = parseSearchQuery('task:42 in:summary polish');
    expect(threadMatches(threads[1], q)).toBe(true);
  });
});

describe('taskMatches — pure matcher', () => {
  const tasks = [
    { id: 'task-42', title: 'Build search', summary: 'polish the sidebar', status: 'in_progress' },
    { id: 'task-43', title: 'Unrelated', summary: '', status: 'done' },
  ];

  it('task:42 targets a specific task id', () => {
    const q = parseSearchQuery('task:42');
    expect(taskMatches(tasks[0], q)).toBe(true);
    expect(taskMatches(tasks[1], q)).toBe(false);
  });

  it('#prefix excludes tasks entirely', () => {
    const q = parseSearchQuery('#foo');
    expect(taskMatches(tasks[0], q)).toBe(false);
  });

  it('in:summary search only checks summary/description', () => {
    const q = parseSearchQuery('in:summary polish');
    expect(taskMatches(tasks[0], q)).toBe(true);
    expect(taskMatches(tasks[1], q)).toBe(false);
  });

  it('status:open excludes done tasks', () => {
    const q = parseSearchQuery('status:open');
    expect(taskMatches(tasks[0], q)).toBe(true);
    expect(taskMatches(tasks[1], q)).toBe(false);
  });
});

describe('messageMatches — pure matcher', () => {
  const msgs = [
    { id: 'm-1', threadId: 't-a', taskId: 'task-42', content: 'please fix the login bug' },
    { id: 'm-2', threadId: 'main', content: 'hello world' },
    { id: 'm-3', threadId: 't-a', taskId: 'task-42', content: { text: 'tool output' } },
  ];

  it('task:42 in:body login finds matching message', () => {
    const q = parseSearchQuery('task:42 in:body login');
    expect(messageMatches(msgs[0], q)).toBe(true);
    expect(messageMatches(msgs[1], q)).toBe(false);
    expect(messageMatches(msgs[2], q)).toBe(false); // no "login" in that content
  });

  it('in:body world matches hello world plainly', () => {
    const q = parseSearchQuery('in:body world');
    expect(messageMatches(msgs[1], q)).toBe(true);
    expect(messageMatches(msgs[0], q)).toBe(false);
  });

  it('in:title foo never matches a message', () => {
    const q = parseSearchQuery('in:title foo');
    for (const m of msgs) expect(messageMatches(m, q)).toBe(false);
  });

  it('#prefix alone does not select messages', () => {
    const q = parseSearchQuery('#a');
    expect(messageMatches(msgs[0], q)).toBe(false);
  });
});
