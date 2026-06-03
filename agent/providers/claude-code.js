import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { startClaudeQuery } from '../claude.js';
import {
  getClaudeProjectsDir,
  getHistorySessions,
  loadSessionHistory,
  getWorkDirFromProjectFolder,
} from '../history.js';

export const name = 'claude-code';

export const capabilities = Object.freeze({
  compact: true,
  clear: true,
  expert: true,
  mcp: true,
  subagents: true,
  attachments: true,
  askUser: true,
  modelPicker: true,
});

/**
 * Start (or resume) a Claude Code CLI session.
 * Returns the same state object that startClaudeQuery stores in ctx.conversations.
 */
export async function start(opts) {
  const state = await startClaudeQuery(
    opts.conversationId,
    opts.workDir,
    opts.resumeSessionId || null
  );
  state.providerName = name;
  return state;
}

/**
 * Claude CLI handles input via the persistent stdin Stream that
 * conversation.js manages directly, so this driver's sendInput is a no-op.
 * conversation.js's existing branch keeps owning the Claude path.
 */
export async function sendInput(_state, _prompt, _opts) {
  /* handled inline by conversation.js for the Claude branch */
}

export function abort(state) {
  if (state?.abortController) {
    try { state.abortController.abort(); } catch { /* noop */ }
  }
}

// ---------- history surface ----------

export async function listFolders() {
  const projectsDir = getClaudeProjectsDir();
  const folders = [];
  if (!existsSync(projectsDir)) return folders;

  for (const entry of readdirSync(projectsDir)) {
    const entryPath = join(projectsDir, entry);
    let stats;
    try { stats = statSync(entryPath); } catch { continue; }
    if (!stats.isDirectory()) continue;
    if (entry.includes('--crew-roles-')) continue;

    const originalPath = getWorkDirFromProjectFolder(entryPath, entry);
    let sessionCount = 0;
    let lastModified = stats.mtime.getTime();
    try {
      for (const file of readdirSync(entryPath)) {
        if (!file.endsWith('.jsonl')) continue;
        sessionCount++;
        try {
          const fs = statSync(join(entryPath, file));
          if (fs.mtime.getTime() > lastModified) lastModified = fs.mtime.getTime();
        } catch { /* noop */ }
      }
    } catch { /* noop */ }

    folders.push({ name: entry, path: originalPath, sessionCount, lastModified });
  }
  folders.sort((a, b) => b.lastModified - a.lastModified);
  return folders;
}

export async function listSessions(workDir) {
  return await getHistorySessions(workDir);
}

export async function loadHistory(workDir, sessionId, limit = 500) {
  return loadSessionHistory(workDir, sessionId, limit);
}

export default { name, capabilities, start, sendInput, abort, listFolders, listSessions, loadHistory };
