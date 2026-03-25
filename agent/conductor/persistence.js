/**
 * Conductor — 持久化管理 (V5)
 *
 * Conductor Home: ~/.config/yeaft-agent/.conductor/
 *   session.json  — Conductor Claude session 元数据
 *   state.json    — 全局 task 注册表
 *   messages.json — UI 消息（分片）
 *
 * Task 目录: {workDir}/.conductor/task-N/
 *   CLAUDE.md, memory.md, plan.json, status.json
 *   actors/{specialty}-{persona}/CLAUDE.md
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { getConfigDir } from '../service.js';
import { createTaskWorktree } from './worktree.js';

// =====================================================================
// Conductor Home (Agent-level, singleton)
// =====================================================================

const CONDUCTOR_HOME = join(getConfigDir(), '.conductor');

export function getConductorHome() {
  return CONDUCTOR_HOME;
}

export async function ensureConductorHome() {
  await fs.mkdir(CONDUCTOR_HOME, { recursive: true });
  return CONDUCTOR_HOME;
}

// =====================================================================
// Task Directory ({workDir}/.conductor/{taskId}/)
// =====================================================================

export function getTaskDir(workDir, taskId) {
  return join(workDir, '.conductor', taskId);
}

export async function initTaskDir(workDir, taskId) {
  const dir = getTaskDir(workDir, taskId);
  await fs.mkdir(join(dir, 'actors'), { recursive: true });

  // Initialize empty files if they don't exist
  const files = {
    'CLAUDE.md': '',
    'memory.md': '',
    'status.json': JSON.stringify({ taskId, status: 'created', updatedAt: Date.now() }, null, 2)
  };
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, content);
    }
  }

  // Create worktree for this task (isolates file modifications per task)
  let worktreePath = null;
  try {
    worktreePath = await createTaskWorktree(workDir, taskId, dir);
  } catch (e) {
    console.warn(`[Conductor] Failed to create worktree for ${taskId}:`, e.message);
  }

  return { dir, worktreePath };
}

// =====================================================================
// State JSON (Global Task Registry)
// =====================================================================

let _stateWriteLock = Promise.resolve();

/**
 * Load global task registry from state.json
 * @returns {ConductorState} { tasks: Record<taskId, TaskRegistryEntry>, lastUpdate }
 */
export async function loadState() {
  const filePath = join(CONDUCTOR_HOME, 'state.json');
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return { tasks: {}, lastUpdate: 0 };
  }
}

/**
 * Save global task registry to state.json (atomic write)
 */
export async function saveState(state) {
  const doWrite = async () => {
    await fs.mkdir(CONDUCTOR_HOME, { recursive: true });
    state.lastUpdate = Date.now();
    const data = JSON.stringify(state, null, 2);
    const filePath = join(CONDUCTOR_HOME, 'state.json');
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, filePath);
  };
  _stateWriteLock = _stateWriteLock.then(doWrite, doWrite);
  return _stateWriteLock;
}

/**
 * Update a single task entry in state.json
 */
export async function updateTaskInState(taskId, entry) {
  const state = await loadState();
  state.tasks[taskId] = { ...entry, lastUpdate: Date.now() };
  await saveState(state);
}

/**
 * Remove a task entry from state.json
 */
export async function removeTaskFromState(taskId) {
  const state = await loadState();
  delete state.tasks[taskId];
  await saveState(state);
}

// =====================================================================
// Conductor Metadata (session.json — Claude session persistence)
// =====================================================================

export async function saveConductorMeta(conductor) {
  const dir = await ensureConductorHome();

  const meta = {
    status: conductor.status,
    costUsd: conductor.costUsd,
    totalInputTokens: conductor.totalInputTokens,
    totalOutputTokens: conductor.totalOutputTokens,
    userId: conductor.userId,
    username: conductor.username,
    createdAt: conductor.createdAt,
    updatedAt: Date.now()
  };

  await fs.writeFile(join(dir, 'session.json'), JSON.stringify(meta, null, 2));

  // Save UI messages (logrotate shards)
  if (conductor.uiMessages && conductor.uiMessages.length > 0) {
    const cleaned = conductor.uiMessages.map(m => {
      const { _streaming, ...rest } = m;
      return rest;
    });
    const json = JSON.stringify(cleaned);
    if (json.length > MESSAGE_SHARD_SIZE && !conductor._rotating) {
      await rotateMessages(conductor, dir, cleaned);
    } else {
      await fs.writeFile(join(dir, 'messages.json'), json);
    }
  }
}

export async function loadConductorMeta() {
  const filePath = join(CONDUCTOR_HOME, 'session.json');
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// =====================================================================
// UI Message Persistence (logrotate shards in conductor home)
// =====================================================================

const MESSAGE_SHARD_SIZE = 256 * 1024;

export async function loadConductorMessages() {
  let messages = [];
  try {
    messages = JSON.parse(await fs.readFile(join(CONDUCTOR_HOME, 'messages.json'), 'utf-8'));
  } catch { /* file may not exist */ }
  let hasOlderMessages = false;
  try {
    await fs.access(join(CONDUCTOR_HOME, 'messages.1.json'));
    hasOlderMessages = true;
  } catch { /* no older shards */ }
  return { messages, hasOlderMessages };
}

async function rotateMessages(conductor, dir, cleaned) {
  conductor._rotating = true;
  try {
    const halfLen = Math.floor(cleaned.length / 2);
    let splitIdx = halfLen;
    for (let i = halfLen; i > Math.max(0, halfLen - 20); i--) {
      if (cleaned[i].type === 'system' || cleaned[i].type === 'task_created') {
        splitIdx = i + 1;
        break;
      }
    }
    splitIdx = Math.max(1, Math.min(splitIdx, cleaned.length - 1));

    const archivePart = cleaned.slice(0, splitIdx);
    const remainPart = cleaned.slice(splitIdx);

    const maxShard = await getMaxShardIndex(dir);
    for (let i = maxShard; i >= 1; i--) {
      const src = join(dir, `messages.${i}.json`);
      const dst = join(dir, `messages.${i + 1}.json`);
      await fs.rename(src, dst).catch(() => {});
    }

    await fs.writeFile(join(dir, 'messages.1.json'), JSON.stringify(archivePart));
    await fs.writeFile(join(dir, 'messages.json'), JSON.stringify(remainPart));
    conductor.uiMessages = remainPart.map(m => ({ ...m }));

    console.log(`[Conductor] Rotated: archived ${archivePart.length} msgs, kept ${remainPart.length}`);
  } finally {
    conductor._rotating = false;
  }
}

export async function getMaxShardIndex(dir) {
  let max = 0;
  try {
    const files = await fs.readdir(dir);
    for (const f of files) {
      const match = f.match(/^messages\.(\d+)\.json$/);
      if (match) {
        const idx = parseInt(match[1], 10);
        if (idx > max) max = idx;
      }
    }
  } catch { /* dir may not exist */ }
  return max;
}

export async function cleanupMessageShards(dir) {
  try {
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (/^messages\.\d+\.json$/.test(f)) {
        await fs.unlink(join(dir, f)).catch(() => {});
      }
    }
  } catch { /* dir may not exist */ }
}

export async function handleLoadConductorHistory(msg, conductor, sendMsg) {
  const { requestId } = msg;
  const shardIndex = parseInt(msg.shardIndex, 10);

  if (!Number.isFinite(shardIndex) || shardIndex < 1 || !conductor) {
    sendMsg({
      type: 'conductor_history_loaded',
      shardIndex: msg.shardIndex, requestId,
      messages: [], hasMore: false
    });
    return;
  }

  const dir = getConductorHome();
  const shardPath = join(dir, `messages.${shardIndex}.json`);
  let messages = [];
  try {
    messages = JSON.parse(await fs.readFile(shardPath, 'utf-8'));
  } catch { /* shard doesn't exist */ }

  const hasMore = shardIndex < await getMaxShardIndex(dir);
  sendMsg({
    type: 'conductor_history_loaded',
    shardIndex, requestId,
    messages, hasMore
  });
}
