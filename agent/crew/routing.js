/**
 * Crew — 路由解析与执行
 * parseRoutes, executeRoute, buildRoutePrompt, dispatchToRole
 */
import { join } from 'path';
import { sendCrewMessage, sendCrewOutput, sendStatusUpdate } from './ui-messages.js';
import { ensureTaskFile, appendTaskRecord, readTaskFile, updateKanban, readKanban, saveRoleWorkSummary } from './task-files.js';
import { createRoleQuery, clearRoleSessionId } from './role-query.js';
import { saveSessionMeta } from './persistence.js';
import ctx from '../context.js';

/** Format role label */
function roleLabel(r) {
  return r.icon ? `${r.icon} ${r.displayName}` : r.displayName;
}

/**
 * 从累积文本中解析所有 ROUTE 块（支持多 ROUTE + task 字段）
 * @returns {Array<{ to, summary, taskId, taskTitle }>}
 */
export function parseRoutes(text) {
  const routes = [];
  // ★ Tolerate both underscore and space variants: ---END_ROUTE--- or ---END ROUTE---
  const regex = /---ROUTE---\s*\n([\s\S]*?)---END[_ ]ROUTE---/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const toMatch = block.match(/to:\s*(.+)/i);
    if (!toMatch) continue;

    // ★ Clean `to` value: take only the first word (strip parenthetical notes, extra text)
    // e.g. "pm (决策者)" → "pm", "dev-1 // main dev" → "dev-1"
    const toRaw = toMatch[1].trim().toLowerCase();
    const toClean = toRaw.split(/[\s(]/)[0];

    // ★ summary: match until next known field (task:/taskTitle:) or end of block
    const summaryMatch = block.match(/summary:\s*([\s\S]+?)(?=\n\s*(?:task|taskTitle)\s*:|$)/i);
    const taskMatch = block.match(/^task:\s*(.+)/im);
    const taskTitleMatch = block.match(/^taskTitle:\s*(.+)/im);

    let summary = summaryMatch ? summaryMatch[1].trim() : '';
    if (!summary) {
      summary = '[该角色未提供消息摘要]';
    }

    routes.push({
      to: toClean,
      summary,
      taskId: taskMatch ? taskMatch[1].trim() : null,
      taskTitle: taskTitleMatch ? taskTitleMatch[1].trim() : null
    });
  }

  return routes;
}

/**
 * Resolve a ROUTE `to` value to an actual role name in the session.
 *
 * Resolution order:
 * 1. Exact match: `to` matches a role name directly (e.g. "dev-1")
 * 2. roleType match: `to` matches a role's roleType (e.g. "developer" → "dev-1")
 * 3. Short prefix match: `to` matches the SHORT_PREFIX of a roleType (e.g. "dev" → "dev-1")
 * 4. Same-group dispatch: if sender is in a multi-instance group (e.g. dev-1),
 *    and `to` matches the roleType/prefix of another group (e.g. "reviewer"),
 *    route to the instance with matching groupIndex (e.g. rev-1)
 *
 * For multi-instance matches (2/3), prefer the instance with the same groupIndex
 * as the sender. Falls back to the first instance if no groupIndex match.
 *
 * @param {string} to - raw route target from ROUTE block
 * @param {object} session - crew session
 * @param {string} [fromRole] - sending role name (for groupIndex matching)
 * @returns {string|null} resolved role name, or null if unresolvable
 */
export function resolveRoleName(to, session, fromRole) {
  // 1. Exact match
  if (session.roles.has(to)) return to;

  // Build candidate list by roleType and short prefix
  const fromRoleConfig = fromRole ? session.roles.get(fromRole) : null;
  const fromGroupIndex = fromRoleConfig?.groupIndex || 0;

  let candidates = [];

  for (const [name, config] of session.roles) {
    // 2. roleType match (e.g. "developer" → dev-1, dev-2, dev-3)
    if (config.roleType === to) {
      candidates.push({ name, groupIndex: config.groupIndex || 0 });
    }
    // 3. Short prefix match (e.g. "dev" → developer roleType → dev-1)
    //    Match if the role name starts with `to-` (e.g. "dev" matches "dev-1", "dev-2")
    else if (name.startsWith(to + '-') && /^\d+$/.test(name.slice(to.length + 1))) {
      candidates.push({ name, groupIndex: config.groupIndex || 0 });
    }
  }

  if (candidates.length === 0) return null;

  // 4. Prefer same groupIndex as sender
  if (fromGroupIndex > 0) {
    const sameGroup = candidates.find(c => c.groupIndex === fromGroupIndex);
    if (sameGroup) return sameGroup.name;
  }

  // Fall back to first candidate
  return candidates[0].name;
}

/**
 * 执行路由
 */
export async function executeRoute(session, fromRole, route) {
  const { to, summary, taskId, taskTitle } = route;

  // 如果 session 已暂停或停止，保存为 pendingRoutes
  if (session.status === 'paused' || session.status === 'stopped') {
    session.pendingRoutes.push({ fromRole, route });
    console.log(`[Crew] Session ${session.status}, route saved as pending: ${fromRole} -> ${to}`);
    return;
  }

  // Task 文件自动管理（fire-and-forget）
  if (taskId && summary) {
    const fromRoleConfig = session.roles.get(fromRole);
    if (fromRoleConfig?.isDecisionMaker && taskTitle && to !== 'human') {
      ensureTaskFile(session, taskId, taskTitle, to, summary)
        .catch(e => console.warn(`[Crew] Failed to create task file ${taskId}:`, e.message));
    }
    appendTaskRecord(session, taskId, fromRole, summary)
      .catch(e => console.warn(`[Crew] Failed to append task record ${taskId}:`, e.message));

    // 更新工作看板：推断状态
    const { getMessages } = await import('../crew-i18n.js');
    const m = getMessages(session.language || 'zh-CN');
    // ★ Use resolveRoleName for kanban status lookup too
    const resolvedKanbanTo = resolveRoleName(to, session, fromRole);
    const toRoleConfig = session.roles.get(resolvedKanbanTo || to);
    let status = m.kanbanStatusDev;
    if (toRoleConfig) {
      switch (toRoleConfig.roleType) {
        case 'reviewer': status = m.kanbanStatusReview; break;
        case 'tester': status = m.kanbanStatusTest; break;
        default:
          if (toRoleConfig.isDecisionMaker) status = m.kanbanStatusDecision;
      }
    }
    updateKanban(session, {
      taskId, taskTitle, assignee: resolvedKanbanTo || to,
      status, summary: summary.substring(0, 100)
    }).catch(e => console.warn(`[Crew] Failed to update kanban:`, e.message));
  }

  // 发送路由消息（UI 显示）
  sendCrewOutput(session, fromRole, 'route', null, {
    routeTo: to, routeSummary: summary,
    taskId: taskId || undefined,
    taskTitle: taskTitle || undefined
  });

  // 路由到 human
  if (to === 'human') {
    session.status = 'waiting_human';
    session.waitingHumanContext = {
      fromRole,
      reason: 'requested',
      message: summary
    };
    sendCrewMessage({
      type: 'crew_human_needed',
      sessionId: session.id,
      fromRole,
      reason: 'requested',
      message: summary
    });
    sendStatusUpdate(session);
    // Status changed to waiting_human — persist
    saveSessionMeta(session).catch(e => console.warn('[Crew] Failed to save after →human:', e.message));
    return;
  }

  // 路由到指定角色
  const resolvedTo = resolveRoleName(to, session, fromRole);
  if (resolvedTo) {
    if (session.humanMessageQueue.length > 0) {
      const { processHumanQueue } = await import('./human-interaction.js');
      await processHumanQueue(session);
    } else {
      const taskPrompt = buildRoutePrompt(fromRole, summary, session);
      await dispatchToRole(session, resolvedTo, taskPrompt, fromRole, taskId, taskTitle);
    }
  } else {
    console.warn(`[Crew] Unknown route target: ${to}`);
    const errorMsg = `路由目标 "${to}" 不存在。来自 ${fromRole} 的消息: ${summary}`;
    await dispatchToRole(session, session.decisionMaker, errorMsg, 'system');
  }
}

/**
 * 构建路由转发的 prompt
 */
export function buildRoutePrompt(fromRole, summary, session) {
  const fromRoleConfig = session.roles.get(fromRole);
  const fromName = fromRoleConfig ? roleLabel(fromRoleConfig) : fromRole;
  return `来自 ${fromName} 的消息:\n${summary}\n\n请开始你的工作。完成后通过 ROUTE 块传递给下一个角色。`;
}

/**
 * 向角色发送消息
 */
export async function dispatchToRole(session, roleName, content, fromSource, taskId, taskTitle) {
  if (session.status === 'paused' || session.status === 'stopped' || session.status === 'initializing') {
    console.log(`[Crew] Session ${session.status}, skipping dispatch to ${roleName}`);
    return;
  }

  let roleState = session.roleStates.get(roleName);

  // 如果角色没有 query 实例，创建一个（支持 resume）
  if (!roleState || !roleState.query || !roleState.inputStream) {
    roleState = await createRoleQuery(session, roleName);
  }

  // 设置 task
  if (taskId) {
    roleState.currentTask = { taskId, taskTitle };
  }

  // Task 上下文注入
  const effectiveTaskId = taskId || roleState.currentTask?.taskId;
  if (effectiveTaskId && typeof content === 'string') {
    const taskContent = await readTaskFile(session, effectiveTaskId);
    if (taskContent) {
      content = `${content}\n\n---\n<task-context file=".crew/context/features/${effectiveTaskId}.md">\n${taskContent}\n</task-context>`;
    }
  }

  // 看板上下文注入（角色重启后知道全局状态）
  if (typeof content === 'string') {
    const kanbanContent = await readKanban(session);
    if (kanbanContent) {
      content = `${content}\n\n---\n<kanban file=".crew/context/kanban.md">\n${kanbanContent}\n</kanban>`;
    }
  }

  // 最近路由消息注入（帮助 clear 后的角色恢复上下文）
  if (typeof content === 'string' && session.messageHistory.length > 0) {
    const recentRoutes = session.messageHistory
      .filter(m => m.from !== 'system')
      .slice(-5)
      .map(m => `[${m.from} → ${m.to}${m.taskId ? ` (${m.taskId})` : ''}] ${m.content}`)
      .join('\n');
    if (recentRoutes) {
      content = `${content}\n\n---\n<recent-routes>\n${recentRoutes}\n</recent-routes>`;
    }
  }

  // 记录消息历史
  session.messageHistory.push({
    from: fromSource,
    to: roleName,
    content: typeof content === 'string' ? content.substring(0, 200) : '...',
    taskId: taskId || roleState.currentTask?.taskId || null,
    timestamp: Date.now()
  });

  // DISABLED (2026-03): Opus 4.6 has 200k context. Claude Code handles its own compaction.
  // Keeping code for reference; re-enable if we ever need custom crew pre-send compact.
  // ★ Pre-send compact check: estimate total tokens and clear+rebuild if needed
  // const autoCompactThreshold = ctx.CONFIG?.autoCompactThreshold || 100000;
  // const lastInputTokens = roleState.lastInputTokens || 0;
  // const estimatedNewTokens = Math.ceil((typeof content === 'string' ? content.length : 0) / 3);
  // const estimatedTotal = lastInputTokens + estimatedNewTokens;
  //
  // if (lastInputTokens > 0 && estimatedTotal > autoCompactThreshold) {
  //   console.log(`[Crew] Pre-send compact for ${roleName}: estimated ${estimatedTotal} tokens (last: ${lastInputTokens} + new: ~${estimatedNewTokens}) exceeds threshold ${autoCompactThreshold}`);
  //
  //   // Save work summary before clearing (use lastTurnText since accumulatedText is cleared after result)
  //   await saveRoleWorkSummary(session, roleName, roleState.lastTurnText || roleState.accumulatedText || '').catch(e =>
  //     console.warn(`[Crew] Failed to save work summary for ${roleName}:`, e.message));
  //
  //   // Clear role session and rebuild
  //   await clearRoleSessionId(session.sharedDir, roleName);
  //   roleState.claudeSessionId = null;
  //
  //   if (roleState.abortController) roleState.abortController.abort();
  //   roleState.query = null;
  //   roleState.inputStream = null;
  //
  //   sendCrewMessage({
  //     type: 'crew_role_cleared',
  //     sessionId: session.id,
  //     role: roleName,
  //     contextPercentage: Math.round((lastInputTokens / (ctx.CONFIG?.maxContextTokens || 128000)) * 100),
  //     reason: 'pre_send_compact'
  //   });
  //
  //   // Recreate the query (fresh Claude process)
  //   roleState = await createRoleQuery(session, roleName);
  // }

  // P1-4: 守卫 stream.enqueue — stream 可能已被 abort 关闭
  roleState.lastDispatchContent = content;
  roleState.lastDispatchFrom = fromSource;
  roleState.lastDispatchTaskId = taskId || null;
  roleState.lastDispatchTaskTitle = taskTitle || null;
  roleState.turnActive = true;
  roleState.accumulatedText = '';
  try {
    if (roleState.inputStream && !roleState.inputStream.isDone) {
      roleState.inputStream.enqueue({
        type: 'user',
        message: { role: 'user', content }
      });
    } else {
      console.warn(`[Crew] Cannot enqueue to ${roleName}: stream closed or missing, recreating`);
      roleState = await createRoleQuery(session, roleName);
      roleState.lastDispatchContent = content;
      roleState.lastDispatchFrom = fromSource;
      roleState.lastDispatchTaskId = taskId || null;
      roleState.lastDispatchTaskTitle = taskTitle || null;
      roleState.turnActive = true;
      roleState.accumulatedText = '';
      roleState.inputStream.enqueue({
        type: 'user',
        message: { role: 'user', content }
      });
    }
  } catch (enqueueErr) {
    console.error(`[Crew] Failed to enqueue to ${roleName}:`, enqueueErr.message);
    // Recreate query and retry once
    roleState = await createRoleQuery(session, roleName);
    roleState.lastDispatchContent = content;
    roleState.lastDispatchFrom = fromSource;
    roleState.lastDispatchTaskId = taskId || null;
    roleState.lastDispatchTaskTitle = taskTitle || null;
    roleState.turnActive = true;
    roleState.accumulatedText = '';
    roleState.inputStream.enqueue({
      type: 'user',
      message: { role: 'user', content }
    });
  }

  sendStatusUpdate(session);
  console.log(`[Crew] Dispatched to ${roleName} from ${fromSource}${taskId ? ` (task: ${taskId})` : ''}`);
}
