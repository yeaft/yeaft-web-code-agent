/**
 * Conversation lifecycle handlers: created, resumed, selected, deleted, etc.
 */

import { isRecentlyClosed, stopProcessingWatchdog } from '../watchdog.js';
import { clearSessionLoading } from '../session.js';
import { sameUserMessage } from '../dedup.js';
import { maxDbMessageId } from '../messages.js';
import { summarizeHistoricalToolMessages } from '../tool-window.js';
import { t } from '../../../utils/i18n.js';

/** Filter out empty user messages — tool_result artifacts stored as empty user records in DB */
function filterEmptyUserMessages(messages) {
  return messages.filter(m => !(m.type === 'user' && (!m.content || !m.content.trim())));
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

function resolveGroupDefaultVpId(groupId) {
  if (!groupId || typeof window === 'undefined') return null;
  try {
    const pinia = window.Pinia || null;
    const sessionsStore = pinia && typeof pinia.useSessionsStore === 'function'
      ? pinia.useSessionsStore()
      : null;
    if (!sessionsStore) return null;
    const group = typeof sessionsStore.sessionById === 'function'
      ? sessionsStore.sessionById(groupId)
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
  return row && (row.messageId || row.id) ? (row.messageId || row.id) : null;
}

function sortYeaftRowsByTimestamp(rows) {
  rows.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function sameAssistantHistoryRow(existing, incoming) {
  if (!existing || !incoming) return false;
  if (existing.type !== 'assistant' || incoming.type !== 'assistant') return false;
  if ((existing.sessionId ?? null) !== (incoming.sessionId ?? null)) return false;

  const existingSpeaker = existing.speakerVpId || existing.vpId || '';
  const incomingSpeaker = incoming.speakerVpId || incoming.vpId || '';
  if (existingSpeaker && incomingSpeaker && existingSpeaker !== incomingSpeaker) return false;

  const existingThread = existing.threadId || '';
  const incomingThread = incoming.threadId || '';
  if (existingThread && incomingThread && existingThread !== incomingThread) return false;

  const canMergeLiveLocalRow = existing.isStreaming || existing.isHistory !== true;
  if (!canMergeLiveLocalRow) return false;
  if (incoming._hasPersistedTurnId !== true) return false;

  const existingTurnId = existing.turnId || '';
  const incomingTurnId = incoming.turnId || '';
  if (!existingTurnId || !incomingTurnId || existingTurnId !== incomingTurnId) return false;

  const existingText = typeof existing.content === 'string' ? existing.content : '';
  const incomingText = typeof incoming.content === 'string' ? incoming.content : '';
  return !!existingText && !!incomingText && (incomingText.startsWith(existingText) || existingText.startsWith(incomingText));
}

function upsertYeaftHistoryRows(existingRows, incomingRows) {
  const indexById = new Map();
  const userIndexByClientId = new Map();
  existingRows.forEach((row, index) => {
    const id = stableHistoryRowId(row);
    if (id) indexById.set(id, index);
    if (row?.type === 'user' && row.clientMessageId) userIndexByClientId.set(row.clientMessageId, index);
  });

  let inserted = 0;
  for (const row of incomingRows) {
    const id = stableHistoryRowId(row);
    let index = id && indexById.has(id) ? indexById.get(id) : null;
    if (index === null && row?.type === 'user' && row.clientMessageId && userIndexByClientId.has(row.clientMessageId)) {
      index = userIndexByClientId.get(row.clientMessageId);
    }
    if (index === null && row?.type === 'assistant') {
      index = existingRows.findIndex(existing => sameAssistantHistoryRow(existing, row));
    }
    if (index !== null && index >= 0) {
      const existingId = stableHistoryRowId(existingRows[index]);
      existingRows[index] = { ...existingRows[index], ...row };
      if (id) indexById.set(id, index);
      if (existingId && existingId !== id && indexById.get(existingId) === index) indexById.delete(existingId);
      if (row?.type === 'user' && row.clientMessageId) userIndexByClientId.set(row.clientMessageId, index);
    } else {
      if (id) indexById.set(id, existingRows.length);
      if (row?.type === 'user' && row.clientMessageId) userIndexByClientId.set(row.clientMessageId, existingRows.length);
      existingRows.push(row);
      inserted += 1;
    }
  }
  sortYeaftRowsByTimestamp(existingRows);
  return inserted;
}

function rowSessionId(row) {
  return row ? (row.sessionId ?? row.groupId ?? null) : null;
}

function replaceYeaftRecentHistoryRows(existingRows, incomingRows, sessionId) {
  const newestIncomingTs = incomingRows.reduce((max, row) => Math.max(max, row?.timestamp || 0), 0);
  const preserved = existingRows.filter((row) => {
    if (!row) return false;
    if (sessionId != null && rowSessionId(row) !== sessionId) return true;
    if (row.isStreaming) return true;
    // A manual refresh can race a just-sent local row that is newer than the
    // persisted recent window. Keep that live tail; the next delta/recent load
    // will merge it by stable id once the agent has flushed it to disk.
    return newestIncomingTs > 0 && (row.timestamp || 0) > newestIncomingTs;
  });
  existingRows.splice(0, existingRows.length, ...preserved);
  upsertYeaftHistoryRows(existingRows, incomingRows);
  return incomingRows.length;
}

function isInternalControlHistoryContent(content) {
  if (typeof content !== 'string') return false;
  const text = content.trimStart();
  return text.startsWith('<task-result ')
    || /^\[system note\] You have called \S+ with the same arguments \d+ times\./.test(text);
}

/** Mark all pending tool-use messages as completed for a conversation */
export function markAllToolsCompleted(store, convId) {
  const msgs = store.messagesMap[convId] || [];
  for (const msg of msgs) {
    if (msg.type === 'tool-use' && !msg.hasResult) {
      msg.hasResult = true;
      // Expire unanswered AskUserQuestion cards so they show expired state
      if (msg.toolName === 'AskUserQuestion' && !msg.askAnswered && !msg.selectedAnswers) {
        msg.isHistory = true;
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
    !(c.claudeSessionId && c.claudeSessionId === msg.claudeSessionId)
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
      msg.dbMessages.map(m => store.formatDbMessageForHistoryHydration(m)).flat().filter(Boolean)
    );
    const summarized = summarizeHistoricalToolMessages(formatted);
    const msgs = store.messagesMap[msg.conversationId] || [];
    for (const m of summarized) {
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
  // 清理 crew 数据
  delete store.crewSessions?.[msg.conversationId];
  delete store.crewMessagesMap?.[msg.conversationId];
  delete store.crewOlderMessages?.[msg.conversationId];
  delete store.crewStatuses?.[msg.conversationId];
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
  // Clear from splitPanes if present
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
  const isDeltaSync =
    typeof msg.afterMessageId === 'number' && msg.afterMessageId > 0;
  if (msg.conversationId && store.activeConversations.includes(msg.conversationId)) {
    const formatted = summarizeHistoricalToolMessages(filterEmptyUserMessages(
      (msg.messages || []).map(m => store.formatDbMessageForHistoryHydration(m)).flat().filter(Boolean)
    ));

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
  store.loadingMoreMessages = false;
  store.setRefreshingSession(msg.conversationId, false);
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
 * chunk — so the spinner doesn't get stuck. Always overwrites
 * `yeaftHasMoreHistory` from the server's authoritative value.
 */
export function handleYeaftHistoryChunk(store, msg) {
  const msgSessionId = msg.sessionId != null ? msg.sessionId : msg.groupId;
  const mode = msg.mode === 'recent' || msg.mode === 'delta' ? msg.mode : 'older';
  const incomingMessages = Array.isArray(msg.messages) ? msg.messages : [];

  const sessionAgentId = msgSessionId && store.yeaftSessionAgentById
    ? store.yeaftSessionAgentById[msgSessionId]
    : null;
  const agentConversationId = sessionAgentId && store.yeaftConversationIdsByAgent
    ? store.yeaftConversationIdsByAgent[sessionAgentId]
    : null;
  const convId = msg.conversationId || agentConversationId || store.yeaftConversationId;
  if (!convId) {
    store.yeaftLoadingMoreHistory = false;
    return;
  }
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
  const existingIds = new Set(
    (store.messagesMap[convId] || [])
      .map(m => m && (m.messageId || m.id))
      .filter(Boolean)
  );
  const seenIds = new Set();
  const formatted = [];
  let acceptedHistoryMessages = 0;
  for (const m of incomingMessages) {
    if (!m) continue;
    if (m._reflection || m.internal || m.systemOnly || m.systemOnlyMessage) continue;
    if (isInternalControlHistoryContent(m.content)) continue;
    const stableId = m.id || m.messageId || null;
    const clientMessageId = m.clientMessageId || null;
    if (stableId && seenIds.has(stableId)) continue;
    if (stableId && mode !== 'recent' && existingIds.has(stableId)) continue;
    if (stableId) seenIds.add(stableId);
    if (m.role === 'user') {
      acceptedHistoryMessages += 1;
      const messageId = stableId || m.messageId || m.turnId || null;
      const rowSessionId = m.sessionId ?? m.groupId ?? msgSessionId ?? null;
      formatted.push({
        ...(stableId ? { id: stableId, messageId: stableId } : {}),
        type: 'user',
        content: m.content,
        timestamp: normalizeHistoryTimestamp(m),
        sessionId: rowSessionId,
        turnId: m.turnId || messageId,
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(Array.isArray(m.attachments) && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
        isStreaming: false,
      });
    } else if (m.role === 'assistant') {
      acceptedHistoryMessages += 1;
      const messageId = stableId || m.messageId || m.turnId || null;
      const rowSessionId = m.sessionId ?? m.groupId ?? msgSessionId ?? null;
      const speakerVpId = resolveHistorySpeakerVpId(m, rowSessionId);
      const timestamp = normalizeHistoryTimestamp(m);
      const hasPersistedTurnId = !!m.turnId;
      const turnId = m.turnId || messageId;
      const assistantContent = typeof m.content === 'string' ? m.content : (m.content || '');
      if (typeof assistantContent !== 'string' || assistantContent.trim()) {
        formatted.push({
          ...(stableId ? { id: stableId, messageId: stableId } : {}),
          type: 'assistant',
          content: assistantContent,
          timestamp,
          sessionId: rowSessionId,
          turnId,
          _hasPersistedTurnId: hasPersistedTurnId,
          ...(speakerVpId ? { vpId: speakerVpId, speakerVpId } : {}),
          isStreaming: false,
          isHistory: true,
        });
      }
      const toolSummaryCount = Number(m.toolSummaryCount || m.toolCalls?.length || 0) || 0;
      if (toolSummaryCount > 0) {
        formatted.push({
          ...(stableId ? { id: `${stableId}:tool-summary`, messageId: `${stableId}:tool-summary` } : {}),
          type: 'tool-summary',
          count: toolSummaryCount,
          omittedCount: toolSummaryCount,
          source: 'history',
          timestamp,
          sessionId: rowSessionId,
          turnId,
          ...(speakerVpId ? { vpId: speakerVpId, speakerVpId } : {}),
          isStreaming: false,
          isHistory: true,
        });
      }
    }
  }

  let insertedRows = 0;
  if (mode === 'recent') {
    insertedRows = replaceYeaftRecentHistoryRows(store.messagesMap[convId], formatted, msgSessionId ?? null);
  } else if (formatted.length > 0) {
    if (mode === 'older') {
      store.messagesMap[convId].splice(0, 0, ...formatted);
      insertedRows = formatted.length;
      if (typeof store.expandYeaftMessageWindow === 'function') {
        // These rows were explicitly requested by scrolling upward. Keep them in
        // the render window; the near-bottom path will prune again later.
        const windowSessionId = store.yeaftActiveSessionFilter ? (msgSessionId ?? null) : null;
        store.expandYeaftMessageWindow(windowSessionId, msg.turns || 10);
      }
    } else {
      insertedRows = upsertYeaftHistoryRows(store.messagesMap[convId], formatted);
    }
  }

  const sessionKey = msgSessionId ?? '__all__';
  const prevState = store.yeaftSessionHistoryState?.[sessionKey] || {};
  const nextLatest = (typeof msg.latestSeq === 'number') ? msg.latestSeq : (prevState.latestSeq ?? null);
  const nextState = mode === 'delta'
    ? {
        ...prevState,
        loaded: true,
        loading: false,
        latestSeq: nextLatest,
        syncingAfterSeq: null,
        count: (prevState.count || 0) + insertedRows,
      }
    : {
        loaded: true,
        loading: false,
        hasMore: !!msg.hasMore,
        oldestSeq: (typeof msg.oldestSeq === 'number') ? msg.oldestSeq : store.yeaftOldestLoadedSeq,
        count: mode === 'older' ? (prevState.count || 0) + insertedRows : acceptedHistoryMessages,
        latestSeq: nextLatest,
        syncingAfterSeq: null,
      };
  if (store.yeaftSessionHistoryState) {
    store.yeaftSessionHistoryState = {
      ...store.yeaftSessionHistoryState,
      [sessionKey]: nextState,
    };
  }
  const activeKey = store.yeaftActiveSessionFilter ?? '__all__';
  if (sessionKey === activeKey) {
    store.yeaftHasMoreHistory = nextState.hasMore;
    if (typeof msg.oldestSeq === 'number') {
      store.yeaftOldestLoadedSeq = msg.oldestSeq;
    }
    store.yeaftLoadingMoreHistory = false;
  } else if (store.yeaftLoadingMoreHistory && sessionKey !== activeKey) {
    const activeState = store.yeaftSessionHistoryState?.[activeKey] || null;
    store.yeaftLoadingMoreHistory = !!activeState?.loading;
  }
}
