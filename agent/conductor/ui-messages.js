/**
 * Conductor — UI Message Helpers (V5)
 *
 * Sends WebSocket messages to server/frontend.
 * Maintains uiMessages persistence list on the conductor instance.
 *
 * No sessionId — Conductor is a singleton per Agent.
 */
import ctx from '../context.js';
import { saveConductorMeta } from './persistence.js';

/**
 * Send conductor message to server (forwarded to Web frontend)
 */
export function sendConductorMessage(msg) {
  if (ctx.sendToServer) {
    ctx.sendToServer(msg);
  }
}

/**
 * Send Conductor Claude output to frontend
 * outputType: 'text' | 'tool_use' | 'tool_result' | 'system' | 'task_creating' | 'task_created' | 'task_forwarded'
 */
export function sendConductorOutput(conductor, outputType, rawMessage, extra = {}) {
  sendConductorMessage({
    type: 'conductor_output',
    outputType,
    data: rawMessage,
    ...extra
  });

  // Record trimmed UI messages
  if (outputType === 'text') {
    const content = rawMessage?.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content.filter(b => b.type === 'text').map(b => b.text).join('');
    }
    if (!text) return;
    let found = false;
    for (let i = conductor.uiMessages.length - 1; i >= 0; i--) {
      const msg = conductor.uiMessages[i];
      if (msg.source === 'conductor' && msg.type === 'text' && msg._streaming) {
        msg.content += text;
        found = true;
        break;
      }
    }
    if (!found) {
      conductor.uiMessages.push({
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
    conductor.uiMessages.push({
      source: 'conductor', type: 'system', content: text, timestamp: Date.now()
    });
  } else if (outputType === 'task_creating') {
    conductor.uiMessages.push({
      source: 'conductor', type: 'task_creating',
      taskId: extra.taskId, taskTitle: extra.taskTitle,
      content: `Creating task: ${extra.taskTitle}...`,
      timestamp: Date.now()
    });
  } else if (outputType === 'task_created') {
    conductor.uiMessages.push({
      source: 'conductor', type: 'task_created',
      taskId: extra.taskId, taskTitle: extra.taskTitle,
      content: `Created task: ${extra.taskTitle}`,
      timestamp: Date.now()
    });
  } else if (outputType === 'task_forwarded') {
    conductor.uiMessages.push({
      source: 'conductor', type: 'task_forwarded',
      taskId: extra.taskId,
      content: `Forwarded message to task: ${extra.taskId}`,
      timestamp: Date.now()
    });
  } else if (outputType === 'tool_use') {
    endConductorStreaming(conductor);
    const content = rawMessage?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          const input = block.input || {};
          const trimmedInput = {};
          if (input.file_path) trimmedInput.file_path = input.file_path;
          if (input.command) trimmedInput.command = input.command.substring(0, 200);
          if (input.pattern) trimmedInput.pattern = input.pattern;
          conductor.uiMessages.push({
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
      for (let i = conductor.uiMessages.length - 1; i >= 0; i--) {
        if (conductor.uiMessages[i].type === 'tool' && conductor.uiMessages[i].toolId === toolId) {
          conductor.uiMessages[i].hasResult = true;
          break;
        }
      }
    }
  }
}

/**
 * End Conductor streaming message
 */
export function endConductorStreaming(conductor) {
  for (let i = conductor.uiMessages.length - 1; i >= 0; i--) {
    if (conductor.uiMessages[i].source === 'conductor' && conductor.uiMessages[i]._streaming) {
      delete conductor.uiMessages[i]._streaming;
      break;
    }
  }
}

/**
 * Record user message to uiMessages
 */
export function recordUserMessage(conductor, content) {
  conductor.uiMessages.push({
    source: 'user', type: 'text', content,
    timestamp: Date.now()
  });
}

/**
 * Send conductor status update to frontend
 */
export function sendStatusUpdate(conductor) {
  const tasks = {};
  for (const [taskId, t] of conductor.tasks) {
    tasks[taskId] = {
      taskId: t.taskId,
      title: t.title,
      workDir: t.workDir,
      scenario: t.scenario,
      status: t.status,
      activeActors: t.activeActors || [],
      currentStep: t.currentStep || '',
      lastUpdate: t.lastUpdate || t.updatedAt
    };
  }

  sendConductorMessage({
    type: 'conductor_status',
    status: conductor.status,
    tasks,
    costUsd: conductor.costUsd,
    totalInputTokens: conductor.totalInputTokens,
    totalOutputTokens: conductor.totalOutputTokens,
    activeClaudes: conductor.activeClaudes || 0
  });

  // Async persist
  saveConductorMeta(conductor).catch(e =>
    console.warn('[Conductor] Failed to save meta:', e.message)
  );
}
