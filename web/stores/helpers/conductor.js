/**
 * Conductor (V5 — 1:1 singleton per Agent) store helpers.
 *
 * V5 model:
 *   - No sessionId — each Agent has exactly one Conductor
 *   - Keyed by agentId (using `conductor_${agentId}` as conversation ID)
 *   - Server protocol: open_conductor, conductor_user_input,
 *     stop_conductor, clear_conductor, conductor_load_history
 *   - Agent responses: conductor_opened, conductor_output, conductor_status,
 *     conductor_turn_completed, conductor_error, conductor_task_created,
 *     conductor_task_message, conductor_cleared, conductor_history_loaded
 *
 * State model:
 *   conductorMessages: { [convId]: message[] }
 *   conductorTasks:    { [convId]: { [taskId]: TaskStatus } }
 *   conductorStatuses: { [convId]: { status, costUsd, ... } }
 */

// ─── Throttle helpers ────────────────────────────────────
const THROTTLE_MS = 2000;
let _throttleTimers = {};   // convId → timerId
let _pendingUpdates = {};   // convId → { tasks, status }

function flushThrottled(store, convId) {
  const pending = _pendingUpdates[convId];
  if (!pending) return;

  if (pending.tasks) {
    if (!store.conductorTasks[convId]) store.conductorTasks[convId] = {};
    Object.assign(store.conductorTasks[convId], pending.tasks);
  }
  if (pending.status) {
    store.conductorStatuses[convId] = {
      ...(store.conductorStatuses[convId] || {}),
      ...pending.status
    };
  }

  delete _pendingUpdates[convId];
  delete _throttleTimers[convId];
}

function scheduleFlush(store, convId) {
  if (_throttleTimers[convId]) return;
  _throttleTimers[convId] = setTimeout(() => {
    flushThrottled(store, convId);
  }, THROTTLE_MS);
}

function mergeThrottled(store, convId, patch) {
  if (!_pendingUpdates[convId]) _pendingUpdates[convId] = {};
  const p = _pendingUpdates[convId];
  if (patch.tasks) p.tasks = { ...(p.tasks || {}), ...patch.tasks };
  if (patch.status) p.status = { ...(p.status || {}), ...patch.status };
  scheduleFlush(store, convId);
}

// ─── Ensure messages array exists ────────────────────────
function ensureMessages(store, convId) {
  if (!store.conductorMessages[convId]) {
    store.conductorMessages[convId] = [];
  }
  return store.conductorMessages[convId];
}

// ─── Derive conversation ID from agentId ─────────────────
function conductorConvId(agentId) {
  return `conductor_${agentId}`;
}

// ─── Public actions ──────────────────────────────────────

/**
 * openConductor(agentId) — V5 1:1 model entry point.
 *
 * Each Agent has exactly ONE Conductor. Clicking the Conductor button
 * either resumes the existing Conductor conversation or creates a new one.
 * No scenario selection — scenario is per-task, not per-Conductor.
 */
export function openConductor(store, agentId) {
  const convId = conductorConvId(agentId);

  // Check if a conductor conversation already exists for this agent
  const existing = store.conversations.find(c => c.id === convId);

  if (existing) {
    // Resume — switch to existing conductor conversation
    store.selectConversation(existing.id, agentId);
    return;
  }

  // Set currentAgent BEFORE sending WS — conductor_opened handler
  // reads store.currentAgent to bind the conversation to this agent.
  store.currentAgent = agentId;

  // Send open_conductor to server — Agent will init or resume
  store.sendWsMessage({
    type: 'open_conductor',
    agentId
  });
}

export function sendConductorMessage(store, content, taskId = null, attachments = undefined) {
  const convId = store.currentConversation;
  const messages = ensureMessages(store, convId);

  messages.push({
    id: crypto.randomUUID(),
    role: 'human',
    type: 'text',
    content,
    taskId,
    timestamp: Date.now()
  });

  // Update lastMessageAt for sidebar sorting
  const conv = store.conversations.find(c => c.id === convId);
  if (conv) conv.lastMessageAt = Date.now();

  const msg = {
    type: 'conductor_user_input',
    content,
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

export function sendConductorControl(store, action) {
  const type = action === 'stop' ? 'stop_conductor' : 'clear_conductor';
  store.sendWsMessage({
    type,
    agentId: store.currentAgent
  });
}

// ─── WS message handler ─────────────────────────────────

export function handleConductorOutput(store, msg) {
  if (!msg) return;

  // V5: derive convId from agentId (no sessionId in messages)
  const agentId = msg.agentId || store.currentAgent;
  const convId = agentId ? conductorConvId(agentId) : store.currentConversation;

  // ── Conductor opened (new or resumed) ──

  if (msg.type === 'conductor_opened') {
    // Restore tasks
    if (msg.tasks) {
      store.conductorTasks[convId] = {};
      if (typeof msg.tasks === 'object' && !Array.isArray(msg.tasks)) {
        // V5: tasks is an object { taskId: entry }
        for (const [taskId, t] of Object.entries(msg.tasks)) {
          store.conductorTasks[convId][taskId] = t;
        }
      }
    }

    // Restore messages
    if (msg.uiMessages && msg.uiMessages.length > 0) {
      store.conductorMessages[convId] = msg.uiMessages.map(m => ({
        id: m.timestamp || crypto.randomUUID(),
        role: m.role || m.source || 'conductor',
        type: m.type || 'text',
        content: m.content,
        taskId: m.taskId || null,
        persona: m.persona || null,
        specialty: m.specialty || null,
        timestamp: m.timestamp || Date.now(),
        _streaming: false
      }));
    } else {
      ensureMessages(store, convId);
    }

    // Update status
    store.conductorStatuses[convId] = {
      status: msg.status || 'running',
      costUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0
    };

    // Create or reuse conversation entry
    let conv = store.conversations.find(c => c.id === convId);
    if (!conv) {
      const agent = store.agents.find(a => a.id === agentId);
      conv = {
        id: convId,
        agentId,
        agentName: agent?.name || agentId,
        workDir: null,
        claudeSessionId: null,
        createdAt: Date.now(),
        processing: false,
        type: 'conductor',
        name: 'Conductor'
      };
      store.conversations.push(conv);
    } else {
      conv.type = 'conductor';
      conv.agentId = agentId;
    }

    // Switch to this conversation
    if (store.currentConversation && store.currentConversation !== convId && store.messages.length > 0) {
      store.messagesCache[store.currentConversation] = store.messages;
    }
    store.currentConversation = convId;
    store.messages = [];
    store.saveOpenSessions();
    return;
  }

  // ── Status update (throttled) ──

  if (msg.type === 'conductor_status') {
    const patch = {};
    if (msg.tasks) {
      patch.tasks = {};
      if (typeof msg.tasks === 'object' && !Array.isArray(msg.tasks)) {
        for (const [taskId, t] of Object.entries(msg.tasks)) {
          patch.tasks[taskId] = t;
        }
      }
    }
    if (msg.status || msg.costUsd !== undefined) {
      patch.status = {
        status: msg.status,
        costUsd: msg.costUsd,
        totalInputTokens: msg.totalInputTokens || 0,
        totalOutputTokens: msg.totalOutputTokens || 0,
        activeClaudes: msg.activeClaudes || 0
      };
    }
    mergeThrottled(store, convId, patch);
    return;
  }

  // ── Task lifecycle ──

  if (msg.type === 'conductor_task_created') {
    if (!store.conductorTasks[convId]) store.conductorTasks[convId] = {};
    const task = msg.task || {};
    const taskId = task.taskId || msg.taskId;
    store.conductorTasks[convId][taskId] = {
      taskId,
      title: task.title || msg.title,
      status: task.status || 'active',
      workDir: task.workDir,
      scenario: task.scenario,
      createdAt: task.createdAt || Date.now()
    };
    ensureMessages(store, convId).push({
      id: crypto.randomUUID(),
      role: 'conductor',
      type: 'task_created',
      content: `Task created: ${task.title || msg.title || taskId}`,
      taskId,
      timestamp: Date.now()
    });
    return;
  }

  if (msg.type === 'conductor_task_message') {
    ensureMessages(store, convId).push({
      id: crypto.randomUUID(),
      role: 'conductor',
      type: 'task_message',
      content: msg.message || '',
      taskId: msg.taskId || null,
      timestamp: Date.now()
    });
    return;
  }

  // ── Message output (conductor text, tool_use, tool_result, system) ──

  if (msg.type === 'conductor_output') {
    const messages = ensureMessages(store, convId);

    if (msg.outputType === 'text') {
      // Try to append to existing streaming message from same source
      let streamMsg = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === (msg.role || 'conductor') && m._streaming && (m.taskId || null) === (msg.taskId || null)) {
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
        if (messages[i].role === (msg.role || 'conductor') && messages[i]._streaming) {
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
    const messages = ensureMessages(store, convId);
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]._streaming) {
        messages[i]._streaming = false;
        break;
      }
    }
    return;
  }

  // ── Conductor cleared ──

  if (msg.type === 'conductor_cleared') {
    store.conductorMessages[convId] = [];
    store.conductorTasks[convId] = {};
    store.conductorStatuses[convId] = {};
    return;
  }

  // ── History loaded ──

  if (msg.type === 'conductor_history_loaded') {
    const messages = ensureMessages(store, convId);
    if (msg.messages && msg.messages.length > 0) {
      const olderMessages = msg.messages.map(m => ({
        id: m.timestamp || crypto.randomUUID(),
        role: m.role || m.source || 'conductor',
        type: m.type || 'text',
        content: m.content,
        taskId: m.taskId || null,
        persona: m.persona || null,
        specialty: m.specialty || null,
        timestamp: m.timestamp || Date.now(),
        _streaming: false
      }));
      // Prepend older messages
      store.conductorMessages[convId] = [...olderMessages, ...messages];
    }
    return;
  }

  // ── Session error ──

  if (msg.type === 'conductor_error') {
    ensureMessages(store, convId).push({
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
