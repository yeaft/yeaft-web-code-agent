/**
 * Conversation lifecycle handlers: created, resumed, selected, deleted, etc.
 */

import { isRecentlyClosed, stopProcessingWatchdog } from '../watchdog.js';
import {
  clearYeaftConversationPromotion,
  migrateYeaftConversationState,
  pendingYeaftConversationPromotion,
  retargetYeaftConversationPromotion,
} from '../yeaft-conversation-state.js';
import { isRetiredYeaftConversation } from '../yeaft-conversation-generation.js';
import { clearSessionLoading } from '../session.js';
import { sameUserMessage } from '../dedup.js';
import { ensureMessageUiKeys, maxDbMessageId } from '../messages.js';
import { t } from '../../../utils/i18n.js';
import { recordPerfTrace, measureNextPaint } from '../perfTrace.js';
import { activeYeaftHistoryIdentity } from '../yeaft-history-load.js';
import {
  yeaftHistoryIdentityKey,
  yeaftOptimisticMessageIdentity,
  yeaftPersistedMessageIdentity,
} from '../yeaft-history-identity.js';
import {
  isDurableYeaftHistoryRow,
  pruneYeaftHistoryCache,
} from '../yeaft-history-cache.js';
import { commitYeaftHistoryPage } from '../yeaft-history-pagination.js';
import { conversationRepositoryFor } from '../conversation-repository.js';

/** Filter out empty user messages — tool_result artifacts stored as empty user records in DB */
function filterEmptyUserMessages(messages) {
  return messages.filter(m => !(m.type === 'user' && (!m.content || !m.content.trim())));
}

function parsePersistedHistorySeq(messageId) {
  const match = typeof messageId === 'string' ? messageId.match(/^m(\d+)$/) : null;
  const seq = match ? Number(match[1]) : null;
  return Number.isFinite(seq) ? seq : null;
}

function normalizeHistoryTimestamp(m) {
  const candidates = [m?.timestamp, m?.createdAt, m?.ts, m?.time, m?.created_at];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
  }
  return null;
}

function latestTodoSnapshot(toolCalls) {
  if (!Array.isArray(toolCalls)) return null;
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const call = toolCalls[index];
    if (call?.name === 'TodoWrite' && Array.isArray(call?.input?.todos)) return call.input.todos;
  }
  return null;
}

function resolveGroupDefaultVpId(groupId) {
  if (!groupId || typeof window === 'undefined') return null;
  try {
    const pinia = window.Pinia || null;
    const sessionsStore = pinia && typeof pinia.useSessionsStore === 'function'
      ? pinia.useSessionsStore()
      : null;
    if (!sessionsStore) return null;
    const chatStore = typeof pinia.useChatStore === 'function' ? pinia.useChatStore() : null;
    const group = typeof sessionsStore.sessionById === 'function'
      ? sessionsStore.sessionById(groupId, chatStore?.currentAgent || null)
      : (sessionsStore.sessions && sessionsStore.sessions[groupId]);
    const vpId = group && typeof group.defaultVpId === 'string'
      ? group.defaultVpId.trim()
      : '';
    return vpId || null;
  } catch {
    return null;
  }
}

function resolveHistorySpeakerVpId(m, groupId) {
  return m.speakerVpId || m.vpId || m.vp_id || m.authorVpId || m.authorVP || resolveGroupDefaultVpId(groupId);
}

function stableHistoryRowId(row) {
  return row?.stableKey || (row && (row.messageId || row.id) ? (row.messageId || row.id) : null);
}

function normalizeHistoryRowIdentity(row, agentId = null) {
  if (!row || row.stableKey) return row;
  const sessionId = rowSessionId(row);
  const messageId = row.messageId || row.id || null;
  const clientMessageId = row.type === 'user' ? row.clientMessageId || null : null;
  row.stableKey = clientMessageId && messageId === clientMessageId
    ? yeaftOptimisticMessageIdentity(agentId, sessionId, clientMessageId)
    : yeaftPersistedMessageIdentity(agentId, sessionId, messageId);
  if (!Number.isFinite(row.seq)) row.seq = parsePersistedHistorySeq(messageId);
  if (!row.uiKey) row.uiKey = row.stableKey || null;
  return row;
}

function rowSessionId(row) {
  return row ? (row.sessionId ?? row.groupId ?? null) : null;
}

function isOptimisticYeaftUserRow(row) {
  if (!row || row.type !== 'user' || !row.clientMessageId) return false;
  const id = row.messageId || row.id || null;
  // sendYeaftSessionMessage creates the local row with id/messageId equal to
  // clientMessageId. Once persisted history echoes it back, id/messageId become
  // the durable message id while clientMessageId remains only a dedup key.
  return id === row.clientMessageId;
}

function replaceYeaftRecentHistoryRows(repository, conversationId, incomingRows, sessionId) {
  const existingRows = repository.rows(conversationId);
  const hasVisibleCachedRows = existingRows.some(row => (
    row && (sessionId == null || rowSessionId(row) === sessionId)
  ));
  // An empty projection is not a deletion signal. Keep the committed window.
  if (incomingRows.length === 0 && hasVisibleCachedRows) {
    return { insertedRows: 0, preservedEmpty: true };
  }

  // A recent replay is only a bounded tail snapshot. Durable rows outside that
  // snapshot are immutable and may have come from explicit older pagination or
  // the browser cache, so keep them. Non-durable stale bootstrap rows can still
  // be discarded; live/optimistic rows remain until persistence catches up.
  const newestIncomingTs = incomingRows.reduce((max, row) => Math.max(max, row?.timestamp || 0), 0);
  const preserved = existingRows.filter((row) => {
    if (!row) return false;
    if (sessionId != null && rowSessionId(row) !== sessionId) return true;
    if (isDurableYeaftHistoryRow(row)) return true;
    if (row.isStreaming) return true;
    if (row.type === 'tool-use' && row.toolName === 'AskUserQuestion'
        && (row.askAnswered || row.askPending || row.askExpired)) return true;
    if (isOptimisticYeaftUserRow(row)) return true;
    return newestIncomingTs > 0 && (row.timestamp || 0) > newestIncomingTs;
  });
  repository.replaceProjection(conversationId, preserved);
  const result = repository.commitDurable({
    conversationId,
    sessionId,
    rows: incomingRows,
    mode: 'recent',
    preserveEmpty: false,
  });
  return { insertedRows: result.insertedRows, preservedEmpty: false };
}
function isInternalControlHistoryContent(content) {
  if (typeof content !== 'string') return false;
  const text = content.trimStart();
  return text.startsWith('<task-result ')
    || /^\[system note\] You have called \S+ with the same arguments \d+ times\./.test(text);
}

function visibleLocalYeaftConversationId(store, agentId) {
  const conversationId = typeof store.yeaftConversationId === 'string'
    ? store.yeaftConversationId
    : '';
  if (conversationId.startsWith(`yeaft-local-${agentId}-`)) return conversationId;
  // Legacy single-Agent placeholders predate the embedded Agent id.
  if (/^yeaft-local-\d/.test(conversationId)) return conversationId;
  return null;
}

function promoteVisibleYeaftHistoryConversation(store, msg, sessionId, conversationId) {
  const agentId = msg.agentId || (sessionId && store.yeaftSessionAgentById?.[sessionId]) || null;
  if (!agentId || !conversationId || store.currentView !== 'yeaft') return;

  const activeIdentity = activeYeaftHistoryIdentity(store);
  if (activeIdentity.sessionId !== (sessionId || null)) return;
  if (activeIdentity.agentId && activeIdentity.agentId !== agentId) return;

  const visibleConversationId = store.yeaftConversationId || null;
  if (isRetiredYeaftConversation(store, agentId, conversationId)) {
    const currentConversationId = store.yeaftConversationIdsByAgent?.[agentId] || null;
    if (currentConversationId && currentConversationId !== conversationId) {
      migrateYeaftConversationState(store, conversationId, currentConversationId, {
        removeSource: conversationId !== store.yeaftConversationId,
      });
    }
    return;
  }
  const pendingForAgent = pendingYeaftConversationPromotion(store, agentId);
  if (pendingForAgent && pendingForAgent.targetConversationId !== conversationId) {
    retargetYeaftConversationPromotion(store, agentId, conversationId);
  }
  const pendingPromotion = pendingYeaftConversationPromotion(store, agentId, conversationId);
  if (pendingPromotion) {
    migrateYeaftConversationState(store, pendingPromotion.sourceConversationId, conversationId, {
      removeSource: true,
    });
    clearYeaftConversationPromotion(store, agentId, conversationId);
    store.yeaftConversationId = conversationId;
  }
  if (visibleConversationId === conversationId || pendingPromotion) {
    if (!store.messagesMap[conversationId]) store.messagesMap[conversationId] = [];
    store.yeaftConversationIdsByAgent = {
      ...(store.yeaftConversationIdsByAgent || {}),
      [agentId]: conversationId,
    };
    store.activeConversations = [conversationId];
    return;
  }

  // Only a visible local placeholder for this Agent is a valid migration source.
  // A different real conversation is not safe to replace from a history frame,
  // and its per-Agent map entry must remain intact so late session_ready metadata
  // can migrate old bridge state after an Agent restart changes conversationId.
  const localConversationId = visibleLocalYeaftConversationId(store, agentId);
  if (!localConversationId) return;

  migrateYeaftConversationState(store, localConversationId, conversationId, {
    removeSource: true,
  });
  store.yeaftConversationIdsByAgent = {
    ...(store.yeaftConversationIdsByAgent || {}),
    [agentId]: conversationId,
  };
  store.yeaftConversationId = conversationId;
  store.activeConversations = [conversationId];
}

/** Complete pending tools, optionally scoped to one native Session turn. */
export function markAllToolsCompleted(store, convId, scope = null) {
  const msgs = store.messagesMap[convId] || [];
  for (const msg of msgs) {
    // Native Sessions share one Agent conversation; another turn's terminal
    // frame has no authority to expire this turn's waiting AskUser request.
    if (scope && Object.entries(scope).some(([field, value]) => value && msg[field] !== value)) continue;
    if (msg.type === 'tool-use' && !msg.hasResult) {
      msg.hasResult = true;
      // Expire unanswered AskUserQuestion cards so they show expired state
      if (msg.toolName === 'AskUserQuestion' && !msg.askAnswered && !msg.selectedAnswers) {
        msg.isHistory = true;
        msg.askExpired = true;
        msg.askPending = false;
        msg.pendingAnswers = null;
        msg.askSubmittedAt = null;
        msg.askError = null;
        msg.askRequestId = null;
      }
    }
  }
}

export function handleConversationCreated(store, msg) {
  clearSessionLoading(store);
  const createdAgent = store.agents.find(a => a.id === msg.agentId);
  store.conversations = store.conversations.filter(c => c.id !== msg.conversationId);
  // Non-Claude providers (e.g. Copilot) boot their backend session in the
  // background — the agent emits conversation_created immediately, then a
  // system_init envelope once the ACP handshake finishes. Mark the row as
  // connecting until then so the UI shows progress instead of looking idle.
  const createdProvider = msg.provider || 'claude-code';
  store.conversations.push({
    id: msg.conversationId,
    agentId: msg.agentId,
    agentName: createdAgent?.name || msg.agentId,
    workDir: msg.workDir,
    claudeSessionId: null,
    createdAt: Date.now(),
    processing: false,
    connecting: createdProvider !== 'claude-code',
    type: 'chat',
    provider: createdProvider,
    capabilities: msg.capabilities || null,
    disallowedTools: msg.disallowedTools ?? null
  });
  store.currentAgent = msg.agentId;
  store.currentAgentInfo = createdAgent;
  // In split mode, assign new conversation to the requesting pane (via _pendingPaneId)
  // or fall back to first empty pane. Never overwrite activeConversations wholesale.
  if (store.panels.length > 1) {
    const pendingPaneId = store._pendingPaneId;
    store._pendingPaneId = null;
    if (pendingPaneId) {
      const targetPane = store.panels.find(p => p.id === pendingPaneId);
      if (targetPane) targetPane.conversationId = msg.conversationId;
    } else {
      const emptyPane = store.panels.find(p => !p.conversationId);
      if (emptyPane) emptyPane.conversationId = msg.conversationId;
    }
    if (!store.activeConversations.includes(msg.conversationId)) {
      store.activeConversations.push(msg.conversationId);
    }
  } else {
    store.activeConversations = [msg.conversationId];
  }
  store.currentWorkDir = msg.workDir;
  store.messagesMap[msg.conversationId] = [];
  store.sendWsMessage({
    type: 'select_conversation',
    conversationId: msg.conversationId
  });
  store.addMessage({
    type: 'system',
    content: t('store.convCreated', { agent: createdAgent?.name || msg.agentId, workDir: msg.workDir })
  });
  store.saveOpenSessions();
}

export function handleConversationResumed(store, msg) {
  clearSessionLoading(store);
  const resumedAgent = store.agents.find(a => a.id === msg.agentId);
  store.conversations = store.conversations.filter(c =>
    c.id !== msg.conversationId &&
    !(c.claudeSessionId && c.claudeSessionId === msg.claudeSessionId &&
      c.agentId === msg.agentId &&
      (c.provider || 'claude-code') === (msg.provider || 'claude-code'))
  );
  store.conversations.push({
    id: msg.conversationId,
    agentId: msg.agentId,
    agentName: resumedAgent?.name || msg.agentId,
    workDir: msg.workDir,
    claudeSessionId: msg.claudeSessionId,
    createdAt: Date.now(),
    processing: false,
    connecting: (msg.provider || 'claude-code') !== 'claude-code',
    type: 'chat',
    provider: msg.provider || 'claude-code',
    capabilities: msg.capabilities || null,
    disallowedTools: msg.disallowedTools ?? null
  });
  store.currentAgent = msg.agentId;
  store.currentAgentInfo = resumedAgent;
  // In split mode, assign resumed conversation to the requesting pane (via _pendingPaneId)
  // or fall back to first empty pane.
  if (store.panels.length > 1) {
    const pendingPaneId = store._pendingPaneId;
    store._pendingPaneId = null;
    if (pendingPaneId) {
      const targetPane = store.panels.find(p => p.id === pendingPaneId);
      if (targetPane) targetPane.conversationId = msg.conversationId;
    } else {
      const emptyPane = store.panels.find(p => !p.conversationId);
      if (emptyPane) emptyPane.conversationId = msg.conversationId;
    }
    if (!store.activeConversations.includes(msg.conversationId)) {
      store.activeConversations.push(msg.conversationId);
    }
  } else {
    store.activeConversations = [msg.conversationId];
  }
  store.currentWorkDir = msg.workDir;
  store.messagesMap[msg.conversationId] = [];
  if (store._pendingSessionTitle) {
    store.conversationTitles[msg.conversationId] = store._pendingSessionTitle;
    store._pendingSessionTitle = null;
  }
  store.sendWsMessage({
    type: 'select_conversation',
    conversationId: msg.conversationId
  });
  store.addMessage({
    type: 'system',
    content: t('store.convResumed', { agent: resumedAgent?.name || msg.agentId, sessionId: msg.claudeSessionId ? msg.claudeSessionId.slice(0, 8) + '...' : '' })
  });
  console.log('dbMessages received:', msg.dbMessages?.length || 0, 'dbMessageCount:', msg.dbMessageCount || 0);
  if (msg.dbMessages && msg.dbMessages.length > 0) {
    const formatted = filterEmptyUserMessages(
      msg.dbMessages.map(m => store.formatDbMessage(m)).flat().filter(Boolean)
    );
    const msgs = store.messagesMap[msg.conversationId] || [];
    for (const m of formatted) {
      msgs.push(m);
    }
  }
  store.hasMoreMessages = !!msg.hasMoreMessages;
  // perf-chat-session-switch-cache: stamp chatSessionState on cold-open so
  // a switch-away → switch-back re-enters via the cache path with the
  // correct lastSeenDbId and the preserved hasMoreOlder flag. Without this,
  // the very first cache-hit after a conversation_resumed loses Load-Older.
  store.chatSessionState[msg.conversationId] = {
    lastSeenDbId: maxDbMessageId(store.messagesMap[msg.conversationId]),
    hasMoreOlder: !!msg.hasMoreMessages,
  };
  store.saveOpenSessions();
}

export function handleConversationDeleted(store, msg) {
  store.conversations = store.conversations.filter(c => c.id !== msg.conversationId);
  delete store.messagesMap[msg.conversationId];
  // perf-chat-session-switch-cache: mirror messagesMap cleanup — see
  // closeSession in conversation.js for the same reason (stale state
  // poisons a same-id rebirth).
  delete store.chatSessionState[msg.conversationId];
  delete store.conversationTitles[msg.conversationId];
  delete store.customConversationTitles[msg.conversationId];
  delete store.processingConversations[msg.conversationId];
  if (store._closedAt) delete store._closedAt[msg.conversationId];
  stopProcessingWatchdog(store, msg.conversationId);
  delete store.executionStatusMap[msg.conversationId];
  // 清理 subagent 数据
  delete store.subagents[msg.conversationId];
  window.dispatchEvent(new CustomEvent('conversation-deleted', { detail: { conversationId: msg.conversationId } }));
  // Remove from activeConversations if present
  const delIdx = store.activeConversations.indexOf(msg.conversationId);
  if (delIdx >= 0) {
    store.activeConversations.splice(delIdx, 1);
    if (store.activeConversations.length === 0) {
      store.addMessage({
        type: 'system',
        content: t('chat.session.closed')
      });
    }
  }
  // Clear from split panels if present
  for (const pane of store.panels) {
    if (pane.conversationId === msg.conversationId) {
      pane.conversationId = null;
    }
  }
  store.saveOpenSessions();
}

export function handleTurnCompleted(store, msg) {
  const convId = msg.conversationId;
  if (convId) {
    delete store.processingConversations[convId];
    stopProcessingWatchdog(store, convId);
    if (!store._closedAt) store._closedAt = {};
    store._closedAt[convId] = Date.now();
    // ★ Persistent guard: prevent agent_list from re-setting processing until next sendMessage
    if (!store._turnCompletedConvs) store._turnCompletedConvs = new Set();
    store._turnCompletedConvs.add(convId);
    const status = store.executionStatusMap[convId];
    if (status) {
      status.currentTool = null;
    }
    store.finishStreamingForConversation(convId);
    markAllToolsCompleted(store, convId);
    const conv = store.conversations.find(c => c.id === convId);
    if (conv) {
      if (msg.claudeSessionId) conv.claudeSessionId = msg.claudeSessionId;
      if (msg.workDir) conv.workDir = msg.workDir;
    }
    // Detect /clear completion: if clearStatus is 'clearing' for this conversation
    if (store.clearStatus?.conversationId === convId && store.clearStatus?.status === 'clearing') {
      store.clearStatus = { conversationId: convId, status: 'completed' };
      setTimeout(() => {
        if (store.clearStatus?.conversationId === convId && store.clearStatus?.status === 'completed') {
          store.clearStatus = null;
        }
      }, 3000);
    }
    store.saveOpenSessions();
  }
}

export function handleConversationClosed(store, msg) {
  const convId = msg.conversationId;
  if (convId) {
    delete store.processingConversations[convId];
    stopProcessingWatchdog(store, convId);
    if (!store._closedAt) store._closedAt = {};
    store._closedAt[convId] = Date.now();
    if (!store._turnCompletedConvs) store._turnCompletedConvs = new Set();
    store._turnCompletedConvs.add(convId);
    const status = store.executionStatusMap[convId];
    if (status) {
      status.currentTool = null;
    }
    store.finishStreamingForConversation(convId);
    markAllToolsCompleted(store, convId);
    const conv = store.conversations.find(c => c.id === convId);
    if (conv) {
      if (msg.claudeSessionId) conv.claudeSessionId = msg.claudeSessionId;
      if (msg.workDir) conv.workDir = msg.workDir;
    }
    store.saveOpenSessions();
  }
}

export function handleConversationRefresh(store, msg) {
  if (msg.conversationId) {
    if (msg.isProcessing && !isRecentlyClosed(store, msg.conversationId)
        && !store._turnCompletedConvs?.has(msg.conversationId)) {
      store.processingConversations[msg.conversationId] = true;
    } else if (store.processingConversations[msg.conversationId]) {
      delete store.processingConversations[msg.conversationId];
      stopProcessingWatchdog(store, msg.conversationId);
      const status = store.executionStatusMap[msg.conversationId];
      if (status) status.currentTool = null;
      store.finishStreamingForConversation(msg.conversationId);
    }
  }
}

export function handleExecutionCancelled(store, msg) {
  const convId = msg.conversationId || store.currentConversation;
  if (convId) {
    delete store.processingConversations[convId];
    stopProcessingWatchdog(store, convId);
    if (!store._closedAt) store._closedAt = {};
    store._closedAt[convId] = Date.now();
    if (!store._turnCompletedConvs) store._turnCompletedConvs = new Set();
    store._turnCompletedConvs.add(convId);
    const status = store.executionStatusMap[convId];
    if (status) {
      status.currentTool = null;
    }
    store.finishStreamingForConversation(convId);
    markAllToolsCompleted(store, convId);
  }
}

export function handleSyncMessagesResult(store, msg) {
  const scopedResponse = !!msg.requestId;
  if (scopedResponse) {
    store.chatHistoryRequestIdSupported = true;
    if (!store.isCurrentChatHistoryResponse?.(msg)) return false;
  } else {
    const catalogKey = `chat:${msg.conversationId}`;
    const pending = store.chatHistoryRequests?.[catalogKey];
    if (store.chatHistoryRequestIdSupported === true || !pending?.loading) return false;
    msg = {
      ...msg,
      requestId: pending.requestId,
      catalogKey,
      mode: pending.mode || msg.mode,
      ...(pending.mode === 'delta' ? { afterMessageId: pending.cursor } : {}),
    };
  }

  if (!store.messagesMap[msg.conversationId]) {
    store.messagesMap[msg.conversationId] = [];
  }
  const msgs = store.messagesMap[msg.conversationId];
  // perf-chat-session-switch-cache: tell the cold-load and the delta
  // paths apart so we don't lie about hasMoreOlder.
  //
  // The server's `msg.hasMore` is computed via getBeforeId(oldestId, 1).
  // For a cold-load (turns / no anchor), `oldestId` is the oldest row of
  // the page returned → hasMore correctly means "older rows exist."
  // For a delta (afterMessageId), `oldestId` is the row just after our
  // cursor → hasMore answers "is anything older than (cursor+1)" which
  // is essentially constant-true, OR false on an empty delta — neither
  // of which says anything about the older-history button. So:
  // delta responses MUST NOT overwrite hasMoreOlder. Only cold-load and
  // older-pagination responses get to.
  const isDeltaSync = msg.mode === 'delta' ||
    typeof msg.afterMessageId === 'number' && msg.afterMessageId > 0;
  if (msg.conversationId && store.activeConversations.includes(msg.conversationId)) {
    const formatted = filterEmptyUserMessages(
      (msg.messages || []).map(m => store.formatDbMessage(m)).flat().filter(Boolean)
    );

    if (formatted.length > 0) {
      const firstDbMsg = msgs.find(m => m.dbMessageId);
      if (firstDbMsg &&
          formatted[0].dbMessageId &&
          formatted[formatted.length - 1].dbMessageId < firstDbMsg.dbMessageId) {
        const insertIdx = msgs.indexOf(firstDbMsg);
        if (store.debug) console.log(`[Sync] Prepending ${formatted.length} older messages at index ${insertIdx}`);
        msgs.splice(insertIdx, 0, ...formatted);
      } else {
        if (store.debug) console.log(`[Sync] Received ${formatted.length} messages`);
        for (const m of formatted) {
          if (m.dbMessageId && msgs.some(existing => existing.dbMessageId === m.dbMessageId)) {
            continue;
          }
          // task-712: Mid-turn refresh race. If the user clicked refresh while
          // a turn was streaming AND the turn completed (isStreaming flipped
          // to false) BEFORE sync_messages_result returned, the in-memory
          // assistant partial is now an orphan with no dbMessageId. The
          // incoming DB row carries the same type+content but a fresh
          // dbMessageId, so the dedup gate above misses it. Reconcile by
          // stamping the dbMessageId onto the finalized orphan instead of
          // appending a duplicate. We only collapse FINALIZED orphans —
          // an actively streaming partial (isStreaming: true) is left
          // alone so its content can keep growing.
          //
          // fix-usermsg-dup / Review I2 (Fowler): the user-row identity
          // rule lives in `sameUserMessage` (web/stores/helpers/dedup.js)
          // — id-equality when both sides have a `clientMessageId`,
          // content-equality only when neither side has one. The same
          // helper backs the live-echo dedup in assistantOutput.js so the
          // two gates can't drift apart. Assistant rows never carry
          // `clientMessageId`, so they keep the historical type+content
          // match path inline.
          if (m.dbMessageId && (m.type === 'assistant' || m.type === 'user')) {
            let orphan = null;
            if (m.type === 'user') {
              orphan = msgs.find(existing =>
                !existing.dbMessageId &&
                !existing.isStreaming &&
                sameUserMessage(existing, m)
              );
            } else {
              orphan = msgs.find(existing =>
                !existing.dbMessageId &&
                !existing.isStreaming &&
                existing.type === 'assistant' &&
                existing.content === m.content
              );
            }
            if (orphan) {
              orphan.dbMessageId = m.dbMessageId;
              orphan.id = m.id;
              if (m.timestamp) orphan.timestamp = m.timestamp;
              if (m.clientMessageId && !orphan.clientMessageId) orphan.clientMessageId = m.clientMessageId;
              continue;
            }
          }
          msgs.push(m);
        }
      }
    }

    // Global mirror — same delta-safety rule as the per-conv field below.
    // Delta syncs preserve the prior value; cold/older replies overwrite.
    if (!isDeltaSync) {
      store.hasMoreMessages = msg.hasMore ?? false;
    }
    clearSessionLoading(store);

    // perf-chat-session-switch-cache: stamp per-conv state ONLY when we
    // actually merged this response (i.e. the conv is still active).
    // Stamping outside the guard would record a `lastSeenDbId` consistent
    // with a discarded merge — fine today (the field is re-derived from
    // messagesMap on read), but a trap for any future consumer.
    const priorHasMoreOlder = store.chatSessionState[msg.conversationId]?.hasMoreOlder;
    store.chatSessionState[msg.conversationId] = {
      lastSeenDbId: maxDbMessageId(store.messagesMap[msg.conversationId]),
      // Delta responses: keep whatever pagination state the cold-load /
      // older-pagination path established. First-ever sync on a brand-new
      // conv: fall back to false.
      hasMoreOlder: isDeltaSync ? !!priorHasMoreOlder : !!msg.hasMore,
    };
  }
  if (store.finishChatHistoryRequest?.(msg)) {
    if (store.currentConversation === msg.conversationId) {
      store.loadingMoreMessages = false;
    }
    store.setRefreshingSession(msg.conversationId, false);
  }
  return true;
}

/**
 * Handle a `yeaft_history_chunk` envelope — the batched response to
 * `yeaft_load_history` / `yeaft_load_more_history`. Unlike Chat-mode's
 * `sync_messages_result`, Yeaft history doesn't live in a SQLite DB and
 * isn't keyed by `dbMessageId`; the agent computes the page directly from
 * on-disk markdown. Older chunks prepend, recent bootstrap chunks replace
 * that session's cached rows, and delta chunks append.
 *
 * Always clears `yeaftLoadingMoreHistory` — even on an empty / error
 * chunk — so the spinner doesn't get stuck. Non-empty recent and older pages
 * update pagination from the server; an empty recent refresh preserves an
 * already committed window because this wire does not represent deletion.
 */
export function handleYeaftHistoryWindow(store, msg) {
  const sessionId = msg.sessionId ?? null;
  const sessionAgentId = msg.agentId || (sessionId && store.yeaftSessionAgentById?.[sessionId]) || null;
  const conversationId = msg.conversationId
    || (sessionAgentId && store.yeaftConversationIdsByAgent?.[sessionAgentId])
    || store.yeaftConversationId;
  if (!conversationId || !sessionId || !Array.isArray(msg.messages)) return null;
  if (!store.messagesMap[conversationId]) store.messagesMap[conversationId] = [];

  const sourceMessageIds = new Set(Array.isArray(msg.sourceMessageIds) ? msg.sourceMessageIds : []);
  const residentMessageIds = new Set();
  const randomAccessMessageIds = new Set();
  for (const row of store.messagesMap[conversationId]) {
    if (rowSessionId(row) !== sessionId) continue;
    const persistedId = row?.persistedMessageId || row?.messageId || row?.id || null;
    if (persistedId) residentMessageIds.add(persistedId);
    if (persistedId && (row?._historyWindowPrefetched === true || row?._historyWindowDetached === true)) {
      randomAccessMessageIds.add(persistedId);
    }
    if (!msg.entryId || !sourceMessageIds.has(persistedId)) continue;
    row.historyEntryId = msg.entryId;
    if (Number.isFinite(msg.indexGeneration)) row.historyIndexGeneration = msg.indexGeneration;
  }
  const windowMessages = msg.messages
    .filter(message => (
      msg.prefetch === true
      || !residentMessageIds.has(message?.id)
      || randomAccessMessageIds.has(message?.id)
    ))
    .map(message => (
      msg.entryId && sourceMessageIds.has(message?.id)
        ? {
            ...message,
            historyEntryId: msg.entryId,
            ...(msg.prefetch === true ? { _historyWindowPrefetched: true } : {}),
            ...(Number.isFinite(msg.indexGeneration)
              ? { historyIndexGeneration: msg.indexGeneration }
              : {}),
          }
        : message
    ));
  const { formatted } = formatYeaftHistoryMessages(
    windowMessages,
    sessionId,
    'window',
    store.messagesMap[conversationId],
    sessionAgentId,
  );
  const windowKey = `history-window:${msg.requestId || msg.anchorMessageId || Date.now()}`;
  for (const row of formatted) {
    row._historyWindowKey = windowKey;
    row._historyWindowDetached = msg.prefetch !== true;
    row._historyWindowPrefetched = msg.prefetch === true;
  }
  const repository = conversationRepositoryFor(store);
  const projection = repository.rows(conversationId);
  const responseMessageIds = new Set(msg.messages.map(message => message?.id).filter(Boolean));
  const promoted = [];
  if (msg.prefetch !== true) {
    for (const row of projection) {
      if (rowSessionId(row) !== sessionId) continue;
      const persistedId = row?.persistedMessageId || row?.messageId || row?.id || null;
      if (!responseMessageIds.has(persistedId)) continue;
      // Validation may overlap the ordinary recent tail. Only promote a row
      // that already belongs to a cache-only/detached random-access window;
      // converting a normal recent row would make Latest permanently filter it.
      if (row._historyWindowPrefetched !== true && row._historyWindowDetached !== true) continue;
      row._historyWindowKey = windowKey;
      row._historyWindowDetached = true;
      row._historyWindowPrefetched = false;
      promoted.push(row);
    }
    const retained = projection.filter(row => (
      rowSessionId(row) !== sessionId
      || row._historyWindowDetached !== true
      || row._historyWindowKey === windowKey
    ));
    if (retained.length !== projection.length) repository.replaceProjection(conversationId, retained);
  }
  repository.commitDurable({
    conversationId,
    sessionId,
    rows: formatted,
    mode: 'window',
  });
  const incomingWindowRows = formatted.length > 0 ? formatted : promoted;
  const activeIdentity = activeYeaftHistoryIdentity(store);
  pruneYeaftHistoryCache(store, {
    conversationId,
    agentId: sessionAgentId,
    sessionId,
    incomingRows: incomingWindowRows,
    activeAgentId: activeIdentity.agentId,
    activeSessionId: activeIdentity.sessionId,
  });
  return conversationId;
}

function askUserHistoryIdentity(row) {
  if (!row?.toolId) return null;
  return [
    rowSessionId(row) ?? '',
    row.vpId || row.speakerVpId || '',
    row.turnId || '',
    row.threadId || 'main',
    row.toolId,
  ].join('\u0000');
}

function applyAskUserHistoryResult(row, result, questions) {
  row.toolName = 'AskUserQuestion';
  row.toolId = result.toolCallId;
  row.toolInput = { questions };
  row.askQuestions = questions;
  row.askRequestId = null;
  row.askPending = false;
  row.pendingAnswers = null;
  row.askSubmitGeneration = null;
  row.askSubmittedAt = null;
  row.askError = null;
  row.hasResult = true;
  row.isHistory = true;
  if (result.status === 'answered') {
    row.askAnswered = true;
    row.selectedAnswers = result.answers;
    row.askExpired = false;
  } else {
    row.askAnswered = false;
    row.selectedAnswers = null;
    row.askExpired = true;
  }
  return row;
}

function existingAskUserRow(existingRows, scope) {
  return (existingRows || []).find(row => row?.type === 'tool-use'
    && (row.toolName === 'AskUser' || row.toolName === 'AskUserQuestion')
    && row.toolId === scope.toolCallId
    && rowSessionId(row) === scope.sessionId
    && (row.vpId || row.speakerVpId || '') === (scope.vpId || '')
    && (row.turnId || '') === (scope.turnId || '')
    && (row.threadId || 'main') === (scope.threadId || 'main')) || null;
}

function formatYeaftHistoryMessages(incomingMessages, msgSessionId, mode, existingRows, agentId = null) {
  const existingIds = new Set((existingRows || [])
    .map(row => stableHistoryRowId(normalizeHistoryRowIdentity(row, agentId)))
    .filter(Boolean));
  const seenIds = new Set();
  const formatted = [];
  let acceptedHistoryMessages = 0;
  for (const m of incomingMessages) {
    if (!m) continue;
    if (m._reflection || m.internal || m.systemOnly || m.systemOnlyMessage) continue;
    if (isInternalControlHistoryContent(m.content)) continue;
    const stableId = m.id || m.messageId || null;
    const clientMessageId = m.clientMessageId || null;
    const rowSessionId = m.sessionId ?? m.groupId ?? msgSessionId ?? null;
    const durableKey = yeaftPersistedMessageIdentity(agentId, rowSessionId, stableId);
    const uiKey = clientMessageId
      ? yeaftOptimisticMessageIdentity(agentId, rowSessionId, clientMessageId)
      : durableKey;
    const historyEntryMeta = m.historyEntryId
      ? {
          historyEntryId: m.historyEntryId,
          ...(Number.isFinite(m.historyIndexGeneration)
            ? { historyIndexGeneration: m.historyIndexGeneration }
            : {}),
        }
      : {};
    if (durableKey && seenIds.has(durableKey)) continue;
    if (durableKey && mode !== 'recent' && existingIds.has(durableKey)) continue;
    if (durableKey) seenIds.add(durableKey);
    if (m.role === 'user') {
      acceptedHistoryMessages += 1;
      const messageId = stableId || m.messageId || m.turnId || null;
      formatted.push({
        ...(stableId ? { id: stableId, messageId: stableId } : {}),
        ...(durableKey ? { stableKey: durableKey } : {}),
        ...(uiKey ? { uiKey } : {}),
        ...historyEntryMeta,
        seq: Number.isFinite(m.seq) ? m.seq : parsePersistedHistorySeq(stableId),
        type: 'user',
        content: m.content,
        timestamp: normalizeHistoryTimestamp(m),
        sessionId: rowSessionId,
        turnId: m.turnId || messageId,
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(Array.isArray(m.attachments) && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
        ...(m.quote ? { quote: m.quote } : {}),
        isStreaming: false,
        isHistory: true,
      });
    } else if (m.role === 'assistant') {
      acceptedHistoryMessages += 1;
      const messageId = stableId || m.messageId || m.turnId || null;
      const speakerVpId = resolveHistorySpeakerVpId(m, rowSessionId);
      const timestamp = normalizeHistoryTimestamp(m);
      const hasPersistedTurnId = !!m.turnId;
      const turnId = m.turnId || messageId;
      const assistantContent = typeof m.content === 'string' ? m.content : (m.content || '');
      const todos = Array.isArray(m.todos) ? m.todos : latestTodoSnapshot(m.toolCalls);
      const executionOriginMeta = m.executionOrigin === 'route_forward'
        ? { executionOrigin: 'route_forward' }
        : {};
      if (typeof assistantContent !== 'string' || assistantContent.trim()) {
        formatted.push({
          ...(stableId ? { id: stableId, messageId: stableId } : {}),
          ...(durableKey ? { stableKey: durableKey } : {}),
          ...(uiKey ? { uiKey } : {}),
          ...historyEntryMeta,
          seq: Number.isFinite(m.seq) ? m.seq : parsePersistedHistorySeq(stableId),
          ...(m.entryId ? { entryId: m.entryId } : {}),
          ...(Array.isArray(m.sourceMessageIds) ? { sourceMessageIds: m.sourceMessageIds } : {}),
          type: 'assistant',
          content: assistantContent,
          timestamp,
          sessionId: rowSessionId,
          turnId,
          _hasPersistedTurnId: hasPersistedTurnId,
          ...executionOriginMeta,
          ...(speakerVpId ? { vpId: speakerVpId, speakerVpId } : {}),
          ...(m.responseKind === 'progress' || m.responseKind === 'result' ? { responseKind: m.responseKind } : {}),
          ...(Number.isInteger(m.llmCallCount) && m.llmCallCount > 0 ? { llmCallCount: m.llmCallCount } : {}),
          ...(Number.isFinite(m.inputTokens) && m.inputTokens >= 0 ? { inputTokens: m.inputTokens } : {}),
          ...(Number.isFinite(m.outputTokens) && m.outputTokens >= 0 ? { outputTokens: m.outputTokens } : {}),
          ...(Number.isFinite(m.totalTokens) && m.totalTokens >= 0 ? { totalTokens: m.totalTokens } : {}),
          ...(Number.isFinite(m.totalMs) && m.totalMs >= 0 ? { totalMs: m.totalMs } : {}),
          ...(typeof m.model === 'string' && m.model ? { model: m.model } : {}),
          ...(typeof m.effort === 'string' && m.effort ? { effort: m.effort } : {}),
          ...(m.incomplete === true ? { incomplete: true } : {}),
          ...(typeof m.stopReason === 'string' && m.stopReason ? { stopReason: m.stopReason } : {}),
          isStreaming: false,
          isHistory: true,
        });
      }
      if (Array.isArray(todos) && todos.length > 0) {
        formatted.push({
          ...(stableId ? { id: `${stableId}:todos`, messageId: `${stableId}:todos` } : {}),
          ...(durableKey ? { stableKey: `${durableKey}:todos` } : {}),
          ...historyEntryMeta,
          seq: Number.isFinite(m.seq) ? m.seq : parsePersistedHistorySeq(stableId),
          type: 'tool-use',
          toolName: 'TodoWrite',
          toolInput: { todos },
          timestamp,
          startTime: timestamp || 0,
          sessionId: rowSessionId,
          turnId,
          ...executionOriginMeta,
          ...(speakerVpId ? { vpId: speakerVpId, speakerVpId } : {}),
          isStreaming: false,
          isHistory: true,
          hasResult: true,
        });
      }
      for (const [index, toolCall] of (Array.isArray(m.toolCalls) ? m.toolCalls : []).entries()) {
        if (!toolCall || toolCall.name === 'TodoWrite') continue;
        const toolIdentity = toolCall.id || `index:${index}`;
        const toolIdentityKey = encodeURIComponent(String(toolIdentity));
        formatted.push({
          ...(stableId ? { id: `${stableId}:tool:${toolIdentityKey}`, messageId: `${stableId}:tool:${toolIdentityKey}`, persistedMessageId: stableId } : {}),
          ...(durableKey ? { stableKey: `${durableKey}:tool:${toolIdentityKey}` } : {}),
          ...historyEntryMeta,
          seq: Number.isFinite(m.seq) ? m.seq : parsePersistedHistorySeq(stableId),
          type: 'tool-use',
          toolId: toolCall.id || null,
          toolName: toolCall.name || 'unknown',
          toolInput: toolCall.input || {},
          timestamp,
          startTime: timestamp || 0,
          sessionId: rowSessionId,
          turnId,
          ...(m.threadId ? { threadId: m.threadId } : {}),
          ...executionOriginMeta,
          ...(speakerVpId ? { vpId: speakerVpId, speakerVpId } : {}),
          isStreaming: false,
          isHistory: true,
          hasResult: true,
        });
      }
      for (const image of Array.isArray(m.images) ? m.images : []) {
        if (!image?.assetId) continue;
        formatted.push({
          id: `${stableId || messageId || turnId}:image:${image.assetId}`,
          messageId: `${stableId || messageId || turnId}:image:${image.assetId}`,
          ...(durableKey ? { stableKey: `${durableKey}:image:${image.assetId}` } : {}),
          ...historyEntryMeta,
          seq: Number.isFinite(m.seq) ? m.seq : parsePersistedHistorySeq(stableId),
          type: 'chat-image', ...image, timestamp, sessionId: rowSessionId, turnId,
          ...executionOriginMeta,
          ...(speakerVpId ? { vpId: speakerVpId, speakerVpId } : {}),
          isStreaming: false, isHistory: true,
        });
      }
      for (const result of Array.isArray(m.askUserResults) ? m.askUserResults : []) {
        if (!result?.toolCallId || (result.status !== 'answered' && result.status !== 'expired')) continue;
        const questions = [{
          question: typeof result.question === 'string' ? result.question : '',
          options: (Array.isArray(result.options) ? result.options : [])
            .filter(label => typeof label === 'string')
            .map(label => ({ label, description: '' })),
          multiSelect: false,
        }];
        const scope = {
          toolCallId: result.toolCallId,
          sessionId: rowSessionId,
          vpId: speakerVpId || '',
          turnId: turnId || '',
          threadId: m.threadId || 'main',
        };
        const existing = existingAskUserRow(existingRows, scope);
        if (existing) {
          Object.assign(existing, historyEntryMeta);
          applyAskUserHistoryResult(existing, result, questions);
          const matchingToolIndex = formatted.findIndex(row => row?.type === 'tool-use'
            && row.toolId === result.toolCallId
            && (row.sessionId ?? row.groupId ?? null) === (existing.sessionId ?? existing.groupId ?? null)
            && (row.turnId || '') === (existing.turnId || ''));
          if (matchingToolIndex >= 0) formatted.splice(matchingToolIndex, 1);
          continue;
        }
        const askRow = applyAskUserHistoryResult({
          id: `${stableId || messageId || turnId}:ask:${result.toolCallId}`,
          messageId: `${stableId || messageId || turnId}:ask:${result.toolCallId}`,
          ...(durableKey ? { stableKey: `${durableKey}:ask:${result.toolCallId}` } : {}),
          ...historyEntryMeta,
          seq: Number.isFinite(m.seq) ? m.seq : parsePersistedHistorySeq(stableId),
          type: 'tool-use',
          timestamp,
          sessionId: rowSessionId,
          turnId,
          threadId: scope.threadId,
          ...executionOriginMeta,
          ...(speakerVpId ? { vpId: speakerVpId, speakerVpId } : {}),
          isStreaming: false,
        }, result, questions);
        const identity = askUserHistoryIdentity(askRow);
        if (!identity || !formatted.some(row => askUserHistoryIdentity(row) === identity)) formatted.push(askRow);
        const matchingToolIndex = formatted.findIndex(row => row !== askRow
          && row?.type === 'tool-use'
          && row.toolId === result.toolCallId
          && (row.sessionId ?? row.groupId ?? null) === (askRow.sessionId ?? askRow.groupId ?? null)
          && (row.turnId || '') === (askRow.turnId || ''));
        if (matchingToolIndex >= 0) formatted.splice(matchingToolIndex, 1);
      }
    }
  }
  return { formatted, acceptedHistoryMessages };
}

export function handleYeaftHistoryChunk(store, msg) {
  const msgSessionId = msg.sessionId != null ? msg.sessionId : msg.groupId;
  const retiredAgentId = msg.agentId || (msgSessionId && store.yeaftSessionAgentById?.[msgSessionId]) || null;
  if (isRetiredYeaftConversation(store, retiredAgentId, msg.conversationId)) {
    const currentConversationId = store.yeaftConversationIdsByAgent?.[retiredAgentId] || null;
    if (!currentConversationId || currentConversationId === msg.conversationId) return;
    migrateYeaftConversationState(store, msg.conversationId, currentConversationId, {
      removeSource: msg.conversationId !== store.yeaftConversationId,
    });
    msg = { ...msg, conversationId: currentConversationId };
  }
  if (msg.requestId && typeof store.isCurrentYeaftHistoryResponse === 'function'
      && !store.isCurrentYeaftHistoryResponse(msg)) return;
  let mode = msg.mode === 'recent' || msg.mode === 'delta' ? msg.mode : 'older';
  const incomingMessages = Array.isArray(msg.messages) ? msg.messages : [];

  const identityAgentId = msg.agentId || (msgSessionId && store.yeaftSessionAgentById?.[msgSessionId]) || null;
  const identityStateKey = yeaftHistoryIdentityKey(identityAgentId, msgSessionId);
  const cachedIdentity = store.yeaftSessionHistoryState?.[identityStateKey] || null;
  const identityMismatch = typeof msg.streamId === 'string'
    && typeof cachedIdentity?.streamId === 'string'
    && (msg.streamId !== cachedIdentity.streamId
      || (Number.isFinite(msg.revision) && Number.isFinite(cachedIdentity.revision)
        && msg.revision !== cachedIdentity.revision));
  if (identityMismatch) {
    // An append cursor is unsafe after clear/recreate, folding, or an older
    // visible-row update. Replace only durable history while keeping optimistic
    // and live rows for the active turn.
    mode = 'recent';
    if (typeof store.clearYeaftHistoryMemory === 'function') {
      store.clearYeaftHistoryMemory({
        agentId: identityAgentId,
        sessionId: msgSessionId,
        preserveLiveRows: true,
        preserveSessionOwner: true,
      });
    }
  }

  if (msg.perfTraceId) {
    recordPerfTrace(store, {
      traceId: msg.perfTraceId,
      phase: 'history.chunk_received',
      agentId: msg.agentId || null,
      sessionId: msgSessionId || null,
      messageType: msg.type,
      bytes: (() => { try { return JSON.stringify(msg).length; } catch { return null; } })(),
      detail: { mode, rawCount: incomingMessages.length },
    });
  }
  const sessionAgentId = msg.agentId || (msgSessionId && store.yeaftSessionAgentById
    ? store.yeaftSessionAgentById[msgSessionId]
    : null);
  const agentConversationId = sessionAgentId && store.yeaftConversationIdsByAgent
    ? store.yeaftConversationIdsByAgent[sessionAgentId]
    : null;
  const convId = msg.conversationId || agentConversationId || store.yeaftConversationId;
  if (!convId) {
    store.yeaftLoadingMoreHistory = false;
    return;
  }
  // Cold history intentionally arrives before session_ready so the browser can
  // paint without waiting for runtime boot. The chunk already carries the real
  // bridge conversation id; promote it for the visible Session now, otherwise
  // MessageList keeps reading the empty local placeholder until metadata lands.
  promoteVisibleYeaftHistoryConversation(store, msg, msgSessionId, convId);
  // The chunk's sessionId is authoritative — it is stamped by the agent
  // from the request sessionId, not inferred from the currently selected row.
  // Accept chunks even when the user has switched to another Session: rows are
  // session-stamped below, and the global spinner/cursor mirrors only the
  // active Session at the end of this handler. Dropping inactive chunks loses
  // active-turn messages when their history/delta replay races a sidebar click.
  if (!store.messagesMap[convId]) store.messagesMap[convId] = [];

  // Same visible projection as handleYeaftLoadHistory's bootstrap replay:
  // only user / assistant text rows. Reflection, internal, and system-only
  // records may be persisted as role=user, but they are not user-authored UI
  // messages and must never be prepended as user bubbles.
  const { formatted, acceptedHistoryMessages } = formatYeaftHistoryMessages(
    incomingMessages,
    msgSessionId,
    mode,
    store.messagesMap[convId],
    sessionAgentId,
  );
  ensureMessageUiKeys(store, convId, formatted);

  const repository = conversationRepositoryFor(store);
  let insertedRows = 0;
  let preservedEmptyRecent = false;
  if (mode === 'recent') {
    const recentResult = replaceYeaftRecentHistoryRows(
      repository,
      convId,
      formatted,
      msgSessionId ?? null,
    );
    insertedRows = recentResult.insertedRows;
    preservedEmptyRecent = recentResult.preservedEmpty;
  } else if (formatted.length > 0) {
    const committed = repository.commitDurable({
      conversationId: convId,
      sessionId: msgSessionId ?? null,
      rows: formatted,
      mode,
    });
    insertedRows = committed.insertedRows;
    if (mode === 'older' && typeof store.expandYeaftMessageWindow === 'function') {
      // These rows were explicitly requested by scrolling upward. Keep the
      // compatibility window state aligned; its default no longer hides rows.
      const windowSessionId = store.yeaftActiveSessionFilter ? (msgSessionId ?? null) : null;
      store.expandYeaftMessageWindow(windowSessionId, msg.turns || 10, sessionAgentId);
    }
  }

  const activeIdentityBeforeCache = activeYeaftHistoryIdentity(store);
  pruneYeaftHistoryCache(store, {
    conversationId: convId,
    agentId: sessionAgentId,
    sessionId: msgSessionId,
    incomingRows: formatted,
    activeAgentId: activeIdentityBeforeCache.agentId,
    activeSessionId: activeIdentityBeforeCache.sessionId,
  });

  const sessionKey = yeaftHistoryIdentityKey(msg.agentId || null, msgSessionId);
  const cacheState = store.yeaftHistoryCacheState?.[sessionKey] || null;
  const prevState = store.yeaftSessionHistoryState?.[sessionKey] || {};
  const preservedFrontier = Number.isFinite(prevState.serverOldestFetchedSeq)
    ? prevState.serverOldestFetchedSeq
    : (Number.isFinite(prevState.oldestSeq) ? prevState.oldestSeq : null);
  const responseFrontier = Number.isFinite(msg.nextBeforeSeq)
    ? msg.nextBeforeSeq
    : (Number.isFinite(msg.oldestSeq)
      ? msg.oldestSeq
      : (preservedEmptyRecent ? preservedFrontier : null));
  const responseHasMore = preservedEmptyRecent
    && !Number.isFinite(msg.nextBeforeSeq)
    && !Number.isFinite(msg.oldestSeq)
    ? (prevState.serverHasMore ?? prevState.hasMore ?? false)
    : msg.hasMore;
  const committedPagination = mode === 'delta'
    ? prevState
    : commitYeaftHistoryPage(prevState, {
        mode,
        oldestSeq: responseFrontier,
        hasMore: responseHasMore,
        ranges: cacheState?.ranges || [],
        pageKind: msg.pageKind,
        stopAtSeq: msg.gapStopAtSeq,
        cacheEpoch: cacheState?.rangeEpoch ?? msg.cacheEpoch ?? 0,
      });
  const nextLatest = (typeof msg.latestSeq === 'number') ? msg.latestSeq : (prevState.latestSeq ?? null);
  const historyIdentity = {
    streamId: typeof msg.streamId === 'string' ? msg.streamId : (prevState.streamId ?? null),
    revision: Number.isFinite(msg.revision) ? msg.revision : (prevState.revision ?? null),
  };
  let nextState = mode === 'delta'
    ? {
        ...prevState,
        ...historyIdentity,
        loaded: true,
        loading: false,
        latestSeq: nextLatest,
        syncingAfterSeq: null,
        count: (prevState.count || 0) + insertedRows,
      }
    : {
        ...committedPagination,
        ...historyIdentity,
        loaded: true,
        loading: false,
        count: cacheState
          ? cacheState.rowCount
          : (mode === 'older'
            ? (prevState.count || 0) + insertedRows
            : (preservedEmptyRecent ? (prevState.count || 0) : acceptedHistoryMessages)),
        latestSeq: preservedEmptyRecent && !Number.isFinite(msg.latestSeq)
          ? (prevState.latestSeq ?? null)
          : nextLatest,
        syncingAfterSeq: null,
      };
  if (msg.requestId && typeof store.finishYeaftHistoryLoad === 'function') {
    store.finishYeaftHistoryLoad(msg, nextState, 'chunk');
  } else if (store.yeaftSessionHistoryState) {
    store.yeaftSessionHistoryState = {
      ...store.yeaftSessionHistoryState,
      [sessionKey]: nextState,
    };
  }
  if (mode === 'delta' && msg.hasMoreAfter === true
      && Number.isFinite(nextState.latestSeq)
      && nextState.latestSeq > Number(msg.afterSeq ?? -1)
      && typeof store.continueYeaftHistoryDelta === 'function') {
    queueMicrotask(() => store.continueYeaftHistoryDelta(
      msgSessionId,
      sessionAgentId,
      nextState.latestSeq,
    ));
  }
  const activeIdentity = activeYeaftHistoryIdentity(store);
  const activeSessionMatches = activeIdentity.sessionId === (msgSessionId || null);
  const activeAgentMatches = !msg.agentId || !activeIdentity.agentId || msg.agentId === activeIdentity.agentId;
  const isActiveHistoryChunk = activeSessionMatches && activeAgentMatches;
  const legacyActiveKey = yeaftHistoryIdentityKey(null, activeIdentity.sessionId);
  if (msg.perfTraceId) {
    recordPerfTrace(store, {
      traceId: msg.perfTraceId,
      phase: 'history.chunk_applied',
      agentId: msg.agentId || null,
      sessionId: msgSessionId || null,
      messageType: msg.type,
      detail: {
        mode,
        formattedCount: formatted.length,
        insertedRows,
        acceptedHistoryMessages,
        preservedEmptyRecent,
      },
    });
    measureNextPaint(store, {
      traceId: msg.perfTraceId,
      phase: 'history.next_paint',
      agentId: msg.agentId || null,
      sessionId: msgSessionId || null,
      messageType: msg.type,
      detail: { mode, insertedRows },
    });
  }
  if (isActiveHistoryChunk) {
    store.yeaftHasMoreHistory = nextState.hasMore;
    store.yeaftOldestLoadedSeq = Number.isFinite(nextState.serverOldestFetchedSeq)
      ? nextState.serverOldestFetchedSeq
      : (Number.isFinite(nextState.oldestSeq)
        ? nextState.oldestSeq
        : store.yeaftOldestLoadedSeq);
    store.yeaftLoadingMoreHistory = false;
  } else if (store.yeaftLoadingMoreHistory) {
    const activeState = store.yeaftSessionHistoryState?.[activeIdentity.sessionKey]
      || store.yeaftSessionHistoryState?.[legacyActiveKey]
      || null;
    store.yeaftLoadingMoreHistory = !!activeState?.loading;
  }
}
