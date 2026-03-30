import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #401 — Session health status indicator.
 *
 * 4-phase typing dots: normal (<30s) → slow (30-90s) → stuck (>90s) → disconnected.
 *
 * Covers 7 areas:
 * 1. waitingPhase logic — phase computation (replicated unit tests)
 * 2. MessageList.js — Chat mode: waitingPhase computed + template + timer lifecycle
 * 3. SplitPane.js — Split-pane mode: same logic with conversationId prop
 * 4. CrewChatView.js — Crew mode: waitingPhase computed + refreshCrewSession
 * 5. i18n — en + zh-CN translation keys
 * 6. CSS — phase color classes + status text + refresh button styles
 * 7. watchdog.js — timeout reduced from 120s to 90s
 * Edge: three-view template consistency, refresh WS message payload
 */

let messageListSource;
let splitPaneSource;
let crewChatViewSource;
let enSource;
let zhSource;
let cssSource;
let watchdogSource;

beforeAll(() => {
  const base = resolve(__dirname, '../../web');
  messageListSource = readFileSync(resolve(base, 'components/MessageList.js'), 'utf-8');
  splitPaneSource = readFileSync(resolve(base, 'components/SplitPane.js'), 'utf-8');
  crewChatViewSource = readFileSync(resolve(base, 'components/CrewChatView.js'), 'utf-8');
  enSource = readFileSync(resolve(base, 'i18n/en.js'), 'utf-8');
  zhSource = readFileSync(resolve(base, 'i18n/zh-CN.js'), 'utf-8');
  cssSource = readFileSync(resolve(base, 'styles/chat-messages.css'), 'utf-8');
  watchdogSource = readFileSync(resolve(base, 'stores/helpers/watchdog.js'), 'utf-8');
});

// =====================================================================
// Replicate waitingPhase logic for unit testing
// =====================================================================
function computeWaitingPhase({ isProcessing, connectionState, lastActivity, now }) {
  if (!isProcessing) return null;
  if (connectionState !== 'connected') return 'disconnected';
  if (!lastActivity) return 'normal';
  const elapsed = now - lastActivity;
  if (elapsed < 30000) return 'normal';
  if (elapsed < 90000) return 'slow';
  return 'stuck';
}

// =====================================================================
// 1. waitingPhase logic — phase computation
// =====================================================================
describe('waitingPhase — phase computation', () => {
  it('should return null when not processing', () => {
    expect(computeWaitingPhase({
      isProcessing: false, connectionState: 'connected', lastActivity: Date.now(), now: Date.now()
    })).toBeNull();
  });

  it('should return "disconnected" when connectionState is not "connected"', () => {
    expect(computeWaitingPhase({
      isProcessing: true, connectionState: 'disconnected', lastActivity: Date.now(), now: Date.now()
    })).toBe('disconnected');
  });

  it('should return "disconnected" for reconnecting state', () => {
    expect(computeWaitingPhase({
      isProcessing: true, connectionState: 'reconnecting', lastActivity: Date.now(), now: Date.now()
    })).toBe('disconnected');
  });

  it('should return "normal" when no lastActivity', () => {
    expect(computeWaitingPhase({
      isProcessing: true, connectionState: 'connected', lastActivity: null, now: Date.now()
    })).toBe('normal');
  });

  it('should return "normal" when elapsed < 30s', () => {
    const now = Date.now();
    expect(computeWaitingPhase({
      isProcessing: true, connectionState: 'connected', lastActivity: now - 10000, now
    })).toBe('normal');
  });

  it('should return "normal" at exactly 0s elapsed', () => {
    const now = Date.now();
    expect(computeWaitingPhase({
      isProcessing: true, connectionState: 'connected', lastActivity: now, now
    })).toBe('normal');
  });

  it('should return "slow" when elapsed >= 30s and < 90s', () => {
    const now = Date.now();
    expect(computeWaitingPhase({
      isProcessing: true, connectionState: 'connected', lastActivity: now - 30000, now
    })).toBe('slow');
  });

  it('should return "slow" at 60s elapsed', () => {
    const now = Date.now();
    expect(computeWaitingPhase({
      isProcessing: true, connectionState: 'connected', lastActivity: now - 60000, now
    })).toBe('slow');
  });

  it('should return "slow" at 89999ms (boundary before stuck)', () => {
    const now = Date.now();
    expect(computeWaitingPhase({
      isProcessing: true, connectionState: 'connected', lastActivity: now - 89999, now
    })).toBe('slow');
  });

  it('should return "stuck" when elapsed >= 90s', () => {
    const now = Date.now();
    expect(computeWaitingPhase({
      isProcessing: true, connectionState: 'connected', lastActivity: now - 90000, now
    })).toBe('stuck');
  });

  it('should return "stuck" at 120s elapsed', () => {
    const now = Date.now();
    expect(computeWaitingPhase({
      isProcessing: true, connectionState: 'connected', lastActivity: now - 120000, now
    })).toBe('stuck');
  });

  it('should return "normal" at 29999ms (boundary before slow)', () => {
    const now = Date.now();
    expect(computeWaitingPhase({
      isProcessing: true, connectionState: 'connected', lastActivity: now - 29999, now
    })).toBe('normal');
  });

  it('disconnected takes priority over time-based phase', () => {
    const now = Date.now();
    expect(computeWaitingPhase({
      isProcessing: true, connectionState: 'disconnected', lastActivity: now, now
    })).toBe('disconnected');
  });

  it('should return null even when disconnected but not processing', () => {
    expect(computeWaitingPhase({
      isProcessing: false, connectionState: 'disconnected', lastActivity: Date.now(), now: Date.now()
    })).toBeNull();
  });
});

// =====================================================================
// 2. MessageList.js — Chat mode
// =====================================================================
describe('MessageList.js — waitingPhase implementation', () => {
  it('should define waitingPhase computed', () => {
    expect(messageListSource).toContain('const waitingPhase = Vue.computed(');
  });

  it('should check store.isProcessing as gate', () => {
    const wpBlock = messageListSource.substring(
      messageListSource.indexOf('const waitingPhase = Vue.computed('),
      messageListSource.indexOf('});', messageListSource.indexOf('const waitingPhase = Vue.computed(')) + 3
    );
    expect(wpBlock).toContain('store.isProcessing');
  });

  it('should check connectionState for disconnected', () => {
    const wpBlock = messageListSource.substring(
      messageListSource.indexOf('const waitingPhase = Vue.computed('),
      messageListSource.indexOf('});', messageListSource.indexOf('const waitingPhase = Vue.computed(')) + 3
    );
    expect(wpBlock).toContain("store.connectionState !== 'connected'");
    expect(wpBlock).toContain("return 'disconnected'");
  });

  it('should use store.currentConversation for convId', () => {
    const wpBlock = messageListSource.substring(
      messageListSource.indexOf('const waitingPhase = Vue.computed('),
      messageListSource.indexOf('});', messageListSource.indexOf('const waitingPhase = Vue.computed(')) + 3
    );
    expect(wpBlock).toContain('store.currentConversation');
  });

  it('should use executionStatusMap and lastActivity', () => {
    const wpBlock = messageListSource.substring(
      messageListSource.indexOf('const waitingPhase = Vue.computed('),
      messageListSource.indexOf('});', messageListSource.indexOf('const waitingPhase = Vue.computed(')) + 3
    );
    expect(wpBlock).toContain('store.executionStatusMap[convId]');
    expect(wpBlock).toContain('lastActivity');
  });

  it('should use 30000 and 90000 thresholds', () => {
    const wpBlock = messageListSource.substring(
      messageListSource.indexOf('const waitingPhase = Vue.computed('),
      messageListSource.indexOf('});', messageListSource.indexOf('const waitingPhase = Vue.computed(')) + 3
    );
    expect(wpBlock).toContain('30000');
    expect(wpBlock).toContain('90000');
  });

  it('should setup now timer on mounted and clear on unmounted', () => {
    expect(messageListSource).toContain('nowTimer = setInterval(');
    expect(messageListSource).toContain('clearInterval(nowTimer)');
  });

  it('should update now.value every 1000ms', () => {
    expect(messageListSource).toContain('now.value = Date.now()');
    expect(messageListSource).toContain(', 1000)');
  });

  it('should return waitingPhase and refreshSession from setup', () => {
    const returnBlock = messageListSource.substring(
      messageListSource.lastIndexOf('return {'),
      messageListSource.indexOf('};', messageListSource.lastIndexOf('return {')) + 2
    );
    expect(returnBlock).toContain('waitingPhase');
    expect(returnBlock).toContain('refreshSession');
  });

  it('refreshSession should send refresh_conversation WS message', () => {
    expect(messageListSource).toContain("type: 'refresh_conversation'");
  });
});

// =====================================================================
// 3. SplitPane.js — Split-pane mode
// =====================================================================
describe('SplitPane.js — waitingPhase implementation', () => {
  it('should define waitingPhase computed', () => {
    expect(splitPaneSource).toContain('const waitingPhase = Vue.computed(');
  });

  it('should use conversationId (prop) not store.currentConversation', () => {
    const wpBlock = splitPaneSource.substring(
      splitPaneSource.indexOf('const waitingPhase = Vue.computed('),
      splitPaneSource.indexOf('});', splitPaneSource.indexOf('const waitingPhase = Vue.computed(')) + 3
    );
    expect(wpBlock).toContain('conversationId.value');
    expect(wpBlock).not.toContain('store.currentConversation');
  });

  it('should check isProcessing.value (local computed)', () => {
    const wpBlock = splitPaneSource.substring(
      splitPaneSource.indexOf('const waitingPhase = Vue.computed('),
      splitPaneSource.indexOf('});', splitPaneSource.indexOf('const waitingPhase = Vue.computed(')) + 3
    );
    expect(wpBlock).toContain('isProcessing.value');
  });

  it('should setup and clear now timer', () => {
    expect(splitPaneSource).toContain('nowTimer = setInterval(');
    expect(splitPaneSource).toContain('clearInterval(nowTimer)');
  });

  it('should return waitingPhase and refreshSession', () => {
    const returnBlock = splitPaneSource.substring(
      splitPaneSource.lastIndexOf('return {'),
      splitPaneSource.indexOf('};', splitPaneSource.lastIndexOf('return {')) + 2
    );
    expect(returnBlock).toContain('waitingPhase');
    expect(returnBlock).toContain('refreshSession');
  });

  it('refreshSession should use conversationId.value', () => {
    const refreshIdx = splitPaneSource.indexOf('function refreshSession');
    const refreshBlock = splitPaneSource.substring(refreshIdx, splitPaneSource.indexOf('}', refreshIdx + 30) + 1);
    expect(refreshBlock).toContain('conversationId.value');
  });
});

// =====================================================================
// 4. CrewChatView.js — Crew mode
// =====================================================================
describe('CrewChatView.js — waitingPhase implementation', () => {
  it('should define waitingPhase computed property', () => {
    expect(crewChatViewSource).toContain('waitingPhase()');
  });

  it('should gate on isWaitingResponse', () => {
    const wpIdx = crewChatViewSource.indexOf('waitingPhase()');
    const wpBlock = crewChatViewSource.substring(wpIdx, crewChatViewSource.indexOf('},', wpIdx) + 2);
    expect(wpBlock).toContain('this.isWaitingResponse');
  });

  it('should use effectiveConvId', () => {
    const wpIdx = crewChatViewSource.indexOf('waitingPhase()');
    const wpBlock = crewChatViewSource.substring(wpIdx, crewChatViewSource.indexOf('},', wpIdx) + 2);
    expect(wpBlock).toContain('this.effectiveConvId');
  });

  it('should use nowTick for time tracking', () => {
    const wpIdx = crewChatViewSource.indexOf('waitingPhase()');
    const wpBlock = crewChatViewSource.substring(wpIdx, crewChatViewSource.indexOf('},', wpIdx) + 2);
    expect(wpBlock).toContain('this.nowTick');
  });

  it('should define refreshCrewSession method', () => {
    expect(crewChatViewSource).toContain('refreshCrewSession()');
  });

  it('refreshCrewSession should send refresh_conversation', () => {
    expect(crewChatViewSource).toContain("type: 'refresh_conversation'");
  });
});

// =====================================================================
// 5. i18n — en + zh-CN translations
// =====================================================================
describe('i18n — typing health translation keys', () => {
  const keys = ['chat.waiting.slow', 'chat.waiting.stuck', 'chat.waiting.refresh', 'chat.waiting.disconnected'];

  keys.forEach(key => {
    it(`should have "${key}" in en.js`, () => {
      expect(enSource).toContain(`'${key}'`);
    });

    it(`should have "${key}" in zh-CN.js`, () => {
      expect(zhSource).toContain(`'${key}'`);
    });
  });

  it('en: slow = "Waiting for response..."', () => {
    expect(enSource).toContain("'Waiting for response...'");
  });

  it('en: stuck = "Response may be stuck"', () => {
    expect(enSource).toContain("'Response may be stuck'");
  });

  it('en: disconnected = "Connection lost"', () => {
    expect(enSource).toContain("'Connection lost'");
  });

  it('zh: slow = "等待响应中..."', () => {
    expect(zhSource).toContain("'等待响应中...'");
  });

  it('zh: stuck = "响应可能已卡住"', () => {
    expect(zhSource).toContain("'响应可能已卡住'");
  });

  it('zh: disconnected = "连接已断开"', () => {
    expect(zhSource).toContain("'连接已断开'");
  });
});

// =====================================================================
// 6. CSS — phase styles
// =====================================================================
describe('chat-messages.css — typing health phase styles', () => {
  it('should have phase-slow with yellow color', () => {
    expect(cssSource).toContain('.typing-indicator.phase-slow');
    expect(cssSource).toContain('#f5a623');
  });

  it('should have phase-stuck with orange color', () => {
    expect(cssSource).toContain('.typing-indicator.phase-stuck');
    expect(cssSource).toContain('#e57c23');
  });

  it('should have phase-disconnected with red color', () => {
    expect(cssSource).toContain('.typing-indicator.phase-disconnected');
    expect(cssSource).toContain('#e53935');
  });

  it('should only color the first 3 spans (dots) via :nth-child(-n+3)', () => {
    expect(cssSource).toContain(':nth-child(-n+3)');
  });

  it('should define typing-status-text class', () => {
    expect(cssSource).toContain('.typing-status-text');
  });

  it('should define typing-status-warn and typing-status-error classes', () => {
    expect(cssSource).toContain('.typing-status-warn');
    expect(cssSource).toContain('.typing-status-error');
  });

  it('should define typing-refresh-btn with hover state', () => {
    expect(cssSource).toContain('.typing-refresh-btn');
    expect(cssSource).toContain('.typing-refresh-btn:hover');
  });

  it('should add align-items: center to typing-indicator base rule', () => {
    const indicatorRule = cssSource.substring(
      cssSource.indexOf('.typing-indicator {'),
      cssSource.indexOf('}', cssSource.indexOf('.typing-indicator {')) + 1
    );
    expect(indicatorRule).toContain('align-items: center');
  });
});

// =====================================================================
// 7. watchdog.js — timeout reduced to 90s
// =====================================================================
describe('watchdog.js — timeout threshold', () => {
  it('should use 90000ms (90 seconds) instead of 120000ms', () => {
    expect(watchdogSource).toContain('90000');
    expect(watchdogSource).not.toContain('120000');
  });

  it('should have "90 seconds" comment', () => {
    expect(watchdogSource).toContain('90 seconds');
  });
});

// =====================================================================
// Edge: three-view template consistency
// =====================================================================
describe('Three-view template consistency', () => {
  it('all three views should use phase class binding on typing-indicator', () => {
    const phaseBinding = "'phase-' + (waitingPhase || 'normal')";
    expect(messageListSource).toContain(phaseBinding);
    expect(splitPaneSource).toContain(phaseBinding);
    expect(crewChatViewSource).toContain(phaseBinding);
  });

  it('all three views should reference all 4 i18n keys', () => {
    for (const src of [messageListSource, splitPaneSource, crewChatViewSource]) {
      expect(src).toContain("$t('chat.waiting.slow')");
      expect(src).toContain("$t('chat.waiting.stuck')");
      expect(src).toContain("$t('chat.waiting.refresh')");
      expect(src).toContain("$t('chat.waiting.disconnected')");
    }
  });

  it('all three views should check waitingPhase === "slow"/"stuck"/"disconnected"', () => {
    for (const src of [messageListSource, splitPaneSource, crewChatViewSource]) {
      expect(src).toContain("waitingPhase === 'slow'");
      expect(src).toContain("waitingPhase === 'stuck'");
      expect(src).toContain("waitingPhase === 'disconnected'");
    }
  });

  it('all three views should have a refresh button with typing-refresh-btn class', () => {
    for (const src of [messageListSource, splitPaneSource, crewChatViewSource]) {
      expect(src).toContain('typing-refresh-btn');
    }
  });
});

// =====================================================================
// Edge: refresh WS message format
// =====================================================================
describe('Refresh button — WS message format', () => {
  it('all three views send refresh_conversation type', () => {
    expect(messageListSource).toContain("type: 'refresh_conversation'");
    expect(splitPaneSource).toContain("type: 'refresh_conversation'");
    expect(crewChatViewSource).toContain("type: 'refresh_conversation'");
  });

  it('MessageList and SplitPane use @click="refreshSession"', () => {
    expect(messageListSource).toContain('@click="refreshSession"');
    expect(splitPaneSource).toContain('@click="refreshSession"');
  });

  it('CrewChatView uses @click="refreshCrewSession"', () => {
    expect(crewChatViewSource).toContain('@click="refreshCrewSession"');
  });
});
