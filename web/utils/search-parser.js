/**
 * task-316 — Unify sidebar advanced search parser.
 *
 * Supersedes (and extends) the inline parser introduced for task-312.
 * Query grammar:
 *
 *   query      := token (WS token)*
 *   token      := '#' IDENT                     // thread-name prefix
 *              | 'task:' NUM                    // restrict to a specific task id
 *              | 'status:' STATUS               // filter thread status
 *              | 'in:' FIELD                    // upcoming keyword applies to FIELD only
 *              | BARE                           // plain keyword fragment
 *
 *   STATUS     := 'open' | 'closed' | 'archived' | 'active' | 'idle'
 *   FIELD      := 'title' | 'summary' | 'body'
 *
 * Multiple tokens combine with AND semantics. Example:
 *   task:42 status:open in:title foo
 *     → matches only items that belong to task 42, whose thread is in
 *       `open` status, and whose TITLE contains "foo".
 *
 * Plain keyword fragments are concatenated with a single space so users
 * may type multi-word queries like `fix login`.
 *
 * Output shape (ParsedQuery):
 *   {
 *     keyword:     string      // lowercased joined keyword (or '')
 *     threadPrefix:string|null // '#foo' → 'foo'
 *     scopedField: 'title'|'summary'|'body'|null
 *     taskId:      string|null // normalised `task-<N>` id
 *     status:      string|null
 *     rawTokens:   string[]    // for debugging / error surfaces
 *   }
 *
 * The parser is deliberately forgiving: unknown `in:` / `status:` values
 * fall through to plain keyword instead of silently dropping the query.
 * This mirrors task-312 safety behaviour and is covered by unit tests.
 */

const STATUS_WHITELIST = new Set(['open', 'closed', 'archived', 'active', 'idle']);
const FIELD_WHITELIST = new Set(['title', 'summary', 'body']);

/**
 * Normalise a `task:N` operand to a task id. Accepts both `42` and
 * `task-42`; other forms are passed through untouched so callers can
 * detect odd inputs.
 */
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
    threadPrefix: null,
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

    // 1) `#name` thread-name shortcut. Only valid when it's the first
    //    token OR standalone; when combined with other tokens we still
    //    honour it but the rest of the query narrows the result set.
    if (tok.startsWith('#') && tok.length > 1) {
      out.threadPrefix = tok.slice(1).toLowerCase();
      continue;
    }

    // 2) `task:N` — numeric or `task-N` form.
    const taskMatch = tok.match(/^task:(.+)$/i);
    if (taskMatch) {
      out.taskId = normaliseTaskId(taskMatch[1]);
      continue;
    }

    // 3) `status:X` — only whitelisted values consumed; bogus falls
    //    through to a keyword fragment so the query isn't silently
    //    dropped. (Same policy as task-312 for `in:`.)
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

    // 4) `in:FIELD` — scope the upcoming keyword to FIELD.
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

    // 5) Bare keyword fragment.
    keywordFrags.push(tok.toLowerCase());
  }

  out.keyword = keywordFrags.join(' ').trim();
  return out;
}

/**
 * Convenience — true when the parsed query carries ANY filter token,
 * i.e. the user typed something that should switch the sidebar into
 * Results mode (hiding the default grouped view).
 */
export function hasActiveQuery(parsed) {
  if (!parsed) return false;
  return !!(parsed.keyword || parsed.threadPrefix || parsed.taskId || parsed.status || parsed.scopedField);
}

/**
 * Does a thread object match every parsed filter? Pure function so the
 * sidebar component (and unit tests) can share logic.
 */
export function threadMatches(thread, parsed) {
  if (!thread) return false;
  const q = parsed || parseSearchQuery('');

  // #name shortcut
  if (q.threadPrefix !== null) {
    if (!(thread.name || '').toLowerCase().includes(q.threadPrefix)) return false;
  }

  // status: filter. Map whitelist values onto actual thread fields.
  if (q.status) {
    const archived = !!(thread.archived || thread.status === 'archived');
    switch (q.status) {
      case 'archived': if (!archived) return false; break;
      case 'closed':   if (!(thread.status === 'closed' || archived)) return false; break;
      case 'open':     if (archived || thread.status === 'closed') return false; break;
      case 'active':   if (!thread.running && archived) return false;
                       if (!thread.running && thread.status !== 'active') return false;
                       break;
      case 'idle':     if (thread.running) return false;
                       if (archived) return false;
                       break;
    }
  }

  // task: filter — thread is linked to a task via taskId field
  // (populated by AttachThreadToTask); also accept a `tasks` array.
  if (q.taskId) {
    const linked = thread.taskId
      ? String(thread.taskId).toLowerCase() === q.taskId
      : Array.isArray(thread.tasks) && thread.tasks.some(t => String(t).toLowerCase() === q.taskId);
    if (!linked) return false;
  }

  // Keyword — respect scopedField when set.
  if (q.keyword) {
    const kw = q.keyword;
    if (q.scopedField === 'title') {
      if (!(thread.title || '').toLowerCase().includes(kw)) return false;
    } else if (q.scopedField === 'summary') {
      if (!((thread.goal || '').toLowerCase().includes(kw)
          || (thread.preview || '').toLowerCase().includes(kw))) return false;
    } else if (q.scopedField === 'body') {
      // For a thread, `body` maps to preview only (long-form body is on
      // individual messages, matched separately by messageMatches).
      if (!(thread.preview || '').toLowerCase().includes(kw)) return false;
    } else {
      const hit = (thread.name || '').toLowerCase().includes(kw)
        || (thread.title || '').toLowerCase().includes(kw)
        || (thread.goal || '').toLowerCase().includes(kw)
        || (thread.preview || '').toLowerCase().includes(kw);
      if (!hit) return false;
    }
  }

  return true;
}

export function taskMatches(task, parsed) {
  if (!task) return false;
  const q = parsed || parseSearchQuery('');

  // #name shortcut excludes tasks entirely — they have no name field.
  if (q.threadPrefix !== null) return false;

  if (q.taskId && String(task.id || '').toLowerCase() !== q.taskId) return false;

  if (q.status) {
    // Thread-oriented statuses don't apply to tasks; map `archived` to
    // task.status === 'done'/'archived' as a best-effort; other values
    // simply don't reject a task.
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

/**
 * Does a message object match the parsed query? Used for the message
 * group in the Results list — in particular, `in:body foo` lets the
 * user search chat content (not just thread / task metadata).
 */
export function messageMatches(msg, parsed) {
  if (!msg) return false;
  const q = parsed || parseSearchQuery('');

  if (q.threadPrefix !== null) {
    // A message is linked to a thread by threadId; threadPrefix needs a
    // thread lookup which the component does outside this fn. Pure fn:
    // conservatively reject so bare `#foo` doesn't drag messages in.
    return false;
  }

  if (q.taskId && String(msg.taskId || '').toLowerCase() !== q.taskId) return false;

  if (q.keyword) {
    const kw = q.keyword;
    const text = typeof msg.content === 'string'
      ? msg.content
      : (msg.content ? JSON.stringify(msg.content) : '');
    if (q.scopedField === 'title') {
      // messages have no title; scoped title search excludes them.
      return false;
    }
    if (q.scopedField === 'summary') return false;
    // `in:body` OR unscoped — match text.
    if (!text.toLowerCase().includes(kw)) return false;
  }

  return true;
}

export const __testing__ = { STATUS_WHITELIST, FIELD_WHITELIST, normaliseTaskId };
