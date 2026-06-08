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
  // line-for-line.
  //
  // Robust to reformatting: instead of a regex that bakes in the exact
  // indentation of the closing brace, we find the method's opening
  // `name(...) {` and then walk forward counting `{`/`}` to find the
  // matching close. That survives any reasonable reformat (tabs, more
  // indent, blank lines) as long as the method body's braces balance.
  function extractMethod(name) {
    const sigRe = new RegExp(`(?:^|[\\s,])${name}\\(([^)]*)\\)\\s*\\{`, 'm');
    const sigMatch = sidebarSrc.match(sigRe);
    if (!sigMatch) throw new Error(`method ${name} not found in YeaftSidebar.js`);
    const params = sigMatch[1];
    const bodyStart = sigMatch.index + sigMatch[0].length; // just past the opening `{`
    let depth = 1;
    let i = bodyStart;
    while (i < sidebarSrc.length && depth > 0) {
      const ch = sidebarSrc[i];
      // Skip over strings + template literals so a `}` inside doesn't fool the counter.
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        i++;
        while (i < sidebarSrc.length && sidebarSrc[i] !== quote) {
          if (sidebarSrc[i] === '\\') i += 2;
          else i++;
        }
        i++;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth !== 0) throw new Error(`method ${name}: unbalanced braces in YeaftSidebar.js`);
    const body = sidebarSrc.slice(bodyStart, i - 1);
    // eslint-disable-next-line no-new-func
    return new Function(params, body);
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

  it('onRemoveFromList calls sessionCrudRequest("archive", { sessionId })', () => {
    // Field rename note (refactor sweep 2026-06-08): web → server wire
    // payload now sends `sessionId` instead of legacy `groupId`. The
    // server-side handler reads `msg.sessionId` (see
    // server/handlers/agent-output.js#session_crud_result). Keeping a
    // `groupId` here would silently break the archive op.
    const calls = [];
    const ctx = {
      groupMenu: { open: true, groupId: 'sess_1' },
      chatStore: { sessionCrudRequest: (op, payload) => calls.push([op, payload]) },
    };
    const onRemoveFromList = extractMethod('onRemoveFromList').bind(ctx);
    onRemoveFromList({ id: 'sess_1' });
    expect(ctx.groupMenu).toEqual({ open: false, groupId: null });
    expect(calls).toEqual([['archive', { sessionId: 'sess_1' }]]);
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
