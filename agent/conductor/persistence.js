/**
 * Conductor — 持久化管理
 *
 * 全局 session 索引 (~/.claude/conductor-sessions.json)
 * 每 task 的 .conductor/ 目录结构
 * Session 元数据 + UI 消息分片（复用 crew 的 logrotate 模式）
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// =====================================================================
// Conductor Session Index (~/.claude/conductor-sessions.json)
// =====================================================================

const CONDUCTOR_INDEX_PATH = join(homedir(), '.claude', 'conductor-sessions.json');

let _indexWriteLock = Promise.resolve();

export async function loadConductorIndex() {
  try { return JSON.parse(await fs.readFile(CONDUCTOR_INDEX_PATH, 'utf-8')); }
  catch { return []; }
}

async function saveConductorIndex(index) {
  const doWrite = async () => {
    await fs.mkdir(join(homedir(), '.claude'), { recursive: true });
    const data = JSON.stringify(index, null, 2);
    const tmpPath = CONDUCTOR_INDEX_PATH + '.tmp';
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, CONDUCTOR_INDEX_PATH);
  };
  _indexWriteLock = _indexWriteLock.then(doWrite, doWrite);
  return _indexWriteLock;
}

function sessionToIndexEntry(session) {
  return {
    sessionId: session.id,
    status: session.status,
    name: session.name || '',
    workDir: session.workDir || null,
    userId: session.userId,
    username: session.username,
    agentId: session.agentId || null,
    scenarioId: session.scenarioId || null,
    createdAt: session.createdAt,
    updatedAt: Date.now()
  };
}

export async function upsertConductorIndex(session) {
  const index = await loadConductorIndex();
  const entry = sessionToIndexEntry(session);
  const idx = index.findIndex(e => e.sessionId === session.id);
  if (idx >= 0) index[idx] = entry; else index.push(entry);
  await saveConductorIndex(index);
}

export async function hideConductorSession(sessionId, conductorSessions) {
  const index = await loadConductorIndex();
  const entry = index.find(e => e.sessionId === sessionId);
  if (entry) {
    entry.hidden = true;
    entry.hiddenAt = Date.now();
    await saveConductorIndex(index);
    console.log(`[Conductor] Hidden session ${sessionId}`);
  }
  if (conductorSessions.has(sessionId)) {
    conductorSessions.delete(sessionId);
  }
}

// =====================================================================
// Conductor Directory Structure
// =====================================================================

/**
 * 初始化 .conductor 目录结构
 * 注意：.conductor 放在 task 绑定的 workDir 下，不在 session 级
 * session 级元数据存储在 ~/.claude/conductor/<sessionId>/
 */
const CONDUCTOR_DATA_DIR = join(homedir(), '.claude', 'conductor');

export function getSessionDataDir(sessionId) {
  return join(CONDUCTOR_DATA_DIR, sessionId);
}

export async function initSessionDataDir(sessionId) {
  const dir = getSessionDataDir(sessionId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// =====================================================================
// Session Metadata
// =====================================================================

const MESSAGE_SHARD_SIZE = 256 * 1024;

export async function saveSessionMeta(session) {
  const dir = getSessionDataDir(session.id);
  await fs.mkdir(dir, { recursive: true });

  const meta = {
    sessionId: session.id,
    name: session.name || '',
    status: session.status,
    workDir: session.workDir || null,
    scenarioId: session.scenarioId || null,
    tasks: Array.from(session.tasks.values()).map(t => ({
      taskId: t.taskId,
      title: t.title,
      workDir: t.workDir,
      status: t.status,
      phase: t.phase,
      progress: t.progress,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt
    })),
    costUsd: session.costUsd,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    userId: session.userId,
    username: session.username,
    agentId: session.agentId || null,
    createdAt: session.createdAt,
    updatedAt: Date.now()
  };

  await fs.writeFile(join(dir, 'session.json'), JSON.stringify(meta, null, 2));

  // 保存 UI 消息（logrotate 分片）
  if (session.uiMessages && session.uiMessages.length > 0) {
    const cleaned = session.uiMessages.map(m => {
      const { _streaming, ...rest } = m;
      return rest;
    });
    const json = JSON.stringify(cleaned);
    if (json.length > MESSAGE_SHARD_SIZE && !session._rotating) {
      await rotateMessages(session, dir, cleaned);
    } else {
      await fs.writeFile(join(dir, 'messages.json'), json);
    }
  }
}

async function rotateMessages(session, dir, cleaned) {
  session._rotating = true;
  try {
    const halfLen = Math.floor(cleaned.length / 2);
    let splitIdx = halfLen;
    // 尝试找 system/route 类型消息作为断点
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
    session.uiMessages = remainPart.map(m => ({ ...m }));

    console.log(`[Conductor] Rotated: archived ${archivePart.length} msgs, kept ${remainPart.length}`);
  } finally {
    session._rotating = false;
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

export async function loadSessionMeta(sessionId) {
  const dir = getSessionDataDir(sessionId);
  try { return JSON.parse(await fs.readFile(join(dir, 'session.json'), 'utf-8')); }
  catch { return null; }
}

export async function loadSessionMessages(sessionId) {
  const dir = getSessionDataDir(sessionId);
  let messages = [];
  try { messages = JSON.parse(await fs.readFile(join(dir, 'messages.json'), 'utf-8')); }
  catch { /* file may not exist */ }
  let hasOlderMessages = false;
  try {
    await fs.access(join(dir, 'messages.1.json'));
    hasOlderMessages = true;
  } catch { /* no older shards */ }
  return { messages, hasOlderMessages };
}

export async function handleLoadConductorHistory(msg, conductorSessions, sendConductorMessage) {
  const { sessionId, requestId } = msg;
  const shardIndex = parseInt(msg.shardIndex, 10);

  if (!Number.isFinite(shardIndex) || shardIndex < 1) {
    sendConductorMessage({
      type: 'conductor_history_loaded',
      sessionId, shardIndex: msg.shardIndex, requestId,
      messages: [], hasMore: false
    });
    return;
  }
  if (!conductorSessions.has(sessionId)) {
    sendConductorMessage({
      type: 'conductor_history_loaded',
      sessionId, shardIndex, requestId,
      messages: [], hasMore: false
    });
    return;
  }

  const dir = getSessionDataDir(sessionId);
  const shardPath = join(dir, `messages.${shardIndex}.json`);
  let messages = [];
  try {
    messages = JSON.parse(await fs.readFile(shardPath, 'utf-8'));
  } catch { /* shard doesn't exist */ }

  const hasMore = shardIndex < await getMaxShardIndex(dir);
  sendConductorMessage({
    type: 'conductor_history_loaded',
    sessionId, shardIndex, requestId,
    messages, hasMore
  });
}
