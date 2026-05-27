// Message CRUD and streaming helpers

// Default group identifier used by the Unify "Default" group seed
// (mirrors agent/unify/groups/seed-default.js DEFAULT_GROUP_ID).
// Every Unify message is tagged with a groupId — either the currently
// active group filter or this default — so the group filter getters
// can use strict equality without hiding "untagged" messages.
const DEFAULT_GROUP_ID = 'grp_default';

// Are we currently writing into the *active* Unify conversation? Both
// the speaker-attribution stamper and the groupId stamper key off this
// same predicate; centralising it keeps the rules in one place.
function inActiveUnifyConv(store, conversationId) {
  return store.currentView === 'unify'
    && conversationId === store.unifyConversationId;
}

// Idempotently mirror the routing context (vpId / turnId / threadId / speakerVpId)
// onto a Unify message that carries VP attribution (assistant or
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
  if (!inActiveUnifyConv(store, conversationId)) return;
  if (!m.vpId && store._currentUnifyVpId) m.vpId = store._currentUnifyVpId;
  if (!m.turnId && store._currentUnifyTurnId) m.turnId = store._currentUnifyTurnId;
  if (!m.threadId && store._currentUnifyThreadId) m.threadId = store._currentUnifyThreadId;
  if (!m.threadTitle && store._currentUnifyThreadTitle) m.threadTitle = store._currentUnifyThreadTitle;
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

  // Unify uniformity: stamp every message that lands in the active Unify
  // conversation with a groupId. Never overwrite an explicit groupId set
  // by the caller (e.g. sendUnifyGroupChat or task_message handler).
  // Bug 1: prefer `_currentUnifyGroupId` (the SEND-context group set by
  // handleUnifyOutput before dispatching streaming chunks) over the user's
  // current filter — otherwise messages arriving while the user has
  // switched groups get stamped with the wrong group.
  if (inActiveUnifyConv(store, conversationId) && !newMsg.groupId) {
    newMsg.groupId = store._currentUnifyGroupId
      || store.unifyActiveGroupFilter
      || DEFAULT_GROUP_ID;
  }

  // Unify per-VP turn: stamp vpId + turnId on the message for turn-level
  // routing. Without this, concurrent VP streams would collide. The
  // speakerVpId derivation lives inside stampSpeakerOnVpMessage — but
  // every Unify message (assistant *or* user) still gets vpId / turnId,
  // so we keep that here.
  if (inActiveUnifyConv(store, conversationId)) {
    if (!newMsg.vpId && store._currentUnifyVpId) {
      newMsg.vpId = store._currentUnifyVpId;
    }
    if (!newMsg.turnId && store._currentUnifyTurnId) {
      newMsg.turnId = store._currentUnifyTurnId;
    }
    if (!newMsg.threadId && store._currentUnifyThreadId) {
      newMsg.threadId = store._currentUnifyThreadId;
    }
    if (!newMsg.threadTitle && store._currentUnifyThreadTitle) {
      newMsg.threadTitle = store._currentUnifyThreadTitle;
    }
    // Speaker derivation is gated by message type (assistant / tool-use)
    // inside the helper itself.
    stampSpeakerOnVpMessage(store, conversationId, newMsg);
  }

  if (!store.messagesMap[conversationId]) {
    store.messagesMap[conversationId] = [];
  }
  store.messagesMap[conversationId].push(newMsg);
  // Bug 1: keep messages sorted by timestamp so history loaded out-of-order
  // (e.g. from different groups) still displays chronologically.
  // Only sort Unify conversations; crew conversations need insertion order.
  if (conversationId === store.unifyConversationId) {
    store.messagesMap[conversationId].sort((a, b) => a.timestamp - b.timestamp);
  }
}

export function appendToAssistantMessageForConversation(store, conversationId, text, opts = {}) {
  if (!conversationId) return;
  if (!text) return;

  if (!store.messagesMap[conversationId]) {
    store.messagesMap[conversationId] = [];
  }
  const msgs = store.messagesMap[conversationId];

  // Per-VP turn routing: when a turnId is active, find the streaming
  // message for THAT turn (not just the last message). This prevents
  // concurrent VP streams from interleaving into the same message.
  const turnId = store._currentUnifyTurnId;
  const threadId = store._currentUnifyThreadId || null;
  if (turnId || threadId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const turnMatches = !turnId || msgs[i].turnId === turnId;
      const threadMatches = !threadId || !msgs[i].threadId || msgs[i].threadId === threadId;
      if (turnMatches && threadMatches && msgs[i].type === 'assistant' && msgs[i].isStreaming) {
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
      type: 'assistant',
      content: text,
      isStreaming: true
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
      type: 'assistant',
      content: text,
      isStreaming: true
    });
  }
}

export function finishStreamingForConversation(store, conversationId) {
  if (!conversationId) return;

  const msgs = store.messagesMap[conversationId];
  if (!msgs || msgs.length === 0) return;

  // v0.1.768 — per-turn isolation. When a Unify turnId is active, ONLY
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
  // cascade. Legacy single-turn path (no _currentUnifyTurnId) keeps the
  // original blanket-clear so non-Unify chats are unaffected.
  const targetTurnId = store._currentUnifyTurnId || null;
  const targetThreadId = store._currentUnifyThreadId || null;

  // ★ Finish ALL streaming messages in the current turn, not just the last one.
  // Non-streaming messages (chat-image, tool-use) can be appended after
  // a streaming assistant message, leaving it stuck with isStreaming: true.
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (targetTurnId || targetThreadId) {
      // Per-turn/thread mode: only touch messages tagged with this turnId, OR
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
      if (targetThreadId && m.threadId && m.threadId !== targetThreadId) {
        if (m.type === 'user') break;
        continue;
      }
    }
    if (m.isStreaming) {
      m.isStreaming = false;
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

export function formatDbMessage(dbMsg) {
  if (!dbMsg) return null;

  const base = {
    id: dbMsg.id,
    dbMessageId: dbMsg.id,  // ★ Bug #3: 保留 DB id 用于分页锚点
    timestamp: dbMsg.created_at
  };

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
    return {
      ...base,
      type: 'user',
      content: typeof dbMsg.content === 'string' ? dbMsg.content : String(dbMsg.content || '')
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
