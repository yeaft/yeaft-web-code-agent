/**
 * yeaft-sidebar-menu.test.js — fix-yeaft-session-list-and-menu Bug 2.
 *
 * Two parts:
 *
 *   1. Template contract: the kebab menu emits exactly three items —
 *      Pin/Unpin, Settings, Remove from list — and binds them to the
 *      correct handler names. Pinned to source content because the
 *      project's components are runtime-compiled Vue strings (no SFC,
 *      no jsdom mount harness wired up for components of this size).
 *
 *   2. Handler behavior: the three new methods (isSessionPinned,
 *      onTogglePin, onRemoveFromList) call into chatStore correctly,
 *      close the menu first, and gracefully no-op when the store is
 *      missing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sidebarPath = resolve(__dirname, '../../web/components/YeaftSidebar.js');
const sidebarSrc = readFileSync(sidebarPath, 'utf-8');

describe('YeaftSidebar — kebab menu template contract', () => {
  it('renders the Pin/Unpin toggle as the first menu item', () => {
    expect(sidebarSrc).toContain('onTogglePin(s.raw)');
    expect(sidebarSrc).toContain("chat.sidebar.unpin");
    expect(sidebarSrc).toContain("chat.sidebar.pin");
  });

  it('renders the Settings menu item that opens the settings modal', () => {
    expect(sidebarSrc).toContain("openGroupSettingsFromMenu(s.raw, 'announcement')");
    expect(sidebarSrc).toContain('yeaft.session.openSettings');
  });

  it('renders the Remove from list menu item as a danger action', () => {
    expect(sidebarSrc).toContain('onRemoveFromList(s.raw)');
    expect(sidebarSrc).toContain('yeaft.session.removeFromList');
    // Danger styling matches chat sidebar's close-session look.
    expect(sidebarSrc).toMatch(/class="session-menu-item danger"[^>]*@click="onRemoveFromList/);
  });

  it('does NOT render the OLD 4-button editor menu (members/announcement/rename/delete)', () => {
    // The old menu had a separate manageMembers item — gone now.
    expect(sidebarSrc).not.toContain("openGroupSettingsFromMenu(s.raw, 'members')");
    expect(sidebarSrc).not.toContain("openGroupSettingsFromMenu(s.raw, 'rename')");
    // The old menu's danger button went to the 'danger' section; remove-from-list
    // replaces it. The 'danger' shortcut should be gone from the kebab.
    expect(sidebarSrc).not.toContain("openGroupSettingsFromMenu(s.raw, 'danger')");
  });
});

describe('YeaftSidebar — kebab menu method behavior', () => {
  // Tiny shim: extract the three methods from the source as standalone
  // functions and bind them to a mock `this`. Avoids the full Vue
  // mount/Pinia harness while still exercising the real method bodies
  // line-for-line. The bodies are small, single-statement-ish closures
  // — eval is the simplest way to keep this test honest to the source.
  function extractMethod(name) {
    const re = new RegExp(`(?:^|\\s)${name}\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n    \\}`, 'm');
    const m = sidebarSrc.match(re);
    if (!m) throw new Error(`method ${name} not found in YeaftSidebar.js`);
    // eslint-disable-next-line no-new-func
    return new Function(m[1], m[2]);
  }

  it('onTogglePin closes the menu, then calls chatStore.togglePin(id)', () => {
    const calls = [];
    const ctx = {
      groupMenu: { open: true, groupId: 'sess_1' },
      chatStore: { togglePin: (id) => calls.push(['togglePin', id]) },
    };
    const onTogglePin = extractMethod('onTogglePin').bind(ctx);
    onTogglePin({ id: 'sess_1' });
    expect(ctx.groupMenu).toEqual({ open: false, groupId: null });
    expect(calls).toEqual([['togglePin', 'sess_1']]);
  });

  it('onTogglePin no-ops on null group without throwing', () => {
    const ctx = {
      groupMenu: { open: true, groupId: 'x' },
      chatStore: { togglePin: () => { throw new Error('should not call'); } },
    };
    const onTogglePin = extractMethod('onTogglePin').bind(ctx);
    onTogglePin(null);
    // menu still closes even on early return
    expect(ctx.groupMenu).toEqual({ open: false, groupId: null });
  });

  it('onTogglePin survives a missing chatStore', () => {
    const ctx = { groupMenu: { open: true, groupId: 'x' }, chatStore: null };
    const onTogglePin = extractMethod('onTogglePin').bind(ctx);
    expect(() => onTogglePin({ id: 's1' })).not.toThrow();
  });

  it('onRemoveFromList calls sessionCrudRequest("archive", { groupId })', () => {
    const calls = [];
    const ctx = {
      groupMenu: { open: true, groupId: 'sess_1' },
      chatStore: { sessionCrudRequest: (op, payload) => calls.push([op, payload]) },
    };
    const onRemoveFromList = extractMethod('onRemoveFromList').bind(ctx);
    onRemoveFromList({ id: 'sess_1' });
    expect(ctx.groupMenu).toEqual({ open: false, groupId: null });
    expect(calls).toEqual([['archive', { groupId: 'sess_1' }]]);
  });

  it('onRemoveFromList survives a missing chatStore', () => {
    const ctx = { groupMenu: { open: true, groupId: 'x' }, chatStore: null };
    const onRemoveFromList = extractMethod('onRemoveFromList').bind(ctx);
    expect(() => onRemoveFromList({ id: 'sess_1' })).not.toThrow();
  });

  it('isSessionPinned delegates to chatStore.isSessionPinned and returns false when missing', () => {
    const isSessionPinned = extractMethod('isSessionPinned');
    expect(isSessionPinned.call({ chatStore: null }, 'x')).toBe(false);
    expect(isSessionPinned.call({ chatStore: {} }, 'x')).toBe(false);
    expect(isSessionPinned.call(
      { chatStore: { isSessionPinned: (id) => id === 'pinned' } },
      'pinned'
    )).toBe(true);
    expect(isSessionPinned.call(
      { chatStore: { isSessionPinned: (id) => id === 'pinned' } },
      'other'
    )).toBe(false);
  });
});
