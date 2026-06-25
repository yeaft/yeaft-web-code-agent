// Message CRUD and streaming helpers

import { applyLiveToolWindow } from './tool-window.js';

// Default session identifier used by the Yeaft "Default" session seed
// (mirrors agent/yeaft/groups/seed-default.js DEFAULT_GROUP_ID).
// The `grp_` prefix is a persistence contract — disk paths, AMS scope
// regex and migration code all key off it, so the string value stays.
// What changed is the JS identifier and the message field it stamps:
// every Yeaft message is tagged with `sessionId` — either the currently
// active session filter or this default — so the session filter getters
// can use strict equality without hiding "untagged" messages.
const DEFAULT_SESSION_ID = 'grp_default';

// Are we currently writing into the *active* Yeaft conversation? Both
// the speaker-attribution stamper and the sessionId stamper key off this
// same predicate; centralising it keeps the rules in one place.
//
// IMPORTANT: this does NOT gate on `store.currentView === 'yeaft'`.
// Yeaft turns keep running on the agent regardless of which view the
// user is looking at; messages can arrive while the user is browsing
// Chat. If we gated on view, those messages would land in messagesMap
// without a `sessionId` and the `messages` getter would silently filter
// them out (it does a strict `m.sessionId === activeSessionFilter` match).
// The user would see the UI frozen on switch-back until something forced
// a re-fetch. Keying purely off "is this the yeaft conversation id"
// keeps stamping consistent regardless of view.
function inActiveYeaftConv(store, conversationId) {
  return !!store.yeaftConversationId
    && conversationId === store.yeaftConversationId;
}

// Idempotently mirror the routing context (vpId / turnId / speakerVpId)
// onto a Yeaft message that carries VP attribution (assistant or
// tool-use). Used at three points:
//   1. on creation in addMessageToConversation
//   2. defensively on each delta in appendToAssistantMessageForConversation
//      (so a message minted before the routing context was set still
//      gets a speakerVpId before AssistantTurn picks it up)
//   3. defensively at finalize in finishStreamingForConversation (last
//      chance before the streaming flag clears and the avatar header has
//      to render from latched fields)
//
// task-vp-header-pos: also covers `tool-use` messages so a turn that
// OPENS with a tool_call (no preceding text_delta) still carries the
// speaker on disk — otherwise reload-from-history shows tools without
// any avatar above them.
//
// Idempotent: only fills missing fields, never overwrites.
function stampSpeakerOnVpMessage(store, conversationId, m) {
  if (!m) return;
  if (m.type !== 'assistant' && m.type !== 'tool-use') return;
  if (!inActiveYeaftConv(store, conversationId)) return;
  if (!m.vpId && store._currentYeaftVpId) m.vpId = store._currentYeaftVpId;
  if (!m.turnId && store._currentYeaftTurnId) m.turnId = store._currentYeaftTurnId;
  if (!m.speakerVpId && m.vpId) m.speakerVpId = m.vpId;
}

function normalizeMessageTimestamp(msg) {
  const candidates = [
    msg?.timestamp,
    msg?.createdAt,
    msg?.ts,
    msg?.time,
    msg?.created_at,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
  }
  return Date.now();
}

function explicitMessageId(msg) {
  const id = msg?.messageId ?? msg?.dbMessageId ?? msg?.id;
  if (id === null || id === undefined || id === '') return null;
  return String(id);
}

function mergeMessageFields(existing, incoming) {
  if (!existing || !incoming) return existing;
  const existingIsLocalYeaftUser = existing.type === 'user'
    && typeof existing.id === 'string'
    && existing.id === existing.clientMessageId;
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null) continue;
    if (key === 'isStreaming') {
      if (existing.isStreaming && value === false) existing.isStreaming = false;
      continue;
    }
    if (key === 'id' || key === 'messageId') {
      if (existingIsLocalYeaftUser && incoming.clientMessageId === existing.clientMessageId && incoming.messageId && incoming.messageId !== existing.clientMessageId) {
        continue;
      }
      if (existing[key] === undefined || existing[key] === null || existing[key] === '') {
        existing[key] = value;
      }
      continue;
    }
    if (key === 'turnId' && existingIsLocalYeaftUser && existing.turnId === existing.clientMessageId) {
      continue;
    }
    if (key === 'content' && typeof value === 'string') {
      if (!existing.content) existing.content = value;
      continue;
    }
    if (key === 'attachments' && Array.isArray(value)) {
      if (!Array.isArray(existing.attachments) || existing.attachments.length === 0) {
        existing.attachments = value;
      }
      continue;
    }
    if (existing[key] === undefined || existing[key] === null || existing[key] === '') {
      existing[key] = value;
    }
  }
  return existing;
}

export function mergeMessagesByStableId(baseMessages = [], incomingMessages = []) {
  const merged = [];
  const byId = new Map();
  const userByClientId = new Map();
  for (const msg of [...baseMessages, ...incomingMessages]) {
    if (!msg) continue;
    const stableId = explicitMessageId(msg);
    const clientMessageId = msg.type === 'user' && msg.clientMessageId ? String(msg.clientMessageId) : null;
    if (stableId && byId.has(stableId)) {
      mergeMessageFields(byId.get(stableId), msg);
      continue;
    }
    if (clientMessageId && userByClientId.has(clientMessageId)) {
      const existing = userByClientId.get(clientMessageId);
      mergeMessageFields(existing, msg);
      if (stableId && !byId.has(stableId)) byId.set(stableId, existing);
      continue;
    }
    merged.push(msg);
    if (stableId) byId.set(stableId, msg);
    if (clientMessageId) userByClientId.set(clientMessageId, msg);
  }
  return merged;
}

export function shouldForceHydrateActiveYeaftSession(nextSessionId, prevSessionId, sessionState) {
  if (!nextSessionId || nextSessionId !== prevSessionId) return false;
  return !sessionState?.loaded && !sessionState?.loading;
}

export function shouldCatchUpLoadedYeaftSession(sessionState, catchUpHistory) {
  return !!catchUpHistory
    && !!sessionState?.loaded
    && !sessionState?.loading
    && Number.isFinite(sessionState?.latestSeq);
}

function mergeAssistantTextByStableId(store, conversationId, opts, text) {
  const stableId = opts?.id ? String(opts.id) : null;
  if (!stableId) return false;
  const msgs = store.messagesMap[conversationId] || [];
  const existing = msgs.find(m => m?.type === 'assistant' && explicitMessageId(m) === stableId);
  if (!existing) return false;
  if (!existing.id) existing.id = stableId;
  if (!existing.messageId) existing.messageId = stableId;
  if (opts.ts && !existing.ts) existing.ts = opts.ts;
  if (opts.timestamp && !existing.timestamp) existing.timestamp = opts.timestamp;
  if (opts.sessionId && !existing.sessionId) existing.sessionId = opts.sessionId;
  if (opts.vpId && !existing.vpId) existing.vpId = opts.vpId;
  if (opts.turnId && !existing.turnId) existing.turnId = opts.turnId;
  if (opts.threadId && !existing.threadId) existing.threadId = opts.threadId;
  if (!existing.content) {
    existing.content = text;
  } else if (typeof existing.content === 'string') {
    if (text.startsWith(existing.content)) {
      existing.content = text;
    } else if (!existing.content.endsWith(text)) {
      existing.content += text;
    }
  }
  stampSpeakerOnVpMessage(store, conversationId, existing);
  return true;
}

export function addMessageToConversation(store, conversationId, msg) {
  if (!conversationId) return;

  const newMsg = {
    ...msg,
    id: msg.dbMessageId || msg.id || Date.now().toString() + Math.random().toString(36).substr(2, 9),
    // Preserve persisted message time when present. History/replay paths may
    // send ISO `ts`/`time`, DB-style `created_at`, or already-normalized epoch
    // fields; only live messages with no persisted time fall back to arrival.
    timestamp: normalizeMessageTimestamp(msg),
  };

  // Yeaft uniformity: stamp every message that lands in the active Yeaft
  // conversation with a sessionId. Never overwrite an explicit sessionId
  // set by the caller (e.g. sendYeaftSessionMessage or task_message
  // handler). Bug 1: prefer `_currentYeaftSessionId` (the SEND-context
  // session set by handleYeaftOutput before dispatching streaming
  // chunks) over the user's current filter — otherwise messages arriving
  // while the user has switched sessions get stamped with the wrong one.
  if (inActiveYeaftConv(store, conversationId) && !newMsg.sessionId) {
    newMsg.sessionId = store._currentYeaftSessionId
      || store.yeaftActiveSessionFilter
      || DEFAULT_SESSION_ID;
  }

  // Yeaft per-VP turn: stamp vpId + turnId on the message for turn-level
  // routing. Without this, concurrent VP streams would collide. The
  // speakerVpId derivation lives inside stampSpeakerOnVpMessage — but
  // every Yeaft message (assistant *or* user) still gets vpId / turnId,
  // so we keep that here.
  if (inActiveYeaftConv(store, conversationId)) {
    if (!newMsg.vpId && store._currentYeaftVpId) {
      newMsg.vpId = store._currentYeaftVpId;
    }
    if (!newMsg.turnId && store._currentYeaftTurnId) {
      newMsg.turnId = store._currentYeaftTurnId;
    }
    // Speaker derivation is gated by message type (assistant / tool-use)
    // inside the helper itself.
    stampSpeakerOnVpMessage(store, conversationId, newMsg);
  }

  if (!store.messagesMap[conversationId]) {
    store.messagesMap[conversationId] = [];
  }
  const stableId = explicitMessageId(msg);
  if (stableId) {
    const existing = store.messagesMap[conversationId].find(m => explicitMessageId(m) === stableId);
    if (existing) {
      mergeMessageFields(existing, newMsg);
      if (conversationId === store.yeaftConversationId) {
        store.messagesMap[conversationId].sort((a, b) => a.timestamp - b.timestamp);
      }
      return existing;
    }
  }
  store.messagesMap[conversationId].push(newMsg);
  applyLiveToolWindow(store.messagesMap[conversationId]);
  // Bug 1: keep messages sorted by timestamp so history loaded out-of-order
  // (e.g. from different sessions) still displays chronologically.
  if (conversationId === store.yeaftConversationId) {
    store.messagesMap[conversationId].sort((a, b) => a.timestamp - b.timestamp);
  }
  return newMsg;
}

export function appendToAssistantMessageForConversation(store, conversationId, text, opts = {}) {
  if (!conversationId) return;
  if (!text) return;

  if (!store.messagesMap[conversationId]) {
    store.messagesMap[conversationId] = [];
  }
  const msgs = store.messagesMap[conversationId];
  if (mergeAssistantTextByStableId(store, conversationId, opts, text)) return;

  // Per-VP turn routing: when a turnId is active, find the streaming
  // message for THAT turn (not just the last message). This prevents
  // concurrent VP streams from interleaving into the same message.
  const turnId = store._currentYeaftTurnId;
  if (turnId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const turnMatches = msgs[i].turnId === turnId;
      if (turnMatches && msgs[i].type === 'assistant' && msgs[i].isStreaming) {
        stampSpeakerOnVpMessage(store, conversationId, msgs[i]);
        if (opts.id && !msgs[i].id) msgs[i].id = opts.id;
        if (opts.id && !msgs[i].messageId) msgs[i].messageId = opts.id;
        if (msgs[i].content.endsWith(text)) return;
        msgs[i].content += text;
        return;
      }
    }
    // No existing streaming message for this turn — create one.
    addMessageToConversation(store, conversationId, {
      ...(opts.id ? { id: opts.id, messageId: opts.id } : {}),
      ...(opts.ts ? { ts: opts.ts } : {}),
      ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.vpId ? { vpId: opts.vpId } : {}),
      ...(opts.turnId ? { turnId: opts.turnId } : {}),
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
      type: 'assistant',
      content: text,
      isStreaming: true,
      status: 'pending',
      turnStartAt: opts.timestamp || Date.now(),
    });
    return;
  }

  // Legacy path (no turnId): append to the last streaming message.
  const lastMsg = msgs[msgs.length - 1];
  if (lastMsg && lastMsg.type === 'assistant' && lastMsg.isStreaming) {
    stampSpeakerOnVpMessage(store, conversationId, lastMsg);
    // Dedup guard: skip if the message already ends with this exact text
    if (opts.id && !lastMsg.id) lastMsg.id = opts.id;
    if (opts.id && !lastMsg.messageId) lastMsg.messageId = opts.id;
    if (lastMsg.content.endsWith(text)) return;
    lastMsg.content += text;
  } else {
    addMessageToConversation(store, conversationId, {
      ...(opts.id ? { id: opts.id, messageId: opts.id } : {}),
      ...(opts.ts ? { ts: opts.ts } : {}),
      ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.vpId ? { vpId: opts.vpId } : {}),
      ...(opts.turnId ? { turnId: opts.turnId } : {}),
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
      type: 'assistant',
      content: text,
      isStreaming: true,
      status: 'pending',
      turnStartAt: opts.timestamp || Date.now(),
    });
  }
}

export function finishStreamingForConversation(store, conversationId) {
  if (!conversationId) return;

  const msgs = store.messagesMap[conversationId];
  if (!msgs || msgs.length === 0) return;

  // v0.1.768 — per-turn isolation. When a Yeaft turnId is active, ONLY
  // clear streaming flags on messages that belong to that turn. Multi-VP
  // fan-out runs concurrent turns inside the same conversation: VP-A's
  // `result` lands before VP-B finishes streaming. Without this guard,
  // VP-A's finishStreamingForConversation walks back across VP-B's
  // still-streaming message and flips its flag — VP-B's next text_delta
  // then finds no streaming message for its turnId and forks a NEW
  // message via the addMessageToConversation branch in
  // appendToAssistantMessageForConversation. Net effect: the original
  // (now misflagged) message sits idle, and the new forked message
  // becomes an "orphan" that only this VP's own result can clear later
  // — and if that result is lost (WS hiccup, agent crash, page reload),
  // it stays `isStreaming: true` forever and the VP shows '生成中'
  // permanently. Scoping the walk-back to turnId eliminates the
  // cascade. Legacy single-turn path (no _currentYeaftTurnId) keeps the
  // original blanket-clear so non-Yeaft chats are unaffected.
  const targetTurnId = store._currentYeaftTurnId || null;

  // ★ Finish ALL streaming messages in the current turn, not just the last one.
  // Non-streaming messages (chat-image, tool-use) can be appended after
  // a streaming assistant message, leaving it stuck with isStreaming: true.
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (targetTurnId) {
      // Per-turn mode: only touch messages tagged with this turnId, OR
      // messages that have NO turnId yet (they were minted before the
      // routing context was set and the defensive stamper below will
      // adopt them into the active turn). Anything tagged with a
      // DIFFERENT turnId is a concurrent VP — leave it alone.
      if (m.turnId && m.turnId !== targetTurnId) {
        // Stop at the user message that opened this fan-out so we don't
        // wander into older history.
        if (m.type === 'user') break;
        continue;
      }
    }
    if (m.isStreaming) {
      m.isStreaming = false;
      // Per-message lifecycle: promote pending → completed at finalize
      // time. The vp_turn_end reducer in the store is the live source
      // of truth and runs FIRST when the turn really ends; this branch
      // catches history-replay paths (no vp_turn_end fires) and any
      // edge where finishStreaming runs without the broker event. We
      // guard on status === 'pending' so live 'aborted' / 'errored'
      // stamps from the store are never silently overwritten back to
      // 'completed'.
      if (m.status === 'pending') {
        m.status = 'completed';
        m.turnEndAt = Date.now();
      }
    }
    // Defensive speaker-attribution stamp at finalize time. The avatar
    // header in AssistantTurn relies on `speakerVpId` to render after
    // streaming ends; if the streaming message lost the latch (or never
    // had it because vpId arrived late), this is the last chance to fill
    // it in from the still-active routing context.
    stampSpeakerOnVpMessage(store, conversationId, m);
    // Stop at the last user message (turn boundary) — no need to go further
    if (m.type === 'user') break;
  }
}

/**
 * v0.1.768 — orphan sweep. After a VP's `result` lands AND every other
 * per-VP turn for this conversation has drained, walk the whole
 * conversation and clear any leftover `isStreaming: true` flag. This is
 * the safety net for the case where a `result` was genuinely lost
 * (network partition, agent restart mid-fan-out, page reload during
 * streaming) — without it, an orphan message would sit `isStreaming:
 * true` past the next user prompt's "turn fence" and the VP would show
 * '生成中' indefinitely.
 *
 * Gated on both `activeVpTurns` being empty AND `processingConversations
 * [convId]` being falsy so the sweep can NEVER race a still-running
 * fan-out peer.
 *
 * @param {object} store
 * @param {string} conversationId
 */
export function sweepStaleStreamingForConversation(store, conversationId) {
  if (!conversationId) return;
  // If anything is still flagged in-flight for THIS conversation or for
  // any per-VP turn, we are not the "last result" — bail.
  if (store.processingConversations && store.processingConversations[conversationId]) return;
  if (store.activeVpTurns && Object.keys(store.activeVpTurns).length > 0) return;
  const msgs = store.messagesMap && store.messagesMap[conversationId];
  if (!msgs || msgs.length === 0) return;
  for (const m of msgs) {
    if (m && m.isStreaming) m.isStreaming = false;
  }
}

export function loadHistoryMessages(store, historyMessages) {
  console.log('Loading history messages:', historyMessages);
  const convId = store.currentConversation;
  if (!convId) return;
  if (!store.messagesMap[convId]) {
    store.messagesMap[convId] = [];
  }
  const msgs = store.messagesMap[convId];
  let lastUserMessage = null;
  for (const msg of historyMessages) {
    console.log('Processing message:', msg.type, msg);
    if (msg.type === 'user') {
      const content = msg.message?.content;
      console.log('User content:', content);
      if (content) {
        const text = typeof content === 'string'
          ? content
          : (Array.isArray(content) ? content.map(block => block.text || '').join('') : '');
        console.log('User text:', text);
        if (text) {
          lastUserMessage = text;
          store.addMessage({
            type: 'user',
            content: text,
            isHistory: true
          });
        }
      }
    } else if (msg.type === 'assistant') {
      const content = msg.message?.content;
      console.log('Assistant content:', content);
      if (content && Array.isArray(content)) {
        for (const block of content) {
          console.log('Assistant block:', block);
          if (block.type === 'text' && block.text) {
            store.addMessage({
              type: 'assistant',
              content: block.text,
              isHistory: true
            });
          } else if (block.type === 'tool_use') {
            store.addMessage({
              type: 'tool-use',
              toolName: block.name,
              toolInput: block.input,
              isHistory: true
            });
          } else if (block.type === 'tool_result') {
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].type === 'tool-use' && !msgs[i].hasResult) {
                msgs[i].hasResult = true;
                msgs[i].toolResult = block.content;
                break;
              }
            }
          }
        }
      }
    }
  }
  if (lastUserMessage && convId && !store.conversationTitles[convId]) {
    const title = lastUserMessage.trim().substring(0, 100);
    store.conversationTitles[convId] = title;
  }
  console.log('Messages after loading:', msgs);
}

/**
 * Largest `dbMessageId` across `msgs`, or null if none of them carry one.
 *
 * Used as the `afterMessageId` cursor for incremental `sync_messages`
 * requests (cache-hit branch in `selectConversation`, plus the cached
 * `chatSessionState[convId].lastSeenDbId` stamp).
 *
 * Three contracts the call sites rely on:
 *   1. **Tail-safe** — streaming assistant partials sit at the tail
 *      without a `dbMessageId`; the naïve `msgs.at(-1)?.dbMessageId`
 *      would yield `undefined` and force a wasteful cold-load.
 *   2. **Order-safe** — older-history prepends can land smaller ids
 *      after larger ones; we walk the whole array and take the max.
 *   3. **Zero-safe** — `dbMessageId === 0` is **excluded** even though
 *      it'd type-check as `number`. SQLite AUTOINCREMENT starts at 1,
 *      so 0 cannot legitimately occur today. But the server uses
 *      `if (msg.afterMessageId)` to discriminate the delta branch
 *      (`client-conversation.js:341`); a literal 0 is falsy and would
 *      silently fall through to `getRecent(limit)`, returning the last
 *      100 rows instead of "everything strictly newer". Treat 0 as
 *      "no cursor" so the cold-load fallback fires instead.
 */
export function maxDbMessageId(msgs) {
  if (!Array.isArray(msgs)) return null;
  let max = null;
  for (const m of msgs) {
    if (typeof m?.dbMessageId === 'number' && m.dbMessageId > 0
        && (max === null || m.dbMessageId > max)) {
      max = m.dbMessageId;
    }
  }
  return max;
}

const DETAILED_HISTORY_TOOL_NAMES = new Set(['TodoWrite', 'AskUserQuestion']);

function dbMessageBase(dbMsg) {
  return {
    id: dbMsg.id,
    dbMessageId: dbMsg.id,  // ★ Bug #3: 保留 DB id 用于分页锚点
    timestamp: dbMsg.created_at
  };
}

export function formatDbMessageForHistoryHydration(dbMsg) {
  if (!dbMsg) return null;
  if (dbMsg.message_type === 'tool_use' && !DETAILED_HISTORY_TOOL_NAMES.has(dbMsg.tool_name)) {
    return {
      ...dbMessageBase(dbMsg),
      type: 'tool-use',
      toolName: dbMsg.tool_name || 'unknown',
      hasResult: true,
      isHistory: true,
      startTime: dbMsg.created_at || 0,
    };
  }
  return formatDbMessage(dbMsg);
}

export function formatDbMessage(dbMsg) {
  if (!dbMsg) return null;

  const base = dbMessageBase(dbMsg);

  if (dbMsg.message_type === 'tool_use') {
    const result = {
      ...base,
      type: 'tool-use',
      toolName: dbMsg.tool_name || 'unknown',
      toolInput: (() => {
        try { return JSON.parse(dbMsg.tool_input || dbMsg.content || '{}'); }
        catch { return {}; }
      })(),
      hasResult: true,
      isHistory: true,
      startTime: dbMsg.created_at || 0
    };
    // Restore AskUserQuestion state from persisted metadata
    if (dbMsg.metadata) {
      try {
        const meta = JSON.parse(dbMsg.metadata);
        if (meta.askRequestId) {
          result.askRequestId = meta.askRequestId;
          result.askQuestions = meta.askQuestions;
          result.askAnswered = !!meta.askAnswered;
          result.selectedAnswers = meta.selectedAnswers || null;
          // Unanswered AskUserQuestion should remain interactive, not history
          if (!meta.askAnswered) {
            result.isHistory = false;
          }
        }
      } catch { /* invalid metadata JSON, ignore */ }
    }
    return result;
  }

  const extractTextContent = (content) => {
    if (!content) return '';
    if (typeof content !== 'string') return String(content);
    if (content.startsWith('[')) {
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          return parsed
            .filter(block => block.type === 'text' && block.text)
            .map(block => block.text)
            .join('');
        }
      } catch { /* not JSON, use as-is */ }
    }
    return content;
  };

  if (dbMsg.role === 'user') {
    // fix-usermsg-dup: surface the persisted clientMessageId so the
    // sync-replay merge (conversationHandler.handleSyncMessagesResult)
    // and the live echo merge (assistantOutput.js user branch) can both
    // match by id. Without this, a session that was viewed AFTER page
    // refresh — i.e. messages come from sync rather than the live echo
    // path — has no dedup key and the next optimistic add produces the
    // duplicate this fix targets.
    let clientMessageId = null;
    if (dbMsg.metadata) {
      try {
        const meta = JSON.parse(dbMsg.metadata);
        if (meta && typeof meta.clientMessageId === 'string') {
          clientMessageId = meta.clientMessageId;
        }
      } catch { /* invalid metadata JSON, ignore */ }
    }
    return {
      ...base,
      type: 'user',
      content: typeof dbMsg.content === 'string' ? dbMsg.content : String(dbMsg.content || ''),
      ...(clientMessageId ? { clientMessageId } : {})
    };
  } else if (dbMsg.role === 'assistant') {
    const text = extractTextContent(dbMsg.content);

    // ★ Extract embedded tool_use blocks from assistant content JSON array.
    // Normally agent-output.js stores text and tool_use as separate DB records,
    // but in edge cases (SDK format changes, bulkAddHistory quirks) the content
    // may be a JSON array containing both text and tool_use blocks.
    // We extract tool_use blocks as separate tool-use messages so turnGroups
    // can aggregate them correctly with the assistant text.
    const embeddedToolUse = (() => {
      if (!dbMsg.content || typeof dbMsg.content !== 'string' || !dbMsg.content.startsWith('[')) return [];
      try {
        const parsed = JSON.parse(dbMsg.content);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(b => b.type === 'tool_use' && b.name);
      } catch { return []; }
    })();

    if (!text && embeddedToolUse.length === 0) return null;

    // If there are embedded tool_use blocks, return an array: [assistant, ...tool-use msgs]
    if (embeddedToolUse.length > 0) {
      const results = [];
      if (text) {
        results.push({ ...base, type: 'assistant', content: text });
      }
      for (let i = 0; i < embeddedToolUse.length; i++) {
        const block = embeddedToolUse[i];
        results.push({
          id: dbMsg.id + '_tool_' + i,
          dbMessageId: dbMsg.id,
          timestamp: dbMsg.created_at,
          type: 'tool-use',
          toolName: block.name,
          toolInput: block.input || {},
          hasResult: true,
          isHistory: true,
          startTime: dbMsg.created_at || 0
        });
      }
      return results;
    }

    return {
      ...base,
      type: 'assistant',
      content: text
    };
  } else if (dbMsg.role === 'tool' || dbMsg.message_type === 'tool_result') {
    return {
      ...base,
      type: 'tool_result',
      tool: dbMsg.tool_name || 'unknown',
      content: typeof dbMsg.content === 'string' ? dbMsg.content : String(dbMsg.content || '')
    };
  }

  return null;
}
