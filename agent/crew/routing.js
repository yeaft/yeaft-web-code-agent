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
 * Append text to content — works for both string and multimodal array content.
 * For arrays, appends to the last text block (or adds a new one).
 */
function _appendTextToContent(content, text) {
  if (typeof content === 'string') return content + text;
  // Multimodal array: find last text block and append
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === 'text') {
      content[i].text += text;
      return content;
    }
  }
  // No text block found — add one
  content.push({ type: 'text', text });
  return content;
}

/**
 * 从累积文本中解析所有 ROUTE 块（支持多 ROUTE + task 字段）
 * @returns {Array<{ to, summary, taskId, taskTitle }>}
 */
export function parseRoutes(text) {
  const routes = [];

  // ─── Pre-pass: Strip fenced code blocks to avoid parsing quoted ROUTE examples ──
  // Replaces ```...``` content with whitespace of same length to preserve positions
  text = text.replace(/```[\s\S]*?```/g, m => ' '.repeat(m.length));

  // ─── Phase 1: Standard ROUTE blocks (with END_ROUTE) ──────────
  // ★ Tolerate both underscore and space variants: ---END_ROUTE--- or ---END ROUTE---
  // ★ Use negative lookahead to not cross another ---ROUTE--- boundary
  const regex = /---ROUTE---\s*\n((?:(?!---ROUTE---)[\s\S])*?)---END[_ ]ROUTE---/g;
  let match;
  const matchedRanges = []; // track matched ranges to avoid double-parsing

  while ((match = regex.exec(text)) !== null) {
    matchedRanges.push({ start: match.index, end: match.index + match[0].length });
    const parsed = _parseRouteBlock(match[1]);
    if (parsed) routes.push(parsed);
  }

  // ─── Phase 2: Fallback — ROUTE block missing END_ROUTE ────────
  // Match ---ROUTE--- without a closing ---END_ROUTE---
  // Take content until next ---ROUTE--- or EOF
  const openRegex = /---ROUTE---\s*\n/g;
  while ((match = openRegex.exec(text)) !== null) {
    // Skip if this range was already captured by Phase 1
    const pos = match.index;
    if (matchedRanges.some(r => pos >= r.start && pos < r.end)) continue;

    const blockStart = pos + match[0].length;
    // End at next ---ROUTE--- or EOF
    const nextRoute = text.indexOf('---ROUTE---', blockStart);
    const blockEnd = nextRoute !== -1 ? nextRoute : text.length;
    const block = text.slice(blockStart, blockEnd);

    const parsed = _parseRouteBlock(block);
    if (parsed) routes.push(parsed);
  }

  // ─── Phase 3: Shorthand — "ROUTE → target" / "ROUTE: target" ─
  // Matches single-line shorthands like: ROUTE → dev-1: summary here
  // or: ROUTE: dev-1, summary here
  const shorthandRegex = /^ROUTE\s*[→:]\s*(\S+)[,:\s]*(.*)$/gm;
  while ((match = shorthandRegex.exec(text)) !== null) {
    // Skip if inside an already-matched ROUTE block range
    const pos = match.index;
    if (matchedRanges.some(r => pos >= r.start && pos < r.end)) continue;
    // Also skip if the line is inside a ---ROUTE--- block (even unclosed)
    const precedingText = text.slice(0, pos);
    const lastRouteOpen = precedingText.lastIndexOf('---ROUTE---');
    const lastRouteClose = Math.max(
      precedingText.lastIndexOf('---END_ROUTE---'),
      precedingText.lastIndexOf('---END ROUTE---')
    );
    if (lastRouteOpen > lastRouteClose) continue; // inside an open block

    const toRaw = match[1].trim().toLowerCase().replace(/[,;:!?。，；：!？]+$/, '');
    const summary = match[2] ? match[2].trim() : '[该角色未提供消息摘要]';

    routes.push({ to: toRaw, summary, taskId: null, taskTitle: null });
  }

  return routes;
}

/**
 * Parse fields from a ROUTE block body (the content between ---ROUTE--- and ---END_ROUTE---).
 * @param {string} block — raw block content
 * @returns {{ to: string, summary: string, taskId: string|null, taskTitle: string|null } | null}
 */
function _parseRouteBlock(block) {
  const toMatch = block.match(/to:\s*(.+)/i);
  if (!toMatch) return null;

  // ★ Clean `to` value: take only the first word (strip parenthetical notes, extra text)
  // e.g. "pm (决策者)" → "pm", "dev-1 // main dev" → "dev-1"
  const toRaw = toMatch[1].trim().toLowerCase();
  // Strip trailing punctuation (commas, semicolons, colons, etc.)
  const toClean = toRaw.split(/[\s(]/)[0].replace(/[,;:!?。，；：!？]+$/, '');

  // ★ summary: match until next known field (task:/taskTitle:) or end of block
  const summaryMatch = block.match(/summary:\s*([\s\S]+?)(?=\n\s*(?:task|taskTitle)\s*:|$)/i);
  const taskMatch = block.match(/^task:\s*(.+)/im);
  const taskTitleMatch = block.match(/^taskTitle:\s*(.+)/im);

  let summary = summaryMatch ? summaryMatch[1].trim() : '';
  if (!summary) {
    summary = '[该角色未提供消息摘要]';
  }

  return {
    to: toClean,
    summary,
    taskId: taskMatch ? taskMatch[1].trim() : null,
    taskTitle: taskTitleMatch ? taskTitleMatch[1].trim() : null
  };
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

  // 4. displayName match (e.g. "乔布斯" → pm)
  if (candidates.length === 0) {
    for (const [name, config] of session.roles) {
      if (config.displayName && config.displayName.toLowerCase() === to) {
        candidates.push({ name, groupIndex: config.groupIndex || 0 });
      }
    }
  }

  // 5. name-displayName compound match (e.g. "pm-乔布斯" → pm)
  //    Claude sometimes concatenates role name + display name with a hyphen
  if (candidates.length === 0) {
    for (const [name, config] of session.roles) {
      if (to.startsWith(name + '-') && to.length > name.length + 1) {
        candidates.push({ name, groupIndex: config.groupIndex || 0 });
      }
    }
  }

  if (candidates.length === 0) return null;

  // 6. Prefer same groupIndex as sender
  if (fromGroupIndex > 0) {
    const sameGroup = candidates.find(c => c.groupIndex === fromGroupIndex);
    if (sameGroup) return sameGroup.name;
  }

  // Fall back to first candidate
  return candidates[0].name;
}

/**
 * 执行路由
 * @param {Array<{mimeType, data}>} [turnImages] - auto-attached images from the turn (max 3)
 */
export async function executeRoute(session, fromRole, route, turnImages = []) {
  const { to, summary, taskId, taskTitle } = route;

  // Auto-resume: paused/stopped → running (route execution means work should continue)
  if (session.status === 'paused' || session.status === 'stopped') {
    console.log(`[Crew] Auto-resuming session from ${session.status} to running (route from ${fromRole} to ${to})`);
    session.status = 'running';
    sendStatusUpdate(session);
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
        case 'product-reviewer': status = m.kanbanStatusProductReview; break;
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
    taskTitle: taskTitle || undefined,
    // ★ Auto-attach turn images (base64) — server will cache and convert to fileId/previewToken
    routeImages: turnImages.length > 0 ? turnImages.map(img => ({
      mimeType: img.mimeType,
      data: img.data
    })) : undefined
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
      const taskPrompt = buildRoutePrompt(fromRole, summary, session, turnImages);
      await dispatchToRole(session, resolvedTo, taskPrompt, fromRole, taskId, taskTitle);
    }
  } else {
    const availableRoles = Array.from(session.roles.keys()).join(', ');
    console.warn(`[Crew] Unknown route target: ${to} (available: ${availableRoles})`);
    const errorMsg = `路由目标 "${to}" 不存在。可用角色: ${availableRoles}\n来自 ${fromRole} 的消息: ${summary}`;
    await dispatchToRole(session, session.decisionMaker, errorMsg, 'system');
  }
}

/**
 * 构建路由转发的 prompt（支持多模态 — 自动附加 turn 截图）
 * @param {Array<{mimeType, data}>} [turnImages] - auto-attached images
 * @returns {string|Array} text string, or multimodal content array when images present
 */
export function buildRoutePrompt(fromRole, summary, session, turnImages = []) {
  const fromRoleConfig = session.roles.get(fromRole);
  const fromName = fromRoleConfig ? roleLabel(fromRoleConfig) : fromRole;
  const text = `来自 ${fromName} 的消息:\n${summary}\n\n请开始你的工作。完成后通过 ROUTE 块传递给下一个角色。`;

  if (turnImages.length === 0) return text;

  // Build multimodal content: images first, then text
  const blocks = [];
  for (const img of turnImages) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.data }
    });
  }
  blocks.push({ type: 'text', text });
  return blocks;
}

/**
 * 向角色发送消息
 */
export async function dispatchToRole(session, roleName, content, fromSource, taskId, taskTitle) {
  // Only block during initialization (roles not ready yet)
  if (session.status === 'initializing') {
    console.log(`[Crew] Session initializing, skipping dispatch to ${roleName}`);
    return;
  }

  // Auto-resume: paused/stopped → running (dispatch means work should continue)
  if (session.status === 'paused' || session.status === 'stopped') {
    console.log(`[Crew] Auto-resuming session from ${session.status} to running (dispatch to ${roleName})`);
    session.status = 'running';
    sendStatusUpdate(session);
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
  if (effectiveTaskId) {
    const taskContent = await readTaskFile(session, effectiveTaskId);
    if (taskContent) {
      const ctx = `\n\n---\n<task-context file=".crew/context/features/${effectiveTaskId}.md">\n${taskContent}\n</task-context>`;
      content = _appendTextToContent(content, ctx);
    }
  }

  // 看板上下文注入（角色重启后知道全局状态）
  {
    const kanbanContent = await readKanban(session);
    if (kanbanContent) {
      const ctx = `\n\n---\n<kanban file=".crew/context/kanban.md">\n${kanbanContent}\n</kanban>`;
      content = _appendTextToContent(content, ctx);
    }
  }

  // 最近路由消息注入（帮助 clear 后的角色恢复上下文）
  if (session.messageHistory.length > 0) {
    const recentRoutes = session.messageHistory
      .filter(m => m.from !== 'system')
      .slice(-5)
      .map(m => `[${m.from} → ${m.to}${m.taskId ? ` (${m.taskId})` : ''}] ${m.content}`)
      .join('\n');
    if (recentRoutes) {
      const ctx = `\n\n---\n<recent-routes>\n${recentRoutes}\n</recent-routes>`;
      content = _appendTextToContent(content, ctx);
    }
  }

  // 记录消息历史
  const historyContent = typeof content === 'string'
    ? content.substring(0, 200)
    : (Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('').substring(0, 200) + (content.some(b => b.type === 'image') ? ' [+images]' : '') : '...');
  session.messageHistory.push({
    from: fromSource,
    to: roleName,
    content: historyContent,
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
