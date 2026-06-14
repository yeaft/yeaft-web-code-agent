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
  store.conversations.push({
    id: msg.conversationId,
    agentId: msg.agentId,
    agentName: createdAgent?.name || msg.agentId,
    workDir: msg.workDir,
    claudeSessionId: null,
    createdAt: Date.now(),
    processing: false,
    type: 'chat',
    provider: msg.provider || 'claude-code',
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
 * Handle a `yeaft_history_chunk` envelope — the response to
 * `yeaft_load_more_history`. Unlike Chat-mode's `sync_messages_result`,
 * Yeaft history doesn't live in a SQLite DB and isn't keyed by
 * `dbMessageId`; the agent computes the page directly from on-disk
 * markdown. The chunk is GUARANTEED to be strictly older than every
 * message currently in `messagesMap[yeaftConversationId]` (the cursor
 * was the oldest currently-loaded seq), so prepending at index 0 is
 * always correct.
 *
 * Always clears `yeaftLoadingMoreHistory` — even on an empty / error
 * chunk — so the spinner doesn't get stuck. Always overwrites
 * `yeaftHasMoreHistory` from the server's authoritative value.
 */
export function handleYeaftHistoryChunk(store, msg) {
  const convId = msg.conversationId || store.yeaftConversationId;
  if (!convId) {
    store.yeaftLoadingMoreHistory = false;
    return;
  }
  // Stale-chunk guard: between the request fly-out and this chunk landing,
  // the user may have switched sessions (or a session lifecycle event —
  // create / archive / delete — may have flipped `activeSessionId` under
  // us). Drop on the floor; the active session's spinner/cursor is keyed
  // separately so accepting this chunk would cross-pollute session history.
  // The chunk's sessionId is authoritative — it's stamped by the agent
  // from the request sessionId, not from messagesMap state.
  const activeFilter = store.yeaftActiveSessionFilter ?? null;
  const msgSessionId = msg.sessionId != null ? msg.sessionId : msg.groupId;
  const hasChunkGroup = msgSessionId != null;
  if (hasChunkGroup && activeFilter && msgSessionId !== activeFilter) {
    const staleKey = msgSessionId ?? '__all__';
    if (store.yeaftSessionHistoryState) {
      store.yeaftSessionHistoryState = {
        ...store.yeaftSessionHistoryState,
        [staleKey]: {
          ...(store.yeaftSessionHistoryState[staleKey] || {}),
          loading: false,
        },
      };
    }
    store.yeaftLoadingMoreHistory = false;
    return;
  }
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
  for (const m of (msg.messages || [])) {
    if (!m) continue;
    if (m._reflection || m.internal || m.systemOnly || m.systemOnlyMessage) continue;
    const stableId = m.id || m.messageId || null;
    if (stableId && (existingIds.has(stableId) || seenIds.has(stableId))) continue;
    if (stableId) seenIds.add(stableId);
    if (m.role === 'user') {
      const messageId = stableId || m.messageId || m.turnId || null;
      const rowSessionId = m.sessionId ?? m.groupId ?? msgSessionId ?? null;
      formatted.push({
        ...(stableId ? { id: stableId, messageId: stableId } : {}),
        type: 'user',
        content: m.content,
        timestamp: normalizeHistoryTimestamp(m),
        sessionId: rowSessionId,
        turnId: m.turnId || messageId,
        ...(Array.isArray(m.attachments) && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
        isStreaming: false,
      });
    } else if (m.role === 'assistant') {
      const messageId = stableId || m.messageId || m.turnId || null;
      const rowSessionId = m.sessionId ?? m.groupId ?? msgSessionId ?? null;
      const speakerVpId = resolveHistorySpeakerVpId(m, rowSessionId);
      formatted.push({
        ...(stableId ? { id: stableId, messageId: stableId } : {}),
        type: 'assistant',
        content: m.content,
        timestamp: normalizeHistoryTimestamp(m),
        sessionId: rowSessionId,
        turnId: m.turnId || messageId,
        ...(speakerVpId ? { vpId: speakerVpId, speakerVpId } : {}),
        isStreaming: false,
        isHistory: true,
      });
    }
  }

  if (formatted.length > 0) {
    store.messagesMap[convId].splice(0, 0, ...formatted);
    if (typeof store.expandYeaftMessageWindow === 'function') {
      // These rows were explicitly requested by scrolling upward. Keep them in
      // the render window; the near-bottom path will prune again later.
      const windowSessionId = store.yeaftActiveSessionFilter ? (msgSessionId ?? null) : null;
      store.expandYeaftMessageWindow(windowSessionId, msg.turns || 10);
    }
  }

  const groupKey = msgSessionId ?? '__all__';
  const nextState = {
    loaded: true,
    loading: false,
    hasMore: !!msg.hasMore,
    oldestSeq: (typeof msg.oldestSeq === 'number') ? msg.oldestSeq : store.yeaftOldestLoadedSeq,
    count: formatted.length,
  };
  if (store.yeaftSessionHistoryState) {
    store.yeaftSessionHistoryState = {
      ...store.yeaftSessionHistoryState,
      [groupKey]: nextState,
    };
  }
  const activeKey = store.yeaftActiveSessionFilter ?? '__all__';
  if (groupKey === activeKey) {
    store.yeaftHasMoreHistory = nextState.hasMore;
    if (typeof msg.oldestSeq === 'number') {
      store.yeaftOldestLoadedSeq = msg.oldestSeq;
    }
    store.yeaftLoadingMoreHistory = false;
  }
}
