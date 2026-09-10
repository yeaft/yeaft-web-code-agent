/**
 * Non-blocking, post-response conversation compaction.
 *
 * The compact artifact is a derived provider-context cache. It never replaces
 * or tombstones ConversationStore rows. A generation fence in Engine decides
 * whether a completed artifact is still current before this module writes it.
 */
import { promises as fs } from 'fs';
import { dirname, join } from 'path';

export const POST_COMPACT_CONTEXT_RATIO = 0.8;

function safePart(value, fallback) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return encodeURIComponent(text).replace(/%/g, '_');
}

export function postCompactPath(yeaftDir, { sessionId, vpId, threadId } = {}) {
  if (!yeaftDir || !sessionId) return null;
  const file = `${safePart(vpId, 'default')}--${safePart(threadId, 'main')}.json`;
  return join(yeaftDir, 'sessions', safePart(sessionId, 'session'), 'conversation', 'post-compact', file);
}

export async function loadPostCompact(path) {
  if (!path) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
    return parsed && parsed.version === 1 && typeof parsed.summary === 'string'
      ? parsed : null;
  } catch {
    return null;
  }
}

export async function savePostCompact(path, artifact, isCurrent = null) {
  if (!path) return false;
  await fs.mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify({ version: 1, ...artifact }, null, 2)}\n`, 'utf8');
  if (typeof isCurrent === 'function' && !isCurrent()) {
    await fs.unlink(temp).catch(() => {});
    return false;
  }
  await fs.rename(temp, path);
  return true;
}

export async function removePostCompactIfSource(path, sourceTurnId) {
  if (!path || !sourceTurnId) return false;
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
    if (parsed?.sourceTurnId !== sourceTurnId) return false;
    await fs.unlink(path);
    return true;
  } catch {
    return false;
  }
}

export async function generatePostCompact({ adapter, model, messages, maxTokens = 4096 }) {
  const transcript = JSON.stringify((Array.isArray(messages) ? messages : []).map(message => ({
    role: message?.role,
    content: message?.content,
    ...(Array.isArray(message?.toolCalls) ? { toolCalls: message.toolCalls } : {}),
    ...(message?.toolCallId ? { toolCallId: message.toolCallId } : {}),
  })));
  const result = await adapter.call({
    model,
    system: 'Summarize the earlier conversation for use as context in a later turn. Preserve user goals, decisions, constraints, unresolved work, and important results. Omit raw tool payloads and do not invent facts. Return only the compact summary.',
    messages: [{ role: 'user', content: `Compact this transcript:\n${transcript}` }],
    maxTokens,
  });
  const summary = typeof result?.text === 'string' ? result.text.trim() : '';
  if (!summary) throw new Error('post compact returned empty content');
  return summary;
}
