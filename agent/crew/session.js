/**
 * Crew Session — 核心数据结构、角色展开和 Session 生命周期管理
 */
import { promises as fs } from 'fs';
import { join, isAbsolute } from 'path';
import ctx from '../context.js';
import { getMessages } from '../crew-i18n.js';
import { initWorktrees } from './worktree.js';
import { initSharedDir, writeRoleClaudeMd, updateSharedClaudeMd, backupMemoryContent } from './shared-dir.js';
import {
  loadCrewIndex, upsertCrewIndex, removeFromCrewIndex,
  loadSessionMeta, saveSessionMeta, loadSessionMessages, getMaxShardIndex
} from './persistence.js';
import { sendCrewMessage, sendCrewOutput, sendStatusUpdate } from './ui-messages.js';
import { preloadSlashCommands } from '../conversation.js';

// =====================================================================
// Data Structures
// =====================================================================

/** @type {Map<string, CrewSession>} */
export const crewSessions = new Map();

// =====================================================================
// Role Multi-Instance Expansion
// =====================================================================

const SHORT_PREFIX = {
  developer: 'dev',
  tester: 'test',
  reviewer: 'rev'
};

const EXPANDABLE_ROLES = new Set(['developer', 'tester', 'reviewer']);

/**
 * 展开角色列表：count > 1 的执行者角色展开为多个实例
 */
export function expandRoles(roles) {
  const devRole = roles.find(r => r.name === 'developer');
  const devCount = devRole?.count > 1 ? devRole.count : 1;

  const expanded = [];
  for (const role of roles) {
    const isExpandable = EXPANDABLE_ROLES.has(role.name);
    const count = isExpandable ? devCount : 1;

    if (count <= 1) {
      expanded.push({
        ...role,
        roleType: role.name,
        groupIndex: isExpandable ? 1 : 0
      });
    } else {
      const prefix = SHORT_PREFIX[role.name] || role.name;
      for (let i = 1; i <= count; i++) {
        expanded.push({
          ...role,
          name: `${prefix}-${i}`,
          displayName: `${role.displayName}-${i}`,
          roleType: role.name,
          groupIndex: i,
          count: undefined
        });
      }
    }
  }
  return expanded;
}

/** Format role label */
export function roleLabel(r) {
  return r.icon ? `${r.icon} ${r.displayName}` : r.displayName;
}

// =====================================================================
// Path Validation
// =====================================================================

function isValidProjectDir(dir) {
  if (!dir || typeof dir !== 'string') return false;
  if (!isAbsolute(dir)) return false;
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(dir)) return false;
  return true;
}

// =====================================================================
// Session Lifecycle
// =====================================================================

/**
 * 生成角色配置的规范化签名（sorted role name list）
 * 用于比较新旧 session 的角色配置是否一致
 */
export function getRolesSignature(roles) {
  if (!roles || roles.length === 0) return '';
  const names = roles.map(r => r.name).sort();
  return names.join(',');
}

/**
 * 查找指定 projectDir 的已有 crew session
 * 返回 { sessionId, source, roles } 或 null
 */
async function findExistingSessionByProjectDir(projectDir) {
  const normalizedDir = projectDir.replace(/\/+$/, '');

  for (const [, session] of crewSessions) {
    if (session.projectDir.replace(/\/+$/, '') === normalizedDir
        && session.status !== 'completed') {
      return {
        sessionId: session.id,
        source: 'active',
        roles: Array.from(session.roles.values())
      };
    }
  }

  const index = await loadCrewIndex();
  const agentId = ctx.CONFIG?.agentName || null;
  const match = index.find(e =>
    e.projectDir.replace(/\/+$/, '') === normalizedDir
    && (!agentId || !e.agentId || e.agentId === agentId)
    && e.status !== 'completed'
  );

  if (match) {
    const meta = await loadSessionMeta(match.sharedDir);
    if (meta) return { sessionId: match.sessionId, source: 'index', roles: meta.roles || [] };
    await removeFromCrewIndex(match.sessionId);
  }

  return null;
}

/**
 * 创建 Crew Session
 */
export async function createCrewSession(msg) {
  const {
    sessionId,
    projectDir,
    sharedDir: sharedDirRel,
    name,
    roles: rawRoles = [],
    teamType = 'dev',
    language = 'zh-CN',
    userId,
    username
  } = msg;

  // 同目录检查：如果已有同目录的 session，比较角色配置
  const existingSession = await findExistingSessionByProjectDir(projectDir);
  if (existingSession) {
    const newRoles = expandRoles(rawRoles);
    const newSig = getRolesSignature(newRoles);
    const oldSig = getRolesSignature(existingSession.roles);

    if (newSig === oldSig) {
      // 角色配置相同，安全 auto-resume
      console.log(`[Crew] Found existing session for ${projectDir}: ${existingSession.sessionId}, roles match, auto-resuming`);
      await resumeCrewSession({ sessionId: existingSession.sessionId, userId, username });
      return;
    }

    // 角色配置不同 → 清理旧 session，用新配置走正常创建流程
    console.log(`[Crew] Roles changed for ${projectDir}: old=[${oldSig}] new=[${newSig}], discarding old session ${existingSession.sessionId}`);
    if (existingSession.source === 'active') {
      crewSessions.delete(existingSession.sessionId);
    }
    await removeFromCrewIndex(existingSession.sessionId);
  }

  const roles = expandRoles(rawRoles);
  const sharedDir = sharedDirRel?.startsWith('/')
    ? sharedDirRel
    : join(projectDir, sharedDirRel || '.crew');
  const decisionMaker = roles.find(r => r.isDecisionMaker)?.name || roles[0]?.name || null;

  // 尝试读取旧 session.json，合并统计数据（deleteCrewDir 保留了该文件）
  const oldMeta = await loadSessionMeta(sharedDir);

  const session = {
    id: sessionId,
    projectDir,
    sharedDir,
    name: name || '',
    roles: new Map(roles.map(r => [r.name, r])),
    roleStates: new Map(),
    decisionMaker,
    status: 'initializing',
    round: oldMeta?.round || 0,
    costUsd: oldMeta?.costUsd || 0,
    totalInputTokens: oldMeta?.totalInputTokens || 0,
    totalOutputTokens: oldMeta?.totalOutputTokens || 0,
    messageHistory: [],
    uiMessages: [],
    humanMessageQueue: [],
    waitingHumanContext: null,
    pendingRoutes: [],
    features: new Map((oldMeta?.features || []).map(f => [f.taskId, f])),
    _completedTaskIds: new Set(oldMeta?._completedTaskIds || []),
    initProgress: null,
    userId,
    username,
    agentId: ctx.CONFIG?.agentName || null,
    teamType,
    language,
    createdAt: oldMeta?.createdAt || Date.now()
  };

  if (oldMeta) {
    console.log(`[Crew] Merged stats from previous session: round=${session.round}, cost=$${session.costUsd.toFixed(4)}, inputTokens=${session.totalInputTokens}, outputTokens=${session.totalOutputTokens}`);
    // 恢复旧消息历史（deleteCrewDir 保留了 messages*.json）
    const loaded = await loadSessionMessages(sharedDir);
    if (loaded.messages.length > 0) {
      session.uiMessages = loaded.messages;
      console.log(`[Crew] Restored ${loaded.messages.length} messages from previous session`);
    }
  }

  crewSessions.set(sessionId, session);

  // 如果有旧消息，检查是否有更早的分片
  const hasOlderMessages = oldMeta ? await getMaxShardIndex(sharedDir) > 0 : false;

  sendCrewMessage({
    type: 'crew_session_created',
    sessionId,
    projectDir,
    sharedDir,
    name: name || '',
    roles: roles.map(r => ({
      name: r.name,
      displayName: r.displayName,
      icon: r.icon,
      description: r.description,
      isDecisionMaker: r.isDecisionMaker || false,
      model: r.model,
      roleType: r.roleType,
      groupIndex: r.groupIndex
    })),
    decisionMaker,
    userId,
    username,
    // 旧消息（recreate 时保留的历史）
    uiMessages: session.uiMessages.length > 0 ? session.uiMessages : undefined,
    hasOlderMessages: hasOlderMessages || undefined
  });

  sendStatusUpdate(session);

  try {
    session.initProgress = 'roles';
    sendStatusUpdate(session);
    await initSharedDir(sharedDir, roles, projectDir, language);

    const groupIndices = [...new Set(roles.filter(r => r.groupIndex > 0).map(r => r.groupIndex))];
    if (groupIndices.length > 0) {
      session.initProgress = 'worktrees';
      sendStatusUpdate(session);
    }
    const worktreeMap = await initWorktrees(projectDir, roles);

    for (const role of roles) {
      if (role.groupIndex > 0 && worktreeMap.has(role.groupIndex)) {
        role.workDir = worktreeMap.get(role.groupIndex);
        await writeRoleClaudeMd(sharedDir, role, language, roles);
      }
    }

    await upsertCrewIndex(session);
    await saveSessionMeta(session);

    if (session.status === 'initializing') {
      session.status = 'running';
    }
    session.initProgress = null;
    sendStatusUpdate(session);
  } catch (e) {
    console.error('[Crew] Session initialization failed:', e);
    if (session.status === 'initializing') {
      session.status = 'running';
    }
    session.initProgress = null;
    sendStatusUpdate(session);
    sendCrewMessage({
      type: 'crew_output',
      sessionId,
      roleName: 'system',
      roleIcon: 'S',
      roleDisplayName: '系统',
      content: `工作环境初始化失败: ${e.message}`,
      isTurnEnd: true
    });
  }

  // ★ Preload project-level skills for crew session input autocomplete
  preloadSlashCommands(projectDir, sessionId).catch(() => {});

  return session;
}

// =====================================================================
// List & Resume Sessions
// =====================================================================

/**
 * 列出所有 crew sessions
 */
export async function handleListCrewSessions(msg) {
  const { requestId, _requestClientId } = msg;
  const index = await loadCrewIndex();

  const agentId = ctx.CONFIG?.agentName || null;
  const filtered = agentId
    ? index.filter(e => !e.agentId || e.agentId === agentId)
    : index;

  for (const entry of filtered) {
    const active = crewSessions.get(entry.sessionId);
    if (active) {
      entry.status = active.status;
    }
  }

  ctx.sendToServer({
    type: 'crew_sessions_list',
    requestId,
    _requestClientId,
    sessions: filtered
  });
}

/**
 * 检查工作目录下是否存在 .crew 目录
 */
export async function handleCheckCrewExists(msg) {
  const { projectDir, requestId, _requestClientId } = msg;
  if (!projectDir || !isValidProjectDir(projectDir)) {
    ctx.sendToServer({
      type: 'crew_exists_result',
      requestId,
      _requestClientId,
      exists: false,
      error: 'projectDir is required'
    });
    return;
  }

  const crewDir = join(projectDir, '.crew');
  try {
    const stat = await fs.stat(crewDir);
    if (stat.isDirectory()) {
      let sessionInfo = null;
      try {
        const sessionPath = join(crewDir, 'session.json');
        const data = await fs.readFile(sessionPath, 'utf-8');
        sessionInfo = JSON.parse(data);
      } catch {}
      ctx.sendToServer({
        type: 'crew_exists_result',
        requestId,
        _requestClientId,
        exists: true,
        projectDir,
        sessionInfo
      });
    } else {
      ctx.sendToServer({
        type: 'crew_exists_result',
        requestId,
        _requestClientId,
        exists: false,
        projectDir
      });
    }
  } catch {
    ctx.sendToServer({
      type: 'crew_exists_result',
      requestId,
      _requestClientId,
      exists: false,
      projectDir
    });
  }
}

/**
 * 删除 Crew 定义文件（模板/角色配置），保留所有用户数据和工作产出
 *
 * 删除: CLAUDE.md（共享模板）、roles/（角色模板）
 * 清空: sessions/ 下的文件（旧角色的 Claude Code session IDs，已失效）
 * 清除: crew-index 中的旧 entry（防止 createCrewSession 走 resume 而非 create）
 * 保留: context/、session.json、messages*.json 及任何其他生成文件（截图、设计文档等）
 */
export async function handleDeleteCrewDir(msg) {
  const { projectDir } = msg;
  if (!isValidProjectDir(projectDir)) return;
  const crewDir = join(projectDir, '.crew');
  try {
    // 提取并备份记忆内容（删除前）
    await backupMemoryContent(crewDir);

    // 删除 Crew 模板定义
    await fs.rm(join(crewDir, 'CLAUDE.md'), { force: true }).catch(() => {});
    await fs.rm(join(crewDir, 'roles'), { recursive: true, force: true }).catch(() => {});

    // 清空 sessions/ 内容（旧角色的 session IDs 已失效），保留目录本身
    const sessionsDir = join(crewDir, 'sessions');
    try {
      const sessionFiles = await fs.readdir(sessionsDir);
      await Promise.all(
        sessionFiles.map(f => fs.rm(join(sessionsDir, f), { recursive: true, force: true }).catch(() => {}))
      );
    } catch { /* sessions/ may not exist */ }

    // 清除 crew-index 中的旧 entry（不删文件），确保新建时走 create → loadSessionMeta 合并统计
    const normalizedDir = projectDir.replace(/\/+$/, '');
    const index = await loadCrewIndex();
    const match = index.find(e => e.projectDir.replace(/\/+$/, '') === normalizedDir);
    if (match) {
      await removeFromCrewIndex(match.sessionId);
      console.log(`[Crew] Cleared index entry for ${projectDir} (sessionId: ${match.sessionId})`);
    }
  } catch {}
}

/**
 * 恢复已停止的 crew session
 */
export async function resumeCrewSession(msg) {
  const { sessionId, userId, username } = msg;

  if (crewSessions.has(sessionId)) {
    const session = crewSessions.get(sessionId);
    const roles = Array.from(session.roles.values());
    if ((!session.uiMessages || session.uiMessages.length === 0) && session.sharedDir) {
      const loaded = await loadSessionMessages(session.sharedDir);
      session.uiMessages = loaded.messages;
    }
    const cleanedMessages = (session.uiMessages || []).map(m => {
      const { _streaming, ...rest } = m;
      return rest;
    });
    const hasOlderMessages = await getMaxShardIndex(session.sharedDir) > 0;

    sendCrewMessage({
      type: 'crew_session_restored',
      sessionId,
      projectDir: session.projectDir,
      sharedDir: session.sharedDir,
      name: session.name || '',
      roles: roles.map(r => ({
        name: r.name, displayName: r.displayName, icon: r.icon,
        description: r.description, isDecisionMaker: r.isDecisionMaker || false,
        groupIndex: r.groupIndex, roleType: r.roleType, model: r.model
      })),
      decisionMaker: session.decisionMaker,
      userId: session.userId,
      username: session.username,
      uiMessages: cleanedMessages,
      hasOlderMessages
    });
    sendStatusUpdate(session);
    // ★ Preload project-level skills for crew session input autocomplete
    preloadSlashCommands(session.projectDir, sessionId).catch(() => {});
    return;
  }

  const index = await loadCrewIndex();
  const indexEntry = index.find(e => e.sessionId === sessionId);
  if (!indexEntry) {
    console.warn(`[Crew] resumeCrewSession: session ${sessionId} not found in index`);
    sendCrewMessage({ type: 'crew_session_restore_failed', sessionId, message: 'Crew session not found in index' });
    return;
  }

  const meta = await loadSessionMeta(indexEntry.sharedDir);
  if (!meta) {
    console.warn(`[Crew] resumeCrewSession: session.json not found at ${indexEntry.sharedDir}`);
    sendCrewMessage({ type: 'crew_session_restore_failed', sessionId, message: 'Crew session metadata not found' });
    return;
  }

  const roles = meta.roles || [];
  // Migration: strip claudeMd from legacy session.json (now persisted in per-role CLAUDE.md files)
  for (const r of roles) delete r.claudeMd;
  if (roles.length === 0) {
    console.warn(`[Crew] resumeCrewSession: session ${sessionId} has empty roles in session.json`);
  }
  const decisionMaker = meta.decisionMaker || roles[0]?.name || null;
  const session = {
    id: sessionId,
    projectDir: meta.projectDir,
    sharedDir: meta.sharedDir || indexEntry.sharedDir,
    name: meta.name || '',
    roles: new Map(roles.map(r => [r.name, r])),
    roleStates: new Map(),
    decisionMaker,
    status: 'waiting_human',
    round: meta.round || 0,
    costUsd: meta.costUsd || 0,
    totalInputTokens: meta.totalInputTokens || 0,
    totalOutputTokens: meta.totalOutputTokens || 0,
    messageHistory: [],
    uiMessages: [],
    humanMessageQueue: [],
    waitingHumanContext: null,
    pendingRoutes: [],
    features: new Map((meta.features || []).map(f => [f.taskId, f])),
    _completedTaskIds: new Set(meta._completedTaskIds || []),
    userId: userId || meta.userId,
    username: username || meta.username,
    agentId: meta.agentId || ctx.CONFIG?.agentName || null,
    teamType: meta.teamType || 'dev',
    language: meta.language || 'zh-CN',
    createdAt: meta.createdAt || Date.now()
  };
  crewSessions.set(sessionId, session);

  const loaded = await loadSessionMessages(session.sharedDir);
  session.uiMessages = loaded.messages;

  sendCrewMessage({
    type: 'crew_session_restored',
    sessionId,
    projectDir: session.projectDir,
    sharedDir: session.sharedDir,
    name: session.name || '',
    roles: roles.map(r => ({
      name: r.name, displayName: r.displayName, icon: r.icon,
      description: r.description, isDecisionMaker: r.isDecisionMaker || false,
      groupIndex: r.groupIndex, roleType: r.roleType, model: r.model
    })),
    decisionMaker,
    userId: session.userId,
    username: session.username,
    uiMessages: session.uiMessages,
    hasOlderMessages: loaded.hasOlderMessages
  });
  sendStatusUpdate(session);

  await upsertCrewIndex(session);
  await saveSessionMeta(session);

  // ★ Preload project-level skills for crew session input autocomplete
  preloadSlashCommands(session.projectDir, sessionId).catch(() => {});

  console.log(`[Crew] Session ${sessionId} resumed, waiting for human input`);
}

/**
 * 更新 crew session 的 name 和/或 roles 配置
 * roles 变更时：重新展开角色、初始化新 worktrees、更新 CLAUDE.md、通知前端
 */
export async function handleUpdateCrewSession(msg) {
  const { sessionId, name, roles: newRolesConfig } = msg;
  const session = crewSessions.get(sessionId);
  if (!session) {
    console.warn(`[Crew] Session not found for update: ${sessionId}`);
    return;
  }
  if (name !== undefined) session.name = name;

  // Handle roles update (count changes, etc.)
  if (newRolesConfig && Array.isArray(newRolesConfig) && newRolesConfig.length > 0) {
    const newExpanded = expandRoles(newRolesConfig);
    const oldRoleNames = new Set(session.roles.keys());
    const newRoleNames = new Set(newExpanded.map(r => r.name));

    // Stop and clean up removed roles
    for (const oldName of oldRoleNames) {
      if (!newRoleNames.has(oldName)) {
        const roleState = session.roleStates.get(oldName);
        if (roleState) {
          if (roleState.abortController) {
            roleState.abortController.abort();
          }
          session.roleStates.delete(oldName);
        }
        session.roles.delete(oldName);
        console.log(`[Crew] Role removed during update: ${oldName}`);
      }
    }

    // Add new roles and update existing ones
    for (const r of newExpanded) {
      if (!oldRoleNames.has(r.name)) {
        // Brand new role — add it
        session.roles.set(r.name, r);
        console.log(`[Crew] Role added during update: ${r.name} (${r.displayName})`);
      } else {
        // Existing role — update metadata (displayName, icon, etc.) but preserve roleState
        // claudeMd is NOT updated here — it's managed via CLAUDE.md files, not through edit session
        const existing = session.roles.get(r.name);
        existing.displayName = r.displayName;
        existing.icon = r.icon;
        existing.description = r.description;
        existing.isDecisionMaker = r.isDecisionMaker;
        existing.roleType = r.roleType;
        existing.groupIndex = r.groupIndex;
      }
    }

    // Update decision maker
    const dm = newExpanded.find(r => r.isDecisionMaker);
    if (dm) session.decisionMaker = dm.name;

    // Initialize worktrees for any new dev groups
    const allRoles = Array.from(session.roles.values());
    const worktreeMap = await initWorktrees(session.projectDir, allRoles);
    for (const role of allRoles) {
      if (role.groupIndex > 0 && worktreeMap.has(role.groupIndex) && !role.workDir) {
        role.workDir = worktreeMap.get(role.groupIndex);
      }
    }

    // Regenerate shared CLAUDE.md and role-specific CLAUDE.md files
    await updateSharedClaudeMd(session);
    for (const role of allRoles) {
      if (role.groupIndex > 0 && role.workDir) {
        await writeRoleClaudeMd(session.sharedDir, role, session.language || 'zh-CN', allRoles);
      }
    }

    // Notify frontend about role changes
    sendStatusUpdate(session);
  }

  await saveSessionMeta(session);
  await upsertCrewIndex(session);
}
