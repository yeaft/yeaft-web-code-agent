/**
 * Conductor (V2 orchestration engine) store helpers.
 * Follows the same pattern as crew.js — extracted from chat.js.
 *
 * State model:
 *   conductorSessions: { [sessionId]: ConductorSessionMeta }
 *   conductorTasks:    { [sessionId]: { [taskId]: TaskStatus } }
 *   conductorActors:   { [sessionId]: { [actorKey]: ActorState } }
 *   conductorMessages: { [sessionId]: message[] }
 *   conductorStatuses: { [sessionId]: { status, costUsd, ... } }
 *
 * 2-second throttle: incoming status updates are batched and flushed
 * every 2 s to avoid UI jitter.
 */

// ─── Throttle helpers ────────────────────────────────────
const THROTTLE_MS = 2000;
let _throttleTimers = {};   // sessionId → timerId
let _pendingUpdates = {};   // sessionId → { tasks, actors, status }

function flushThrottled(store, sessionId) {
  const pending = _pendingUpdates[sessionId];
  if (!pending) return;

  if (pending.tasks) {
    if (!store.conductorTasks[sessionId]) store.conductorTasks[sessionId] = {};
    Object.assign(store.conductorTasks[sessionId], pending.tasks);
  }
  if (pending.actors) {
    store.conductorActors[sessionId] = { ...pending.actors };
  }
  if (pending.status) {
    store.conductorStatuses[sessionId] = {
      ...(store.conductorStatuses[sessionId] || {}),
      ...pending.status
    };
  }

  delete _pendingUpdates[sessionId];
  delete _throttleTimers[sessionId];
}

function scheduleFlush(store, sessionId) {
  if (_throttleTimers[sessionId]) return; // already scheduled
  _throttleTimers[sessionId] = setTimeout(() => {
    flushThrottled(store, sessionId);
  }, THROTTLE_MS);
}

function mergeThrottled(store, sessionId, patch) {
  if (!_pendingUpdates[sessionId]) _pendingUpdates[sessionId] = {};
  const p = _pendingUpdates[sessionId];
  if (patch.tasks) p.tasks = { ...(p.tasks || {}), ...patch.tasks };
  if (patch.actors) p.actors = patch.actors; // replace (full snapshot)
  if (patch.status) p.status = { ...(p.status || {}), ...patch.status };
  scheduleFlush(store, sessionId);
}

// ─── Ensure messages array exists ────────────────────────
function ensureMessages(store, sessionId) {
  if (!store.conductorMessages[sessionId]) {
    store.conductorMessages[sessionId] = [];
  }
  return store.conductorMessages[sessionId];
}

// ─── Public actions ──────────────────────────────────────

export function createConductorSession(store, config) {
  const sessionId = 'cond_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const agentId = config.agentId || store.currentAgent;

  store.conductorMessages[sessionId] = [];
  store.conductorTasks[sessionId] = {};
  store.conductorActors[sessionId] = {};

  store.sendWsMessage({
    type: 'create_conductor_session',
    sessionId,
    scenario: config.scenario || 'dev',
    workDir: config.workDir,
    name: config.name || '',
    agentId
  });
}

export function resumeConductorSession(store, sessionId, agentId) {
  if (!store.conductorMessages[sessionId]) store.conductorMessages[sessionId] = [];
  store._pendingConductorRestore = sessionId;
  store.sendWsMessage({
    type: 'resume_conductor_session',
    sessionId,
    agentId: agentId || store.currentAgent
  });
}

export function sendConductorMessage(store, content, taskId = null, attachments = undefined) {
  const sessionId = store.currentConversation;
  const messages = ensureMessages(store, sessionId);

  messages.push({
    id: crypto.randomUUID(),
    role: 'human',
    type: 'text',
    content,
    taskId,
    timestamp: Date.now()
  });

  // Update lastMessageAt for sidebar sorting
  const conv = store.conversations.find(c => c.id === sessionId);
  if (conv) conv.lastMessageAt = Date.now();

  const msg = {
    type: 'conductor_human_input',
    sessionId,
    content,
    taskId,
    agentId: store.currentAgent
  };
  if (attachments && attachments.length > 0) {
    msg.attachments = attachments;
  }

  const sent = store.sendWsMessage(msg);
  if (!sent && messages.length > 0) {
    messages[messages.length - 1]._sendFailed = true;
  }
}

export function sendConductorControl(store, action, taskId = null) {
  const sessionId = store.currentConversation;
  store.sendWsMessage({
    type: 'conductor_control',
    sessionId,
    action,
    taskId,
    agentId: store.currentAgent
  });
}

export function switchConductorWorkDir(store, workDir) {
  const sessionId = store.currentConversation;
  store.sendWsMessage({
    type: 'conductor_switch_workdir',
    sessionId,
    workDir,
    agentId: store.currentAgent
  });
  // Optimistic update
  if (store.conductorSessions[sessionId]) {
    store.conductorSessions[sessionId].currentWorkDir = workDir;
  }
}

// ─── WS message handler ─────────────────────────────────

export function handleConductorOutput(store, msg) {
  if (!msg) return;
  const sid = msg.sessionId;

  // ── Session lifecycle ──

  if (msg.type === 'conductor_session_created') {
    store.conductorSessions[sid] = {
      id: sid,
      scenario: msg.scenario,
      currentWorkDir: msg.workDir,
      name: msg.name || '',
      createdAt: msg.createdAt || Date.now()
    };
    store.conductorTasks[sid] = {};
    store.conductorActors[sid] = {};
    ensureMessages(store, sid).push({
      id: crypto.randomUUID(),
      role: 'system',
      type: 'system',
      content: 'Conductor session started',
      timestamp: Date.now()
    });

    // Create or reuse conversation entry
    let conv = store.conversations.find(c => c.id === sid);
    if (!conv) {
      const agent = store.agents.find(a => a.id === store.currentAgent);
      conv = {
        id: sid,
        agentId: store.currentAgent,
        agentName: agent?.name || store.currentAgent,
        workDir: msg.workDir,
        claudeSessionId: null,
        createdAt: Date.now(),
        processing: false,
        type: 'conductor',
        name: msg.name || ''
      };
      store.conversations.push(conv);
    } else {
      conv.type = 'conductor';
      conv.name = msg.name || '';
    }

    // Switch to this conversation
    if (store.currentConversation && store.messages.length > 0) {
      store.messagesCache[store.currentConversation] = store.messages;
    }
    store.currentConversation = sid;
    store.currentWorkDir = msg.workDir;
    store.messages = [];
    store.saveOpenSessions();
    return;
  }

  if (msg.type === 'conductor_session_restored') {
    store.conductorSessions[sid] = {
      id: sid,
      scenario: msg.scenario,
      currentWorkDir: msg.workDir,
      name: msg.name || '',
      createdAt: msg.createdAt || Date.now()
    };

    // Restore tasks + actors snapshots
    if (msg.tasks) {
      store.conductorTasks[sid] = {};
      for (const t of msg.tasks) {
        store.conductorTasks[sid][t.taskId] = t;
      }
    }
    if (msg.actors) {
      store.conductorActors[sid] = {};
      for (const a of msg.actors) {
        store.conductorActors[sid][a.key || `${a.persona}-${a.specialty}`] = a;
      }
    }

    // Restore messages
    if (msg.uiMessages && msg.uiMessages.length > 0) {
      store.conductorMessages[sid] = msg.uiMessages.map(m => ({
        id: m.timestamp || crypto.randomUUID(),
        role: m.role,
        type: m.type || 'text',
        content: m.content,
        taskId: m.taskId || null,
        persona: m.persona || null,
        specialty: m.specialty || null,
        timestamp: m.timestamp || Date.now(),
        _streaming: false
      }));
    } else {
      ensureMessages(store, sid);
    }

    // Ensure conversation entry
    let conv = store.conversations.find(c => c.id === sid);
    if (!conv) {
      const agent = store.agents.find(a => a.id === store.currentAgent);
      conv = {
        id: sid,
        agentId: store.currentAgent,
        agentName: agent?.name || store.currentAgent,
        workDir: msg.workDir,
        claudeSessionId: null,
        createdAt: Date.now(),
        processing: false,
        type: 'conductor',
        name: msg.name || ''
      };
      store.conversations.push(conv);
    } else {
      conv.type = 'conductor';
      conv.name = msg.name || '';
    }

    // Switch if user explicitly restored
    if (store._pendingConductorRestore === sid) {
      if (store.currentConversation && store.messages.length > 0) {
        store.messagesCache[store.currentConversation] = store.messages;
      }
      store.currentConversation = sid;
      store.currentWorkDir = msg.workDir;
      store.messages = [];
      delete store._pendingConductorRestore;
    }
    store.saveOpenSessions();
    return;
  }

  // ── Status updates (throttled) ──

  if (msg.type === 'conductor_status_update') {
    const patch = {};
    if (msg.tasks) {
      patch.tasks = {};
      for (const t of msg.tasks) {
        patch.tasks[t.taskId] = t;
      }
    }
    if (msg.actors) {
      patch.actors = {};
      for (const a of msg.actors) {
        patch.actors[a.key || `${a.persona}-${a.specialty}`] = a;
      }
    }
    if (msg.status || msg.costUsd !== undefined) {
      patch.status = {
        status: msg.status,
        costUsd: msg.costUsd,
        totalInputTokens: msg.totalInputTokens || 0,
        totalOutputTokens: msg.totalOutputTokens || 0
      };
    }
    mergeThrottled(store, sid, patch);
    return;
  }

  if (msg.type === 'conductor_actor_update') {
    // Immediate actor state change (spawn / release)
    if (!store.conductorActors[sid]) store.conductorActors[sid] = {};
    const key = msg.actorKey || `${msg.persona}-${msg.specialty}`;

    if (msg.action === 'spawn') {
      store.conductorActors[sid][key] = {
        key,
        persona: msg.persona,
        specialty: msg.specialty,
        taskId: msg.taskId,
        status: msg.status || 'active',
        spawnedAt: Date.now()
      };
      // System message
      ensureMessages(store, sid).push({
        id: crypto.randomUUID(),
        role: 'system',
        type: 'actor_spawn',
        content: `${msg.persona} joined as ${msg.specialty}`,
        persona: msg.persona,
        specialty: msg.specialty,
        taskId: msg.taskId,
        timestamp: Date.now()
      });
    } else if (msg.action === 'release') {
      // Mark as releasing for CSS fade-out animation, then remove after 300ms
      if (store.conductorActors[sid][key]) {
        store.conductorActors[sid][key].status = 'releasing';
        setTimeout(() => {
          if (store.conductorActors[sid]?.[key]?.status === 'releasing') {
            delete store.conductorActors[sid][key];
          }
        }, 300);
      } else {
        delete store.conductorActors[sid][key];
      }
      ensureMessages(store, sid).push({
        id: crypto.randomUUID(),
        role: 'system',
        type: 'actor_release',
        content: `${msg.persona} (${msg.specialty}) completed`,
        persona: msg.persona,
        specialty: msg.specialty,
        taskId: msg.taskId,
        timestamp: Date.now()
      });
    } else if (msg.action === 'status') {
      if (store.conductorActors[sid][key]) {
        store.conductorActors[sid][key].status = msg.status;
      }
    }
    return;
  }

  // ── Task lifecycle ──

  if (msg.type === 'conductor_task_created') {
    if (!store.conductorTasks[sid]) store.conductorTasks[sid] = {};
    store.conductorTasks[sid][msg.taskId] = {
      taskId: msg.taskId,
      title: msg.title,
      status: 'active',
      plan: msg.plan || [],
      instanceCount: 0,
      progress: 0,
      createdAt: Date.now()
    };
    ensureMessages(store, sid).push({
      id: crypto.randomUUID(),
      role: 'conductor',
      type: 'task_created',
      content: `Task created: ${msg.title}`,
      taskId: msg.taskId,
      timestamp: Date.now()
    });
    return;
  }

  if (msg.type === 'conductor_task_updated') {
    if (store.conductorTasks[sid]?.[msg.taskId]) {
      const task = store.conductorTasks[sid][msg.taskId];
      if (msg.status) task.status = msg.status;
      if (msg.plan) task.plan = msg.plan;
      if (msg.progress !== undefined) task.progress = msg.progress;
      if (msg.instanceCount !== undefined) task.instanceCount = msg.instanceCount;
    }
    return;
  }

  if (msg.type === 'conductor_task_completed') {
    if (store.conductorTasks[sid]?.[msg.taskId]) {
      store.conductorTasks[sid][msg.taskId].status = 'completed';
      store.conductorTasks[sid][msg.taskId].progress = 100;
    }
    ensureMessages(store, sid).push({
      id: crypto.randomUUID(),
      role: 'system',
      type: 'task_completed',
      content: `Task completed: ${msg.title || msg.taskId}`,
      taskId: msg.taskId,
      timestamp: Date.now()
    });
    return;
  }

  // ── Message output (conductor / orchestrator / actor text) ──

  if (msg.type === 'conductor_output') {
    const messages = ensureMessages(store, sid);

    if (msg.outputType === 'text') {
      // Try to append to existing streaming message from same source
      let streamMsg = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === msg.role && m._streaming && (m.taskId || null) === (msg.taskId || null)) {
          streamMsg = m;
          break;
        }
      }

      const textContent = extractTextContent(msg);

      if (streamMsg) {
        streamMsg.content += textContent;
        return;
      }

      messages.push({
        id: crypto.randomUUID(),
        role: msg.role || 'conductor',
        type: 'text',
        content: textContent,
        taskId: msg.taskId || null,
        persona: msg.persona || null,
        specialty: msg.specialty || null,
        _streaming: true,
        timestamp: Date.now()
      });
      return;
    }

    if (msg.outputType === 'tool_use') {
      // End streaming text
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === msg.role && messages[i]._streaming) {
          messages[i]._streaming = false;
          break;
        }
      }

      const content = msg.data?.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            messages.push({
              id: crypto.randomUUID(),
              role: msg.role || 'conductor',
              type: 'tool',
              toolName: block.name,
              toolId: block.id,
              toolInput: block.input,
              hasResult: false,
              toolResult: null,
              taskId: msg.taskId || null,
              persona: msg.persona || null,
              specialty: msg.specialty || null,
              content: `${block.name} ${block.input?.file_path || block.input?.command?.substring(0, 60) || ''}`,
              timestamp: Date.now()
            });
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

    if (msg.outputType === 'system') {
      const text = extractTextContent(msg);
      messages.push({
        id: crypto.randomUUID(),
        role: 'system',
        type: 'system',
        content: text,
        taskId: msg.taskId || null,
        timestamp: Date.now()
      });
      return;
    }
  }

  // ── Turn completed ──

  if (msg.type === 'conductor_turn_completed') {
    const messages = ensureMessages(store, sid);
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === msg.role && messages[i]._streaming) {
        messages[i]._streaming = false;
        break;
      }
    }
    return;
  }

  // ── Work dir switched ──

  if (msg.type === 'conductor_workdir_changed') {
    if (store.conductorSessions[sid]) {
      store.conductorSessions[sid].currentWorkDir = msg.workDir;
    }
    const conv = store.conversations.find(c => c.id === sid);
    if (conv) conv.workDir = msg.workDir;
    if (store.currentConversation === sid) {
      store.currentWorkDir = msg.workDir;
    }
    return;
  }

  // ── Session error ──

  if (msg.type === 'conductor_error') {
    ensureMessages(store, sid).push({
      id: crypto.randomUUID(),
      role: 'system',
      type: 'error',
      content: msg.error || msg.message || 'Unknown error',
      taskId: msg.taskId || null,
      timestamp: Date.now()
    });
    return;
  }
}

// ─── Text extraction helper ──────────────────────────────

function extractTextContent(msg) {
  const content = msg.data?.message?.content ?? msg.content ?? '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  return '';
}

// ─── Cleanup on disconnect / logout ──────────────────────

export function clearConductorThrottles() {
  for (const id of Object.keys(_throttleTimers)) {
    clearTimeout(_throttleTimers[id]);
  }
  _throttleTimers = {};
  _pendingUpdates = {};
}
