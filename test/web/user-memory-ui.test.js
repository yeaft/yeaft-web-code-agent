/**
 * task-334-ui-d — User Memory UI wiring tests (source-scan style).
 *
 * Covers:
 *   (1) i18n key parity between en and zh-CN for every `unify.userMemory.*` key.
 *   (2) user-memory store exports defineStore with correct id and actions.
 *   (3) chat.js dispatches user_memory_snapshot / user_memory_updated / user_memory_removed.
 *   (4) app.js exposes useUserMemoryStore via window.Pinia.
 *   (5) UserMemoryPage emits 'back', sends WS events, renders shard tabs.
 *   (6) UnifySidebarV2 emits 'open-user-memory' and renders the sidebar entry.
 *   (7) UnifyPage imports UserMemoryPage, wires @open-user-memory, exposes userMemoryOpen.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const umStoreSrc     = read('web/stores/user-memory.js');
const chatStoreSrc   = read('web/stores/chat.js');
const appJsSrc       = read('web/app.js');
const enSrc          = read('web/i18n/en.js');
const zhSrc          = read('web/i18n/zh-CN.js');
const umPageSrc      = read('web/components/UserMemoryPage.js');
const sidebarSrc     = read('web/components/UnifySidebarV2.js');
const unifyPageSrc   = read('web/components/UnifyPage.js');

// ─── (1) i18n key parity ─────────────────────────────────────

const I18N_KEYS = [
  'unify.userMemory.sidebarTitle',
  'unify.userMemory.sidebarAria',
  'unify.userMemory.title',
  'unify.userMemory.backAria',
  'unify.userMemory.back',
  'unify.userMemory.count',
  'unify.userMemory.allShards',
  'unify.userMemory.empty',
  'unify.userMemory.emptyHint',
  'unify.userMemory.pin',
  'unify.userMemory.unpin',
  'unify.userMemory.delete',
  'unify.userMemory.deleteConfirm',
];

describe('task-334-ui-d: User Memory UI', () => {

  describe('(1) i18n key parity', () => {
    for (const key of I18N_KEYS) {
      it(`en.js has '${key}'`, () => {
        expect(enSrc).toContain(`'${key}'`);
      });
      it(`zh-CN.js has '${key}'`, () => {
        expect(zhSrc).toContain(`'${key}'`);
      });
    }
  });

  // ─── (2) user-memory store shape ─────────────────────────────

  describe('(2) user-memory store shape', () => {
    it('defines a Pinia store with id "userMemory"', () => {
      expect(umStoreSrc).toContain("defineStore('userMemory'");
    });
    it('exports useUserMemoryStore', () => {
      expect(umStoreSrc).toContain('export const useUserMemoryStore');
    });
    for (const action of ['applySnapshot', 'applyUpdate', 'applyRemoval', 'togglePin', 'markPending']) {
      it(`has action: ${action}`, () => {
        expect(umStoreSrc).toContain(`${action}(`);
      });
    }
    for (const getter of ['entryList', 'byShard', 'shardNames', 'entryCount']) {
      it(`has getter: ${getter}`, () => {
        expect(umStoreSrc).toContain(getter);
      });
    }
    it('state has entries, order, loading, pendingRequests', () => {
      expect(umStoreSrc).toContain('entries:');
      expect(umStoreSrc).toContain('order:');
      expect(umStoreSrc).toContain('loading:');
      expect(umStoreSrc).toContain('pendingRequests:');
    });
  });

  // ─── (3) chat.js WS event dispatch ──────────────────────────

  describe('(3) chat.js dispatches user_memory events', () => {
    it('handles user_memory_snapshot', () => {
      expect(chatStoreSrc).toContain("'user_memory_snapshot'");
      expect(chatStoreSrc).toContain('applySnapshot(event.entries)');
    });
    it('handles user_memory_updated', () => {
      expect(chatStoreSrc).toContain("'user_memory_updated'");
      expect(chatStoreSrc).toContain('applyUpdate(event)');
    });
    it('handles user_memory_removed', () => {
      expect(chatStoreSrc).toContain("'user_memory_removed'");
      expect(chatStoreSrc).toContain('applyRemoval(event)');
    });
    it('accesses useUserMemoryStore from window.Pinia', () => {
      expect(chatStoreSrc).toContain('useUserMemoryStore');
    });
  });

  // ─── (4) app.js registration ────────────────────────────────

  describe('(4) app.js exposes useUserMemoryStore', () => {
    it('imports useUserMemoryStore from stores/user-memory.js', () => {
      expect(appJsSrc).toContain("from './stores/user-memory.js'");
    });
    it('registers on window.Pinia', () => {
      expect(appJsSrc).toContain('window.Pinia.useUserMemoryStore');
    });
  });

  // ─── (5) UserMemoryPage component ──────────────────────────

  describe('(5) UserMemoryPage component', () => {
    it('emits back event', () => {
      expect(umPageSrc).toContain("emits: ['back']");
    });
    // task-fix: the previous pinned-entries / shard-tabs / delete-modal
    // skeleton (tests removed) was never wired to a real backend and
    // confused users by stacking with the folder-view section. The page
    // now renders a single unified scope-tree view; pin/remove/shard
    // features are dropped until a real backend ships them.
    it('renders the scope-tree as the unified view', () => {
      expect(umPageSrc).toContain('um-scope-section');
      expect(umPageSrc).toContain('um-scope-tree');
      expect(umPageSrc).not.toContain('um-shard-tabs');
      expect(umPageSrc).not.toContain('um-delete-overlay');
      expect(umPageSrc).not.toContain("type: 'unify_user_memory_write'");
      expect(umPageSrc).not.toContain("type: 'unify_user_memory_remove'");
    });
    it('does NOT render two stacked sections (regression: empty + Loading)', () => {
      // The fix collapses the duplicate empty state + folder section
      // into one. Specifically the standalone "Memory · folder view"
      // header (and its hard-coded Loading text) must be gone.
      expect(umPageSrc).not.toContain('Memory · folder view');
      expect(umPageSrc).not.toContain('Loading memory entries');
    });
    it('has loading + empty state keys', () => {
      expect(umPageSrc).toContain('um-empty');
      expect(umPageSrc).toContain('unify.userMemory.empty');
      expect(umPageSrc).toContain('unify.userMemory.loading');
    });
  });

  // ─── (6) UnifySidebarV2 wiring ─────────────────────────────

  describe('(6) UnifySidebarV2 user memory entry', () => {
    it('emits open-user-memory', () => {
      expect(sidebarSrc).toContain('open-user-memory');
    });
    it('renders user memory sidebar section', () => {
      expect(sidebarSrc).toContain('usv2-group-user-memory');
      expect(sidebarSrc).toContain('usv2-user-memory-link');
    });
    it('references i18n keys', () => {
      expect(sidebarSrc).toContain('unify.userMemory.sidebarTitle');
      expect(sidebarSrc).toContain('unify.userMemory.sidebarAria');
    });
  });

  // ─── (7) UnifyPage wiring ──────────────────────────────────

  describe('(7) UnifyPage integrates UserMemoryPage', () => {
    it('imports UserMemoryPage', () => {
      expect(unifyPageSrc).toContain("import UserMemoryPage from './UserMemoryPage.js'");
    });
    it('registers UserMemoryPage in components', () => {
      expect(unifyPageSrc).toContain('UserMemoryPage');
    });
    it('listens to @open-user-memory on sidebar', () => {
      expect(unifyPageSrc).toContain('@open-user-memory="onOpenUserMemory"');
    });
    it('has userMemoryOpen ref', () => {
      expect(unifyPageSrc).toContain('userMemoryOpen');
    });
    it('conditionally renders UserMemoryPage', () => {
      expect(unifyPageSrc).toContain('v-if="!showSettings && userMemoryOpen');
    });
    it('hides MessageList when userMemoryOpen', () => {
      expect(unifyPageSrc).toContain('!userMemoryOpen');
    });
  });
});
