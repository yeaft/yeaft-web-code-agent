/**
 * Conductor — Session Core (V5 Singleton)
 *
 * Each Agent has exactly one Conductor (1:1 binding).
 * No multi-session Map — just a single conductor instance.
 *
 * Conductor has no workDir; tasks bind to workDir.
 */
import ctx from '../context.js';
import {
  ensureConductorHome, loadConductorMeta, saveConductorMeta,
  loadConductorMessages, loadState, getMaxShardIndex,
  getConductorHome, cleanupMessageShards
} from './persistence.js';
import {
  sendConductorMessage, sendConductorOutput, sendStatusUpdate, recordUserMessage
} from './ui-messages.js';
import { createConductorClaude, sendToConductor, stopConductorClaude } from './conductor-claude.js';

// =====================================================================
// Singleton Conductor Instance
// =====================================================================

/** @type {Conductor|null} */
let conductor = null;

/**
 * Get the current Conductor instance (or null if not initialized)
 */
export function getConductor() {
  return conductor;
}

// =====================================================================
// Conductor Lifecycle
// =====================================================================

/**
 * Initialize or restore the single Conductor instance.
 * Called when user opens the Conductor UI.
 */
export async function initConductor(msg) {
  const { userId, username } = msg;

  // Already initialized in memory — just send current state
  if (conductor) {
    if (!conductor.uiMessages || conductor.uiMessages.length === 0) {
      const loaded = await loadConductorMessages();
      conductor.uiMessages = loaded.messages;
    }
    const cleaned = (conductor.uiMessages || []).map(m => {
      const { _streaming, ...rest } = m;
      return rest;
    });
    const dir = getConductorHome();
    const hasOlderMessages = await getMaxShardIndex(dir) > 0;

    // Load state.json for task info
    const state = await loadState();

    sendConductorMessage({
      type: 'conductor_opened',
      tasks: state.tasks,
      userId: conductor.userId,
      username: conductor.username,
      uiMessages: cleaned,
      hasOlderMessages,
      status: conductor.status
    });
    sendStatusUpdate(conductor);
    return conductor;
  }

  // Ensure conductor home directory exists
  await ensureConductorHome();

  // Try restore from disk
  const meta = await loadConductorMeta();

  conductor = {
    status: 'running',
    tasks: new Map(),
    conductorState: null,
    costUsd: meta?.costUsd || 0,
    totalInputTokens: meta?.totalInputTokens || 0,
    totalOutputTokens: meta?.totalOutputTokens || 0,
    activeClaudes: 0,
    uiMessages: [],
    userId: userId || meta?.userId,
    username: username || meta?.username,
    createdAt: meta?.createdAt || Date.now(),
    _rotating: false,
    _conductorSemRelease: null
  };

  // Load state.json to populate tasks map
  const state = await loadState();
  for (const [taskId, entry] of Object.entries(state.tasks || {})) {
    conductor.tasks.set(taskId, entry);
  }

  // Load UI messages from disk
  const loaded = await loadConductorMessages();
  conductor.uiMessages = loaded.messages;

  const isResume = !!meta;

  sendConductorMessage({
    type: 'conductor_opened',
    tasks: state.tasks,
    userId: conductor.userId,
    username: conductor.username,
    uiMessages: conductor.uiMessages,
    hasOlderMessages: loaded.hasOlderMessages,
    status: conductor.status,
    resumed: isResume
  });
  sendStatusUpdate(conductor);

  // Start Conductor Claude
  try {
    await createConductorClaude(conductor);
    console.log(`[Conductor] ${isResume ? 'Resumed' : 'Created'}, Claude ready`);
  } catch (e) {
    console.error('[Conductor] Failed to start Claude:', e.message);
    sendConductorOutput(conductor, 'system', {
      message: { role: 'assistant', content: `Conductor 启动失败: ${e.message}` }
    });
  }

  await saveConductorMeta(conductor);
  return conductor;
}

/**
 * Handle user input to Conductor
 */
export async function handleConductorUserInput(msg) {
  const { content } = msg;
  if (!conductor) {
    console.warn('[Conductor] Not initialized, ignoring input');
    return;
  }

  if (conductor.status === 'stopped') {
    sendConductorMessage({
      type: 'conductor_error',
      error: 'Conductor is stopped'
    });
    return;
  }

  recordUserMessage(conductor, content);
  conductor.status = 'running';
  await sendToConductor(conductor, content);
}

/**
 * Stop Conductor
 */
export async function stopConductor() {
  if (!conductor) return;

  conductor.status = 'stopped';
  await stopConductorClaude(conductor);

  sendConductorOutput(conductor, 'system', {
    message: { role: 'assistant', content: 'Conductor 已停止' }
  });
  sendStatusUpdate(conductor);
  await saveConductorMeta(conductor);

  conductor = null;
  console.log('[Conductor] Stopped');
}

/**
 * Clear Conductor (reset messages, restart Claude)
 */
export async function clearConductor() {
  if (!conductor) return;

  await stopConductorClaude(conductor);

  // Clear data but keep tasks
  conductor.uiMessages = [];
  conductor.costUsd = 0;
  conductor.totalInputTokens = 0;
  conductor.totalOutputTokens = 0;

  const dir = getConductorHome();
  await cleanupMessageShards(dir);

  conductor.status = 'running';

  sendConductorMessage({ type: 'conductor_cleared' });
  sendStatusUpdate(conductor);

  // Restart Claude
  try {
    await createConductorClaude(conductor);
  } catch (e) {
    console.error('[Conductor] Failed to restart Claude after clear:', e.message);
  }

  await saveConductorMeta(conductor);
  console.log('[Conductor] Cleared');
}
