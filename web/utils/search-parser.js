/**
 * Unify sidebar search parser.
 *
 * H2.f.6: thread-prefix and threadMatches removed alongside the
 * multi-thread engine. The parser now supports task / status / in:
 * filters and bare keyword fragments.
 *
 *   query      := token (WS token)*
 *   token      := 'task:' NUM                    // restrict to a specific task id
 *              | 'status:' STATUS               // archived | closed | open
 *              | 'in:' FIELD                    // upcoming keyword applies to FIELD only
 *              | BARE                           // plain keyword fragment
 *
 *   STATUS     := 'open' | 'closed' | 'archived'
 *   FIELD      := 'title' | 'summary' | 'body'
 *
 * Multiple tokens combine with AND semantics. Plain keyword fragments
 * are concatenated with a single space so users may type multi-word
 * queries like `fix login`.
 */

const STATUS_WHITELIST = new Set(['open', 'closed', 'archived']);
const FIELD_WHITELIST = new Set(['title', 'summary', 'body']);

function normaliseTaskId(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^task-/.test(v)) return v.toLowerCase();
  if (/^\d+$/.test(v)) return `task-${v}`;
  return v.toLowerCase();
}

export function parseSearchQuery(raw) {
  const out = {
    keyword: '',
    scopedField: null,
    taskId: null,
    status: null,
    rawTokens: [],
  };
  const src = (raw || '').trim();
  if (!src) return out;

  const parts = src.split(/\s+/);
  out.rawTokens = parts.slice();
  const keywordFrags = [];

  for (const rawTok of parts) {
    const tok = rawTok;
    if (!tok) continue;

    // task:N — numeric or `task-N` form.
    const taskMatch = tok.match(/^task:(.+)$/i);
    if (taskMatch) {
      out.taskId = normaliseTaskId(taskMatch[1]);
      continue;
    }

    // status:X — only whitelisted values consumed; bogus falls through
    //            to a keyword fragment so the query isn't silently dropped.
    const statusMatch = tok.match(/^status:(.+)$/i);
    if (statusMatch) {
      const v = statusMatch[1].toLowerCase();
      if (STATUS_WHITELIST.has(v)) {
        out.status = v;
        continue;
      }
      keywordFrags.push(tok.toLowerCase());
      continue;
    }

    // in:FIELD — scope the upcoming keyword to FIELD.
    const inMatch = tok.match(/^in:(.+)$/i);
    if (inMatch) {
      const v = inMatch[1].toLowerCase();
      if (FIELD_WHITELIST.has(v)) {
        out.scopedField = v;
        continue;
      }
      keywordFrags.push(tok.toLowerCase());
      continue;
    }

    keywordFrags.push(tok.toLowerCase());
  }

  out.keyword = keywordFrags.join(' ').trim();
  return out;
}

export function hasActiveQuery(parsed) {
  if (!parsed) return false;
  return !!(parsed.keyword || parsed.taskId || parsed.status || parsed.scopedField);
}

export function taskMatches(task, parsed) {
  if (!task) return false;
  const q = parsed || parseSearchQuery('');

  if (q.taskId && String(task.id || '').toLowerCase() !== q.taskId) return false;

  if (q.status) {
    if (q.status === 'archived' && !(task.status === 'archived' || task.archived)) return false;
    if (q.status === 'closed' && !(task.status === 'done' || task.status === 'closed')) return false;
    if (q.status === 'open' && (task.status === 'done' || task.status === 'closed' || task.archived)) return false;
  }

  if (q.keyword) {
    const kw = q.keyword;
    if (q.scopedField === 'title') {
      if (!((task.title || '').toLowerCase().includes(kw)
          || (task.id || '').toLowerCase().includes(kw))) return false;
    } else if (q.scopedField === 'summary' || q.scopedField === 'body') {
      if (!((task.summary || '').toLowerCase().includes(kw)
          || (task.description || '').toLowerCase().includes(kw))) return false;
    } else {
      const hit = (task.title || '').toLowerCase().includes(kw)
        || (task.id || '').toLowerCase().includes(kw)
        || (task.summary || '').toLowerCase().includes(kw)
        || (task.description || '').toLowerCase().includes(kw);
      if (!hit) return false;
    }
  }
  return true;
}

export function messageMatches(msg, parsed) {
  if (!msg) return false;
  const q = parsed || parseSearchQuery('');

  if (q.taskId && String(msg.taskId || '').toLowerCase() !== q.taskId) return false;

  if (q.keyword) {
    const kw = q.keyword;
    const text = typeof msg.content === 'string'
      ? msg.content
      : (msg.content ? JSON.stringify(msg.content) : '');
    if (q.scopedField === 'title') return false;
    if (q.scopedField === 'summary') return false;
    if (!text.toLowerCase().includes(kw)) return false;
  }

  return true;
}

export const __testing__ = { STATUS_WHITELIST, FIELD_WHITELIST, normaliseTaskId };
