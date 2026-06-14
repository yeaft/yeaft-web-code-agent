// Provider-neutral assistant output frame processing helpers.

import { resetProcessingWatchdog, stopProcessingWatchdog } from './watchdog.js';
import { markAllToolsCompleted } from './handlers/conversationHandler.js';
import { sameUserMessage } from './dedup.js';

function normalizeUserVisibleContent(content) {
  let value = content;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try { value = JSON.parse(trimmed); } catch { value = content; }
    }
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text' && typeof part.text === 'string') return part.text;
        if (part.type === 'input_text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('')
      .replace(/\n\n\[Uploaded files\][\s\S]*$/m, '')
      .trim();
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    if (typeof value.content === 'string') return value.content.trim();
    return '';
  }
  return typeof value === 'string'
    ? value.replace(/\n\n\[Uploaded files\][\s\S]*$/m, '').trim()
    : '';
}

export function getOrCreateExecutionStatus(store, conversationId) {
  if (!store.executionStatusMap[conversationId]) {
    store.executionStatusMap[conversationId] = {
      currentTool: null,
      toolHistory: [],
      lastActivity: null
    };
  }
  return store.executionStatusMap[conversationId];
}

export function handleAssistantOutputFrame(store, conversationId, data) {
  if (!conversationId) return;

  const execStatus = getOrCreateExecutionStatus(store, conversationId);
  execStatus.lastActivity = Date.now();

  resetProcessingWatchdog(store, conversationId);

  if (data.type === 'system') {
    if (data.subtype === 'init') {
      return;
    }
    if (data.message) {
      store.addMessageToConversation(conversationId, {
        type: 'system',
        content: typeof data.message === 'string' ? data.message : JSON.stringify(data.message, null, 2)
      });
    }
    return;
  }

  if (data.type === 'assistant') {
    const content = data.message?.content;
    if (!content) return;

    // New assistant message means all previous tools are done
    const msgs = store.messagesMap[conversationId] || [];
    for (const msg of msgs) {
      if (msg.type === 'tool-use' && !msg.hasResult) {
        msg.hasResult = true;
      }
    }
    for (const t of execStatus.toolHistory) {
      if (t.status === 'running') t.status = 'done';
    }
    execStatus.currentTool = null;

    // content 可能是字符串或数组
    if (typeof content === 'string') {
      store.appendToAssistantMessageForConversation(conversationId, content, {
        id: data.message?.id || data.message?.messageId || null,
        ts: data.ts || data.message?.ts || data.message?.time || null,
        sessionId: store._currentYeaftSessionId || null,
        vpId: store._currentYeaftVpId || null,
        turnId: store._currentYeaftTurnId || null,
        threadId: store._currentYeaftThreadId || null,
        threadTitle: store._currentYeaftThreadTitle || null,
      });
      return;
    }
    if (!Array.isArray(content)) return;

    // Empty content array = finish-streaming signal (text was fully streamed via deltas)
    if (content.length === 0) {
      store.finishStreamingForConversation(conversationId);
      return;
    }

    for (const block of content) {
      if (block.type === 'text') {
        store.appendToAssistantMessageForConversation(conversationId, block.text, {
          id: data.message?.id || data.message?.messageId || null,
          ts: data.ts || data.message?.ts || data.message?.time || null,
          sessionId: store._currentYeaftSessionId || null,
          vpId: store._currentYeaftVpId || null,
          turnId: store._currentYeaftTurnId || null,
          threadId: store._currentYeaftThreadId || null,
          threadTitle: store._currentYeaftThreadTitle || null,
        });
      } else if (block.type === 'tool_use') {
        // Finish any in-progress streaming so typing dots reappear during tool execution.
        // Without this, isStreaming stays true on the assistant message, which suppresses
        // the typing indicator (showTypingDots = isProcessing && !hasStreamingMessage).
        store.finishStreamingForConversation(conversationId);

        execStatus.currentTool = {
          name: block.name,
          input: block.input,
          startTime: Date.now()
        };
        execStatus.toolHistory.unshift({
          name: block.name,
          input: block.input,
          timestamp: Date.now(),
          status: 'running'
        });
        if (execStatus.toolHistory.length > 20) {
          execStatus.toolHistory.pop();
        }

        store.addMessageToConversation(conversationId, {
          type: 'tool-use',
          toolName: block.name,
          toolInput: block.input,
          startTime: Date.now()
        });
      }
    }
  } else if (data.type === 'user') {
    // Legacy Claude CLI quirk: skill/slash command local output (e.g.
    // /context, /cost) is echoed as a user frame whose content is wrapped
    // in <local-command-stdout>. Other providers (including Copilot CLI)
    // can ignore this branch by never emitting that marker.
    const rawUserContent = data.message?.content;
    const userContent = normalizeUserVisibleContent(rawUserContent);

    // NOTE: Compact-summary and <task-notification> filtering used to live
    // here as a defensive web-side guard. As of feat-claude-chat-subagent-
    // compact-toolline (agent/claude.js parseTaskNotification +
    // isCompactSummary), the agent rewrites both classes of "fake user
    // messages" into synthetic assistant.tool_use blocks (__SubagentResult,
    // __CompactSummary) BEFORE they ever reach this code path. Keeping a
    // second copy of the detection regex here would mean two places to keep
    // in sync — and worse, would silently drop the message when we want to
    // surface it as a ToolLine. If the agent ever fails to recognise a new
    // variant, the message will fall through and render as a user bubble;
    // that's a visible regression we can fix at the source, not a silent
    // data loss.

    // Filter legacy Claude CLI internal markers (not user-visible).
    // - <local-command-caveat> — CLI 内部 caveat 标记
    // - <command-name>/<command-message>/<command-args> — slash command 元数据
    if (typeof userContent === 'string') {
      if (userContent.includes('<local-command-caveat>') || userContent.includes('<command-name>')) {
        return;
      }
    }

    if (typeof userContent === 'string' && userContent.includes('<local-command-stdout>')) {
      const match = userContent.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
      if (match) {
        store.appendToAssistantMessageForConversation(conversationId, match[1].trim());
        store.finishStreamingForConversation(conversationId);
        return;
      }
      // If local-command-stdout tag exists but regex didn't match, log for debugging
      console.warn('[assistantOutput] local-command-stdout detected but regex failed, content length:', userContent.length);
    }

    let toolResults = [];

    if (data.tool_use_result) {
      const results = Array.isArray(data.tool_use_result) ? data.tool_use_result : [data.tool_use_result];
      toolResults = results;
    } else if (data.message?.content) {
      const content = data.message.content;
      const blocks = Array.isArray(content) ? content : [];
      toolResults = blocks.filter(b => b.type === 'tool_result');
    }

    if (toolResults.length > 0) {
      const msgs = store.messagesMap[conversationId] || [];

      for (const result of toolResults) {
        if (execStatus.toolHistory.length > 0) {
          const runningIdx = execStatus.toolHistory.findIndex(t => t.status === 'running');
          if (runningIdx >= 0) execStatus.toolHistory[runningIdx].status = 'done';
        }

        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].type === 'tool-use' && !msgs[i].hasResult) {
            msgs[i].hasResult = true;
            msgs[i].toolResult = result.content || result;
            break;
          }
        }
      }

      execStatus.currentTool = null;
    } else if ((typeof userContent === 'string' && userContent.trim()) || (Array.isArray(data.message?.attachments) && data.message.attachments.length > 0)) {
      // 普通用户消息（agent 广播回来的）
      // 发送端已通过 addMessage 本地添加，检查是否已存在以避免重复
      //
      // fix-usermsg-dup: prefer the server-stamped `clientMessageId` for
      // dedup. The shared `sameUserMessage` helper (web/stores/helpers/
      // dedup.js) encodes the canonical rule — id-equality when both
      // sides have an id, content-equality only as a legacy fallback.
      // See review I2 (Fowler) for why this lives in a single helper
      // rather than being reimplemented at each gate.
      const echoClientMsgId = data.message?.clientMessageId || data.clientMessageId || null;
      const echoCandidate = {
        type: 'user',
        content: userContent,
        clientMessageId: echoClientMsgId
      };
      const msgs = store.messagesMap[conversationId] || [];
      const duplicate = msgs.some(m => sameUserMessage(m, echoCandidate));
      if (!duplicate) {
        store.addMessageToConversation(conversationId, {
          ...(data.message?.id ? { id: data.message.id, messageId: data.message.id } : {}),
          ...(data.ts ? { ts: data.ts } : {}),
          type: 'user',
          content: userContent,
          // Preserve attachment metadata from agent history replay
          ...(data.message?.attachments ? { attachments: data.message.attachments } : {}),
          // Stamp the echo id on the freshly-added message so any future
          // dedup pass (e.g. sync_messages_result merge) still matches.
          ...(echoClientMsgId ? { clientMessageId: echoClientMsgId } : {}),
          // Bug 1: forward original ts so history messages keep their real
          // timestamp instead of using arrival time.
        });
      } else if (echoClientMsgId) {
        // Common live-send path (NOT a rare race): the dedup gate above
        // already collapsed the echo's row onto the optimistic row by
        // clientMessageId. The optimistic row never has a `dbMessageId`
        // or server-side `ts`/`id` — those only exist after the server
        // persists the message. Stamp them now so subsequent
        // `sync_messages_result` merges can match by `dbMessageId` in
        // addition to `clientMessageId`, and so any sort-by-server-ts
        // surfaces the correct ordering. Review T-I2 (Torvalds):
        // previous comment made this look like a rare race-loser
        // branch — it isn't, every successful send hits it.
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].type === 'user' && msgs[i].clientMessageId === echoClientMsgId) {
            if (data.dbMessageId && !msgs[i].dbMessageId) msgs[i].dbMessageId = data.dbMessageId;
            if (data.message?.id && !msgs[i].messageId) {
              msgs[i].id = data.message.id;
              msgs[i].messageId = data.message.id;
            }
            if (data.ts && !msgs[i].ts) msgs[i].ts = data.ts;
            break;
          }
        }
      }
    }
  } else if (data.type === 'result') {
    if (data.isHistoryReplay) {
      finishHistoryReplayForConversation(store, conversationId);
      return;
    }
    // ★ result 表示当前 turn 已完成，立即清除 processing 状态
    delete store.processingConversations[conversationId];
    stopProcessingWatchdog(store, conversationId);

    // Clear per-VP turn tracking if this result belongs to a specific turnId.
    if (store._currentYeaftTurnId && store.activeVpTurns[store._currentYeaftTurnId]) {
      const { [store._currentYeaftTurnId]: _removed, ...rest } = store.activeVpTurns;
      store.activeVpTurns = rest;
    }

    function finishHistoryReplayForConversation(store, conversationId) {
      const msgs = store.messagesMap[conversationId] || [];
      const targetTurnId = store._currentYeaftTurnId || null;
      const targetThreadId = store._currentYeaftThreadId || null;
      if (!targetTurnId && !targetThreadId) {
        store.finishStreamingForConversation(conversationId);
        return;
      }
      for (const m of msgs) {
        if (!m || !m.isStreaming) continue;
        if (targetTurnId && m.turnId !== targetTurnId) continue;
        if (targetThreadId && m.threadId && m.threadId !== targetThreadId) continue;
        m.isStreaming = false;
        if (m.status === 'pending') m.status = 'completed';
      }
    }
    // ★ 设置防护窗口，防止后续 agent_list 中的 stale processing:true 重新设回
    if (!store._closedAt) store._closedAt = {};
    store._closedAt[conversationId] = Date.now();
    // ★ 持久标记：阻止 agent_list 重新设置 processing 直到下次 sendMessage
    if (!store._turnCompletedConvs) store._turnCompletedConvs = new Set();
    store._turnCompletedConvs.add(conversationId);
    execStatus.currentTool = null;
    markAllToolsCompleted(store, conversationId);
    const msgs = store.messagesMap[conversationId] || [];
    // ★ Display result text only when no assistant message exists for this turn.
    // Normal conversation: text was already streamed via 'assistant' messages,
    // so result_text is a duplicate — skip it.
    // Slash commands (/skills, /context): no assistant message was streamed,
    // result_text is the only output — append it.
    const resultText = data.result_text || '';
    if (typeof resultText === 'string' && resultText.trim()) {
      // Check if any assistant message exists in this turn (streaming or finished).
      // Walk backwards from the end; stop at the first user/human message (turn boundary).
      let hasAssistantInTurn = false;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].type === 'assistant') { hasAssistantInTurn = true; break; }
        if (msgs[i].type === 'user') break;
      }
      if (!hasAssistantInTurn) {
        store.appendToAssistantMessageForConversation(conversationId, resultText.trim());
      }
    }
    store.finishStreamingForConversation(conversationId);
    // v0.1.768 — orphan sweep: when this is the last per-VP `result` for
    // the conversation, clear any stale `isStreaming: true` flag left
    // behind by a prior turn whose `result` was lost (WS hiccup, agent
    // restart, page reload). Without this, an orphan message persists
    // across the user-message turn fence and the VP shows '生成中'
    // forever. By this point `processingConversations[convId]` has
    // already been cleared above (line 189), so the operative gate
    // inside the helper is `activeVpTurns` being empty — i.e. every
    // concurrent fan-out peer has also drained. The helper still
    // re-checks both gates defensively so it stays safe if invoked
    // from any future call site.
    store.sweepStaleStreamingForConversation(conversationId);
  }
}
