/**
 * Crew — UI 消息辅助函数
 * sendCrewMessage, sendCrewOutput, sendStatusUpdate, endRoleStreaming, findActiveRole
 */
import ctx from '../context.js';

/**
 * 发送 crew 消息到 server（透传到 Web）
 */
export function sendCrewMessage(msg) {
  if (ctx.sendToServer) {
    ctx.sendToServer(msg);
  }
}

/** Format role label: "icon displayName" or just "displayName" if no icon */
function roleLabel(r) {
  return r.icon ? `${r.icon} ${r.displayName}` : r.displayName;
}

/**
 * 结束指定角色的最后一条 streaming 消息（反向搜索）
 */
export function endRoleStreaming(session, roleName) {
  for (let i = session.uiMessages.length - 1; i >= 0; i--) {
    if (session.uiMessages[i].role === roleName && session.uiMessages[i]._streaming) {
      delete session.uiMessages[i]._streaming;
      break;
    }
  }
}

/**
 * 找到当前活跃的角色（最近一个 turnActive 的）
 */
export function findActiveRole(session) {
  for (const [name, state] of session.roleStates) {
    if (state.turnActive) return name;
  }
  return null;
}

/**
 * 发送角色输出到 Web
 */
export function sendCrewOutput(session, roleName, outputType, rawMessage, extra = {}) {
  const role = session.roles.get(roleName);
  const roleIcon = role?.icon || '';
  const displayName = role?.displayName || roleName;
  const isDecisionMaker = !!(role && role.isDecisionMaker);

  // 从 extra 或 roleState 获取当前 task 信息（extra 优先）
  const roleState = session.roleStates.get(roleName);
  const taskId = extra.taskId || roleState?.currentTask?.taskId || null;
  const taskTitle = extra.taskTitle || roleState?.currentTask?.taskTitle || null;

  // 清除 extra 中的 taskId/taskTitle 避免重复展开到 WebSocket 消息
  const { taskId: _tid, taskTitle: _tt, ...extraRest } = extra;

  sendCrewMessage({
    type: 'crew_output',
    sessionId: session.id,
    role: roleName,
    roleIcon,
    roleName: displayName,
    outputType,  // 'text' | 'tool_use' | 'tool_result' | 'route' | 'system'
    data: rawMessage,
    taskId,
    taskTitle,
    ...extraRest
  });

  // ★ 累积 feature 到持久化列表
  if (taskId && taskTitle && !session.features.has(taskId)) {
    session.features.set(taskId, { taskId, taskTitle, createdAt: Date.now() });
  }

  // ★ 记录精简 UI 消息用于恢复（跳过 tool_use/tool_result，只记录可见内容）
  if (outputType === 'text') {
    const content = rawMessage?.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content.filter(b => b.type === 'text').map(b => b.text).join('');
    }
    if (!text) return;
    // ★ 反向搜索该角色最后一条 _streaming 消息
    let found = false;
    for (let i = session.uiMessages.length - 1; i >= 0; i--) {
      const msg = session.uiMessages[i];
      if (msg.role === roleName && msg.type === 'text' && msg._streaming) {
        msg.content += text;
        found = true;
        break;
      }
    }
    if (!found) {
      session.uiMessages.push({
        role: roleName, roleIcon, roleName: displayName,
        type: 'text', content: text, _streaming: true,
        taskId, taskTitle, isDecisionMaker,
        timestamp: Date.now()
      });
    }
  } else if (outputType === 'route') {
    // 结束该角色前一条 streaming
    endRoleStreaming(session, roleName);
    session.uiMessages.push({
      role: roleName, roleIcon, roleName: displayName,
      type: 'route', routeTo: extra.routeTo,
      routeSummary: extra.routeSummary || '',
      round: session.round || 0,
      content: `→ @${extra.routeTo} ${extra.routeSummary || ''}`,
      taskId, taskTitle, isDecisionMaker,
      timestamp: Date.now()
    });
  } else if (outputType === 'system') {
    const content = rawMessage?.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content.filter(b => b.type === 'text').map(b => b.text).join('');
    }
    if (!text) return;
    session.uiMessages.push({
      role: roleName, roleIcon, roleName: displayName,
      type: 'system', content: text,
      timestamp: Date.now()
    });
  } else if (outputType === 'tool_use') {
    // 结束该角色前一条 streaming
    endRoleStreaming(session, roleName);
    const content = rawMessage?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          // Save trimmed toolInput for restore
          const input = block.input || {};
          let savedInput;
          if (block.name === 'TodoWrite' || block.name === 'AskUserQuestion') {
            savedInput = input;
          } else {
            const trimmedInput = {};
            if (input.file_path) trimmedInput.file_path = input.file_path;
            if (input.command) trimmedInput.command = input.command.substring(0, 200);
            if (input.pattern) trimmedInput.pattern = input.pattern;
            if (input.old_string) trimmedInput.old_string = input.old_string.substring(0, 100);
            if (input.new_string) trimmedInput.new_string = input.new_string.substring(0, 100);
            if (input.url) trimmedInput.url = input.url;
            if (input.query) trimmedInput.query = input.query;
            savedInput = Object.keys(trimmedInput).length > 0 ? trimmedInput : null;
          }
          session.uiMessages.push({
            role: roleName, roleIcon, roleName: displayName,
            type: 'tool',
            toolName: block.name,
            toolId: block.id,
            toolInput: savedInput,
            content: `${block.name} ${block.input?.file_path || block.input?.command?.substring(0, 60) || ''}`,
            hasResult: false,
            taskId, taskTitle, isDecisionMaker,
            timestamp: Date.now()
          });
        }
      }
    }
  } else if (outputType === 'tool_result') {
    // 标记对应 tool 的 hasResult
    const toolId = rawMessage?.message?.tool_use_id;
    if (toolId) {
      for (let i = session.uiMessages.length - 1; i >= 0; i--) {
        if (session.uiMessages[i].type === 'tool' && session.uiMessages[i].toolId === toolId) {
          session.uiMessages[i].hasResult = true;
          break;
        }
      }
    }
    // Check for image blocks in tool_result content
    const resultContent = rawMessage?.message?.content;
    if (Array.isArray(resultContent)) {
      for (const item of resultContent) {
        if (item.type === 'image' && item.source?.type === 'base64') {
          sendCrewMessage({
            type: 'crew_image',
            sessionId: session.id,
            role: roleName,
            roleIcon,
            roleName: displayName,
            toolId: toolId || '',
            mimeType: item.source.media_type,
            data: item.source.data,
            taskId, taskTitle
          });
          session.uiMessages.push({
            role: roleName, roleIcon, roleName: displayName,
            type: 'image', toolId: toolId || '',
            mimeType: item.source.media_type,
            taskId, taskTitle, isDecisionMaker,
            timestamp: Date.now()
          });
        }
      }
    }
  }
  // tool 只保存精简信息（toolName + 摘要），不存完整 toolInput/toolResult
}

/**
 * 从当前活跃 messages（不含历史 shard）中提取有消息的 features。
 * 避免发送全量 features 到前端导致 feature panel 渲染卡顿。
 */
function getActiveFeatures(session) {
  const activeTaskIds = new Set();
  for (const m of session.uiMessages) {
    if (m.taskId) activeTaskIds.add(m.taskId);
  }
  return Array.from(session.features.values())
    .filter(f => activeTaskIds.has(f.taskId));
}

/**
 * 发送 session 状态更新
 */
export function sendStatusUpdate(session) {
  const currentRole = findActiveRole(session);

  sendCrewMessage({
    type: 'crew_status',
    sessionId: session.id,
    status: session.status,
    currentRole,
    round: session.round,
    costUsd: session.costUsd,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    roles: Array.from(session.roles.values()).map(r => ({
      name: r.name,
      displayName: r.displayName,
      icon: r.icon,
      description: r.description,
      isDecisionMaker: r.isDecisionMaker || false,
      model: r.model,
      roleType: r.roleType,
      groupIndex: r.groupIndex
    })),
    activeRoles: Array.from(session.roleStates.entries())
      .filter(([, s]) => s.turnActive)
      .map(([name]) => name),
    currentToolByRole: Object.fromEntries(
      Array.from(session.roleStates.entries())
        .filter(([, s]) => s.turnActive && s.currentTool)
        .map(([name, s]) => [name, s.currentTool])
    ),
    features: getActiveFeatures(session),
    initProgress: session.initProgress || null
  });
  // Persist is NOT called here — callers that change persistent state
  // (status, roles, cost, messages) must call saveSessionMeta explicitly.
}
