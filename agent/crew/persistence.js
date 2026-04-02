/**
 * Crew — 持久化管理
 * Session 索引 (~/.claude/crew-sessions.json)、session 元数据、消息分片
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// =====================================================================
// Crew Session Index (~/.claude/crew-sessions.json)
// =====================================================================

const CREW_INDEX_PATH = join(homedir(), '.claude', 'crew-sessions.json');

// 写入锁：防止并发写入导致文件损坏
let _indexWriteLock = Promise.resolve();

export async function loadCrewIndex() {
  try { return JSON.parse(await fs.readFile(CREW_INDEX_PATH, 'utf-8')); }
  catch { return []; }
}

async function saveCrewIndex(index) {
  const doWrite = async () => {
    await fs.mkdir(join(homedir(), '.claude'), { recursive: true });
    const data = JSON.stringify(index, null, 2);
    // 先写临时文件再 rename，保证原子性
    const tmpPath = CREW_INDEX_PATH + '.tmp';
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, CREW_INDEX_PATH);
  };
  // 串行化写入
  _indexWriteLock = _indexWriteLock.then(doWrite, doWrite);
  return _indexWriteLock;
}

function sessionToIndexEntry(session) {
  return {
    sessionId: session.id,
    projectDir: session.projectDir,
    sharedDir: session.sharedDir,
    status: session.status,
    name: session.name || '',
    userId: session.userId,
    username: session.username,
    agentId: session.agentId || null,
    createdAt: session.createdAt,
    updatedAt: Date.now()
  };
}

export async function upsertCrewIndex(session) {
  const index = await loadCrewIndex();
  const entry = sessionToIndexEntry(session);
  const idx = index.findIndex(e => e.sessionId === session.id);
  if (idx >= 0) index[idx] = entry; else index.push(entry);
  await saveCrewIndex(index);
}

export async function removeFromCrewIndex(sessionId) {
  // Lazy import to avoid circular dependency
  const { crewSessions } = await import('./session.js');

  const index = await loadCrewIndex();
  const filtered = index.filter(e => e.sessionId !== sessionId);
  if (filtered.length !== index.length) {
    await saveCrewIndex(filtered);
    console.log(`[Crew] Removed session ${sessionId} from index`);
  }
  // 从内存中也移除（防止 sendConversationList 重新加入）
  if (crewSessions.has(sessionId)) {
    crewSessions.delete(sessionId);
    console.log(`[Crew] Removed session ${sessionId} from active sessions`);
  }
  // 注意：不再删除磁盘上的 session.json、messages.json 等文件
  // 这些文件在 recreate 时会被复用（合并统计数据 + 恢复消息历史）
}

// =====================================================================
// Session Metadata (.crew/session.json)
// =====================================================================

const MESSAGE_SHARD_SIZE = 256 * 1024; // 256KB per shard
const SAVE_DEBOUNCE_MS = 10_000; // 10 seconds

/**
 * Debounced version of saveSessionMeta.
 * Coalesces rapid-fire calls (e.g. multiple role turn-ends) into a single
 * disk write per session, at most once every SAVE_DEBOUNCE_MS.
 */
export function debouncedSaveSessionMeta(session) {
  if (session._saveDebounceTimer) {
    clearTimeout(session._saveDebounceTimer);
  }
  session._saveDebounceTimer = setTimeout(() => {
    session._saveDebounceTimer = null;
    saveSessionMeta(session).catch(e =>
      console.warn('[Crew] Debounced save failed:', e.message)
    );
  }, SAVE_DEBOUNCE_MS);
}

export async function saveSessionMeta(session) {
  const meta = {
    sessionId: session.id,
    projectDir: session.projectDir,
    sharedDir: session.sharedDir,
    name: session.name || '',
    status: session.status,
    // claudeMd is intentionally excluded — it's large and already persisted
    // in per-role CLAUDE.md files under .crew/roles/<name>/CLAUDE.md
    roles: Array.from(session.roles.values()).map(r => ({
      name: r.name, displayName: r.displayName, icon: r.icon,
      description: r.description,
      isDecisionMaker: r.isDecisionMaker || false,
      groupIndex: r.groupIndex, roleType: r.roleType, model: r.model
    })),
    decisionMaker: session.decisionMaker,
    round: session.round,
    createdAt: session.createdAt,
    updatedAt: Date.now(),
    userId: session.userId,
    username: session.username,
    agentId: session.agentId || null,
    teamType: session.teamType || 'dev',
    language: session.language || 'zh-CN',
    costUsd: session.costUsd,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    features: Array.from(session.features.values()),
    _completedTaskIds: Array.from(session._completedTaskIds || [])
  };
  await fs.writeFile(join(session.sharedDir, 'session.json'), JSON.stringify(meta, null, 2));
  // 保存 UI 消息历史（用于恢复时重放）
  if (session.uiMessages && session.uiMessages.length > 0) {
    // 清理 _streaming 标记后保存
    const cleaned = session.uiMessages.map(m => {
      const { _streaming, ...rest } = m;
      return rest;
    });
    const json = JSON.stringify(cleaned);
    // 超过阈值时直接归档（rotateMessages 内部写两个文件，避免双写）
    if (json.length > MESSAGE_SHARD_SIZE && !session._rotating) {
      await rotateMessages(session, cleaned);
    } else {
      await fs.writeFile(join(session.sharedDir, 'messages.json'), json);
    }
  }
}

/**
 * 归档旧消息到分片文件（logrotate 风格）
 */
async function rotateMessages(session, cleaned) {
  session._rotating = true;
  try {
    const halfLen = Math.floor(cleaned.length / 2);
    let splitIdx = halfLen;
    for (let i = halfLen; i > Math.max(0, halfLen - 20); i--) {
      if (cleaned[i].type === 'route' || cleaned[i].type === 'system') {
        splitIdx = i + 1;
        break;
      }
    }
    if (splitIdx === halfLen) {
      for (let i = halfLen + 1; i < Math.min(cleaned.length - 1, halfLen + 20); i++) {
        if (cleaned[i].type === 'route' || cleaned[i].type === 'system') {
          splitIdx = i + 1;
          break;
        }
      }
    }
    splitIdx = Math.max(1, Math.min(splitIdx, cleaned.length - 1));

    const archivePart = cleaned.slice(0, splitIdx);
    const remainPart = cleaned.slice(splitIdx);

    const maxShard = await getMaxShardIndex(session.sharedDir);
    for (let i = maxShard; i >= 1; i--) {
      const src = join(session.sharedDir, `messages.${i}.json`);
      const dst = join(session.sharedDir, `messages.${i + 1}.json`);
      await fs.rename(src, dst).catch(() => {});
    }

    await fs.writeFile(join(session.sharedDir, 'messages.1.json'), JSON.stringify(archivePart));
    await fs.writeFile(join(session.sharedDir, 'messages.json'), JSON.stringify(remainPart));
    session.uiMessages = remainPart.map(m => ({ ...m }));

    console.log(`[Crew] Rotated messages: archived ${archivePart.length} msgs to shard 1, kept ${remainPart.length} in active`);
  } finally {
    session._rotating = false;
  }
}

/**
 * 获取当前最大分片编号
 */
export async function getMaxShardIndex(sharedDir) {
  let max = 0;
  try {
    const files = await fs.readdir(sharedDir);
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

/**
 * 删除所有消息分片文件
 */
export async function cleanupMessageShards(sharedDir) {
  try {
    const files = await fs.readdir(sharedDir);
    for (const f of files) {
      if (/^messages\.\d+\.json$/.test(f)) {
        await fs.unlink(join(sharedDir, f)).catch(() => {});
      }
    }
  } catch { /* dir may not exist */ }
}

export async function loadSessionMeta(sharedDir) {
  try { return JSON.parse(await fs.readFile(join(sharedDir, 'session.json'), 'utf-8')); }
  catch { return null; }
}

export async function loadSessionMessages(sharedDir) {
  let messages = [];
  try { messages = JSON.parse(await fs.readFile(join(sharedDir, 'messages.json'), 'utf-8')); }
  catch { /* file may not exist */ }
  let hasOlderMessages = false;
  try {
    await fs.access(join(sharedDir, 'messages.1.json'));
    hasOlderMessages = true;
  } catch { /* no older shards */ }
  return { messages, hasOlderMessages };
}

/**
 * 加载历史消息分片（前端上滑到顶部时按需请求）
 */
export async function handleLoadCrewHistory(msg) {
  const { sessionId, requestId } = msg;
  const shardIndex = parseInt(msg.shardIndex, 10);

  // Lazy import to avoid circular dependency
  const { crewSessions } = await import('./session.js');
  const { sendCrewMessage } = await import('./ui-messages.js');

  if (!Number.isFinite(shardIndex) || shardIndex < 1) {
    sendCrewMessage({
      type: 'crew_history_loaded',
      sessionId,
      shardIndex: msg.shardIndex,
      requestId,
      messages: [],
      hasMore: false
    });
    return;
  }
  const session = crewSessions.get(sessionId);
  if (!session) {
    sendCrewMessage({
      type: 'crew_history_loaded',
      sessionId,
      shardIndex,
      requestId,
      messages: [],
      hasMore: false
    });
    return;
  }

  const shardPath = join(session.sharedDir, `messages.${shardIndex}.json`);
  let messages = [];
  try {
    messages = JSON.parse(await fs.readFile(shardPath, 'utf-8'));
  } catch { /* shard file doesn't exist */ }

  const hasMore = shardIndex < await getMaxShardIndex(session.sharedDir);

  sendCrewMessage({
    type: 'crew_history_loaded',
    sessionId,
    shardIndex,
    requestId,
    messages,
    hasMore
  });
}
