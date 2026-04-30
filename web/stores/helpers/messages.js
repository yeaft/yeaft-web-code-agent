// Message CRUD and streaming helpers

// Default group identifier used by the Unify "Default" group seed
// (mirrors agent/unify/groups/seed-default.js DEFAULT_GROUP_ID).
// Every Unify message is tagged with a groupId — either the currently
// active group filter or this default — so the group filter getters
// can use strict equality without hiding "untagged" messages.
const DEFAULT_GROUP_ID = 'grp_default';

export function addMessageToConversation(store, conversationId, msg) {
  if (!conversationId) return;

  const newMsg = {
    id: msg.dbMessageId || Date.now().toString() + Math.random().toString(36).substr(2, 9),
    timestamp: Date.now(),
    ...msg
  };

  // Unify uniformity: stamp every message that lands in the active Unify
  // conversation with a groupId. Never overwrite an explicit groupId set
  // by the caller (e.g. sendUnifyGroupChat or task_message handler).
  // Bug 1: prefer `_currentUnifyGroupId` (the SEND-context group set by
  // handleUnifyOutput before dispatching streaming chunks) over the user's
  // current filter — otherwise messages arriving while the user has
  // switched groups get stamped with the wrong group.
  if (
    store.currentView === 'unify'
    && conversationId === store.unifyConversationId
    && !newMsg.groupId
  ) {
    newMsg.groupId = store._currentUnifyGroupId
      || store.unifyActiveGroupFilter
      || DEFAULT_GROUP_ID;
  }

  // Unify per-VP turn: stamp vpId + turnId on the message for turn-level
  // routing. Without this, concurrent VP streams would collide.
  if (
    store.currentView === 'unify'
    && conversationId === store.unifyConversationId
  ) {
    if (!newMsg.vpId && store._currentUnifyVpId) {
      newMsg.vpId = store._currentUnifyVpId;
    }
    if (!newMsg.turnId && store._currentUnifyTurnId) {
      newMsg.turnId = store._currentUnifyTurnId;
    }
    // Derive speakerVpId for MessageList VP-grouping.
    if (!newMsg.speakerVpId && newMsg.vpId && newMsg.type === 'assistant') {
      newMsg.speakerVpId = newMsg.vpId;
    }
  }

  if (!store.messagesMap[conversationId]) {
    store.messagesMap[conversationId] = [];
  }
  store.messagesMap[conversationId].push(newMsg);
}

export function appendToAssistantMessageForConversation(store, conversationId, text) {
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
  if (turnId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].turnId === turnId && msgs[i].type === 'assistant' && msgs[i].isStreaming) {
        if (msgs[i].content.endsWith(text)) return;
        msgs[i].content += text;
        return;
      }
    }
    // No existing streaming message for this turn — create one.
    addMessageToConversation(store, conversationId, {
      type: 'assistant',
      content: text,
      isStreaming: true
    });
    return;
  }

  // Legacy path (no turnId): append to the last streaming message.
  const lastMsg = msgs[msgs.length - 1];
  if (lastMsg && lastMsg.type === 'assistant' && lastMsg.isStreaming) {
    // Dedup guard: skip if the message already ends with this exact text
    if (lastMsg.content.endsWith(text)) return;
    lastMsg.content += text;
  } else {
    addMessageToConversation(store, conversationId, {
      type: 'assistant',
      content: text,
      isStreaming: true
    });
  }
}

export function finishStreamingForConversation(store, conversationId) {
  if (!conversationId) return;

  const msgs = store.messagesMap[conversationId];
  if (msgs && msgs.length > 0) {
    // ★ Finish ALL streaming messages in the current turn, not just the last one.
    // Non-streaming messages (chat-image, tool-use) can be appended after
    // a streaming assistant message, leaving it stuck with isStreaming: true.
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].isStreaming) {
        msgs[i].isStreaming = false;
      }
      // Stop at the last user message (turn boundary) — no need to go further
      if (msgs[i].type === 'user') break;
    }
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
