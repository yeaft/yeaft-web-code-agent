/**
 * Conductor — Session 核心
 *
 * 管理 Conductor session 的完整生命周期。
 * 与 V1 Crew 的关键区别：
 * - 不绑定固定工作路径，workDir 可动态切换
 * - 不定义固定角色列表，task 创建时由 orchestrator 决定
 * - session 级元数据存在 ~/.claude/conductor/<sessionId>/
 */
import { randomUUID } from 'crypto';
import ctx from '../context.js';
import {
  loadConductorIndex, upsertConductorIndex,
  loadSessionMeta, saveSessionMeta, loadSessionMessages,
  getMaxShardIndex, getSessionDataDir, initSessionDataDir,
  cleanupMessageShards
} from './persistence.js';
import {
  sendConductorMessage, sendConductorOutput, sendStatusUpdate, recordUserMessage
} from './ui-messages.js';
import { createConductorClaude, sendToConductor, stopConductorClaude } from './conductor-claude.js';

// =====================================================================
// Data Structures
// =====================================================================

/** @type {Map<string, ConductorSession>} */
export const conductorSessions = new Map();

// =====================================================================
// Session Lifecycle
// =====================================================================

/**
 * 创建 Conductor Session
 */
export async function createConductorSession(msg) {
  const {
    sessionId = randomUUID(),
    name = '',
    workDir = null,
    scenarioId = null,
    userId,
    username
  } = msg;

  const session = {
    id: sessionId,
    name: name || 'Conductor',
    workDir,
    scenarioId,
    status: 'running',
    tasks: new Map(),
    conductorState: null,
    costUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    activeClaudes: 0,
    uiMessages: [],
    userId,
    username,
    agentId: ctx.CONFIG?.agentName || null,
    createdAt: Date.now(),
    _rotating: false,
    _conductorSemRelease: null
  };

  conductorSessions.set(sessionId, session);

  // 初始化数据目录
  await initSessionDataDir(sessionId);

  // 通知前端
  sendConductorMessage({
    type: 'conductor_session_created',
    sessionId,
    name: session.name,
    workDir: session.workDir,
    scenarioId: session.scenarioId,
    userId,
    username
  });

  sendStatusUpdate(session);

  // 注册到全局 index
  await upsertConductorIndex(session);
  await saveSessionMeta(session);

  // 启动 Conductor Claude
  try {
    await createConductorClaude(session);
    console.log(`[Conductor] Session ${sessionId} created, Claude ready`);
  } catch (e) {
    console.error('[Conductor] Failed to start Claude:', e.message);
    sendConductorOutput(session, 'system', {
      message: { role: 'assistant', content: `Conductor 启动失败: ${e.message}` }
    });
  }

  return session;
}

/**
 * 列出所有 conductor sessions
 */
export async function handleListConductorSessions(msg) {
  const { requestId, _requestClientId } = msg;
  const index = await loadConductorIndex();

  const agentId = ctx.CONFIG?.agentName || null;
  const filtered = agentId
    ? index.filter(e => !e.agentId || e.agentId === agentId)
    : index;

  // 更新活跃 session 的状态
  for (const entry of filtered) {
    const active = conductorSessions.get(entry.sessionId);
    if (active) {
      entry.status = active.status;
    }
  }

  ctx.sendToServer({
    type: 'conductor_sessions_list',
    requestId,
    _requestClientId,
    sessions: filtered.filter(e => !e.hidden)
  });
}

/**
 * 恢复已停止的 conductor session
 */
export async function resumeConductorSession(msg) {
  const { sessionId, userId, username } = msg;

  // 已在内存中
  if (conductorSessions.has(sessionId)) {
    const session = conductorSessions.get(sessionId);
    // 加载 UI 消息
    if (!session.uiMessages || session.uiMessages.length === 0) {
      const loaded = await loadSessionMessages(sessionId);
      session.uiMessages = loaded.messages;
    }
    const cleaned = (session.uiMessages || []).map(m => {
      const { _streaming, ...rest } = m;
      return rest;
    });
    const dir = getSessionDataDir(sessionId);
    const hasOlderMessages = await getMaxShardIndex(dir) > 0;

    sendConductorMessage({
      type: 'conductor_session_restored',
      sessionId,
      name: session.name,
      workDir: session.workDir,
      scenarioId: session.scenarioId,
      tasks: Array.from(session.tasks.values()),
      userId: session.userId,
      username: session.username,
      uiMessages: cleaned,
      hasOlderMessages
    });
    sendStatusUpdate(session);
    return;
  }

  // 从磁盘恢复
  const meta = await loadSessionMeta(sessionId);
  if (!meta) {
    sendConductorMessage({
      type: 'error', sessionId,
      message: 'Conductor session not found'
    });
    return;
  }

  const session = {
    id: sessionId,
    name: meta.name || '',
    workDir: meta.workDir || null,
    scenarioId: meta.scenarioId || null,
    status: 'running',
    tasks: new Map((meta.tasks || []).map(t => [t.taskId, t])),
    conductorState: null,
    costUsd: meta.costUsd || 0,
    totalInputTokens: meta.totalInputTokens || 0,
    totalOutputTokens: meta.totalOutputTokens || 0,
    activeClaudes: 0,
    uiMessages: [],
    userId: userId || meta.userId,
    username: username || meta.username,
    agentId: meta.agentId || ctx.CONFIG?.agentName || null,
    createdAt: meta.createdAt || Date.now(),
    _rotating: false,
    _conductorSemRelease: null
  };

  conductorSessions.set(sessionId, session);

  const loaded = await loadSessionMessages(sessionId);
  session.uiMessages = loaded.messages;

  sendConductorMessage({
    type: 'conductor_session_restored',
    sessionId,
    name: session.name,
    workDir: session.workDir,
    scenarioId: session.scenarioId,
    tasks: Array.from(session.tasks.values()),
    userId: session.userId,
    username: session.username,
    uiMessages: session.uiMessages,
    hasOlderMessages: loaded.hasOlderMessages
  });
  sendStatusUpdate(session);

  // 启动 Conductor Claude
  try {
    await createConductorClaude(session);
    console.log(`[Conductor] Session ${sessionId} resumed, Claude ready`);
  } catch (e) {
    console.error('[Conductor] Failed to resume Claude:', e.message);
  }

  await upsertConductorIndex(session);
  await saveSessionMeta(session);
}

/**
 * 处理用户输入
 */
export async function handleConductorUserInput(msg) {
  const { sessionId, content } = msg;
  const session = conductorSessions.get(sessionId);
  if (!session) {
    console.warn(`[Conductor] Session not found: ${sessionId}`);
    return;
  }

  // 确保 session 在运行态（先检查再记录，避免停止态也记录消息）
  if (session.status === 'stopped') {
    sendConductorMessage({
      type: 'conductor_error',
      sessionId,
      error: 'Session is stopped'
    });
    return;
  }

  // 记录到 UI
  recordUserMessage(session, content);

  session.status = 'running';

  // 发给 Conductor Claude
  await sendToConductor(session, content);
}

/**
 * 更新工作路径
 */
export async function handleUpdateWorkDir(msg) {
  const { sessionId, workDir } = msg;
  const session = conductorSessions.get(sessionId);
  if (!session) return;

  session.workDir = workDir;
  console.log(`[Conductor] Session ${sessionId} workDir updated: ${workDir}`);

  sendConductorMessage({
    type: 'conductor_workdir_updated',
    sessionId,
    workDir
  });
  sendStatusUpdate(session);
  await saveSessionMeta(session);
}

/**
 * 更新 session name
 */
export async function handleUpdateConductorSession(msg) {
  const { sessionId, name, workDir } = msg;
  const session = conductorSessions.get(sessionId);
  if (!session) return;

  if (name !== undefined) session.name = name;
  if (workDir !== undefined) session.workDir = workDir;
  await saveSessionMeta(session);
  await upsertConductorIndex(session);
}

/**
 * 停止 session
 */
export async function stopConductorSession(sessionId) {
  const session = conductorSessions.get(sessionId);
  if (!session) return;

  session.status = 'stopped';

  // 停止 Conductor Claude
  await stopConductorClaude(session);

  sendConductorOutput(session, 'system', {
    message: { role: 'assistant', content: 'Session 已停止' }
  });
  sendStatusUpdate(session);
  await saveSessionMeta(session);
  await upsertConductorIndex(session);

  conductorSessions.delete(sessionId);
  console.log(`[Conductor] Session ${sessionId} stopped`);
}

/**
 * 清空 session
 */
export async function clearConductorSession(sessionId) {
  const session = conductorSessions.get(sessionId);
  if (!session) return;

  // 停止 Claude
  await stopConductorClaude(session);

  // 清空数据
  session.tasks.clear();
  session.uiMessages = [];
  session.costUsd = 0;
  session.totalInputTokens = 0;
  session.totalOutputTokens = 0;

  const dir = getSessionDataDir(sessionId);
  await cleanupMessageShards(dir);

  session.status = 'running';

  sendConductorMessage({
    type: 'conductor_session_cleared',
    sessionId
  });
  sendStatusUpdate(session);

  // 重启 Claude
  try {
    await createConductorClaude(session);
  } catch (e) {
    console.error('[Conductor] Failed to restart Claude after clear:', e.message);
  }

  await saveSessionMeta(session);
  console.log(`[Conductor] Session ${sessionId} cleared`);
}
