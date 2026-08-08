import { readdir, stat } from 'fs/promises';
import { join, relative, resolve } from 'path';
import ctx from '../context.js';
import { sendWorkbenchResult } from './request-routing.js';

export async function handleFileSearch(msg) {
  const { conversationId, query, _requestUserId } = msg;
  const conv = ctx.conversations.get(conversationId);
  const workDir = msg.workDir || conv?.workDir || ctx.CONFIG.workDir;
  const searchRoot = msg.dirPath || workDir;

  try {
    if (!query || query.trim().length === 0) {
      sendWorkbenchResult(ctx, msg, { type: 'file_search_result', conversationId, _requestUserId, query, results: [] });
      return;
    }

    const resolved = resolve(searchRoot);
    const results = [];
    const MAX_RESULTS = 100;
    const lowerQuery = query.toLowerCase();
    const skipDirs = new Set(['.git', 'node_modules', '__pycache__', '.next', '.nuxt', 'dist', 'build', '.cache', 'bin', 'obj']);

    async function walk(dir, depth) {
      if (depth > 10 || results.length >= MAX_RESULTS) return;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= MAX_RESULTS) return;
          if (skipDirs.has(entry.name) && entry.isDirectory()) continue;

          const fullPath = join(dir, entry.name);

          if (entry.name.toLowerCase().includes(lowerQuery)) {
            let size = 0;
            try { const s = await stat(fullPath); size = s.size; } catch {}
            results.push({
              name: entry.name,
              path: relative(resolved, fullPath).replace(/\\/g, '/'),
              fullPath: fullPath.replace(/\\/g, '/'),
              type: entry.isDirectory() ? 'directory' : 'file',
              size
            });
          }

          if (entry.isDirectory()) {
            await walk(fullPath, depth + 1);
          }
        }
      } catch {}
    }

    await walk(resolved, 0);

    sendWorkbenchResult(ctx, msg, {
      type: 'file_search_result',
      conversationId,
      _requestUserId,
      query,
      results,
      truncated: results.length >= MAX_RESULTS
    });
  } catch (e) {
    sendWorkbenchResult(ctx, msg, { type: 'file_search_result', conversationId, _requestUserId, query, results: [], error: e.message });
  }
}
