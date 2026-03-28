import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for Crew session inline rename feature.
 *
 * Verification points:
 * 1) ChatPage template has dblclick trigger on crew title text
 * 2) ChatPage has inline input for renaming (v-if editingCrewId)
 * 3) Input has correct keyboard handlers (Enter=save, Escape=cancel, blur=save)
 * 4) crew.js store helper has renameCrewSession function
 * 5) renameCrewSession sends update_crew_session WS message
 * 6) chat.js wires up renameCrewSession via crewHelpers
 * 7) CSS includes crew-rename-input styles
 * 8) Clicking session item is blocked while editing
 */

let chatPageSource;
let crewHelperSource;
let chatStoreSource;
let sidebarCssSource;

beforeAll(() => {
  chatPageSource = readFileSync(
    resolve(__dirname, '../../web/components/ChatPage.js'), 'utf-8'
  );
  crewHelperSource = readFileSync(
    resolve(__dirname, '../../web/stores/helpers/crew.js'), 'utf-8'
  );
  chatStoreSource = readFileSync(
    resolve(__dirname, '../../web/stores/chat.js'), 'utf-8'
  );
  sidebarCssSource = readFileSync(
    resolve(__dirname, '../../web/styles/sidebar.css'), 'utf-8'
  );
});

// =====================================================================
// 1. Template: dblclick trigger
// =====================================================================
describe('dblclick triggers inline rename', () => {
  it('crew title span has @dblclick.stop handler', () => {
    expect(chatPageSource).toContain('@dblclick.stop="startCrewRename(conv)"');
  });

  it('crew title span is rendered with crew-title-text class', () => {
    expect(chatPageSource).toContain('class="crew-title-text"');
  });
});

// =====================================================================
// 2. Template: inline input
// =====================================================================
describe('inline rename input', () => {
  it('input appears conditionally when editingCrewId matches', () => {
    expect(chatPageSource).toContain('v-if="editingCrewId === conv.id"');
  });

  it('input has crew-rename-input class', () => {
    expect(chatPageSource).toContain('class="crew-rename-input"');
  });

  it('input uses v-model editingCrewName', () => {
    expect(chatPageSource).toContain('v-model="editingCrewName"');
  });

  it('input has ref for programmatic focus', () => {
    expect(chatPageSource).toContain('ref="crewRenameInput"');
  });
});

// =====================================================================
// 3. Keyboard handlers
// =====================================================================
describe('keyboard and blur handlers', () => {
  it('Enter commits rename', () => {
    expect(chatPageSource).toContain('@keydown.enter="commitCrewRename"');
  });

  it('Escape cancels rename', () => {
    expect(chatPageSource).toContain('@keydown.escape="cancelCrewRename"');
  });

  it('blur commits rename', () => {
    expect(chatPageSource).toContain('@blur="commitCrewRename"');
  });
});

// =====================================================================
// 4. Store helper: renameCrewSession function
// =====================================================================
describe('renameCrewSession store helper', () => {
  it('exports renameCrewSession function', () => {
    expect(crewHelperSource).toContain('export function renameCrewSession(store, sessionId, name)');
  });

  it('optimistically updates conversation name', () => {
    expect(crewHelperSource).toContain('conv.name = name');
  });

  it('sends update_crew_session WS message', () => {
    expect(crewHelperSource).toContain("type: 'update_crew_session'");
  });
});

// =====================================================================
// 5. chat.js wires up renameCrewSession
// =====================================================================
describe('chat.js store integration', () => {
  it('chat store exposes renameCrewSession method', () => {
    expect(chatStoreSource).toContain('renameCrewSession(sessionId, name)');
    expect(chatStoreSource).toContain('crewHelpers.renameCrewSession');
  });
});

// =====================================================================
// 6. CSS styles
// =====================================================================
describe('inline rename CSS styles', () => {
  it('crew-rename-input has no side borders and bottom underline', () => {
    expect(sidebarCssSource).toContain('.crew-rename-input');
    expect(sidebarCssSource).toContain('border: none');
    expect(sidebarCssSource).toContain('border-bottom: 1px solid');
  });

  it('crew-rename-input has transparent background', () => {
    expect(sidebarCssSource).toContain('background: transparent');
  });
});

// =====================================================================
// 7. Click is blocked during editing
// =====================================================================
describe('session click blocked during editing', () => {
  it('session item click is conditional on editingCrewId', () => {
    expect(chatPageSource).toContain('editingCrewId !== conv.id && onSessionClick');
  });
});

// =====================================================================
// 8. Methods exist in ChatPage
// =====================================================================
describe('ChatPage methods', () => {
  it('has startCrewRename method', () => {
    expect(chatPageSource).toContain('startCrewRename(conv)');
  });

  it('has commitCrewRename method', () => {
    expect(chatPageSource).toContain('commitCrewRename()');
  });

  it('has cancelCrewRename method', () => {
    expect(chatPageSource).toContain('cancelCrewRename()');
  });

  it('startCrewRename sets editingCrewId and focuses input', () => {
    expect(chatPageSource).toContain('this.editingCrewId = conv.id');
    expect(chatPageSource).toContain('el.focus()');
    expect(chatPageSource).toContain('el.select()');
  });

  it('commitCrewRename calls store.renameCrewSession', () => {
    expect(chatPageSource).toContain('this.store.renameCrewSession(sessionId');
  });

  it('empty name falls back to Crew Session', () => {
    expect(chatPageSource).toContain("this.editingCrewName.trim() || 'Crew Session'");
  });
});
