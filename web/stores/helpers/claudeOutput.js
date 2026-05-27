// Claude output processing helpers

import { resetProcessingWatchdog, stopProcessingWatchdog } from './watchdog.js';
import { markAllToolsCompleted } from './handlers/conversationHandler.js';

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

export function handleClaudeOutput(store, conversationId, data) {
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
      store.appendToAssistantMessageForConversation(conversationId, content, { id: data.message?.id || data.message?.messageId || null });
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
        store.appendToAssistantMessageForConversation(conversationId, block.text, { id: data.message?.id || data.message?.messageId || null });
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
    // 检查是否是 skill/slash command 的本地输出（如 /context, /cost 等）
    // Claude CLI 将这些结果以 user 消息返回，content 用 <local-command-stdout> 包裹
    const rawUserContent = data.message?.content;
    const userContent = normalizeUserVisibleContent(rawUserContent);

    // 过滤 compact summary 消息（compact 后的上下文摘要，不应显示在 UI 中）
    // Claude Code compact summary 特征检测 — 兜底防线，即使 agent 端没过滤也不会泄漏到 UI
    if (typeof userContent === 'string' && userContent.length > 200) {
      if (userContent.includes('This session is being continued from a previous conversation')
          || userContent.includes('The summary below covers the earlier portion of the conversation')
          || /Summary:[\s\S]*\d+\.\s*(Primary Request|Key Technical|Current Work)/m.test(userContent)) {
        return;
      }
    }
    // content 可能是数组形式（每个 block 是 { type: 'text', text: '...' }）
    if (Array.isArray(userContent)) {
      const fullText = userContent.map(b => (typeof b === 'string' ? b : b?.text || '')).join('');
      if (fullText.length > 200 && (
        fullText.includes('This session is being continued from a previous conversation')
        || fullText.includes('The summary below covers the earlier portion of the conversation')
        || /Summary:[\s\S]*\d+\.\s*(Primary Request|Key Technical|Current Work)/m.test(fullText)
      )) {
        return;
      }
    }

    // 过滤 Claude CLI 内部消息（不应显示在 UI 中）
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
      console.warn('[claudeOutput] local-command-stdout detected but regex failed, content length:', userContent.length);
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
      const msgs = store.messagesMap[conversationId] || [];
      const duplicate = msgs.some(m => m.type === 'user' && m.content === userContent);
      if (!duplicate) {
        store.addMessageToConversation(conversationId, {
          ...(data.message?.id ? { id: data.message.id, messageId: data.message.id } : {}),
          type: 'user',
          content: userContent,
          // Preserve attachment metadata from agent history replay
          ...(data.message?.attachments ? { attachments: data.message.attachments } : {}),
          // Bug 1: forward original ts so history messages keep their real
          // timestamp instead of using arrival time.
          ...(data.ts ? { ts: data.ts } : {}),
        });
      }
    }
  } else if (data.type === 'result') {
    // ★ result 表示当前 turn 已完成，立即清除 processing 状态
    delete store.processingConversations[conversationId];
    stopProcessingWatchdog(store, conversationId);

    // Clear per-VP turn tracking if this result belongs to a specific turnId.
    if (store._currentUnifyTurnId && store.activeVpTurns[store._currentUnifyTurnId]) {
      const { [store._currentUnifyTurnId]: _removed, ...rest } = store.activeVpTurns;
      store.activeVpTurns = rest;
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
