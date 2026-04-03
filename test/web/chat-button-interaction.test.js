import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for Chat mode button interaction: refresh, compact, clear.
 *
 * Verifies business logic:
 * 1) Refresh button — clears messages, sends sync_messages, guards double-refresh
 * 2) canRefresh computed — checks currentConversation, processingConversations, refreshingSession
 * 3) Compact button — loading state via isCompacting
 * 4) Clear button — clearStatus state management, auto-dismiss
 * 5) Unified status banner — supports both compact and clear status
 * 6) Store state fields — clearStatus, refreshingSession
 * 7) conversationHandler — clear completion detection, auto-dismiss
 */

let headerSource;
let storeSource;
let handlerSource;

beforeAll(() => {
  const base = resolve(__dirname, '../../web');
  headerSource = readFileSync(resolve(base, 'components/ChatHeader.js'), 'utf-8');
  storeSource = readFileSync(resolve(base, 'stores/chat.js'), 'utf-8');
  handlerSource = readFileSync(resolve(base, 'stores/helpers/handlers/conversationHandler.js'), 'utf-8');
});

// =====================================================================
// 1. Refresh button — business logic
// =====================================================================
describe('refresh button — business logic', () => {
  it('refresh button has btn-loading class binding for isRefreshing', () => {
    expect(headerSource).toContain("'btn-loading': isRefreshing");
  });

  it('refresh button is disabled when isRefreshing', () => {
    expect(headerSource).toContain('isRefreshing');
    expect(headerSource).toContain(':disabled="!canRefresh');
  });

  it('refreshSession clears messages for non-Crew before sending', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const fnStart = setupSection.indexOf('refreshSession');
    const fnBody = setupSection.substring(fnStart, fnStart + 800);
    expect(fnBody).toContain('messagesMap[effectiveConvId.value] = []');
  });

  it('refreshSession sets refreshingSession via per-conversation setter', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const fnStart = setupSection.indexOf('refreshSession');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).toContain('setRefreshingSession');
  });

  it('refreshSession sends sync_messages with turns: 5', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const fnStart = setupSection.indexOf('refreshSession');
    const fnBody = setupSection.substring(fnStart, fnStart + 800);
    expect(fnBody).toContain("type: 'sync_messages'");
    expect(fnBody).toContain('turns: 5');
  });

  it('refreshSession sends conversationId in sync_messages', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const fnStart = setupSection.indexOf('refreshSession');
    const fnBody = setupSection.substring(fnStart, fnStart + 800);
    expect(fnBody).toContain('conversationId: effectiveConvId.value');
  });

  it('refreshSession guards against double-refresh and missing conversation', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const fnStart = setupSection.indexOf('refreshSession');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).toContain('isRefreshingSession');
    expect(fnBody).toContain('effectiveConvId');
  });
});

// =====================================================================
// 2. canRefresh computed
// =====================================================================
describe('canRefresh computed', () => {
  it('canRefresh checks currentConversation or effectiveConvId', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const fnStart = setupSection.indexOf('canRefresh');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).toContain('effectiveConvId');
  });

  it('canRefresh checks processingConversations', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const fnStart = setupSection.indexOf('canRefresh');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).toContain('processingConversations');
  });

  it('canRefresh checks isRefreshingSession', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const fnStart = setupSection.indexOf('canRefresh');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).toContain('isRefreshingSession');
  });
});

// =====================================================================
// 3. Compact button — loading state
// =====================================================================
describe('compact button — loading state', () => {
  it('compact button has btn-loading class binding for isCompacting', () => {
    expect(headerSource).toContain("'btn-loading': isCompacting");
  });

  it('compact button disabled binding uses isCompacting', () => {
    expect(headerSource).toContain(':disabled="isCompacting"');
  });
});

// =====================================================================
// 4. Clear button — state management
// =====================================================================
describe('clear button — state management', () => {
  it('clear button has btn-loading class binding for isClearing', () => {
    expect(headerSource).toContain("'btn-loading': isClearing");
  });

  it('isClearing computed checks clearStatus.status === clearing', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    expect(setupSection).toContain("clearStatus?.status === 'clearing'");
  });

  it('isClearing checks conversationId matches effectiveConvId', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const fnStart = setupSection.indexOf('isClearing');
    const fnBody = setupSection.substring(fnStart, fnStart + 200);
    expect(fnBody).toContain('clearStatus?.conversationId');
    expect(fnBody).toContain('effectiveConvId');
  });

  it('clearMessages sets clearStatus before sending /clear', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const clearStart = setupSection.indexOf('clearMessages');
    const clearBody = setupSection.substring(clearStart, clearStart + 500);
    expect(clearBody).toContain('store.clearStatus');
    expect(clearBody).toContain("status: 'clearing'");
  });

  it('clearMessages checks isClearing before proceeding', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const clearStart = setupSection.indexOf('clearMessages');
    const clearBody = setupSection.substring(clearStart, clearStart + 300);
    expect(clearBody).toContain('isClearing');
  });
});

// =====================================================================
// 5. Unified status banner — business logic
// =====================================================================
describe('unified status banner', () => {
  it('showStatusBanner checks clearStatus', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const fnStart = setupSection.indexOf('showStatusBanner');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).toContain('clearStatus');
  });

  it('showStatusBanner also checks compactStatus', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const fnStart = setupSection.indexOf('showStatusBanner');
    const fnBody = setupSection.substring(fnStart, fnStart + 300);
    expect(fnBody).toContain('compactStatus');
  });

  it('statusBannerClass distinguishes clearing vs compacting', () => {
    const setupSection = headerSource.split(/setup\s*\([^)]*\)/)[1] || '';
    const fnStart = setupSection.indexOf('statusBannerClass');
    const fnBody = setupSection.substring(fnStart, fnStart + 400);
    expect(fnBody).toContain("'clearing'");
    expect(fnBody).toContain("'compacting'");
  });
});

// =====================================================================
// 6. Store state fields
// =====================================================================
describe('store — new state fields', () => {
  it('store has clearStatus field initialized to null', () => {
    expect(storeSource).toContain('clearStatus: null');
  });

  it('store has refreshingSession field and per-conversation map', () => {
    expect(storeSource).toContain('refreshingSession: false');
    expect(storeSource).toContain('refreshingSessionMap');
  });
});

// =====================================================================
// 7. conversationHandler — clear completion detection
// =====================================================================
describe('conversationHandler — clear completion detection', () => {
  it('handleTurnCompleted checks clearStatus for clearing state', () => {
    expect(handlerSource).toContain("clearStatus?.status === 'clearing'");
  });

  it('handleTurnCompleted sets clearStatus to completed', () => {
    expect(handlerSource).toContain("status: 'completed'");
  });

  it('handleTurnCompleted uses setTimeout for 3s auto-dismiss', () => {
    const fnStart = handlerSource.indexOf('handleTurnCompleted');
    const fnBody = handlerSource.substring(fnStart, fnStart + 1500);
    expect(fnBody).toContain('setTimeout');
    expect(fnBody).toContain('3000');
  });

  it('auto-dismiss sets clearStatus to null', () => {
    const fnStart = handlerSource.indexOf('handleTurnCompleted');
    const fnBody = handlerSource.substring(fnStart, fnStart + 1500);
    expect(fnBody).toContain('clearStatus = null');
  });

  it('auto-dismiss only clears if still completed for same conversation', () => {
    const fnStart = handlerSource.indexOf('handleTurnCompleted');
    const fnBody = handlerSource.substring(fnStart, fnStart + 1500);
    expect(fnBody).toContain("clearStatus?.conversationId === convId");
    expect(fnBody).toContain("status === 'completed'");
  });

  it('handleSyncMessagesResult resets refreshingSession via per-conversation setter', () => {
    expect(handlerSource).toContain('setRefreshingSession');
  });
});
