/**
 * Conductor — UI 消息辅助函数
 *
 * 与 crew/ui-messages.js 结构一致，但用 conductor_ 前缀的消息类型。
 * 核心职责：向 server 发送 WebSocket 消息，维护 uiMessages 持久化列表。
 */
import ctx from '../context.js';
import { upsertConductorIndex, saveSessionMeta } from './persistence.js';

/**
 * 发送 conductor 消息到 server（透传到 Web 前端）
 */
export function sendConductorMessage(msg) {
  if (ctx.sendToServer) {
    ctx.sendToServer(msg);
  }
}

/**
 * 发送 Conductor Claude 的输出到前端
 * outputType: 'text' | 'tool_use' | 'tool_result' | 'system' | 'task_created' | 'task_forwarded'
 */
export function sendConductorOutput(session, outputType, rawMessage, extra = {}) {
  sendConductorMessage({
    type: 'conductor_output',
    sessionId: session.id,
    outputType,
    data: rawMessage,
    ...extra
  });

  // 记录精简 UI 消息
  if (outputType === 'text') {
    const content = rawMessage?.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content.filter(b => b.type === 'text').map(b => b.text).join('');
    }
    if (!text) return;
    // 反向查找 streaming 消息
    let found = false;
    for (let i = session.uiMessages.length - 1; i >= 0; i--) {
      const msg = session.uiMessages[i];
      if (msg.source === 'conductor' && msg.type === 'text' && msg._streaming) {
        msg.content += text;
        found = true;
        break;
      }
    }
    if (!found) {
      session.uiMessages.push({
        source: 'conductor', type: 'text', content: text,
        _streaming: true, timestamp: Date.now()
      });
    }
  } else if (outputType === 'system') {
    const content = rawMessage?.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.filter(b => b.type === 'text').map(b => b.text).join('');
    if (!text) return;
    session.uiMessages.push({
      source: 'conductor', type: 'system', content: text, timestamp: Date.now()
    });
  } else if (outputType === 'task_created') {
    session.uiMessages.push({
      source: 'conductor', type: 'task_created',
      taskId: extra.taskId, taskTitle: extra.taskTitle,
      content: `Created task: ${extra.taskTitle}`,
      timestamp: Date.now()
    });
  } else if (outputType === 'task_forwarded') {
    session.uiMessages.push({
      source: 'conductor', type: 'task_forwarded',
      taskId: extra.taskId,
      content: `Forwarded message to task: ${extra.taskId}`,
      timestamp: Date.now()
    });
  } else if (outputType === 'tool_use') {
    endConductorStreaming(session);
    const content = rawMessage?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          const input = block.input || {};
          const trimmedInput = {};
          if (input.file_path) trimmedInput.file_path = input.file_path;
          if (input.command) trimmedInput.command = input.command.substring(0, 200);
          if (input.pattern) trimmedInput.pattern = input.pattern;
          session.uiMessages.push({
            source: 'conductor', type: 'tool',
            toolName: block.name, toolId: block.id,
            toolInput: Object.keys(trimmedInput).length > 0 ? trimmedInput : null,
            content: `${block.name} ${input.file_path || input.command?.substring(0, 60) || ''}`,
            hasResult: false,
            timestamp: Date.now()
          });
        }
      }
    }
  } else if (outputType === 'tool_result') {
    const toolId = rawMessage?.message?.tool_use_id;
    if (toolId) {
      for (let i = session.uiMessages.length - 1; i >= 0; i--) {
        if (session.uiMessages[i].type === 'tool' && session.uiMessages[i].toolId === toolId) {
          session.uiMessages[i].hasResult = true;
          break;
        }
      }
    }
  }
}

/**
 * 结束 Conductor 的 streaming 消息
 */
export function endConductorStreaming(session) {
  for (let i = session.uiMessages.length - 1; i >= 0; i--) {
    if (session.uiMessages[i].source === 'conductor' && session.uiMessages[i]._streaming) {
      delete session.uiMessages[i]._streaming;
      break;
    }
  }
}

/**
 * 记录用户消息到 uiMessages
 */
export function recordUserMessage(session, content) {
  session.uiMessages.push({
    source: 'user', type: 'text', content,
    timestamp: Date.now()
  });
}

/**
 * 发送 session 状态更新到前端
 */
export function sendStatusUpdate(session) {
  const tasks = Array.from(session.tasks.values()).map(t => ({
    taskId: t.taskId,
    title: t.title,
    workDir: t.workDir,
    status: t.status,
    phase: t.phase,
    progress: t.progress,
    activeActors: t.activeActors || [],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt
  }));

  sendConductorMessage({
    type: 'conductor_status',
    sessionId: session.id,
    status: session.status,
    workDir: session.workDir,
    tasks,
    costUsd: session.costUsd,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    activeClaudes: session.activeClaudes || 0
  });

  // 异步持久化
  upsertConductorIndex(session).catch(e => console.warn('[Conductor] Failed to update index:', e.message));
  saveSessionMeta(session).catch(e => console.warn('[Conductor] Failed to save meta:', e.message));
}
