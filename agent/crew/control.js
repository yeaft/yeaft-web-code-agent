/**
 * Crew — 控制操作
 * pause, resume, stop, clear, abort, interrupt 等
 */
import { join } from 'path';
import { promises as fs } from 'fs';
import { sendCrewMessage, sendCrewOutput, sendStatusUpdate, endRoleStreaming } from './ui-messages.js';
import { saveRoleSessionId, clearRoleSessionId, createRoleQuery } from './role-query.js';
import { saveSessionMeta, cleanupMessageShards } from './persistence.js';
import { executeRoute, dispatchToRole } from './routing.js';
import { saveRoleWorkSummary } from './task-files.js';
import { getMessages } from '../crew-i18n.js';
import { cleanupWorktrees } from './worktree.js';
import { upsertCrewIndex } from './persistence.js';
import { processHumanQueue } from './human-interaction.js';

/**
 * 处理控制命令
 */
export async function handleCrewControl(msg) {
  // Lazy import to avoid circular dependency
  const { crewSessions } = await import('./session.js');

  const { sessionId, action, targetRole } = msg;
  const session = crewSessions.get(sessionId);
  if (!session) {
    console.warn(`[Crew] Session not found: ${sessionId}`);
    return;
  }

  switch (action) {
    case 'pause':
      await pauseAll(session);
      break;
    case 'resume':
      await resumeSession(session);
      break;
    case 'stop_role':
      if (targetRole) await stopRole(session, targetRole);
      break;
    case 'interrupt_role':
      if (targetRole && msg.content) {
        await interruptRole(session, targetRole, msg.content, 'human');
      }
      break;
    case 'abort_role':
      if (targetRole) await abortRole(session, targetRole);
      break;
    case 'clear_role':
      if (targetRole) await clearSingleRole(session, targetRole);
      break;
    case 'stop_all':
      await stopAll(session);
      break;
    case 'clear':
      await clearSession(session);
      break;
    default:
      console.warn(`[Crew] Unknown control action: ${action}`);
  }
}

/**
 * 清空单个角色的对话
 */
async function clearSingleRole(session, roleName) {
  const roleState = session.roleStates.get(roleName);

  // P0-1: 清除该角色在 humanMessageQueue 中的待处理消息，防止幽灵 ROUTE 执行
  if (session.humanMessageQueue.length > 0) {
    session.humanMessageQueue = session.humanMessageQueue.filter(m => m.target !== roleName);
  }

  if (roleState) {
    // 保存工作摘要到 task file（与 context_exceeded clear 一致）
    if (roleState.accumulatedText) {
      await saveRoleWorkSummary(session, roleName, roleState.accumulatedText).catch(e =>
        console.warn(`[Crew] Failed to save work summary for ${roleName}:`, e.message));
    }

    // P1-3: abort 并等待 query iterator 退出，避免 abort+dispatch 竞态
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    // 等待 query 完成（iterator 会因 AbortError 退出）
    if (roleState.query) {
      try {
        // Drain the iterator — it will throw AbortError and exit
        // eslint-disable-next-line no-empty
        for await (const _ of roleState.query) {}
      } catch {
        // Expected: AbortError or other cleanup errors
      }
    }

    roleState.query = null;
    roleState.inputStream = null;
    roleState.turnActive = false;
    roleState.claudeSessionId = null;
    roleState.consecutiveErrors = 0;
    roleState.accumulatedText = '';
    roleState.lastDispatchContent = null;
    roleState.lastDispatchFrom = null;
    roleState.lastDispatchTaskId = null;
    roleState.lastDispatchTaskTitle = null;
    // P0-3: 重置 UI 相关状态，防止显示过时信息
    roleState.currentTask = null;
    roleState.currentTool = null;
    roleState.lastTurnText = '';
  }

  await clearRoleSessionId(session.sharedDir, roleName);

  sendCrewMessage({
    type: 'crew_role_cleared',
    sessionId: session.id,
    role: roleName,
    reason: 'manual'
  });

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `${roleName} 对话已清空` }] }
  });
  sendStatusUpdate(session);
  console.log(`[Crew] Role ${roleName} cleared`);

  // 从 messageHistory 提取该角色最近 5 条相关消息，构造记忆恢复 prompt
  const roleMessages = session.messageHistory
    .filter(m => m.from === roleName || m.to === roleName)
    .slice(-5);
  if (roleMessages.length > 0) {
    const m = getMessages(session.language || 'zh-CN');
    const summary = roleMessages
      .map(msg => `[${msg.from} → ${msg.to}${msg.taskId ? ` (${msg.taskId})` : ''}] ${msg.content}`)
      .join('\n');
    const restorePrompt = `${m.memoryRestorePrompt}\n\n${summary}`;
    await dispatchToRole(session, roleName, restorePrompt, 'system');
  }
}

/**
 * 暂停所有角色
 */
async function pauseAll(session) {
  session.status = 'paused';

  for (const [roleName, roleState] of session.roleStates) {
    if (roleState.claudeSessionId) {
      await saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId)
        .catch(e => console.warn(`[Crew] Failed to save sessionId for ${roleName}:`, e.message));
    }
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    roleState.wasActive = roleState.turnActive;
    roleState.turnActive = false;
    roleState.query = null;
    roleState.inputStream = null;
  }

  console.log(`[Crew] Session ${session.id} paused, all active queries aborted`);

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Session 已暂停' }] }
  });
  sendStatusUpdate(session);

  await saveSessionMeta(session);
}

/**
 * 恢复 session
 */
async function resumeSession(session) {
  if (session.status !== 'paused') return;

  session.status = 'running';
  console.log(`[Crew] Session ${session.id} resumed`);

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Session 已恢复' }] }
  });
  sendStatusUpdate(session);

  if (session.pendingRoutes.length > 0) {
    const pending = session.pendingRoutes.slice();
    session.pendingRoutes = [];
    console.log(`[Crew] Replaying ${pending.length} pending route(s)`);
    // P1-5: 串行执行 pending routes，防止多个 route 指向同一角色时并发 dispatch
    for (const { fromRole, route } of pending) {
      try {
        await executeRoute(session, fromRole, route);
      } catch (err) {
        console.warn(`[Crew] Pending route replay failed:`, err);
      }
    }
    return;
  }

  await processHumanQueue(session);
}

/**
 * 中断角色当前 turn 并发送新消息
 */
async function interruptRole(session, roleName, newContent, fromSource = 'human') {
  const roleState = session.roleStates.get(roleName);
  if (!roleState) {
    console.warn(`[Crew] Cannot interrupt ${roleName}: no roleState`);
    return;
  }

  console.log(`[Crew] Interrupting ${roleName}`);

  endRoleStreaming(session, roleName);

  if (roleState.claudeSessionId) {
    await saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId)
      .catch(e => console.warn(`[Crew] Failed to save sessionId for ${roleName}:`, e.message));
  }

  if (roleState.abortController) {
    roleState.abortController.abort();
  }

  roleState.query = null;
  roleState.inputStream = null;
  roleState.turnActive = false;
  roleState.accumulatedText = '';

  // Mark pending tool messages as completed before notifying frontend
  for (const m of session.uiMessages) {
    if (m.role === roleName && m.type === 'tool' && !m.hasResult) {
      m.hasResult = true;
    }
  }

  sendCrewMessage({
    type: 'crew_turn_completed',
    sessionId: session.id,
    role: roleName,
    interrupted: true
  });

  sendStatusUpdate(session);

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `${roleName} 被中断` }] }
  });

  await dispatchToRole(session, roleName, newContent, fromSource);
}

/**
 * 中止角色当前 turn
 */
async function abortRole(session, roleName) {
  const roleState = session.roleStates.get(roleName);
  if (!roleState) {
    console.warn(`[Crew] Cannot abort ${roleName}: no roleState`);
    return;
  }

  if (!roleState.turnActive) {
    console.log(`[Crew] ${roleName} is not active, nothing to abort`);
    return;
  }

  console.log(`[Crew] Aborting ${roleName}`);

  endRoleStreaming(session, roleName);

  if (roleState.claudeSessionId) {
    await saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId)
      .catch(e => console.warn(`[Crew] Failed to save sessionId for ${roleName}:`, e.message));
  }

  if (roleState.abortController) {
    roleState.abortController.abort();
  }

  roleState.query = null;
  roleState.inputStream = null;
  roleState.turnActive = false;
  roleState.accumulatedText = '';

  // Mark pending tool messages as completed before notifying frontend
  for (const m of session.uiMessages) {
    if (m.role === roleName && m.type === 'tool' && !m.hasResult) {
      m.hasResult = true;
    }
  }

  sendCrewMessage({
    type: 'crew_turn_completed',
    sessionId: session.id,
    role: roleName,
    interrupted: true
  });

  sendStatusUpdate(session);

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `${roleName} 已中止` }] }
  });
}

async function stopRole(session, roleName) {
  const roleState = session.roleStates.get(roleName);
  if (roleState) {
    if (roleState.claudeSessionId) {
      await saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId)
        .catch(e => console.warn(`[Crew] Failed to save sessionId for ${roleName}:`, e.message));
    }
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    roleState.query = null;
    roleState.inputStream = null;
    roleState.turnActive = false;
    session.roleStates.delete(roleName);
  }

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `${roleName} 已停止` }] }
  });
  sendStatusUpdate(session);
  console.log(`[Crew] Role ${roleName} stopped`);
}

/**
 * 终止整个 session
 */
async function stopAll(session) {
  const { crewSessions } = await import('./session.js');

  session.status = 'stopped';

  for (const [roleName, roleState] of session.roleStates) {
    if (roleState.claudeSessionId) {
      await saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId)
        .catch(e => console.warn(`[Crew] Failed to save sessionId for ${roleName}:`, e.message));
    }
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    console.log(`[Crew] Stopping role: ${roleName}`);
  }
  session.roleStates.clear();

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Session 已终止' }] }
  });
  sendStatusUpdate(session);

  await cleanupWorktrees(session.projectDir);

  await saveSessionMeta(session);
  await upsertCrewIndex(session);

  crewSessions.delete(session.id);
  console.log(`[Crew] Session ${session.id} stopped`);
}

/**
 * 清空 session
 */
async function clearSession(session) {
  // P1-2: 先重置 _processingHumanQueue，防止后续消息处理被阻塞
  session._processingHumanQueue = false;

  for (const [roleName, roleState] of session.roleStates) {
    if (roleState.abortController) {
      roleState.abortController.abort();
    }
    console.log(`[Crew] Clearing role: ${roleName}`);
  }
  session.roleStates.clear();

  for (const [roleName] of session.roles) {
    await clearRoleSessionId(session.sharedDir, roleName);
  }

  // P1-1: humanMessageQueue 在这里清空，确保不会有幽灵消息在 clear 后被处理
  session.messageHistory = [];
  session.uiMessages = [];
  session.humanMessageQueue = [];
  session.waitingHumanContext = null;
  session.pendingRoutes = [];

  // 清除 feature/task 数据，避免 UI 残留空 task 卡片
  session.features.clear();
  session._completedTaskIds = new Set();

  session.round = 0;

  // 重置计费统计（clearSession 清除了所有 claudeSessionId，后续 query 全新，费用从零开始）
  session.costUsd = 0;
  session.totalInputTokens = 0;
  session.totalOutputTokens = 0;

  const messagesPath = join(session.sharedDir, 'messages.json');
  await fs.writeFile(messagesPath, '[]').catch(() => {});
  await cleanupMessageShards(session.sharedDir);

  session.status = 'running';

  sendCrewMessage({
    type: 'crew_session_cleared',
    sessionId: session.id
  });

  sendCrewOutput(session, 'system', 'system', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '会话已清空，所有角色将使用全新对话' }] }
  });
  sendStatusUpdate(session);

  await saveSessionMeta(session);

  console.log(`[Crew] Session ${session.id} cleared`);
}
