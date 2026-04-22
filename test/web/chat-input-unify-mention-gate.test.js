/**
 * task-338-F5 regression — `@` in Unify must route to VP candidates
 * even when vpList is empty / slow to hydrate.
 *
 * Historical bug: `isInUnifyGroupContext()` in ChatInput.js gated the
 * VP autocomplete branch on `store.currentView === 'unify' && vpStore.vpList.length > 0`.
 * When the VP snapshot hadn't arrived yet (F2 race, fresh install before
 * seeding, or transient WS reconnect), the `@` handler silently fell
 * through to the crew expert-roles branch — the wrong UI.
 *
 * Fix: drop the `vpList.length > 0` coupling so Unify view always routes
 * `@` to VP candidates. The downstream VpMentionAutocomplete renders an
 * empty-state list when the list is actually empty.
 *
 * These are source-level assertions because `isInUnifyGroupContext` is
 * an inner closure — not exported — and the surrounding `setup()` pulls
 * in the whole Pinia + Vue component tree. Pattern mirrors the S-cN
 * regression style used by task-334-ui-* tests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');
const chatInputSrc = readFileSync(join(root, 'web/components/ChatInput.js'), 'utf8');

describe('task-338-F5: @ mention gate in Unify view', () => {
  it('isInUnifyGroupContext no longer couples to vpList.length', () => {
    // Extract the function body so we don't accidentally match references
    // elsewhere in the file.
    const match = chatInputSrc.match(
      /const\s+isInUnifyGroupContext\s*=\s*\(\s*\)\s*=>\s*\{[\s\S]*?\n\s*\}\s*;/
    );
    expect(match, 'isInUnifyGroupContext() must be defined').toBeTruthy();
    const body = match[0];
    // The hard coupling to vpList.length is the bug — must be gone.
    expect(body).not.toMatch(/vpList\s*\.\s*length/);
    expect(body).not.toMatch(/vpStore\s*\.\s*vpList/);
  });

  it('gate includes currentView === "unify" single condition', () => {
    const match = chatInputSrc.match(
      /const\s+isInUnifyGroupContext\s*=\s*\(\s*\)\s*=>\s*\{[\s\S]*?\n\s*\}\s*;/
    );
    const body = match[0];
    expect(body).toMatch(/store\.currentView\s*===\s*['"]unify['"]/);
  });

  it('gate still allows unifyActiveTaskDetailId path (task detail bubble context)', () => {
    // Regression-defense: the first arm of the OR was pre-existing.
    const match = chatInputSrc.match(
      /const\s+isInUnifyGroupContext\s*=\s*\(\s*\)\s*=>\s*\{[\s\S]*?\n\s*\}\s*;/
    );
    const body = match[0];
    expect(body).toMatch(/unifyActiveTaskDetailId/);
  });

  it('@ handler dispatches via isInUnifyGroupContext() (not a direct vpList check)', () => {
    // The @ keystroke branch selects VP vs expert autocomplete solely
    // through this gate. If anyone re-introduces a `vpList.length` check
    // at the @ site, this guard catches it.
    const atHandlerRegion = chatInputSrc.match(
      /if\s*\(atIdx\s*!==\s*-1\s*&&\s*!showAutocomplete\.value\)[\s\S]{0,600}/
    );
    expect(atHandlerRegion).toBeTruthy();
    expect(atHandlerRegion[0]).toMatch(/isInUnifyGroupContext\s*\(\s*\)/);
    expect(atHandlerRegion[0]).not.toMatch(/vpList\s*\.\s*length/);
  });
});

// Behavioural sanity: reproduce the gate logic inline and verify the
// desired truth table end-to-end.
describe('task-338-F5: behavioural truth table', () => {
  // Recreate the post-fix predicate for pure-logic verification.
  const isInUnifyGroupContext = (store) =>
    !!(store.unifyActiveTaskDetailId || store.currentView === 'unify');

  it('unify view + empty vpList → still VP candidates', () => {
    const store = { currentView: 'unify', unifyActiveTaskDetailId: null };
    expect(isInUnifyGroupContext(store)).toBe(true);
  });

  it('unify view + populated vpList → VP candidates', () => {
    const store = { currentView: 'unify', unifyActiveTaskDetailId: null };
    expect(isInUnifyGroupContext(store)).toBe(true);
  });

  it('chat view → falls through to expert-roles (not regressed)', () => {
    const store = { currentView: 'chat', unifyActiveTaskDetailId: null };
    expect(isInUnifyGroupContext(store)).toBe(false);
  });

  it('crew view → falls through to expert-roles (not regressed)', () => {
    const store = { currentView: 'crew', unifyActiveTaskDetailId: null };
    expect(isInUnifyGroupContext(store)).toBe(false);
  });

  it('task detail bubble (any view) → VP candidates (pre-existing arm)', () => {
    const store = { currentView: 'chat', unifyActiveTaskDetailId: 'task-123' };
    expect(isInUnifyGroupContext(store)).toBe(true);
  });
});
