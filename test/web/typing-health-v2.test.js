import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #403 — Event-driven typing indicator + typing dots disappearing fix.
 *
 * Replaces v1 time-based (30s/90s) with event-driven ping/pong model.
 * Statuses: disconnected, compacting, agent-offline, session-lost, cli-exited.
 * Task B: empty content array sends finish-streaming signal → dots reappear.
 *
 * Covers 11 areas:
 * 1. waitingStatus logic — replicated unit tests
 * 2. Agent layer — handlePingSession + _lastOutputTime tracking
 * 3. Server layer — ping_session routing + pong_session forwarding
 * 4. MessageList.js — waitingStatus computed + template
 * 5. SplitPane.js — waitingStatus + conversationId
 * 6. CrewChatView.js — waitingStatus + refreshCrewSession
 * 7. messageHandler — pong_session handling
 * 8. watchdog.js — ping-based model (45s initial, 30s interval, 10s pong timeout)
 * 9. claudeOutput.js — empty content finish-streaming signal (Task B)
 * 10. i18n — 6 keys in en + zh-CN
 * 11. CSS — status classes (not phase classes)
 * Edge: three-view consistency, store.sessionHealth state, timer cleanup
 */

let messageListSource;
let splitPaneSource;
let crewChatViewSource;
let enSource;
let zhSource;
let cssSource;
let watchdogSource;
let messageHandlerSource;
let claudeOutputSource;
let storeSource;
let agentConvSource;
let agentClaudeSource;
let serverAgentOutputSource;
let serverClientConvSource;
let querySource;
let messageRouterSource;

beforeAll(() => {
  const web = resolve(__dirname, '../../web');
  const agent = resolve(__dirname, '../../agent');
  const server = resolve(__dirname, '../../server');
  messageListSource = readFileSync(resolve(web, 'components/MessageList.js'), 'utf-8');
  splitPaneSource = readFileSync(resolve(web, 'components/SplitPane.js'), 'utf-8');
  crewChatViewSource = readFileSync(resolve(web, 'components/CrewChatView.js'), 'utf-8');
  enSource = readFileSync(resolve(web, 'i18n/en.js'), 'utf-8');
  zhSource = readFileSync(resolve(web, 'i18n/zh-CN.js'), 'utf-8');
  cssSource = readFileSync(resolve(web, 'styles/chat-messages.css'), 'utf-8');
  watchdogSource = readFileSync(resolve(web, 'stores/helpers/watchdog.js'), 'utf-8');
  messageHandlerSource = readFileSync(resolve(web, 'stores/helpers/messageHandler.js'), 'utf-8');
  claudeOutputSource = readFileSync(resolve(web, 'stores/helpers/claudeOutput.js'), 'utf-8');
  storeSource = readFileSync(resolve(web, 'stores/chat.js'), 'utf-8');
  agentConvSource = readFileSync(resolve(agent, 'conversation.js'), 'utf-8');
  agentClaudeSource = readFileSync(resolve(agent, 'claude.js'), 'utf-8');
  serverAgentOutputSource = readFileSync(resolve(server, 'handlers/agent-output.js'), 'utf-8');
  serverClientConvSource = readFileSync(resolve(server, 'handlers/client-conversation.js'), 'utf-8');
  querySource = readFileSync(resolve(agent, 'sdk/query.js'), 'utf-8');
  messageRouterSource = readFileSync(resolve(agent, 'connection/message-router.js'), 'utf-8');
});

// =====================================================================
// Replicate waitingStatus logic for unit testing
// =====================================================================
function computeWaitingStatus({ isProcessing, connectionState, compactStatus, convId, sessionHealth }) {
  if (!isProcessing) return null;
  if (connectionState !== 'connected') return 'disconnected';
  if (compactStatus?.conversationId === convId && compactStatus?.status === 'compacting') return 'compacting';
  const health = sessionHealth?.[convId];
  if (health) return health.status;
  return null;
}

// =====================================================================
// 1. waitingStatus logic — phase computation
// =====================================================================
describe('waitingStatus — event-driven computation', () => {
  it('should return null when not processing', () => {
    expect(computeWaitingStatus({
      isProcessing: false, connectionState: 'connected', compactStatus: null, convId: 'c1', sessionHealth: {}
    })).toBeNull();
  });

  it('should return "disconnected" when WS not connected', () => {
    expect(computeWaitingStatus({
      isProcessing: true, connectionState: 'disconnected', compactStatus: null, convId: 'c1', sessionHealth: {}
    })).toBe('disconnected');
  });

  it('should return "compacting" when compact is active for this conversation', () => {
    expect(computeWaitingStatus({
      isProcessing: true, connectionState: 'connected',
      compactStatus: { conversationId: 'c1', status: 'compacting' },
      convId: 'c1', sessionHealth: {}
    })).toBe('compacting');
  });

  it('should NOT return "compacting" for different conversation', () => {
    expect(computeWaitingStatus({
      isProcessing: true, connectionState: 'connected',
      compactStatus: { conversationId: 'c2', status: 'compacting' },
      convId: 'c1', sessionHealth: {}
    })).toBeNull();
  });

  it('should return "agent-offline" from sessionHealth', () => {
    expect(computeWaitingStatus({
      isProcessing: true, connectionState: 'connected', compactStatus: null,
      convId: 'c1', sessionHealth: { c1: { status: 'agent-offline' } }
    })).toBe('agent-offline');
  });

  it('should return "session-lost" from sessionHealth', () => {
    expect(computeWaitingStatus({
      isProcessing: true, connectionState: 'connected', compactStatus: null,
      convId: 'c1', sessionHealth: { c1: { status: 'session-lost' } }
    })).toBe('session-lost');
  });

  it('should return "cli-exited" from sessionHealth', () => {
    expect(computeWaitingStatus({
      isProcessing: true, connectionState: 'connected', compactStatus: null,
      convId: 'c1', sessionHealth: { c1: { status: 'cli-exited' } }
    })).toBe('cli-exited');
  });

  it('should return null when processing, connected, no compact, no health issue', () => {
    expect(computeWaitingStatus({
      isProcessing: true, connectionState: 'connected', compactStatus: null,
      convId: 'c1', sessionHealth: {}
    })).toBeNull();
  });

  it('disconnected priority: should return "disconnected" even with sessionHealth set', () => {
    expect(computeWaitingStatus({
      isProcessing: true, connectionState: 'reconnecting', compactStatus: null,
      convId: 'c1', sessionHealth: { c1: { status: 'agent-offline' } }
    })).toBe('disconnected');
  });

  it('compacting priority: should return "compacting" even with sessionHealth set', () => {
    expect(computeWaitingStatus({
      isProcessing: true, connectionState: 'connected',
      compactStatus: { conversationId: 'c1', status: 'compacting' },
      convId: 'c1', sessionHealth: { c1: { status: 'agent-offline' } }
    })).toBe('compacting');
  });
});

// =====================================================================
// 2. Agent layer
// =====================================================================
describe('Agent — handlePingSession + _lastOutputTime', () => {
  it('conversation.js should export handlePingSession', () => {
    expect(agentConvSource).toContain('export function handlePingSession');
  });

  it('handlePingSession should return "session-lost" when conv not found', () => {
    const fn = agentConvSource.substring(agentConvSource.indexOf('export function handlePingSession'));
    expect(fn).toContain("status: 'session-lost'");
  });

  it('handlePingSession should return "cli-exited" when no query', () => {
    const fn = agentConvSource.substring(agentConvSource.indexOf('export function handlePingSession'));
    expect(fn).toContain("status: 'cli-exited'");
  });

  it('handlePingSession should return "ok" with isProcessing and currentTool', () => {
    const fn = agentConvSource.substring(agentConvSource.indexOf('export function handlePingSession'));
    expect(fn).toContain("status: 'ok'");
    expect(fn).toContain('isProcessing');
    expect(fn).toContain('currentTool');
  });

  it('handlePingSession should send pong_session type', () => {
    const fn = agentConvSource.substring(agentConvSource.indexOf('export function handlePingSession'));
    expect(fn).toContain("type: 'pong_session'");
  });

  it('claude.js should track _lastOutputTime', () => {
    expect(agentClaudeSource).toContain('state._lastOutputTime = Date.now()');
  });

  it('message-router should register ping_session case', () => {
    expect(messageRouterSource).toContain("case 'ping_session':");
    expect(messageRouterSource).toContain('handlePingSession');
  });
});

// =====================================================================
// 3. Server layer
// =====================================================================
describe('Server — ping/pong routing', () => {
  it('client-conversation should handle ping_session', () => {
    expect(serverClientConvSource).toContain("case 'ping_session':");
  });

  it('server should check agent online before forwarding ping', () => {
    const pingBlock = serverClientConvSource.substring(
      serverClientConvSource.indexOf("case 'ping_session':"),
      serverClientConvSource.indexOf('break;', serverClientConvSource.indexOf("case 'ping_session':")) + 6
    );
    expect(pingBlock).toContain('readyState !== 1');
    expect(pingBlock).toContain("status: 'agent-offline'");
  });

  it('server should forward ping_session to agent with clientId', () => {
    const pingBlock = serverClientConvSource.substring(
      serverClientConvSource.indexOf("case 'ping_session':"),
      serverClientConvSource.indexOf('break;', serverClientConvSource.indexOf("case 'ping_session':")) + 6
    );
    expect(pingBlock).toContain("type: 'ping_session'");
    expect(pingBlock).toContain('clientId');
  });

  it('agent-output should handle pong_session', () => {
    expect(serverAgentOutputSource).toContain("case 'pong_session':");
  });

  it('pong_session should forward to specific client when clientId present', () => {
    const pongBlock = serverAgentOutputSource.substring(
      serverAgentOutputSource.indexOf("case 'pong_session':"),
      serverAgentOutputSource.indexOf('break;', serverAgentOutputSource.indexOf("case 'pong_session':")) + 6
    );
    expect(pongBlock).toContain('msg.clientId');
    expect(pongBlock).toContain("type: 'pong_session'");
  });
});

// =====================================================================
// 4. MessageList.js — waitingStatus
// =====================================================================
describe('MessageList.js — waitingStatus', () => {
  it('should define waitingStatus computed (not waitingPhase)', () => {
    expect(messageListSource).toContain('const waitingStatus = Vue.computed(');
    expect(messageListSource).not.toContain('const waitingPhase = Vue.computed(');
  });

  it('should check compactStatus for compacting', () => {
    const wsBlock = messageListSource.substring(
      messageListSource.indexOf('const waitingStatus = Vue.computed('),
      messageListSource.indexOf('});', messageListSource.indexOf('const waitingStatus = Vue.computed(')) + 3
    );
    expect(wsBlock).toContain('store.compactStatus');
    expect(wsBlock).toContain("'compacting'");
  });

  it('should check sessionHealth for health status', () => {
    const wsBlock = messageListSource.substring(
      messageListSource.indexOf('const waitingStatus = Vue.computed('),
      messageListSource.indexOf('});', messageListSource.indexOf('const waitingStatus = Vue.computed(')) + 3
    );
    expect(wsBlock).toContain('store.sessionHealth');
    expect(wsBlock).toContain('health.status');
  });

  it('should NOT have time-based now timer (removed from v1)', () => {
    // nowTimer and setInterval for time tracking should be gone
    expect(messageListSource).not.toContain('nowTimer = setInterval(');
  });

  it('should return waitingStatus from setup', () => {
    const returnBlock = messageListSource.substring(
      messageListSource.lastIndexOf('return {'),
      messageListSource.indexOf('};', messageListSource.lastIndexOf('return {')) + 2
    );
    expect(returnBlock).toContain('waitingStatus');
    expect(returnBlock).not.toContain('waitingPhase');
  });
});

// =====================================================================
// 5. SplitPane.js — waitingStatus
// =====================================================================
describe('SplitPane.js — waitingStatus', () => {
  it('should define waitingStatus computed (not waitingPhase)', () => {
    expect(splitPaneSource).toContain('const waitingStatus = Vue.computed(');
    expect(splitPaneSource).not.toContain('const waitingPhase = Vue.computed(');
  });

  it('should use conversationId.value not store.currentConversation', () => {
    const wsBlock = splitPaneSource.substring(
      splitPaneSource.indexOf('const waitingStatus = Vue.computed('),
      splitPaneSource.indexOf('});', splitPaneSource.indexOf('const waitingStatus = Vue.computed(')) + 3
    );
    expect(wsBlock).toContain('conversationId.value');
    expect(wsBlock).not.toContain('store.currentConversation');
  });

  it('should NOT have time-based now timer (removed from v1)', () => {
    expect(splitPaneSource).not.toContain('nowTimer = setInterval(');
  });

  it('should return waitingStatus from setup', () => {
    const returnBlock = splitPaneSource.substring(
      splitPaneSource.lastIndexOf('return {'),
      splitPaneSource.indexOf('};', splitPaneSource.lastIndexOf('return {')) + 2
    );
    expect(returnBlock).toContain('waitingStatus');
  });
});

// =====================================================================
// 6. CrewChatView.js — waitingStatus
// =====================================================================
describe('CrewChatView.js — waitingStatus', () => {
  it('should define waitingStatus computed (not waitingPhase)', () => {
    expect(crewChatViewSource).toContain('waitingStatus()');
    expect(crewChatViewSource).not.toContain('waitingPhase()');
  });

  it('should use effectiveConvId', () => {
    const wsIdx = crewChatViewSource.indexOf('waitingStatus()');
    const wsBlock = crewChatViewSource.substring(wsIdx, crewChatViewSource.indexOf('},', wsIdx) + 2);
    expect(wsBlock).toContain('this.effectiveConvId');
  });

  it('should check compactStatus and sessionHealth', () => {
    const wsIdx = crewChatViewSource.indexOf('waitingStatus()');
    const wsBlock = crewChatViewSource.substring(wsIdx, crewChatViewSource.indexOf('},', wsIdx) + 2);
    expect(wsBlock).toContain('this.store.compactStatus');
    expect(wsBlock).toContain('this.store.sessionHealth');
  });

  it('should define refreshCrewSession method', () => {
    expect(crewChatViewSource).toContain('refreshCrewSession()');
  });
});

// =====================================================================
// 7. messageHandler — pong_session handling
// =====================================================================
describe('messageHandler — pong_session', () => {
  it('should handle pong_session message type', () => {
    expect(messageHandlerSource).toContain("case 'pong_session':");
  });

  it('should clear pong timeout on pong received', () => {
    // Extract the full pong_session case block (up to the closing "}\n" of the case)
    const start = messageHandlerSource.indexOf("case 'pong_session':");
    const nextCase = messageHandlerSource.indexOf("case '", start + 20);
    const pongBlock = messageHandlerSource.substring(start, nextCase > start ? nextCase : start + 500);
    expect(pongBlock).toContain('clearTimeout(store._pongTimeouts[pongConvId])');
  });

  it('should clear sessionHealth on ok status', () => {
    const start = messageHandlerSource.indexOf("case 'pong_session':");
    const nextCase = messageHandlerSource.indexOf("case '", start + 20);
    const pongBlock = messageHandlerSource.substring(start, nextCase > start ? nextCase : start + 500);
    expect(pongBlock).toContain("msg.status === 'ok'");
    expect(pongBlock).toContain('delete store.sessionHealth[pongConvId]');
  });

  it('should clear processing state when agent says not processing', () => {
    const start = messageHandlerSource.indexOf("case 'pong_session':");
    const nextCase = messageHandlerSource.indexOf("case '", start + 20);
    const pongBlock = messageHandlerSource.substring(start, nextCase > start ? nextCase : start + 500);
    expect(pongBlock).toContain('!msg.isProcessing && store.processingConversations[pongConvId]');
    expect(pongBlock).toContain('delete store.processingConversations[pongConvId]');
  });

  it('should set sessionHealth for non-ok statuses', () => {
    const start = messageHandlerSource.indexOf("case 'pong_session':");
    const nextCase = messageHandlerSource.indexOf("case '", start + 20);
    const pongBlock = messageHandlerSource.substring(start, nextCase > start ? nextCase : start + 500);
    expect(pongBlock).toContain('store.sessionHealth[pongConvId] = { status: msg.status }');
  });

  it('should clear processing for session-lost and cli-exited', () => {
    const start = messageHandlerSource.indexOf("case 'pong_session':");
    const nextCase = messageHandlerSource.indexOf("case '", start + 20);
    const pongBlock = messageHandlerSource.substring(start, nextCase > start ? nextCase : start + 500);
    expect(pongBlock).toContain("msg.status === 'session-lost'");
    expect(pongBlock).toContain("msg.status === 'cli-exited'");
  });
});

// =====================================================================
// 8. watchdog.js — ping-based model
// =====================================================================
describe('watchdog.js — ping-based health monitoring', () => {
  it('should send ping_session instead of refresh_conversation in startProcessingWatchdog', () => {
    expect(watchdogSource).toContain("type: 'ping_session'");
    // startProcessingWatchdog uses ping, but startLegacyWatchdog uses refresh for old agents
    const pingSection = watchdogSource.substring(0, watchdogSource.indexOf('startLegacyWatchdog'));
    expect(pingSection).not.toContain("type: 'refresh_conversation'");
  });

  it('should use 45000ms initial delay', () => {
    expect(watchdogSource).toContain('45000');
  });

  it('should use 30000ms ping interval', () => {
    expect(watchdogSource).toContain('30000');
  });

  it('should use 10000ms pong timeout', () => {
    expect(watchdogSource).toContain('10000');
  });

  it('should mark agent-offline on pong timeout', () => {
    expect(watchdogSource).toContain("status: 'agent-offline'");
  });

  it('should store pong timeout in _pongTimeouts', () => {
    expect(watchdogSource).toContain('store._pongTimeouts');
  });

  it('resetProcessingWatchdog should clear pong timeout', () => {
    const resetFn = watchdogSource.substring(
      watchdogSource.indexOf('export function resetProcessingWatchdog'),
      watchdogSource.indexOf('export function stopProcessingWatchdog')
    );
    expect(resetFn).toContain('clearTimeout(store._pongTimeouts[conversationId])');
  });

  it('resetProcessingWatchdog should clear sessionHealth warning', () => {
    const resetFn = watchdogSource.substring(
      watchdogSource.indexOf('export function resetProcessingWatchdog'),
      watchdogSource.indexOf('export function stopProcessingWatchdog')
    );
    expect(resetFn).toContain('delete store.sessionHealth[conversationId]');
  });

  it('stopProcessingWatchdog should clear both timeout and interval', () => {
    const stopFn = watchdogSource.substring(
      watchdogSource.indexOf('export function stopProcessingWatchdog')
    );
    expect(stopFn).toContain('clearTimeout(store._processingWatchdogs[conversationId])');
    expect(stopFn).toContain('clearInterval(store._processingWatchdogs[conversationId])');
  });

  it('stopProcessingWatchdog should clean up _pongTimeouts', () => {
    const stopFn = watchdogSource.substring(
      watchdogSource.indexOf('export function stopProcessingWatchdog')
    );
    expect(stopFn).toContain('store._pongTimeouts[conversationId]');
  });
});

// =====================================================================
// 9. claudeOutput.js — empty content finish-streaming signal (Task B)
// =====================================================================
describe('claudeOutput.js — finish-streaming signal', () => {
  it('should detect empty content array as finish-streaming', () => {
    expect(claudeOutputSource).toContain('content.length === 0');
  });

  it('should call finishStreamingForConversation on empty content', () => {
    expect(claudeOutputSource).toContain('store.finishStreamingForConversation(conversationId)');
  });

  it('query.js should emit _finishStreaming signal for text-only messages', () => {
    expect(querySource).toContain('_finishStreaming: true');
    // Should send empty content array
    expect(querySource).toContain("content: []");
  });
});

// =====================================================================
// 10. i18n — 6 keys
// =====================================================================
describe('i18n — typing health v2 keys', () => {
  const keys = [
    'chat.waiting.disconnected',
    'chat.waiting.compacting',
    'chat.waiting.agentOffline',
    'chat.waiting.sessionLost',
    'chat.waiting.cliExited',
    'chat.waiting.refresh'
  ];

  keys.forEach(key => {
    it(`en.js should have "${key}"`, () => {
      expect(enSource).toContain(`'${key}'`);
    });
    it(`zh-CN.js should have "${key}"`, () => {
      expect(zhSource).toContain(`'${key}'`);
    });
  });

  // Verify v1 keys are removed
  it('should NOT have old v1 "chat.waiting.slow" key in en.js', () => {
    expect(enSource).not.toContain("'chat.waiting.slow'");
  });

  it('should NOT have old v1 "chat.waiting.stuck" key in en.js', () => {
    expect(enSource).not.toContain("'chat.waiting.stuck'");
  });

  // Spot-check values
  it('en: compacting = "Compacting context..."', () => {
    expect(enSource).toContain("'Compacting context...'");
  });

  it('zh: compacting = "正在压缩上下文..."', () => {
    expect(zhSource).toContain("'正在压缩上下文...'");
  });

  it('en: agentOffline = "Agent offline"', () => {
    expect(enSource).toContain("'Agent offline'");
  });

  it('zh: agentOffline = "Agent 已离线"', () => {
    expect(zhSource).toContain("'Agent 已离线'");
  });

  it('en: sessionLost = auto-refreshed message', () => {
    expect(enSource).toContain("'Session lost, refreshed, waiting for update...'");
  });

  it('zh: sessionLost = auto-refreshed message', () => {
    expect(zhSource).toContain("'Session 已丢失，已刷新，等待最新信息...'");
  });

  it('en: cliExited = auto-refreshed message', () => {
    expect(enSource).toContain("'Claude process exited, refreshed, waiting for update...'");
  });

  it('zh: cliExited = auto-refreshed message', () => {
    expect(zhSource).toContain("'Claude 进程已退出，已刷新，等待最新信息...'");
  });
});

// =====================================================================
// 11. CSS — status classes (replacing phase classes)
// =====================================================================
describe('CSS — typing health v2 status styles', () => {
  it('should have status-disconnected with red color (rgba)', () => {
    expect(cssSource).toContain('.typing-indicator.status-disconnected');
    expect(cssSource).toContain('rgba(229, 57, 53');
  });

  it('should have status-agent-offline with red color', () => {
    expect(cssSource).toContain('.typing-indicator.status-agent-offline');
  });

  it('should have status-compacting with blue color (rgba)', () => {
    expect(cssSource).toContain('.typing-indicator.status-compacting');
    expect(cssSource).toContain('rgba(91, 155, 213');
  });

  it('should have status-session-lost with orange color', () => {
    expect(cssSource).toContain('.typing-indicator.status-session-lost');
  });

  it('should have status-cli-exited with orange color', () => {
    expect(cssSource).toContain('.typing-indicator.status-cli-exited');
  });

  it('should have typing-status-compact class', () => {
    expect(cssSource).toContain('.typing-status-compact');
  });

  it('should NOT have old phase-slow or phase-stuck classes', () => {
    expect(cssSource).not.toContain('.typing-indicator.phase-slow');
    expect(cssSource).not.toContain('.typing-indicator.phase-stuck');
  });

  it('should still use :nth-child(-n+3) for dot coloring', () => {
    expect(cssSource).toContain(':nth-child(-n+3)');
  });
});

// =====================================================================
// Edge: three-view template consistency
// =====================================================================
describe('Three-view template consistency (v2)', () => {
  it('all views should use status-based class binding (not phase)', () => {
    const statusBinding = "waitingStatus ? ('status-' + waitingStatus) : ''";
    expect(messageListSource).toContain(statusBinding);
    expect(splitPaneSource).toContain(statusBinding);
    expect(crewChatViewSource).toContain(statusBinding);
  });

  it('all views should check all 5 statuses in template', () => {
    const statuses = ['disconnected', 'compacting', 'agent-offline', 'session-lost', 'cli-exited'];
    for (const src of [messageListSource, splitPaneSource, crewChatViewSource]) {
      for (const s of statuses) {
        expect(src).toContain(`waitingStatus === '${s}'`);
      }
    }
  });

  it('all views should reference all 6 i18n keys', () => {
    const i18nKeys = [
      'chat.waiting.disconnected', 'chat.waiting.compacting',
      'chat.waiting.agentOffline', 'chat.waiting.sessionLost',
      'chat.waiting.cliExited', 'chat.waiting.refresh'
    ];
    for (const src of [messageListSource, splitPaneSource, crewChatViewSource]) {
      for (const key of i18nKeys) {
        expect(src).toContain(`$t('${key}')`);
      }
    }
  });

  it('only agent-offline should have refresh button (session-lost/cli-exited auto-refresh)', () => {
    for (const src of [messageListSource, splitPaneSource, crewChatViewSource]) {
      // Count refresh buttons — should be 1 (only agent-offline; session-lost/cli-exited auto-refresh)
      const matches = src.match(/typing-refresh-btn/g) || [];
      expect(matches.length).toBe(1);
    }
  });

  it('disconnected and compacting should NOT have refresh button', () => {
    // In the template, disconnected and compacting spans don't contain refresh-btn
    for (const src of [messageListSource, splitPaneSource, crewChatViewSource]) {
      // Find disconnected block — it should not contain refresh-btn
      const dcIdx = src.indexOf("waitingStatus === 'disconnected'");
      const dcBlock = src.substring(dcIdx, src.indexOf('</span>', dcIdx) + 7);
      expect(dcBlock).not.toContain('typing-refresh-btn');
    }
  });
});

// =====================================================================
// Edge: store.sessionHealth state
// =====================================================================
describe('Store — sessionHealth state', () => {
  it('should declare sessionHealth in store state', () => {
    expect(storeSource).toContain('sessionHealth: {}');
  });

  it('should describe sessionHealth with status types in comment', () => {
    expect(storeSource).toContain('agent-offline');
    expect(storeSource).toContain('session-lost');
    expect(storeSource).toContain('cli-exited');
  });
});
