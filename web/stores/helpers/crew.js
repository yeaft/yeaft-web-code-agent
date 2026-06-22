/**
 * Crew (multi-agent) actions for the chat store.
 * Extracted from chat.js to keep the main store file focused.
 */

// Timeout guard for refreshingSession — auto-reset after 15s if response never arrives
// Per-conversation timers to avoid cross-pane interference
const _refreshTimers = {};

export function startRefreshTimeout(store, convId) {
  clearRefreshTimeout(convId);
  _refreshTimers[convId || '_global'] = setTimeout(() => {
    store.setRefreshingSession(convId, false);
    delete _refreshTimers[convId || '_global'];
  }, 15000);
}

export function clearRefreshTimeout(convId) {
  const key = convId || '_global';
  if (_refreshTimers[key]) {
    clearTimeout(_refreshTimers[key]);
    delete _refreshTimers[key];
  }
}

/** Mark pending crew tool messages as completed, optionally filtered by role */
function markCrewToolsCompleted(messages, role) {
  for (const m of messages) {
    if (m.type === 'tool' && !m.hasResult && (!role || m.role === role)) {
      m.hasResult = true;
    }
  }
}

export function enterCrewMode(store) {
  const wasEnabled = store.crewModeEnabled;
  if (!wasEnabled) {
    store.setCrewModeEnabled(true);
  }
  store.crewConfigMode = 'create';
  store.crewConfigOpen = true;
  if (wasEnabled) store.listCrewSessions();
}

export function listCrewSessions(store) {
  if (!store.currentAgent || !store.crewModeEnabled) return;
  store.sendWsMessage({
    type: 'list_crew_sessions',
    agentId: store.currentAgent
  });
}

export function handleCrewSessionsList(store, msg) {
  if (!store.crewModeEnabled) return;
  const sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
  // The crew_sessions_list reply carries no top-level agentId; the list was
  // requested keyed on the active agent (see listCrewSessions), so these rows
  // belong to store.currentAgent.
  const agentId = store.currentAgent;
  if (!agentId) return;
  const agent = store.agents.find(a => a.id === agentId);
  const listedIds = new Set();

  for (const session of sessions) {
    if (!session?.sessionId) continue;
    listedIds.add(session.sessionId);
    const active = session.active === true;
    const next = {
      id: session.sessionId,
      agentId,
      agentName: agent?.name || agentId,
      workDir: session.projectDir,
      createdAt: session.createdAt || session.updatedAt || Date.now(),
      processing: active && session.status === 'running',
      type: 'crew',
      name: session.name || '',
      crewListLoaded: true
    };
    const conv = store.conversations.find(c => c.id === session.sessionId);
    if (conv) {
      Object.assign(conv, next);
    } else {
      store.conversations.push(next);
    }
  }

  store.conversations = store.conversations.filter(conv => {
    if (conv.type !== 'crew') return true;
    if (conv.agentId !== agentId) return true;
    if (!conv.crewListLoaded) return true;
    if (store.activeConversations.includes(conv.id)) return true;
    return listedIds.has(conv.id);
  });
}

export function checkCrewExists(store, projectDir, agentId) {
  store.crewExistsResult = null;
  store.sendWsMessage({
    type: 'check_crew_exists',
    projectDir,
    agentId: agentId || store.currentAgent
  });
}

export function deleteCrewDir(store, projectDir, agentId) {
  store.sendWsMessage({
    type: 'delete_crew_dir',
    projectDir,
    agentId: agentId || store.currentAgent
  });
}

export function openCrewConfig(store) {
  store.crewConfigMode = 'edit';
  store.crewConfigOpen = true;
}

export function createCrewSession(store, config) {
  const sessionId = 'crew_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const agentId = config.agentId || store.currentAgent;
  // 初始化 crew 消息存储
  store.crewMessagesMap[sessionId] = [];
  store.sendWsMessage({
    type: 'create_crew_session',
    sessionId,
    projectDir: config.projectDir,
    sharedDir: config.sharedDir || '.crew',
    name: config.name || '',
    roles: config.roles,
    teamType: config.teamType || 'dev',
    language: config.language || 'zh-CN',
    agentId
  });
  store.crewConfigOpen = false;
}

export function resumeCrewSession(store, sessionId, agentId) {
  // 初始化 crew 消息存储
  if (!store.crewMessagesMap[sessionId]) store.crewMessagesMap[sessionId] = [];
  // 标记用户主动恢复 — crew_session_restored 收到后据此切换 currentConversation
  // 页面刷新按钮直接发 WS 消息，不经此函数，不会设置标记
  store._pendingCrewRestore = sessionId;
  store.sendWsMessage({
    type: 'resume_crew_session',
    sessionId,
    agentId: agentId || store.currentAgent
  });
}

export function loadCrewHistory(store, sessionId) {
  const older = store.crewOlderMessages[sessionId];
  if (!older || !older.hasMore || older.loading) return false;
  older.loading = true;
  store.sendWsMessage({
    type: 'crew_load_history',
    sessionId,
    shardIndex: older.nextShard,
    agentId: store.currentAgent
  });
  return true;
}

/**
 * Infer taskId for a human message so it appears in the relevant feature detail.
 * Priority: 1) @mentioned role's latest taskId, 2) currently streaming feature taskId, 3) null (global)
 */
function inferHumanMessageTaskId(store, sessionId, targetRole) {
  const messages = store.crewMessagesMap[sessionId];
  if (!messages || messages.length === 0) return null;

  // 1. If user @mentioned a specific role, find that role's latest taskId
  if (targetRole) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === targetRole && m.taskId) return m.taskId;
    }
  }

  // 2. Find the currently streaming feature's taskId
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m._streaming && m.taskId) return m.taskId;
  }

  return null;
}

export function sendCrewMessage(store, content, targetRole, attachments, conversationId) {
  const sessionId = conversationId || store.currentConversation;
  // 添加人的消息到本地显示
  if (!store.crewMessagesMap[sessionId]) store.crewMessagesMap[sessionId] = [];

  // Infer taskId for the human message so it appears in feature detail
  const taskId = inferHumanMessageTaskId(store, sessionId, targetRole);

  store.crewMessagesMap[sessionId].push({
    id: Date.now(),
    role: 'human',
    roleIcon: 'H',
    roleName: '你',
    type: 'text',
    content,
    attachments,
    taskId,
    timestamp: Date.now()
  });
  // Update lastMessageAt for sidebar sorting
  const conv = store.conversations.find(c => c.id === sessionId);
  if (conv) {
    conv.lastMessageAt = Date.now();
  }
  // 发送到 server
  const msg = {
    type: 'crew_human_input',
    sessionId,
    content,
    targetRole,
    agentId: store.currentAgent
  };
  if (attachments && attachments.length > 0) {
    msg.attachments = attachments;
  }
  const sent = store.sendWsMessage(msg);
  if (!sent) {
    // Mark the message as failed so user knows it didn't send
    const messages = store.crewMessagesMap[sessionId];
    if (messages && messages.length > 0) {
      messages[messages.length - 1]._sendFailed = true;
    }
  }
}

export function sendCrewControl(store, action, targetRole, conversationId) {
  const sessionId = conversationId || store.currentConversation;
  store.sendWsMessage({
    type: 'crew_control',
    sessionId,
    action,
    targetRole,
    agentId: store.currentAgent
  });
}

export function addCrewRole(store, role, conversationId) {
  const sessionId = conversationId || store.currentConversation;
  store.sendWsMessage({
    type: 'crew_add_role',
    sessionId,
    role,
    agentId: store.currentAgent
  });
}

export function removeCrewRole(store, roleName, conversationId) {
  const sessionId = conversationId || store.currentConversation;
  store.sendWsMessage({
    type: 'crew_remove_role',
    sessionId,
    roleName,
    agentId: store.currentAgent
  });
}

export function renameCrewSession(store, sessionId, name) {
  // Optimistic update: immediately reflect in sidebar
  const conv = store.conversations.find(c => c.id === sessionId);
  if (conv) conv.name = name;
  // Also update crewSessions metadata if present
  if (store.crewSessions[sessionId]) {
    store.crewSessions[sessionId].name = name;
  }
  // Persist via agent
  store.sendWsMessage({
    type: 'update_crew_session',
    sessionId,
    name,
    agentId: store.currentAgent
  });
}

export function handleCrewOutput(store, msg) {
  if (!msg) return;
  const sid = msg.sessionId;

  // 确保消息数组存在
  const ensureMessages = (sessionId) => {
    if (!store.crewMessagesMap[sessionId]) store.crewMessagesMap[sessionId] = [];
    return store.crewMessagesMap[sessionId];
  };

  if (msg.type === 'crew_session_created') {
    store.crewSessions[sid] = {
      id: sid,
      projectDir: msg.projectDir,
      sharedDir: msg.sharedDir,
      name: msg.name || '',
      roles: msg.roles,
      decisionMaker: msg.decisionMaker
    };
    // 恢复旧消息历史（recreate 场景）或初始化新消息
    if (msg.uiMessages && msg.uiMessages.length > 0) {
      ensureMessages(sid).push(...msg.uiMessages);
      if (msg.hasOlderMessages) {
        store.crewOlderMessages[sid] = { hasMore: true, nextShard: 1, loading: false };
      }
    } else {
      ensureMessages(sid).push({
        id: Date.now(),
        role: 'system',
        roleIcon: 'S',
        roleName: '系统',
        type: 'system',
        content: `Crew Session 已创建`,
        timestamp: Date.now()
      });
    }
    // 创建或更新 conversation
    let conv = store.conversations.find(c => c.id === sid);
    if (!conv) {
      const agent = store.agents.find(a => a.id === store.currentAgent);
      conv = {
        id: sid,
        agentId: store.currentAgent,
        agentName: agent?.name || store.currentAgent,
        workDir: msg.projectDir,
        claudeSessionId: null,
        createdAt: Date.now(),
        processing: false,
        type: 'crew',
        name: msg.name || ''
      };
      store.conversations.push(conv);
    } else {
      conv.type = 'crew';
      conv.name = msg.name || '';
    }
    // 切换到 crew conversation — split mode aware
    if (store.panels.length > 1) {
      const pendingPaneId = store._pendingPaneId;
      store._pendingPaneId = null;
      if (pendingPaneId) {
        const targetPane = store.panels.find(p => p.id === pendingPaneId);
        if (targetPane) targetPane.conversationId = sid;
      } else {
        const emptyPane = store.panels.find(p => !p.conversationId);
        if (emptyPane) emptyPane.conversationId = sid;
      }
      if (!store.activeConversations.includes(sid)) {
        store.activeConversations.push(sid);
      }
    } else {
      store.activeConversations = [sid];
    }
    store.currentWorkDir = msg.projectDir;
    store.messagesMap[sid] = [];
    store.saveOpenSessions();
    return;
  }

  if (msg.type === 'crew_session_restored') {
    // 恢复时只重建 session 数据，不添加系统消息，不强制切换
    // ★ 防御空 roles：如果 agent 返回空 roles，保留前端已有的 roles（fallback）
    const incomingRoles = msg.roles;
    const existingRoles = store.crewSessions[sid]?.roles;
    const effectiveRoles = (incomingRoles && incomingRoles.length > 0)
      ? incomingRoles
      : (existingRoles && existingRoles.length > 0 ? existingRoles : []);
    if (!incomingRoles || incomingRoles.length === 0) {
      console.warn(`[Crew] crew_session_restored for ${sid} has empty roles, using fallback:`, effectiveRoles.length);
    }
    store.crewSessions[sid] = {
      id: sid,
      projectDir: msg.projectDir,
      sharedDir: msg.sharedDir,
      name: msg.name || '',
      roles: effectiveRoles,
      decisionMaker: msg.decisionMaker
    };
    // 恢复 UI 消息历史
    // ★ Only replace messages when this is an explicit user-initiated restore
    // (_pendingCrewRestore is set) or the local session has no messages.
    // During normal operation, agent_list triggers resume_crew_session which
    // sends crew_session_restored. Replacing messages mid-turn would wipe the
    // local human message and make the typing indicator disappear prematurely.
    const localMsgs = store.crewMessagesMap[sid];
    const isUserInitiatedRestore = store._pendingCrewRestore === sid;
    const hasLocalMessages = localMsgs && localMsgs.length > 0;
    if (msg.uiMessages && msg.uiMessages.length > 0 && (!hasLocalMessages || isUserInitiatedRestore)) {
      store.crewMessagesMap[sid] = msg.uiMessages.map(m => {
        // Dynamically compute isDecisionMaker from session roles (same as real-time crew_output)
        const senderRole = effectiveRoles.find(r => r.name === m.role);
        // Restored AskUserQuestion: expire only if no askRequestId at all.
        // If askRequestId exists but askAnswered is false → keep interactive so user can still submit.
        const isAsk = m.type === 'tool' && m.toolName === 'AskUserQuestion';
        const isHistoryAsk = isAsk && !m.askRequestId;
        return {
          id: m.timestamp || Date.now() + Math.random(),
          role: m.role,
          roleIcon: m.roleIcon,
          roleName: m.roleName,
          type: m.type,
          content: m.content,
          routeTo: m.routeTo,
          routeSummary: m.routeSummary || '',
          round: m.round || 0,
          toolName: m.toolName || null,
          toolId: m.toolId || null,
          toolInput: m.toolInput || null,
          toolResult: null,
          hasResult: m.hasResult || false,
          isHistory: isHistoryAsk || undefined,
          // Preserve ask state for unanswered questions so UI keeps them interactive
          askRequestId: (isAsk && m.askRequestId) ? m.askRequestId : undefined,
          askAnswered: (isAsk && m.askRequestId) ? !!m.askAnswered : undefined,
          askQuestions: (isAsk && m.askQuestions) ? m.askQuestions : undefined,
          selectedAnswers: (isAsk && m.selectedAnswers) ? m.selectedAnswers : undefined,
          taskId: m.taskId || null,
          taskTitle: m.taskTitle || null,
          isDecisionMaker: !!(senderRole && senderRole.isDecisionMaker),
          timestamp: m.timestamp || Date.now()
          // 显式不包含 _streaming — 恢复的消息不应有 streaming 状态
        };
      });
    } else {
      ensureMessages(sid);
    }
    // 记录是否有历史分片可加载
    if (msg.hasOlderMessages) {
      store.crewOlderMessages[sid] = { hasMore: true, nextShard: 1, loading: false };
    } else {
      delete store.crewOlderMessages[sid];
    }
    // 确保 conversation 存在
    let conv = store.conversations.find(c => c.id === sid);
    if (!conv) {
      const agent = store.agents.find(a => a.id === store.currentAgent);
      conv = {
        id: sid,
        agentId: store.currentAgent,
        agentName: agent?.name || store.currentAgent,
        workDir: msg.projectDir,
        claudeSessionId: null,
        createdAt: Date.now(),
        processing: false,
        type: 'crew',
        name: msg.name || ''
      };
      store.conversations.push(conv);
    } else {
      conv.type = 'crew';
      conv.name = msg.name || '';
    }
    // 用户主动恢复（从 CrewConfigPanel 点击恢复按钮）→ 切换到恢复的 session
    // 页面刷新时不设置 _pendingCrewRestore，不切换（保持当前行为）
    if (store._pendingCrewRestore === sid) {
      // Split mode aware — don't nuke other panes' conversations
      if (store.panels.length > 1) {
        const pendingPaneId = store._pendingPaneId;
        store._pendingPaneId = null;
        if (pendingPaneId) {
          const targetPane = store.panels.find(p => p.id === pendingPaneId);
          if (targetPane) targetPane.conversationId = sid;
        } else {
          // Find the pane that triggered the restore, or an empty pane
          const emptyPane = store.panels.find(p => !p.conversationId);
          if (emptyPane) emptyPane.conversationId = sid;
        }
        if (!store.activeConversations.includes(sid)) {
          store.activeConversations.push(sid);
        }
      } else {
        store.activeConversations = [sid];
      }
      store.currentWorkDir = msg.projectDir;
      store.messagesMap[sid] = [];
      delete store._pendingCrewRestore;
    }
    store.saveOpenSessions();
    // ★ Reset refreshingSession flag — crew_session_restored completes a refresh cycle
    store.setRefreshingSession(sid, false);
    clearRefreshTimeout(sid);
    return;
  }

  if (msg.type === 'crew_output') {
    const messages = ensureMessages(sid);
    // Check if message sender is a decision maker from crew session roles
    const sessionRoles = store.crewSessions[sid]?.roles || [];
    const senderRole = sessionRoles.find(r => r.name === msg.role);
    const crewMsg = {
      id: Date.now() + Math.random(),
      role: msg.role,
      roleIcon: msg.roleIcon,
      roleName: msg.roleName,
      type: msg.outputType,
      taskId: msg.taskId || null,
      taskTitle: msg.taskTitle || null,
      isDecisionMaker: !!(senderRole && senderRole.isDecisionMaker),
      timestamp: Date.now()
    };

    if (msg.outputType === 'text') {
      const msgTaskId = msg.taskId || null;
      // 反向搜索该角色的最后一条 _streaming 消息（并发安全）
      // ★ 同时匹配 taskId，防止跨 task 合并导致 feature 面板丢失消息
      let streamMsg = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === msg.role && messages[i].type === 'text' && messages[i]._streaming
            && (messages[i].taskId || null) === msgTaskId) {
          streamMsg = messages[i];
          break;
        }
      }
      // 如果没有 _streaming 消息，查找同角色最后一条 text（可能被 tool_use 关闭了 _streaming）
      // 如果中间只隔了 tool/tool_result（同角色），说明在同一 turn 内，重新 append
      // ★ 同样检查 taskId 一致性
      if (!streamMsg) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.role !== msg.role) break; // 碰到其他角色的消息，停止
          if (m.type === 'text' && (m.taskId || null) === msgTaskId) { streamMsg = m; break; }
          if (m.type === 'text') break; // 同角色 text 但 taskId 不同，停止
          if (m.type !== 'tool') break; // 碰到非 tool 类型（如 route/system），停止
        }
        if (streamMsg) streamMsg._streaming = true;
      }
      if (streamMsg) {
        const content = msg.data?.message?.content;
        if (content) {
          if (typeof content === 'string') {
            streamMsg.content += content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                streamMsg.content += block.text;
              }
            }
          }
        }
        return;
      }
      const content = msg.data?.message?.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content.filter(b => b.type === 'text').map(b => b.text).join('');
      }
      crewMsg.content = text;
      crewMsg._streaming = true;
      messages.push(crewMsg);
      return;
    }

    if (msg.outputType === 'tool_use') {
      // 先结束该角色的 streaming 文本（tool_use 意味着文本部分结束）
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === msg.role && messages[i].type === 'text' && messages[i]._streaming) {
          messages[i]._streaming = false;
          break;
        }
      }
      const content = msg.data?.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            messages.push({
              ...crewMsg,
              type: 'tool',
              toolName: block.name,
              toolId: block.id,
              toolInput: block.input,
              hasResult: false,
              toolResult: null,
              content: `${block.name} ${block.input?.file_path || block.input?.command?.substring(0, 60) || ''}`
            });
            // AskUserQuestion: 提取 question 内容作为普通消息显示在聊天区
            if (block.name === 'AskUserQuestion') {
              const questions = block.input?.questions || [];
              const questionText = questions.map(q => q.question).filter(Boolean).join('\n') || block.input?.question || '';
              if (questionText) {
                messages.push({
                  ...crewMsg,
                  id: crewMsg.id + '_ask_text',
                  type: 'text',
                  content: questionText,
                  _askQuestion: true,  // 标记为 ask 问题消息
                });
              }
            }
          }
        }
      }
      return;
    }

    if (msg.outputType === 'tool_result') {
      const resultContent = msg.data?.message?.content;
      if (Array.isArray(resultContent)) {
        for (const block of resultContent) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].type === 'tool' && messages[i].toolId === block.tool_use_id) {
                messages[i].hasResult = true;
                messages[i].toolResult = block.content;
                break;
              }
            }
          }
        }
      }
      return;
    }

    if (msg.outputType === 'route') {
      // End streaming on this role's last text (route = turn finished, same as tool_use)
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === msg.role && messages[i].type === 'text' && messages[i]._streaming) {
          messages[i]._streaming = false;
          break;
        }
      }
      messages.push({
        ...crewMsg,
        type: 'route',
        routeTo: msg.routeTo,
        routeSummary: msg.routeSummary || '',
        routeImages: msg.routeImages || [],  // [{fileId, previewToken, mimeType}]
        round: store.crewStatuses[sid]?.round || 0,
        content: `→ @${msg.routeTo} ${msg.routeSummary || ''}`
      });
      return;
    }

    if (msg.outputType === 'system') {
      const content = msg.data?.message?.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content.filter(b => b.type === 'text').map(b => b.text).join('');
      }
      messages.push({
        ...crewMsg,
        type: 'system',
        content: text
      });
      return;
    }
  }

  if (msg.type === 'crew_image') {
    const messages = ensureMessages(sid);
    const imgRoles = store.crewSessions[sid]?.roles || [];
    const imgSender = imgRoles.find(r => r.name === msg.role);
    messages.push({
      id: Date.now() + Math.random(),
      role: msg.role,
      roleIcon: msg.roleIcon,
      roleName: msg.roleName,
      type: 'image',
      fileId: msg.fileId,
      previewToken: msg.previewToken,
      mimeType: msg.mimeType,
      toolId: msg.toolId,
      taskId: msg.taskId || null,
      taskTitle: msg.taskTitle || null,
      isDecisionMaker: !!(imgSender && imgSender.isDecisionMaker),
      timestamp: Date.now()
    });
    return;
  }

  if (msg.type === 'crew_status') {
    store.crewStatuses[sid] = {
      status: msg.status,
      currentRole: msg.currentRole,
      round: msg.round,
      costUsd: msg.costUsd,
      totalInputTokens: msg.totalInputTokens || 0,
      totalOutputTokens: msg.totalOutputTokens || 0,
      activeRoles: msg.activeRoles || [],
      currentToolByRole: msg.currentToolByRole || {},
      features: msg.features || [],
      initProgress: msg.initProgress || null
    };
    if (msg.roles && msg.roles.length > 0 && store.crewSessions[sid]) {
      store.crewSessions[sid].roles = msg.roles;
    }
    // 根据 activeRoles 同步 _streaming 标记
    const messages = store.crewMessagesMap[sid];
    if (messages) {
      const activeSet = new Set(msg.activeRoles || []);
      if (activeSet.size === 0) {
        for (const m of messages) {
          if (m._streaming) m._streaming = false;
        }
        markCrewToolsCompleted(messages);
      } else {
        for (const m of messages) {
          if (m._streaming && !activeSet.has(m.role)) {
            m._streaming = false;
            if (m.type === 'tool' && !m.hasResult) m.hasResult = true;
          }
        }
      }
    }
    // Clear processing dot when crew session stops or completes
    if (msg.status === 'stopped' || msg.status === 'completed') {
      delete store.processingConversations[sid];
    }
    return;
  }

  if (msg.type === 'crew_turn_completed') {
    const messages = ensureMessages(sid);
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === msg.role && messages[i]._streaming) {
        messages[i]._streaming = false;
        if (msg.interrupted) {
          messages[i].interrupted = true;
        }
        break;
      }
    }
    markCrewToolsCompleted(messages, msg.role);
    return;
  }

  if (msg.type === 'crew_message_queued') {
    ensureMessages(sid).push({
      id: Date.now() + Math.random(),
      role: 'system',
      type: 'system',
      content: `消息已排队，等待 ${msg.target} 完成当前任务（队列: ${msg.queueLength}）`,
      timestamp: Date.now()
    });
    return;
  }

  if (msg.type === 'crew_role_error') {
    ensureMessages(sid).push({
      id: Date.now() + Math.random(),
      role: 'system',
      roleIcon: '\u26a0',
      roleName: msg.role,
      type: 'role_error',
      content: msg.recoverable
        ? `${msg.role} 遇到 ${msg.reason}，正在自动恢复 (${msg.retryCount}/3)...`
        : `${msg.role} 发生不可恢复错误: ${msg.error}`,
      error: msg.error,
      reason: msg.reason,
      recoverable: msg.recoverable,
      retryCount: msg.retryCount,
      timestamp: Date.now()
    });
    return;
  }

  if (msg.type === 'crew_human_needed') {
    ensureMessages(sid).push({
      id: Date.now(),
      role: 'system',
      roleIcon: 'S',
      roleName: '系统',
      type: 'human_needed',
      fromRole: msg.fromRole,
      content: `${msg.fromRole} 需要人工介入: ${msg.message}`,
      timestamp: Date.now()
    });
    return;
  }

  if (msg.type === 'crew_routing') {
    // Show route notification toasts
    if (msg.status === 'routing' && msg.routes && msg.routes.length > 0) {
      const sessionRoles = store.crewSessions[sid]?.roles || [];
      const fromRoleObj = sessionRoles.find(r => r.name === msg.fromRole);
      for (const route of msg.routes) {
        const toRoleObj = sessionRoles.find(r => r.name === route.to);
        store.crewNotifications.push({
          id: Date.now() + Math.random(),
          fromRole: msg.fromRole,
          fromIcon: fromRoleObj?.icon || '',
          fromName: fromRoleObj?.displayName || msg.fromRole,
          toRole: route.to,
          toIcon: toRoleObj?.icon || '',
          toName: toRoleObj?.displayName || route.to,
          taskId: route.taskId || null,
          taskTitle: route.taskTitle || null,
          timestamp: Date.now()
        });
      }
    }
    return;
  }

  if (msg.type === 'crew_session_cleared') {
    // 清空前端消息和 feature/task 数据，保留 session 配置
    store.crewMessagesMap[sid] = [];
    delete store.crewOlderMessages[sid];
    // 清除 features，避免残留空 task 卡片
    if (store.crewStatuses[sid]) {
      store.crewStatuses[sid].features = [];
    }
    store.crewNotifications = [];
    return;
  }

  if (msg.type === 'crew_history_loaded') {
    const older = store.crewOlderMessages[sid];
    if (!older) return;
    older.loading = false;
    // Prepend historical messages to the front of the array
    if (msg.messages && msg.messages.length > 0) {
      const sessionRoles = store.crewSessions[sid]?.roles || [];
      const mapped = msg.messages.map(m => {
        const senderRole = sessionRoles.find(r => r.name === m.role);
        return {
          id: m.timestamp || Date.now() + Math.random(),
          role: m.role,
          roleIcon: m.roleIcon,
          roleName: m.roleName,
          type: m.type,
          content: m.content,
          routeTo: m.routeTo,
          routeSummary: m.routeSummary || '',
          round: m.round || 0,
          toolName: m.toolName || null,
          toolId: m.toolId || null,
          toolInput: m.toolInput || null,
          toolResult: null,
          hasResult: m.hasResult || false,
          taskId: m.taskId || null,
          taskTitle: m.taskTitle || null,
          isDecisionMaker: !!(senderRole && senderRole.isDecisionMaker),
          timestamp: m.timestamp || Date.now()
        };
      });
      const existing = store.crewMessagesMap[sid] || [];
      // Replace the array ref to trigger featureBlocks cache invalidation
      store.crewMessagesMap[sid] = [...mapped, ...existing];
    }
    if (msg.hasMore) {
      older.nextShard = (msg.shardIndex || 1) + 1;
      older.hasMore = true;
    } else {
      older.hasMore = false;
    }
    return;
  }

  if (msg.type === 'crew_role_added') {
    if (store.crewSessions[sid]) {
      store.crewSessions[sid].roles = [...(store.crewSessions[sid].roles || []), msg.role];
      // Sort roles by type priority, then by groupIndex within same type
      const ROLE_TYPE_ORDER = { pm: 0, developer: 1, reviewer: 2, tester: 3, designer: 4, architect: 5, ops: 6, researcher: 7, writer: 8 };
      const getRoleType = (r) => r.roleType || r.name.replace(/-\d+$/, '');
      const getOrder = (r) => ROLE_TYPE_ORDER[getRoleType(r)] ?? 99;
      store.crewSessions[sid].roles.sort((a, b) => {
        const orderDiff = getOrder(a) - getOrder(b);
        if (orderDiff !== 0) return orderDiff;
        return (a.groupIndex || 0) - (b.groupIndex || 0);
      });
      if (msg.decisionMaker) {
        store.crewSessions[sid].decisionMaker = msg.decisionMaker;
      }
    }
    return;
  }

  if (msg.type === 'crew_role_removed') {
    if (store.crewSessions[sid]) {
      store.crewSessions[sid].roles = (store.crewSessions[sid].roles || []).filter(r => r.name !== msg.roleName);
      if (msg.decisionMaker !== undefined) {
        store.crewSessions[sid].decisionMaker = msg.decisionMaker;
      }
    }
    return;
  }
}
