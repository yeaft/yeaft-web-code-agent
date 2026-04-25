import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Regression: User Memory page stuck on "Loading memory entries…"
 *
 * Bug: The Unify "用户记忆" page rendered TWO sections at once —
 *   1. an upper "暂无用户记忆条目" empty-state (from the never-populated
 *      pinned-entries skeleton)
 *   2. a lower "Memory · folder view" header that stayed on
 *      "Loading memory entries…" forever, because
 *      `fetchUnifyMemoryScope()` early-returned when `unifyAgentId`
 *      was null and never flipped `unifyMemoryScopeLoaded` to true.
 *
 * Fix: collapse to a single scope-tree view + resolve the loading flag
 * to true with empty entries when no agent is connected, so the page
 * lands on the proper empty-state instead of a stuck loading shimmer.
 */

const ROOT = resolve(__dirname, '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

describe('User Memory page: no-agent loading resolves to empty state', () => {
  it('chat.js fetchUnifyMemoryScope flips loaded=true when unifyAgentId is null', () => {
    const src = read('web/stores/chat.js');
    // Locate the fetchUnifyMemoryScope action body.
    const idx = src.indexOf('fetchUnifyMemoryScope()');
    expect(idx).toBeGreaterThan(0);
    const slice = src.slice(idx, idx + 600);
    // The branch for "no agent" must mark scope loaded so the page
    // exits the loading state.
    expect(slice).toMatch(/unifyMemoryScopeLoaded\s*=\s*true/);
    expect(slice).toMatch(/unifyMemoryScopeEntries\s*=\s*\[\]/);
    // And it must still NOT send a WS message in that branch.
    // (The send happens AFTER the early-resolve path's return.)
    const earlyBranch = slice.split('return;')[0];
    expect(earlyBranch).not.toContain('sendWsMessage');
  });

  it('UserMemoryPage no longer renders the "Memory · folder view" duplicate header', () => {
    const src = read('web/components/UserMemoryPage.js');
    expect(src).not.toContain('Memory · folder view');
    // Hard-coded "Loading memory entries…" string must be gone — replaced
    // by an i18n key so en/zh both have a translation.
    expect(src).not.toContain('Loading memory entries');
    expect(src).toContain("$t('unify.userMemory.loading')");
  });

  it('i18n: unify.userMemory.loading is present in en and zh-CN', () => {
    expect(read('web/i18n/en.js')).toContain('unify.userMemory.loading');
    expect(read('web/i18n/zh-CN.js')).toContain('unify.userMemory.loading');
  });

  it('UserMemoryPage drops the never-functional pinned-entry/shard skeleton', () => {
    const src = read('web/components/UserMemoryPage.js');
    expect(src).not.toContain('um-shard-tabs');
    expect(src).not.toContain('um-entry-pin');
    expect(src).not.toContain('um-delete-overlay');
    expect(src).not.toContain("type: 'unify_user_memory_write'");
    expect(src).not.toContain("type: 'unify_user_memory_remove'");
  });

  it('UserMemoryPage gates loading vs empty correctly via scopeLoaded', () => {
    const src = read('web/components/UserMemoryPage.js');
    // !scopeLoaded → loading branch
    expect(src).toMatch(/v-if=["']!scopeLoaded["']/);
    // scopeLoaded && entries.length === 0 → empty branch (rendered as v-else-if)
    expect(src).toMatch(/v-else-if=["']scopeEntries\.length\s*===\s*0["']/);
  });
});
