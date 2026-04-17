/**
 * unify-sidebar-v2-merge.test.js — task-313
 *
 * Exercises the sidebar's merge-into flow by driving the component through
 * its public methods / computed properties with an injected thread list.
 * Verifies:
 *   - mergeCandidates excludes the source and any archived threads
 *   - onRequestMerge rejects main / archived sources
 *   - pickMergeTarget advances to the confirm stage with the chosen target
 *   - confirmMerge emits `merge-thread` with {sourceId, targetId}
 *   - cancelMerge resets both stages
 *   - template declares the kebab / right-click affordance and the overlays
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import UnifySidebarV2 from '../../web/components/UnifySidebarV2.js';

const rootDir = join(import.meta.dirname, '..', '..');
const componentSrc = readFileSync(join(rootDir, 'web/components/UnifySidebarV2.js'), 'utf8');

function mockThreads() {
  return [
    { id: 'main', name: 'main', title: 'Inbox', archived: false, status: 'active' },
    { id: 't-a', name: 'a', title: 'A',  archived: false, status: 'active' },
    { id: 't-b', name: 'b', title: 'B',  archived: false, status: 'active' },
    { id: 't-c', name: 'c', title: 'C',  archived: true,  status: 'archived' },
  ];
}

function makeCtx() {
  const data = UnifySidebarV2.data();
  const emitted = [];
  const ctx = {
    ...data,
    threadsSource: mockThreads(),
    tasksSource: [],
    $emit: (name, payload) => emitted.push([name, payload]),
  };
  for (const [k, fn] of Object.entries(UnifySidebarV2.computed)) {
    Object.defineProperty(ctx, k, { get: () => fn.call(ctx), configurable: true });
  }
  ctx.__emitted = emitted;
  return ctx;
}

describe('UnifySidebarV2 — merge-thread flow (task-313)', () => {
  it('declares merge-thread as an emit', () => {
    expect(UnifySidebarV2.emits).toEqual(expect.arrayContaining(['merge-thread']));
  });

  it('template wires a kebab button and right-click handler on thread rows', () => {
    expect(componentSrc).toMatch(/usv2-thread-kebab/);
    expect(componentSrc).toMatch(/@contextmenu\.prevent="onRequestMerge/);
    expect(componentSrc).toMatch(/onRequestMerge/);
  });

  it('template renders target picker + irreversible confirm overlays', () => {
    expect(componentSrc).toMatch(/usv2-merge-overlay/);
    expect(componentSrc).toMatch(/usv2-merge-panel-confirm/);
    expect(componentSrc).toMatch(/mergeIrreversible/);
  });

  it('mergeCandidates excludes source and archived threads', () => {
    const ctx = makeCtx();
    UnifySidebarV2.methods.onRequestMerge.call(ctx, { id: 't-a' });
    const cands = ctx.mergeCandidates;
    const ids = cands.map(c => c.id);
    expect(ids).toContain('main');
    expect(ids).toContain('t-b');
    expect(ids).not.toContain('t-a');  // source excluded
    expect(ids).not.toContain('t-c');  // archived excluded
  });

  it('rejects merge from main thread and from archived threads', () => {
    const ctx = makeCtx();
    UnifySidebarV2.methods.onRequestMerge.call(ctx, { id: 'main' });
    expect(ctx.mergePicker.open).toBe(false);
    UnifySidebarV2.methods.onRequestMerge.call(ctx, { id: 't-c', archived: true });
    expect(ctx.mergePicker.open).toBe(false);
  });

  it('pickMergeTarget advances to confirm; confirmMerge emits merge-thread', () => {
    const ctx = makeCtx();
    UnifySidebarV2.methods.onRequestMerge.call(ctx, { id: 't-a' });
    UnifySidebarV2.methods.pickMergeTarget.call(ctx, { id: 't-b' });
    expect(ctx.mergePicker.open).toBe(false);
    expect(ctx.mergeConfirm).toEqual({ open: true, sourceId: 't-a', targetId: 't-b' });
    UnifySidebarV2.methods.confirmMerge.call(ctx);
    expect(ctx.__emitted).toContainEqual(['merge-thread', { sourceId: 't-a', targetId: 't-b' }]);
    expect(ctx.mergeConfirm.open).toBe(false);
  });

  it('cancelMerge resets both picker and confirm stages', () => {
    const ctx = makeCtx();
    UnifySidebarV2.methods.onRequestMerge.call(ctx, { id: 't-a' });
    UnifySidebarV2.methods.pickMergeTarget.call(ctx, { id: 't-b' });
    UnifySidebarV2.methods.cancelMerge.call(ctx);
    expect(ctx.mergePicker.open).toBe(false);
    expect(ctx.mergeConfirm.open).toBe(false);
  });
});
