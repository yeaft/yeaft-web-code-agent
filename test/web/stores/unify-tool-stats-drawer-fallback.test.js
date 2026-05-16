/**
 * unify-tool-stats-drawer-fallback.test.js — pins the registered-list
 * fallback in UnifyToolStatsDrawer.rankedRows().
 *
 * Before the fix, the drawer rendered only tools that had at least one
 * recorded call. A fresh install (or any time the snapshot was empty)
 * showed the "(no tool calls recorded yet)" placeholder row, even
 * though the agent reliably reports its full registered tool list on
 * every reply. Users complained that the panel "wasn't ready" when in
 * fact the data was right there.
 *
 * This test extracts the component's `rankedRows` computed and runs it
 * against a fake `this` so we don't need a Vue runtime.
 */
import { describe, it, expect } from 'vitest';
import drawer from '../../../web/components/UnifyToolStatsDrawer.js';

function rankedRowsFor(stats) {
  return drawer.computed.rankedRows.call({ stats });
}

describe('UnifyToolStatsDrawer — rankedRows', () => {
  it('returns recorded snapshot rows sorted by callCount desc', () => {
    const rows = rankedRowsFor({
      snapshot: {
        Bash: { callCount: 5, errorCount: 0 },
        Read: { callCount: 2, errorCount: 1 },
        Edit: { callCount: 9, errorCount: 0 },
      },
      registered: ['Bash', 'Read', 'Edit'],
      unused: [],
    });
    expect(rows.map(r => r.name)).toEqual(['Edit', 'Bash', 'Read']);
  });

  it('falls back to registered list for tools not yet called (0-counters)', () => {
    const rows = rankedRowsFor({
      snapshot: {
        Bash: { callCount: 3, errorCount: 0 },
      },
      registered: ['Bash', 'Read', 'Edit', 'Grep'],
      unused: ['Read', 'Edit', 'Grep'],
    });
    expect(rows.map(r => r.name)).toEqual(['Bash', 'Edit', 'Grep', 'Read']);
    // The fallback rows must be zeroed, not undefined — the template
    // formats numbers and would render "NaN" / "-" otherwise.
    const read = rows.find(r => r.name === 'Read');
    expect(read.callCount).toBe(0);
    expect(read.errorCount).toBe(0);
    expect(read.errorRate).toBe(0);
    expect(read.p50Ms).toBe(0);
    expect(read.p95Ms).toBe(0);
    expect(read.lastCalledAt).toBeNull();
  });

  it('still renders the catalog when the snapshot is empty (notice path)', () => {
    const rows = rankedRowsFor({
      snapshot: {},
      registered: ['Bash', 'Read', 'Edit'],
      unused: ['Bash', 'Read', 'Edit'],
      notice: 'Agent is offline.',
    });
    expect(rows.map(r => r.name)).toEqual(['Bash', 'Edit', 'Read']);
    for (const r of rows) expect(r.callCount).toBe(0);
  });

  it('does not double-render a tool present in both snapshot and registered', () => {
    const rows = rankedRowsFor({
      snapshot: {
        Bash: { callCount: 4, errorCount: 0 },
      },
      registered: ['Bash', 'Bash', 'Read'],
      unused: ['Read'],
    });
    expect(rows.filter(r => r.name === 'Bash').length).toBe(1);
    expect(rows.find(r => r.name === 'Bash').callCount).toBe(4);
  });

  it('keeps snapshot row, not zeroed fallback, when name is in both snapshot and registered', () => {
    // The dominant production case: every recorded tool is also
    // registered. Make sure the dedup keeps the rich snapshot row
    // rather than letting the zero-counter fallback win.
    const rows = rankedRowsFor({
      snapshot: { Bash: { callCount: 7, errorCount: 1 } },
      registered: ['Bash', 'Read'],
    });
    expect(rows.filter(r => r.name === 'Bash').length).toBe(1);
    expect(rows.find(r => r.name === 'Bash').callCount).toBe(7);
    expect(rows.find(r => r.name === 'Bash').errorCount).toBe(1);
  });

  it('tolerates missing stats / registered fields', () => {
    expect(rankedRowsFor(null)).toEqual([]);
    expect(rankedRowsFor({ snapshot: {} })).toEqual([]);
    expect(rankedRowsFor({ snapshot: {}, registered: 'bad' })).toEqual([]);
  });

  it('skips falsy / non-string entries in registered', () => {
    const rows = rankedRowsFor({
      snapshot: {},
      registered: ['', null, 'Bash', 42, 'Read'],
    });
    expect(rows.map(r => r.name)).toEqual(['Bash', 'Read']);
  });
});
