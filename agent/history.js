import { homedir } from 'os';
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync, fstatSync } from 'fs';
import { join } from 'path';
import ctx from './context.js';
import { getProvider, DEFAULT_PROVIDER } from './providers/index.js';

// Claude 项目目录
export function getClaudeProjectsDir() {
  return join(homedir(), '.claude', 'projects');
}

// 将路径转换为 Claude 项目文件夹名
export function pathToProjectFolder(workDir) {
  return workDir
    .replace(/:/g, '-')
    .replace(/[\\\/]/g, '-');
}

// 从 session 文件中提取原始工作目录路径
// Claude session jsonl 文件的每条消息都包含 cwd 字段
export function extractWorkDirFromSessionFile(sessionFilePath) {
  try {
    const content = readFileSync(sessionFilePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines.slice(0, 5)) { // 只检查前几行
      try {
        const data = JSON.parse(line);
        // 每条消息都有 cwd 字段
        if (data.cwd) {
          return data.cwd.replace(/\\/g, '/');
        }
      } catch {}
    }
  } catch {}
  return null;
}

// 从项目文件夹中获取原始工作目录路径
// 优先从 session 文件读取，失败则用简单转换
export function getWorkDirFromProjectFolder(projectFolderPath, folderName) {
  // 尝试从第一个 session 文件读取真实路径
  try {
    const files = readdirSync(projectFolderPath);
    for (const file of files) {
      if (file.endsWith('.jsonl')) {
        const workDir = extractWorkDirFromSessionFile(join(projectFolderPath, file));
        if (workDir) {
          return workDir;
        }
      }
    }
  } catch {}

  // 回退：简单转换（可能不准确，但总比没有好）
  if (/^[A-Za-z]--/.test(folderName)) {
    return folderName.replace(/^([A-Za-z])--/, '$1:/').replace(/-/g, '/');
  }
  if (folderName.startsWith('-')) {
    return '/' + folderName.substring(1).replace(/-/g, '/');
  }
  return folderName.replace(/-/g, '/');
}

// 获取指定目录的历史会话列表
export async function getHistorySessions(workDir) {
  // 过滤掉 crew 角色目录的 sessions
  if (workDir && /[/\\]\.crew[/\\]roles[/\\]/.test(workDir)) {
    return [];
  }

  const projectsDir = getClaudeProjectsDir();
  const projectFolder = pathToProjectFolder(workDir);
  const projectPath = join(projectsDir, projectFolder);

  console.log(`Looking for sessions in: ${projectPath}`);

  if (!existsSync(projectPath)) {
    console.log(`Project folder not found: ${projectPath}`);
    return [];
  }

  const sessions = [];
  const files = readdirSync(projectPath);

  for (const file of files) {
    if (file.endsWith('.jsonl') && file !== 'sessions-index.json') {
      const sessionId = file.replace('.jsonl', '');
      const filePath = join(projectPath, file);
      const stats = statSync(filePath);

      let title = '';
      let firstMessage = '';
      let hasUserMessage = false;
      let customTitle = '';
      let jsonlSummary = '';

      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            // First user message → preview + fallback title
            if (!hasUserMessage && data.type === 'user' && data.message?.content) {
              const text = typeof data.message.content === 'string'
                ? data.message.content
                : data.message.content[0]?.text || '';
              if (text.trim()) {
                firstMessage = text.substring(0, 100);
                title = text.substring(0, 100);
                hasUserMessage = true;
              }
            }
            // /rename → custom-title (keep last occurrence)
            if (data.type === 'custom-title' && data.customTitle) {
              customTitle = data.customTitle;
            }
            // Auto-generated summary
            if (data.type === 'summary' && data.summary) {
              jsonlSummary = data.summary;
            }
          } catch {}
        }
      } catch (e) {
        console.error(`Error reading session file: ${e.message}`);
      }

      // 只添加有实际用户消息的会话，过滤掉空会话
      if (hasUserMessage) {
        // Priority: custom-title (/rename) > auto-generated summary > first user message
        sessions.push({
          sessionId,
          workDir,
          title: customTitle || jsonlSummary || title || sessionId.slice(0, 8),
          preview: firstMessage,
          lastModified: stats.mtime.getTime(),
          size: stats.size
        });
      }
    }
  }

  sessions.sort((a, b) => b.lastModified - a.lastModified);
  return sessions;
}

// feat-chat-load-perf: tail-read helper used by loadSessionHistory.
// Reads the last `limit` user/assistant rows from a JSONL without slurping
// the whole file. Strategy: open the file, fstat to get size, then read
// fixed-size chunks from the end backwards into a buffer. After each chunk
// we split on '\n', parse complete lines, push valid user/assistant rows
// into a stack, and stop once the stack has `limit` rows or we've read past
// the head of the file. A 42 MB / 100k-message JSONL with limit=500 reads
// roughly 1–4 MB instead of the entire file.
//
// Tradeoffs:
// - Falls back to full readFileSync if anything throws (defensive — a 200ms
//   slow path beats a broken history load).
// - JSONL lines are bounded in practice (Claude CLI writes one message per
//   line, typically a few KB). The chunk size (256 KB) is sized so a single
//   chunk almost always contains many complete lines.
// - We keep a "carry" prefix between chunks for the first partial line, so a
//   line that straddles a chunk boundary is parsed correctly on the next
//   iteration.
const TAIL_CHUNK_SIZE = 256 * 1024; // 256 KB
function readTailMessages(filePath, limit) {
  const fd = openSync(filePath, 'r');
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return [];

    const collected = []; // newest-first while we build it; reverse before return
    let carry = ''; // partial-line tail from the previous (further-into-file) chunk
    let position = size;
    const chunk = Buffer.alloc(TAIL_CHUNK_SIZE);

    while (position > 0 && collected.length < limit) {
      const readSize = Math.min(TAIL_CHUNK_SIZE, position);
      const offset = position - readSize;
      readSync(fd, chunk, 0, readSize, offset);
      position = offset;

      const text = chunk.slice(0, readSize).toString('utf-8') + carry;
      const lines = text.split('\n');
      // If we're not yet at the head of the file, the first segment is a
      // potentially partial line — stash it for the next iteration.
      carry = position > 0 ? lines.shift() : '';

      // Walk lines newest-first (end to start).
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line || !line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.type === 'user' || data.type === 'assistant') {
            collected.push(data);
            if (collected.length >= limit) break;
          }
        } catch {}
      }
    }

    // If we ran out of file with leftover carry, try it as the head line.
    if (collected.length < limit && carry && carry.trim()) {
      try {
        const data = JSON.parse(carry);
        if (data.type === 'user' || data.type === 'assistant') {
          collected.push(data);
        }
      } catch {}
    }

    // collected is newest-first; flip to chronological order for callers.
    return collected.reverse();
  } finally {
    closeSync(fd);
  }
}

// 读取 session 文件中的历史消息
export function loadSessionHistory(workDir, claudeSessionId, limit = 500) {
  const projectsDir = getClaudeProjectsDir();
  const projectFolder = pathToProjectFolder(workDir);
  const sessionFile = join(projectsDir, projectFolder, `${claudeSessionId}.jsonl`);

  console.log(`Loading session history from: ${sessionFile}`);

  if (!existsSync(sessionFile)) {
    console.log(`Session file not found: ${sessionFile}`);
    return [];
  }

  // Fast path: tail-read only the last `limit` user/assistant rows. Avoids
  // slurping ~42 MB into memory + ~100k JSON.parse calls when we only need
  // the last 500 entries on every chat resume.
  if (limit && limit > 0) {
    try {
      return readTailMessages(sessionFile, limit);
    } catch (e) {
      console.error(`Tail-read failed (${e.message}), falling back to full read for: ${sessionFile}`);
    }
  }

  const messages = [];
  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.type === 'user' || data.type === 'assistant') {
          messages.push(data);
        }
      } catch {}
    }
  } catch (e) {
    console.error(`Error reading session file: ${e.message}`);
  }

  // ★ Phase 6: 限制返回数量（取最后 N 条）
  if (limit && messages.length > limit) {
    return messages.slice(-limit);
  }

  return messages;
}

export async function handleListHistorySessions(msg) {
  const { workDir, requestId, _requestClientId, provider } = msg;
  const effectiveWorkDir = workDir || ctx.CONFIG.workDir;
  const providerName = provider || DEFAULT_PROVIDER;

  console.log(`Listing history sessions for: ${effectiveWorkDir} (provider=${providerName})`);

  try {
    const driver = getProvider(providerName);
    const sessions = typeof driver.listSessions === 'function'
      ? await driver.listSessions(effectiveWorkDir)
      : await getHistorySessions(effectiveWorkDir);
    ctx.sendToServer({
      type: 'history_sessions_list',
      requestId,
      _requestClientId,
      workDir: effectiveWorkDir,
      provider: providerName,
      sessions
    });
  } catch (e) {
    console.error('Error listing history sessions:', e);
    ctx.sendToServer({
      type: 'history_sessions_list',
      requestId,
      _requestClientId,
      workDir: effectiveWorkDir,
      provider: providerName,
      sessions: [],
      error: e.message
    });
  }
}

// 列出指定 provider 下所有 folder (工作目录)
export async function handleListFolders(msg) {
  const { requestId, _requestClientId, provider } = msg;
  const providerName = provider || DEFAULT_PROVIDER;

  console.log(`Listing folders for provider=${providerName}`);

  try {
    const driver = getProvider(providerName);
    let folders = [];
    if (typeof driver.listFolders === 'function') {
      folders = await driver.listFolders();
    }
    folders.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    console.log(`Found ${folders.length} folders (provider=${providerName}), sending response...`);
    ctx.sendToServer({
      type: 'folders_list',
      requestId,
      _requestClientId,
      provider: providerName,
      folders
    });
  } catch (e) {
    console.error('Error listing folders:', e);
    ctx.sendToServer({
      type: 'folders_list',
      requestId,
      _requestClientId,
      provider: providerName,
      folders: [],
      error: e.message
    });
  }
}

// 列出指定 provider 下可选 model
export async function handleListModels(msg) {
  const { requestId, _requestClientId, provider } = msg;
  const providerName = provider || DEFAULT_PROVIDER;
  try {
    const driver = getProvider(providerName);
    let models = [];
    if (typeof driver.listModels === 'function') {
      models = await driver.listModels();
    }
    ctx.sendToServer({
      type: 'models_list',
      requestId,
      _requestClientId,
      provider: providerName,
      models: Array.isArray(models) ? models : [],
    });
  } catch (e) {
    ctx.sendToServer({
      type: 'models_list',
      requestId,
      _requestClientId,
      provider: providerName,
      models: [],
      error: e.message,
    });
  }
}
