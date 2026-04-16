/**
 * Crew — 角色输出处理
 * processRoleOutput（核心流式输出处理循环）
 */
import { sendCrewMessage, sendCrewOutput, sendStatusUpdate, endRoleStreaming } from './ui-messages.js';
import { saveRoleSessionId, clearRoleSessionId, classifyRoleError, createRoleQuery } from './role-query.js';
import { parseRoutes, executeRoute, dispatchToRole } from './routing.js';
import { parseCompletedTasks, updateFeatureIndex, appendChangelog, saveRoleWorkSummary, updateKanban } from './task-files.js';
import { debouncedSaveSessionMeta, saveSessionMeta } from './persistence.js';
import ctx from '../context.js';

// Context 使用率常量（运行时从 ctx.CONFIG 读取）
const getMaxContext = () => ctx.CONFIG?.maxContextTokens || 128000;

/**
 * Detect routing intent in text that lacks a proper ROUTE block.
 * Returns true if keywords suggest the role intended to route to someone.
 * @param {string} text
 * @returns {boolean}
 */
export function _detectRouteIntent(text) {
  if (!text || text.length < 10) return false;
  // Check only the last 1000 chars (routing intent is usually at the end)
  const tail = text.slice(-1000);
  // Chinese patterns: 提交给/交给/请.*审查/转给/发给/route to
  // English patterns: route to/submit to/forward to/hand off to/pass to
  const intentPatterns = [
    /提交给\s*\S+/,
    /交给\s*\S+/,
    /请\s*\S+\s*审查/,
    /转给\s*\S+/,
    /发给\s*\S+/,
    /route\s+to\s+\S+/i,
    /submit\s+to\s+\S+/i,
    /forward\s+to\s+\S+/i,
    /hand\s*off\s+to\s+\S+/i,
    /pass\s+to\s+\S+/i,
    /ROUTE[→:]\s*\S+/,  // shorthand that parseRoutes might have already caught, but as safety net
  ];
  return intentPatterns.some(p => p.test(tail));
}

/**
 * 处理角色的流式输出
 */
export async function processRoleOutput(session, roleName, roleQuery, roleState) {
  // 辅助函数：将 lastSeenUsage 结算到 session（用于 abort/error 场景，避免丢失 token）
  function settleLastSeenUsage() {
    if (!roleState.lastSeenUsage) return;
    const { totalCostUsd, inputTokens, outputTokens } = roleState.lastSeenUsage;
    if (totalCostUsd != null) {
      const costDelta = totalCostUsd - roleState.lastCostUsd;
      if (costDelta > 0) session.costUsd += costDelta;
      roleState.lastCostUsd = totalCostUsd;
    }
    if (inputTokens != null || outputTokens != null) {
      const inputDelta = (inputTokens || 0) - (roleState.lastInputTokens || 0);
      const outputDelta = (outputTokens || 0) - (roleState.lastOutputTokens || 0);
      if (inputDelta > 0) session.totalInputTokens += inputDelta;
      if (outputDelta > 0) session.totalOutputTokens += outputDelta;
      roleState.lastInputTokens = inputTokens || 0;
      roleState.lastOutputTokens = outputTokens || 0;
    }
    roleState.lastSeenUsage = null;
  }

  try {
    for await (const message of roleQuery) {
      // 检查 session 是否已停止或暂停
      if (session.status === 'stopped' || session.status === 'paused') break;

      // 每次收到带 usage/cost 的消息，暂存到 lastSeenUsage（供 abort/error 结算）
      if (message.total_cost_usd != null || message.usage) {
        roleState.lastSeenUsage = {
          totalCostUsd: message.total_cost_usd,
          inputTokens: message.usage?.input_tokens,
          outputTokens: message.usage?.output_tokens
        };
      }

      if (message.type === 'system' && message.subtype === 'init') {
        roleState.claudeSessionId = message.session_id;
        console.log(`[Crew] ${roleName} session: ${message.session_id}`);

        // Decision maker 的 system init 中捕获 slash_commands，发给前端用于 autocomplete
        const roleConfig = session.roles.get(roleName);
        if (roleConfig?.isDecisionMaker && message.slash_commands?.length > 0) {
          console.log(`[Crew] ${roleName} slash commands: ${message.slash_commands.join(', ')}`);
          sendCrewMessage({
            type: 'slash_commands_update',
            conversationId: session.id,
            slashCommands: message.slash_commands
          });
        }
        continue;
      }

      if (message.type === 'assistant') {
        const content = message.message?.content;
        if (content) {
          if (typeof content === 'string') {
            roleState.accumulatedText += content;
            sendCrewOutput(session, roleName, 'text', message);
          } else if (Array.isArray(content)) {
            let hasText = false;
            for (const block of content) {
              if (block.type === 'text') {
                roleState.accumulatedText += block.text;
                hasText = true;
              } else if (block.type === 'tool_use') {
                endRoleStreaming(session, roleName);
                roleState.currentTool = block.name;
                sendCrewOutput(session, roleName, 'tool_use', message);
              }
            }
            if (hasText) {
              sendCrewOutput(session, roleName, 'text', message);
            }
          }
        }
      } else if (message.type === 'user') {
        roleState.currentTool = null;
        sendCrewOutput(session, roleName, 'tool_result', message);
      } else if (message.type === 'result') {
        // Turn 完成
        console.log(`[Crew] ${roleName} turn completed`);
        roleState.consecutiveErrors = 0;

        endRoleStreaming(session, roleName);

        // 更新费用（通过 settleLastSeenUsage 统一处理，避免重复逻辑）
        settleLastSeenUsage();

        // 持久化 sessionId
        if (roleState.claudeSessionId) {
          saveRoleSessionId(session.sharedDir, roleName, roleState.claudeSessionId)
            .catch(e => console.warn(`[Crew] Failed to save sessionId for ${roleName}:`, e.message));
        }

        // context 使用率监控
        const inputTokens = message.usage?.input_tokens || 0;
        if (inputTokens > 0) {
          sendCrewMessage({
            type: 'crew_context_usage',
            sessionId: session.id,
            role: roleName,
            inputTokens,
            maxTokens: getMaxContext(),
            percentage: Math.min(100, Math.round((inputTokens / getMaxContext()) * 100))
          });
        }

        // 解析路由
        const routes = parseRoutes(roleState.accumulatedText);
        // Fallback: 如果 route summary 仍为空占位符，用 accumulatedText 末尾 500 字符
        for (const route of routes) {
          if (route.summary === '[该角色未提供消息摘要]' && roleState.accumulatedText) {
            const tail = roleState.accumulatedText.slice(-500).trim();
            if (tail) route.summary = `[auto-extracted]\n${tail}`;
          }
        }

        // 决策者 turn 完成：检测 TASKS block 中新完成的任务
        const roleConfig = session.roles.get(roleName);
        if (roleConfig?.isDecisionMaker) {
          const knownTaskIds = Array.from(session.features.keys());
          const nowCompleted = parseCompletedTasks(roleState.accumulatedText, knownTaskIds);
          if (nowCompleted.size > 0) {
            const prev = session._completedTaskIds || new Set();
            const newlyDone = [];
            for (const tid of nowCompleted) {
              if (!prev.has(tid)) {
                prev.add(tid);
                newlyDone.push(tid);
              }
            }
            session._completedTaskIds = prev;
            if (newlyDone.length > 0) {
              updateFeatureIndex(session).catch(e => console.warn('[Crew] Failed to update feature index:', e.message));
              for (const tid of newlyDone) {
                const feature = session.features.get(tid);
                const title = feature?.taskTitle || tid;
                appendChangelog(session, tid, title).catch(e => console.warn(`[Crew] Failed to append changelog for ${tid}:`, e.message));
                updateKanban(session, { taskId: tid, completed: true }).catch(e => console.warn(`[Crew] Failed to update kanban for ${tid}:`, e.message));
              }
            }
          }
        }

        // 保存本 turn 文本（供 routing.js 预检时 saveRoleWorkSummary 使用）
        roleState.lastTurnText = roleState.accumulatedText;
        roleState.accumulatedText = '';
        roleState.turnActive = false;

        // Mark pending tool messages as completed before notifying frontend
        for (const m of session.uiMessages) {
          if (m.role === roleName && m.type === 'tool' && !m.hasResult) {
            m.hasResult = true;
          }
        }

        sendCrewMessage({
          type: 'crew_turn_completed',
          sessionId: session.id,
          role: roleName
        });

        sendStatusUpdate(session);
        // Cost/tokens/messages updated — debounced persist (coalesces rapid turn-ends)
        debouncedSaveSessionMeta(session);

        // 执行路由
        if (routes.length > 0) {
          session.round++;

          // ★ Collect turn images for auto-attach (last 3, then clear)
          const turnImages = roleState.turnImages || [];
          roleState.turnImages = [];

          const currentTask = roleState.currentTask;
          for (const route of routes) {
            if (!route.taskId && currentTask) {
              route.taskId = currentTask.taskId;
              route.taskTitle = currentTask.taskTitle;
            }
          }

          // 通知前端进入 routing 状态
          sendCrewMessage({
            type: 'crew_routing',
            sessionId: session.id,
            fromRole: roleName,
            routes: routes.map(r => ({ to: r.to, taskId: r.taskId, taskTitle: r.taskTitle })),
            status: 'routing'
          });

          const results = await Promise.allSettled(routes.map(route =>
            executeRoute(session, roleName, route, turnImages)
          ));
          for (const r of results) {
            if (r.status === 'rejected') {
              console.warn(`[Crew] Route execution failed:`, r.reason);
            }
          }

          // routing 完成，通知前端恢复正常状态
          sendCrewMessage({
            type: 'crew_routing',
            sessionId: session.id,
            fromRole: roleName,
            status: 'done'
          });
          sendStatusUpdate(session);
        } else {
          // ★ Route intent detection: if no ROUTE block but text suggests routing intent,
          // auto-forward to PM so the message doesn't get lost
          if (_detectRouteIntent(roleState.lastTurnText) && roleName !== session.decisionMaker) {
            console.log(`[Crew] ${roleName} turn ended without ROUTE but has routing intent — auto-forwarding to PM`);
            const autoSummary = `[auto-forward: ${roleName} 的输出包含路由意图但缺少 ROUTE 块]\n${(roleState.lastTurnText || '').slice(-500).trim()}`;
            await executeRoute(session, roleName, {
              to: session.decisionMaker,
              summary: autoSummary,
              taskId: roleState.currentTask?.taskId || null,
              taskTitle: roleState.currentTask?.taskTitle || null,
            });
          } else {
            const { processHumanQueue } = await import('./human-interaction.js');
            await processHumanQueue(session);
          }
        }
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`[Crew] ${roleName} aborted`);
      // 结算 abort 前累积的 usage，避免丢失 token
      settleLastSeenUsage();
      if (session.status === 'paused' && roleState.accumulatedText) {
        const routes = parseRoutes(roleState.accumulatedText);
        if (routes.length > 0 && session.pendingRoutes.length === 0) {
          // Fill missing taskId from roleState.currentTask (same as normal path L170-175)
          const currentTask = roleState.currentTask;
          for (const route of routes) {
            if (!route.taskId && currentTask) {
              route.taskId = currentTask.taskId;
              route.taskTitle = currentTask.taskTitle;
            }
          }
          session.pendingRoutes = routes.map(route => ({ fromRole: roleName, route }));
          console.log(`[Crew] Saved ${routes.length} pending route(s) from aborted ${roleName}`);
        }
        roleState.accumulatedText = '';
      }
    } else {
      console.error(`[Crew] ${roleName} error:`, error.message);

      // 结算 error 前累积的 usage，避免丢失 token
      settleLastSeenUsage();

      // Step 1: 清理 roleState
      endRoleStreaming(session, roleName);
      const errorTurnText = roleState.accumulatedText;
      roleState.query = null;
      roleState.inputStream = null;
      roleState.turnActive = false;
      roleState.accumulatedText = '';

      // Step 2: 错误分类
      const classification = classifyRoleError(error);
      roleState.consecutiveErrors++;

      // Step 3: 通知前端
      sendCrewMessage({
        type: 'crew_role_error',
        sessionId: session.id,
        role: roleName,
        error: error.message.substring(0, 500),
        reason: classification.reason,
        recoverable: classification.recoverable,
        retryCount: roleState.consecutiveErrors
      });
      sendStatusUpdate(session);

      // Step 4: 判断是否重试
      const MAX_RETRIES = 3;
      if (!classification.recoverable || roleState.consecutiveErrors > MAX_RETRIES) {
        const exhausted = roleState.consecutiveErrors > MAX_RETRIES;
        const errDetail = exhausted
          ? `角色 ${roleName} 连续 ${MAX_RETRIES} 次错误后停止重试。最后错误: ${error.message}`
          : `角色 ${roleName} 不可恢复错误: ${error.message}`;
        if (roleName !== session.decisionMaker) {
          await dispatchToRole(session, session.decisionMaker, errDetail, 'system');
        } else {
          session.status = 'waiting_human';
          sendCrewMessage({
            type: 'crew_human_needed',
            sessionId: session.id,
            fromRole: roleName,
            reason: 'error',
            message: errDetail
          });
          sendStatusUpdate(session);
          // Status changed to waiting_human — persist
          saveSessionMeta(session).catch(e => console.warn('[Crew] Failed to save after error→human:', e.message));
        }
        return;
      }

      // Step 5: 可恢复 → 保存摘要后 clear + 重建重试
      console.log(`[Crew] ${roleName} attempting recovery (${classification.reason}), retry ${roleState.consecutiveErrors}/${MAX_RETRIES}`);

      sendCrewOutput(session, 'system', 'system', {
        type: 'assistant',
        message: { role: 'assistant', content: [{
          type: 'text',
          text: `${roleName} 遇到 ${classification.reason}，正在自动恢复 (${roleState.consecutiveErrors}/${MAX_RETRIES})...`
        }] }
      });

      if (roleState.lastDispatchContent) {
        // 保存工作摘要
        await saveRoleWorkSummary(session, roleName, errorTurnText).catch(e =>
          console.warn(`[Crew] Failed to save work summary for ${roleName}:`, e.message));

        // 所有可恢复错误统一 clear + rebuild
        await clearRoleSessionId(session.sharedDir, roleName);
        const consecutiveErrors = roleState.consecutiveErrors;
        await dispatchToRole(
          session, roleName,
          roleState.lastDispatchContent,
          roleState.lastDispatchFrom || 'system',
          roleState.lastDispatchTaskId,
          roleState.lastDispatchTaskTitle
        );
        // 保持错误计数
        const newState = session.roleStates.get(roleName);
        if (newState) newState.consecutiveErrors = consecutiveErrors;
      } else {
        const msg = `角色 ${roleName} 已恢复（${classification.reason}），但无待重试消息。`;
        if (roleName !== session.decisionMaker) {
          await dispatchToRole(session, session.decisionMaker, msg, 'system');
        }
      }
    }
  }
}
