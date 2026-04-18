/**
 * Crew — 路由解析与执行
 * parseRoutes, executeRoute, buildRoutePrompt, dispatchToRole
 *
 * task-330c — Greedy-strip guard:
 *   ⚠️ ROUTE-block stripping lives in `parseRoutes()` ONLY. Callers that
 *      want the role's prose without ROUTE blocks must consume
 *      `parseRoutes(text).displayBody` — never run a second
 *      `text.replace(/---ROUTE---[\s\S]*$/g, '')` style strip on already
 *      parser-cleaned text. A second strip would (a) re-process text
 *      that no longer has ROUTE markers (no-op at best, miscut at worst),
 *      (b) reintroduce the greedy tail-eating bug fixed by task-328.
 *      The summary-fallback in role-output.js and the recent-routes
 *      injector below both honour this contract.
 */
import { join } from 'path';
import { sendCrewMessage, sendCrewOutput, sendStatusUpdate } from './ui-messages.js';
import { ensureTaskFile, appendTaskRecord, readTaskFile, updateKanban, readKanban, saveRoleWorkSummary } from './task-files.js';
import { createRoleQuery, clearRoleSessionId } from './role-query.js';
import { saveSessionMeta } from './persistence.js';
import { recordRoutingEvent } from './routing-metrics.js';
import ctx from '../context.js';

/** Format role label */
function roleLabel(r) {
  return r.icon ? `${r.icon} ${r.displayName}` : r.displayName;
}

/**
 * task-330c — Smart truncate for recent-routes / history snippets.
 *
 * Cuts at a sentence/line boundary when possible to avoid mid-sentence
 * truncation; falls back to a hard cut when no good boundary exists in
 * the candidate window. Always appends a marker so downstream readers
 * (LLM roles seeing recent-routes context) know the full text lives
 * elsewhere (feature file).
 *
 * Boundary detection: looks for the last period (`.` `。` `!` `?` `！` `？`)
 * or newline inside the window `[Math.floor(max*0.7), max)`. The 70% lower
 * bound is a quality floor — we don't want to cut so early that we lose
 * meaningful tail context just to hit a clean boundary.
 *
 * Idempotent: text already short enough is returned unchanged (no marker).
 *
 * @param {string} text — input string (may be any length)
 * @param {number} max  — maximum chars before truncation
 * @returns {string}    — original text or `<truncated>…(truncated, full in feature file)`
 */
const TRUNCATE_MARKER = '…(truncated, full in feature file)';
export function smartTruncate(text, max) {
  if (typeof text !== 'string') return '';
  if (!Number.isFinite(max) || max <= 0) return '';
  if (text.length <= max) return text;

  // Search window: prefer cuts in the last 30% of the limit.
  const windowStart = Math.floor(max * 0.7);
  const windowSlice = text.slice(windowStart, max);
  // Last sentence boundary in window — period family OR newline.
  // We accept a boundary char and cut AFTER it so the sentence stays whole.
  const BOUNDARY_RE = /[.。!?！？\n]/g;
  let bestIdx = -1;
  let m;
  while ((m = BOUNDARY_RE.exec(windowSlice)) !== null) {
    bestIdx = m.index;
  }
  let cutEnd;
  if (bestIdx !== -1) {
    cutEnd = windowStart + bestIdx + 1; // include the boundary char itself
  } else {
    cutEnd = max; // no boundary in window → hard cut
  }
  // Trim trailing whitespace from the cut piece for cleaner output.
  const head = text.slice(0, cutEnd).replace(/\s+$/, '');
  return `${head}${TRUNCATE_MARKER}`;
}

/**
 * Append text to content — works for both string and multimodal array content.
 * For arrays, appends to the last text block (or adds a new one).
 */
function _appendTextToContent(content, text) {
  if (typeof content === 'string') return content + text;
  // Multimodal array: find last text block and append
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === 'text') {
      content[i].text += text;
      return content;
    }
  }
  // No text block found — add one
  content.push({ type: 'text', text });
  return content;
}

/**
 * 从累积文本中解析所有 ROUTE 块（支持多 ROUTE + task 字段）。
 *
 * task-328 — Returns a structured result:
 *   { routes, displayBody }
 *
 * - `routes`      — Array<{to, summary, taskId, taskTitle}> (same shape as before)
 * - `displayBody` — original text MINUS the exact matched ROUTE ranges
 *                   (including any surrounding ```fence``` that wraps the
 *                   ROUTE block), preserving everything else verbatim.
 *
 * Backward compatibility: the returned object is also iterable as an array
 * of routes for any legacy caller that does `for (const r of parseRoutes(...))`
 * or `parseRoutes(...).length` — we attach `[Symbol.iterator]`, `length`, and
 * numeric index properties mirroring `routes`. New callers should use the
 * named `.routes` / `.displayBody` fields.
 *
 * Scope A — ROUTE parser tolerance (task-328):
 *   (1) Markdown fence-wrapped ROUTE blocks are still parsed AND the fence
 *       lines are stripped from displayBody (so the user doesn't see an
 *       empty ```…```).
 *   (2) END variants accepted:  ---END_ROUTE--- / ---END ROUTE--- /
 *       ---END--- / ---END:--- / ---END-ROUTE--- / ---endroute---.
 *   (3) `to:` accepts:  `to:` `to ：` `to：` `TO:` with any casing.
 *   (4) Phase 2 soft-end is a STRUCTURAL signal (blank line + `---`, or
 *       `<kanban>` / `<recent-routes>` / `<task-context>`), NOT a bare blank
 *       line — so multi-paragraph summaries are not truncated.
 *   (5) Pre-pass: fenced code is MASKED (positions preserved) but a fence
 *       that contains `---ROUTE---` is NOT masked — the ROUTE inside the
 *       fence is the real one (matches what users write).
 *
 * Scope B — non-ROUTE body preservation (task-328):
 *   - `displayBody` = original minus the EXACT matched ROUTE ranges.
 *     No greedy "strip-to-EOF" anymore — post-ROUTE text survives.
 *
 * @param {string} text - Raw role output (may contain 0+ ROUTE blocks)
 * @returns {{ routes: Array<{to:string,summary:string,taskId:string|null,taskTitle:string|null}>, displayBody: string } & Iterable}
 */
export function parseRoutes(text) {
  const input = typeof text === 'string' ? text : '';
  const routes = [];
  // Exact character ranges (in ORIGINAL `input`) to remove from displayBody.
  // Each entry: { start, end } — half-open, end exclusive.
  const strippedRanges = [];

  if (!input) return _wrapParseResult(routes, '', strippedRanges);

  // ─── Pre-pass §2: mask fenced code WITHOUT stripping from original ──
  // We build a boolean mask the same length as `input`. Fences are walked
  // left-to-right. A fence containing `---ROUTE---` is SKIPPED (not masked)
  // so the real ROUTE inside it can be parsed by Phase 1. Non-ROUTE fences
  // are masked so any ```example``` won't pollute Phase 1/2/3 matching.
  //
  // We also remember the start/end of each "ROUTE-carrying fence" so the
  // displayBody calculation can extend a ROUTE match to cover its fence
  // lines — otherwise the user would see an empty ```…``` left behind.
  const masked = _maskNonRouteFences(input);
  const maskedText = masked.text;               // original chars or ' ' for masked regions
  const routeFences = masked.routeFences;       // [{start, end, innerStart, innerEnd}, ...]

  // ─── Phase 1: Standard ROUTE blocks (with closing marker) ─────
  // Accept END variants:  END_ROUTE | END ROUTE | END-ROUTE | END: | END | endroute
  // Body capture uses negative lookahead to avoid crossing another opener.
  // We run regex on `maskedText` so quoted examples (in non-ROUTE fences)
  // don't match, but we use match.index to index into the ORIGINAL input
  // when computing the strip range.
  const closedRegex = /---\s*ROUTE\s*---\s*\r?\n((?:(?!---\s*ROUTE\s*---)[\s\S])*?)---\s*(?:END[_ \-]?ROUTE|ENDROUTE|END)\s*:?\s*---/gi;
  let match;
  while ((match = closedRegex.exec(maskedText)) !== null) {
    const parsed = _parseRouteBlock(match[1]);
    let rangeStart = match.index;
    let rangeEnd = match.index + match[0].length;
    // §5: if this match lives inside a ROUTE-carrying fence, extend the
    // strip to cover the fence lines (so the UI doesn't see empty ```…```).
    const fence = routeFences.find(f => rangeStart >= f.innerStart && rangeEnd <= f.innerEnd);
    if (fence) { rangeStart = fence.start; rangeEnd = fence.end; }
    strippedRanges.push({ start: rangeStart, end: rangeEnd });
    if (parsed) routes.push(parsed);
  }

  // ─── Phase 2: Fallback — ROUTE block with no closing marker ──
  // Soft-end uses a STRUCTURAL signal, not a bare blank line. A summary
  // can span multiple paragraphs — it ends only when we see:
  //   (a) another ---ROUTE--- opener, or
  //   (b) EOF, or
  //   (c) a structural separator after ≥2 consecutive newlines:
  //       `\n\s*\n+---` (blank line + ---)
  //       `\n\s*\n+<(kanban|recent-routes|task-context|EOF)`
  //   (d) the 2048-char hard cap (safety valve for runaway blocks).
  const openRegex = /---\s*ROUTE\s*---\s*\r?\n/gi;
  while ((match = openRegex.exec(maskedText)) !== null) {
    const openStart = match.index;
    // Skip if this opener was already consumed by a Phase 1 match.
    if (strippedRanges.some(r => openStart >= r.start && openStart < r.end)) continue;

    const blockStart = openStart + match[0].length;
    // (a) next opener?
    const nextOpen = maskedText.indexOf('---ROUTE---', blockStart);
    const hardEnd = nextOpen !== -1 ? nextOpen : maskedText.length;
    const scope = maskedText.slice(blockStart, hardEnd);

    // (c) structural cutoff — scan for the first structural signal after
    //     ≥2 consecutive newlines (blank line + structure).
    const SOFT_END_RE = /\n[ \t]*\n+(?:---(?!\s*ROUTE)|<(?:kanban|recent-routes|task-context)\b)/;
    const softMatch = scope.match(SOFT_END_RE);
    let blockEnd = hardEnd;
    if (softMatch && softMatch.index != null) {
      blockEnd = blockStart + softMatch.index;
    }

    // (d) 2048-char hard cap — protect against runaway unclosed blocks.
    const SUMMARY_CAP = 2048;
    if (blockEnd - blockStart > SUMMARY_CAP) blockEnd = blockStart + SUMMARY_CAP;

    const block = maskedText.slice(blockStart, blockEnd);
    const parsed = _parseRouteBlock(block);

    let rangeStart = openStart;
    let rangeEnd = blockEnd;
    // Extend to fence if wrapped.
    const fence = routeFences.find(f => rangeStart >= f.innerStart && rangeEnd <= f.innerEnd);
    if (fence) { rangeStart = fence.start; rangeEnd = fence.end; }
    strippedRanges.push({ start: rangeStart, end: rangeEnd });
    if (parsed) routes.push(parsed);
  }

  // ─── Phase 3: Shorthand — "ROUTE → target" / "ROUTE: target" ─
  // Only matches a single line and only outside any ROUTE block. We also
  // run this on maskedText so shorthand inside quoted fences is ignored.
  const shorthandRegex = /^ROUTE\s*[→:]\s*(\S+)[,:\s]*(.*)$/gm;
  while ((match = shorthandRegex.exec(maskedText)) !== null) {
    const pos = match.index;
    if (strippedRanges.some(r => pos >= r.start && pos < r.end)) continue;

    // Also skip if inside an open ---ROUTE--- block (even unclosed).
    const precedingText = maskedText.slice(0, pos);
    const lastRouteOpen = precedingText.search(/---\s*ROUTE\s*---(?![\s\S]*---\s*ROUTE\s*---)/i);
    const lastRouteOpenIdx = precedingText.lastIndexOf('---ROUTE---');
    const lastRouteCloseIdx = Math.max(
      precedingText.lastIndexOf('---END_ROUTE---'),
      precedingText.lastIndexOf('---END ROUTE---'),
      precedingText.lastIndexOf('---END-ROUTE---'),
      precedingText.lastIndexOf('---END---'),
    );
    if (lastRouteOpenIdx > lastRouteCloseIdx) continue;
    void lastRouteOpen; // silence unused

    const toRaw = match[1].trim().toLowerCase().replace(/[,;:!?。，；：!？]+$/, '');
    const summary = match[2] ? match[2].trim() : '[该角色未提供消息摘要]';

    routes.push({ to: toRaw, summary, taskId: null, taskTitle: null });
    // Shorthand is a single line — strip the whole line.
    const lineEnd = maskedText.indexOf('\n', pos);
    strippedRanges.push({
      start: pos,
      end: lineEnd === -1 ? maskedText.length : lineEnd,
    });
  }

  const displayBody = _removeRanges(input, strippedRanges);
  return _wrapParseResult(routes, displayBody, strippedRanges);
}

/**
 * Wrap the parse result in an object that is ALSO iterable as an array
 * of routes (for legacy `for (const r of parseRoutes(x))` callers) and
 * supports `.length` / numeric index. New fields: `.routes`, `.displayBody`.
 * @private
 */
function _wrapParseResult(routes, displayBody, rangesForDebug) {
  // Start from a real Array so `Array.isArray()` and iteration/indexing
  // "just work". Decorate with named fields that new callers prefer.
  const arr = routes.slice();
  Object.defineProperty(arr, 'routes', { value: routes, enumerable: false });
  Object.defineProperty(arr, 'displayBody', { value: displayBody, enumerable: false });
  Object.defineProperty(arr, 'strippedRanges', { value: rangesForDebug, enumerable: false });
  return arr;
}

/**
 * §2 helper — build a mask of `input` that replaces non-ROUTE fenced
 * code with spaces (length-preserving), and records the positions of
 * fences that DO contain a ROUTE opener (so Phase 1/2 can extend their
 * strip range to swallow the fence lines).
 *
 * @param {string} input
 * @returns {{ text: string, routeFences: Array<{start:number,end:number,innerStart:number,innerEnd:number}> }}
 * @private
 */
function _maskNonRouteFences(input) {
  const FENCE_RE = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  let out = '';
  let lastIdx = 0;
  const routeFences = [];
  while ((m = FENCE_RE.exec(input)) !== null) {
    const fenceStart = m.index;
    const fenceEnd = m.index + m[0].length;
    const innerStart = fenceStart + m[0].indexOf('\n') + 1;
    const innerEnd = fenceEnd - 3; // strip trailing ```
    const fenceContent = m[1];
    const hasRoute = /---\s*ROUTE\s*---/i.test(fenceContent);
    // Copy unchanged text up to fence start
    out += input.slice(lastIdx, fenceStart);
    if (hasRoute) {
      // Keep the fence content intact so Phase 1 sees the ROUTE; record
      // the fence range for the displayBody extender.
      out += input.slice(fenceStart, fenceEnd);
      routeFences.push({ start: fenceStart, end: fenceEnd, innerStart, innerEnd });
    } else {
      // Mask entire fence (including markers) with spaces of equal length
      // so positions line up with the original string.
      out += ' '.repeat(fenceEnd - fenceStart);
    }
    lastIdx = fenceEnd;
  }
  out += input.slice(lastIdx);
  return { text: out, routeFences };
}

/**
 * Remove a list of (possibly overlapping) character ranges from `input`.
 * Also trims leading/trailing whitespace from the resulting blocks so the
 * displayBody doesn't keep lonely blank lines where a ROUTE used to be.
 *
 * @param {string} input
 * @param {Array<{start:number, end:number}>} ranges
 * @returns {string}
 * @private
 */
function _removeRanges(input, ranges) {
  if (!ranges || ranges.length === 0) return input;
  // Merge overlapping/adjacent ranges.
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= prev.end) prev.end = Math.max(prev.end, cur.end);
    else merged.push({ ...cur });
  }
  // Build output by keeping the gaps between merged ranges.
  let out = '';
  let cursor = 0;
  for (const r of merged) {
    out += input.slice(cursor, r.start);
    cursor = r.end;
  }
  out += input.slice(cursor);
  // Collapse 3+ consecutive newlines (left by a removal) to a double newline.
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * Parse fields from a ROUTE block body (the content between ---ROUTE--- and ---END_ROUTE---).
 * @param {string} block — raw block content
 * @returns {{ to: string, summary: string, taskId: string|null, taskTitle: string|null } | null}
 */
function _parseRouteBlock(block) {
  // task-328 §3: tolerate Chinese full-width colon (`to：` / `task：` / `summary：`)
  // and stray whitespace before the colon (`to :`). All field separators accept
  // either ASCII `:` or Chinese `：`.
  const toMatch = block.match(/to\s*[:：]\s*(.+)/i);
  if (!toMatch) return null;

  // ★ Clean `to` value: take only the first word (strip parenthetical notes, extra text)
  // e.g. "pm (决策者)" → "pm", "dev-1 // main dev" → "dev-1"
  const toRaw = toMatch[1].trim().toLowerCase();
  // Strip trailing punctuation (commas, semicolons, colons, etc.)
  const toClean = toRaw.split(/[\s(]/)[0].replace(/[,;:!?。，；：!？]+$/, '');

  // ★ summary: match until next known field (task:/taskTitle:) or end of block.
  //   Field separator accepts ASCII `:` or Chinese `：`.
  const summaryMatch = block.match(/summary\s*[:：]\s*([\s\S]+?)(?=\n\s*(?:task|taskTitle)\s*[:：]|$)/i);
  const taskMatch = block.match(/^task\s*[:：]\s*(.+)/im);
  const taskTitleMatch = block.match(/^taskTitle\s*[:：]\s*(.+)/im);

  let summary = summaryMatch ? summaryMatch[1].trim() : '';

  // ★ Bare-body fallback — PM / humans often omit the `summary:` label and
  //   just write the message as free text AFTER the known fields. Collect
  //   everything that is NOT a recognised field line as the body.
  if (!summary) {
    const KNOWN_FIELD = /^\s*(?:to|task|taskTitle|summary)\s*[:：]/i;
    const bare = block
      .split(/\r?\n/)
      .filter(line => !KNOWN_FIELD.test(line))
      .join('\n')
      .trim();
    if (bare) summary = bare;
  }

  if (!summary) {
    summary = '[该角色未提供消息摘要]';
  }

  return {
    to: toClean,
    summary,
    taskId: taskMatch ? taskMatch[1].trim() : null,
    taskTitle: taskTitleMatch ? taskTitleMatch[1].trim() : null
  };
}

/**
 * Resolve a ROUTE `to` value to an actual role name in the session.
 *
 * Resolution order:
 * 1. Exact match: `to` matches a role name directly (e.g. "dev-1")
 * 2. roleType match: `to` matches a role's roleType (e.g. "developer" → "dev-1")
 * 3. Short prefix match: `to` matches the SHORT_PREFIX of a roleType (e.g. "dev" → "dev-1")
 * 4. Same-group dispatch: if sender is in a multi-instance group (e.g. dev-1),
 *    and `to` matches the roleType/prefix of another group (e.g. "reviewer"),
 *    route to the instance with matching groupIndex (e.g. rev-1)
 *
 * For multi-instance matches (2/3), prefer the instance with the same groupIndex
 * as the sender. Falls back to the first instance if no groupIndex match.
 *
 * @param {string} to - raw route target from ROUTE block
 * @param {object} session - crew session
 * @param {string} [fromRole] - sending role name (for groupIndex matching)
 * @returns {string|null} resolved role name, or null if unresolvable
 */
export function resolveRoleName(to, session, fromRole) {
  // 1. Exact match
  if (session.roles.has(to)) return to;

  // Build candidate list by roleType and short prefix
  const fromRoleConfig = fromRole ? session.roles.get(fromRole) : null;
  const fromGroupIndex = fromRoleConfig?.groupIndex || 0;

  let candidates = [];

  for (const [name, config] of session.roles) {
    // 2. roleType match (e.g. "developer" → dev-1, dev-2, dev-3)
    if (config.roleType === to) {
      candidates.push({ name, groupIndex: config.groupIndex || 0 });
    }
    // 3. Short prefix match (e.g. "dev" → developer roleType → dev-1)
    //    Match if the role name starts with `to-` (e.g. "dev" matches "dev-1", "dev-2")
    else if (name.startsWith(to + '-') && /^\d+$/.test(name.slice(to.length + 1))) {
      candidates.push({ name, groupIndex: config.groupIndex || 0 });
    }
  }

  // 4. displayName match (e.g. "乔布斯" → pm)
  if (candidates.length === 0) {
    for (const [name, config] of session.roles) {
      if (config.displayName && config.displayName.toLowerCase() === to) {
        candidates.push({ name, groupIndex: config.groupIndex || 0 });
      }
    }
  }

  // 5. name-displayName compound match (e.g. "pm-乔布斯" → pm)
  //    Claude sometimes concatenates role name + display name with a hyphen
  if (candidates.length === 0) {
    for (const [name, config] of session.roles) {
      if (to.startsWith(name + '-') && to.length > name.length + 1) {
        candidates.push({ name, groupIndex: config.groupIndex || 0 });
      }
    }
  }

  if (candidates.length === 0) return null;

  // 6. Prefer same groupIndex as sender
  if (fromGroupIndex > 0) {
    const sameGroup = candidates.find(c => c.groupIndex === fromGroupIndex);
    if (sameGroup) return sameGroup.name;
  }

  // Fall back to first candidate
  return candidates[0].name;
}

/**
 * 执行路由
 * @param {Array<{mimeType, data}>} [turnImages] - auto-attached images from the turn (max 3)
 */
export async function executeRoute(session, fromRole, route, turnImages = []) {
  let { to, summary, taskId, taskTitle } = route;

  // task-330b §B item 1: self-route metric. §A (task-330a) owns the actual
  // rejection; here we only record the event so the counter still increments
  // even if §A lands later or in a different code path. Comparison is on
  // the RAW `to` string — resolution to a different name (e.g. roleType
  // expansion) is treated as a different routing decision.
  if (typeof to === 'string' && to === fromRole) {
    recordRoutingEvent(session, 'self-route', {
      fromRole,
      toRole: to,
      taskId: taskId || null,
      note: 'route.to === fromRole at executeRoute entry',
    });
  }

  // task-330b §B item 1: state-stopped metric — message arrived while
  // session was paused/stopped. Behaviour (auto-resume) is unchanged for
  // backward compat; this is observer-only.
  if (session.status === 'paused' || session.status === 'stopped') {
    recordRoutingEvent(session, 'state-stopped', {
      fromRole,
      toRole: to,
      taskId: taskId || null,
      note: `session.status=${session.status} at executeRoute entry`,
    });
  }

  // Auto-resume: paused/stopped → running (route execution means work should continue)
  if (session.status === 'paused' || session.status === 'stopped') {
    console.log(`[Crew] Auto-resuming session from ${session.status} to running (route from ${fromRole} to ${to})`);
    session.status = 'running';
    sendStatusUpdate(session);
  }

  // ─── task-321: taskId fallback chain ─────────────────────────────
  // When a ROUTE omits `task:` (shorthand, bare dispatch, human messages,
  // PM forgetting the field), fall back to:
  //   (a) the sender's currentTask.taskId
  //   (b) the most recent non-system entry in session.messageHistory
  // This keeps prev-* / designer / architect / shorthand messages from
  // becoming taskId=null orphans that never appear on any feature card.
  if (!taskId) {
    const fromRoleState = session.roleStates?.get(fromRole);
    if (fromRoleState?.currentTask?.taskId) {
      taskId = fromRoleState.currentTask.taskId;
      taskTitle = taskTitle || fromRoleState.currentTask.taskTitle || null;
    } else if (Array.isArray(session.messageHistory) && session.messageHistory.length > 0) {
      for (let i = session.messageHistory.length - 1; i >= 0; i--) {
        const h = session.messageHistory[i];
        if (h && h.from !== 'system' && h.taskId) {
          taskId = h.taskId;
          break;
        }
      }
    }
    // Mirror the fallback back into the route object so downstream
    // consumers (dispatchToRole / sendCrewOutput) see the inferred id.
    if (taskId) {
      route.taskId = taskId;
      if (taskTitle) route.taskTitle = taskTitle;
    }
  }

  // Task 文件自动管理（fire-and-forget）
  if (taskId && summary) {
    const fromRoleConfig = session.roles.get(fromRole);
    // task-321: Auto-create feature file even when a non-PM role is the
    // first to mention the taskId. Any role carrying a taskId (PM, devs,
    // reviewers, designer, architect) now triggers creation — not just PM
    // with explicit taskTitle. appendTaskRecord itself also creates the
    // file if missing, so this is a best-effort fast path.
    const effectiveTitle = taskTitle
      || session.features?.get(taskId)?.taskTitle
      || null;
    if (effectiveTitle && to !== 'human') {
      ensureTaskFile(session, taskId, effectiveTitle, fromRoleConfig?.isDecisionMaker ? to : fromRole, summary)
        .catch(e => console.warn(`[Crew] Failed to create task file ${taskId}:`, e.message));
    }
    appendTaskRecord(session, taskId, fromRole, summary, { taskTitle: effectiveTitle })
      .catch(e => console.warn(`[Crew] Failed to append task record ${taskId}:`, e.message));

    // 更新工作看板：推断状态
    const { getMessages } = await import('../crew-i18n.js');
    const m = getMessages(session.language || 'zh-CN');
    // ★ Use resolveRoleName for kanban status lookup too
    const resolvedKanbanTo = resolveRoleName(to, session, fromRole);
    const toRoleConfig = session.roles.get(resolvedKanbanTo || to);
    let status = m.kanbanStatusDev;
    if (toRoleConfig) {
      switch (toRoleConfig.roleType) {
        case 'reviewer': status = m.kanbanStatusReview; break;
        case 'product-reviewer': status = m.kanbanStatusProductReview; break;
        default:
          if (toRoleConfig.isDecisionMaker) status = m.kanbanStatusDecision;
      }
    }
    updateKanban(session, {
      taskId, taskTitle, assignee: resolvedKanbanTo || to,
      status, summary
    }).catch(e => console.warn(`[Crew] Failed to update kanban:`, e.message));
  }

  // 发送路由消息（UI 显示）
  sendCrewOutput(session, fromRole, 'route', null, {
    routeTo: to, routeSummary: summary,
    taskId: taskId || undefined,
    taskTitle: taskTitle || undefined,
    // ★ Auto-attach turn images (base64) — server will cache and convert to fileId/previewToken
    routeImages: turnImages.length > 0 ? turnImages.map(img => ({
      mimeType: img.mimeType,
      data: img.data
    })) : undefined
  });

  // 路由到 human
  if (to === 'human') {
    session.status = 'waiting_human';
    session.waitingHumanContext = {
      fromRole,
      reason: 'requested',
      message: summary
    };
    sendCrewMessage({
      type: 'crew_human_needed',
      sessionId: session.id,
      fromRole,
      reason: 'requested',
      message: summary
    });
    sendStatusUpdate(session);
    // Status changed to waiting_human — persist
    saveSessionMeta(session).catch(e => console.warn('[Crew] Failed to save after →human:', e.message));
    return;
  }

  // 路由到指定角色
  const resolvedTo = resolveRoleName(to, session, fromRole);
  if (resolvedTo) {
    if (session.humanMessageQueue.length > 0) {
      const { processHumanQueue } = await import('./human-interaction.js');
      await processHumanQueue(session);
    } else {
      const taskPrompt = buildRoutePrompt(fromRole, summary, session, turnImages);
      await dispatchToRole(session, resolvedTo, taskPrompt, fromRole, taskId, taskTitle);
    }
  } else {
    const availableRoles = Array.from(session.roles.keys()).join(', ');
    console.warn(`[Crew] Unknown route target: ${to} (available: ${availableRoles})`);
    const errorMsg = `路由目标 "${to}" 不存在。可用角色: ${availableRoles}\n来自 ${fromRole} 的消息: ${summary}`;
    await dispatchToRole(session, session.decisionMaker, errorMsg, 'system');
  }
}

/**
 * 构建路由转发的 prompt（支持多模态 — 自动附加 turn 截图）
 * @param {Array<{mimeType, data}>} [turnImages] - auto-attached images
 * @returns {string|Array} text string, or multimodal content array when images present
 */
export function buildRoutePrompt(fromRole, summary, session, turnImages = []) {
  const fromRoleConfig = session.roles.get(fromRole);
  const fromName = fromRoleConfig ? roleLabel(fromRoleConfig) : fromRole;
  const text = `来自 ${fromName} 的消息:\n${summary}\n\n请开始你的工作。完成后通过 ROUTE 块传递给下一个角色。`;

  if (turnImages.length === 0) return text;

  // Build multimodal content: images first, then text
  const blocks = [];
  for (const img of turnImages) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.data }
    });
  }
  blocks.push({ type: 'text', text });
  return blocks;
}

/**
 * 向角色发送消息
 */
export async function dispatchToRole(session, roleName, content, fromSource, taskId, taskTitle) {
  // Only block during initialization (roles not ready yet)
  if (session.status === 'initializing') {
    console.log(`[Crew] Session initializing, skipping dispatch to ${roleName}`);
    return;
  }

  // Auto-resume: paused/stopped → running (dispatch means work should continue)
  if (session.status === 'paused' || session.status === 'stopped') {
    console.log(`[Crew] Auto-resuming session from ${session.status} to running (dispatch to ${roleName})`);
    session.status = 'running';
    sendStatusUpdate(session);
  }

  let roleState = session.roleStates.get(roleName);

  // 如果角色没有 query 实例，创建一个（支持 resume）
  if (!roleState || !roleState.query || !roleState.inputStream) {
    roleState = await createRoleQuery(session, roleName);
  }

  // 设置 task
  // task-321: keep currentTask sticky. A new taskId updates it; a dispatch
  // without taskId preserves the previous currentTask so subsequent
  // sendCrewOutput calls (which read roleState.currentTask.taskId) keep
  // attaching to the right feature card — instead of falling back to null
  // the moment the sender omits the `task:` field.
  if (taskId) {
    roleState.currentTask = { taskId, taskTitle: taskTitle || roleState.currentTask?.taskTitle || null };
  }

  // Task 上下文注入
  const effectiveTaskId = taskId || roleState.currentTask?.taskId;
  if (effectiveTaskId) {
    const taskContent = await readTaskFile(session, effectiveTaskId);
    if (taskContent) {
      const ctx = `\n\n---\n<task-context file=".crew/context/features/${effectiveTaskId}.md">\n${taskContent}\n</task-context>`;
      content = _appendTextToContent(content, ctx);
    }
  }

  // 看板上下文注入（角色重启后知道全局状态）
  {
    const kanbanContent = await readKanban(session);
    if (kanbanContent) {
      const ctx = `\n\n---\n<kanban file=".crew/context/kanban.md">\n${kanbanContent}\n</kanban>`;
      content = _appendTextToContent(content, ctx);
    }
  }

  // 最近路由消息注入（帮助 clear 后的角色恢复上下文）
  // task-330c: each entry is smart-truncated to 400 chars at a sentence
  // boundary (period/newline) so we don't slice key info mid-sentence.
  // The full content lives in the feature file — the marker tells the
  // role where to look if they need more context. The pre-stored
  // `m.content` was already truncated to 200 (history step below) until
  // task-330c bumped it to 400 + smart boundary.
  // ⚠️ DO NOT pass `m.content` through any greedy `.replace(/.../g, '')`
  //    here — it has already been derived from displayBody at message
  //    time (parser-stripped), and a second strip would re-process
  //    text that no longer holds ROUTE markers. See _appendHistory below.
  if (session.messageHistory.length > 0) {
    const recentRoutes = session.messageHistory
      .filter(m => m.from !== 'system')
      .slice(-5)
      .map(m => `[${m.from} → ${m.to}${m.taskId ? ` (${m.taskId})` : ''}] ${smartTruncate(m.content, 400)}`)
      .join('\n');
    if (recentRoutes) {
      const ctx = `\n\n---\n<recent-routes>\n${recentRoutes}\n</recent-routes>`;
      content = _appendTextToContent(content, ctx);
    }
  }

  // 记录消息历史
  const historyContent = typeof content === 'string'
    ? content.substring(0, 200)
    : (Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('').substring(0, 200) + (content.some(b => b.type === 'image') ? ' [+images]' : '') : '...');
  session.messageHistory.push({
    from: fromSource,
    to: roleName,
    content: historyContent,
    taskId: taskId || roleState.currentTask?.taskId || null,
    timestamp: Date.now()
  });

  // DISABLED (2026-03): Opus 4.6 has 200k context. Claude Code handles its own compaction.
  // Keeping code for reference; re-enable if we ever need custom crew pre-send compact.
  // ★ Pre-send compact check: estimate total tokens and clear+rebuild if needed
  // const autoCompactThreshold = ctx.CONFIG?.autoCompactThreshold || 100000;
  // const lastInputTokens = roleState.lastInputTokens || 0;
  // const estimatedNewTokens = Math.ceil((typeof content === 'string' ? content.length : 0) / 3);
  // const estimatedTotal = lastInputTokens + estimatedNewTokens;
  //
  // if (lastInputTokens > 0 && estimatedTotal > autoCompactThreshold) {
  //   console.log(`[Crew] Pre-send compact for ${roleName}: estimated ${estimatedTotal} tokens (last: ${lastInputTokens} + new: ~${estimatedNewTokens}) exceeds threshold ${autoCompactThreshold}`);
  //
  //   // Save work summary before clearing (use lastTurnText since accumulatedText is cleared after result)
  //   await saveRoleWorkSummary(session, roleName, roleState.lastTurnText || roleState.accumulatedText || '').catch(e =>
  //     console.warn(`[Crew] Failed to save work summary for ${roleName}:`, e.message));
  //
  //   // Clear role session and rebuild
  //   await clearRoleSessionId(session.sharedDir, roleName);
  //   roleState.claudeSessionId = null;
  //
  //   if (roleState.abortController) roleState.abortController.abort();
  //   roleState.query = null;
  //   roleState.inputStream = null;
  //
  //   sendCrewMessage({
  //     type: 'crew_role_cleared',
  //     sessionId: session.id,
  //     role: roleName,
  //     contextPercentage: Math.round((lastInputTokens / (ctx.CONFIG?.maxContextTokens || 128000)) * 100),
  //     reason: 'pre_send_compact'
  //   });
  //
  //   // Recreate the query (fresh Claude process)
  //   roleState = await createRoleQuery(session, roleName);
  // }

  // P1-4: 守卫 stream.enqueue — stream 可能已被 abort 关闭
  roleState.lastDispatchContent = content;
  roleState.lastDispatchFrom = fromSource;
  roleState.lastDispatchTaskId = taskId || null;
  roleState.lastDispatchTaskTitle = taskTitle || null;
  roleState.turnActive = true;
  roleState.accumulatedText = '';
  try {
    if (roleState.inputStream && !roleState.inputStream.isDone) {
      roleState.inputStream.enqueue({
        type: 'user',
        message: { role: 'user', content }
      });
    } else {
      console.warn(`[Crew] Cannot enqueue to ${roleName}: stream closed or missing, recreating`);
      roleState = await createRoleQuery(session, roleName);
      roleState.lastDispatchContent = content;
      roleState.lastDispatchFrom = fromSource;
      roleState.lastDispatchTaskId = taskId || null;
      roleState.lastDispatchTaskTitle = taskTitle || null;
      roleState.turnActive = true;
      roleState.accumulatedText = '';
      roleState.inputStream.enqueue({
        type: 'user',
        message: { role: 'user', content }
      });
    }
  } catch (enqueueErr) {
    console.error(`[Crew] Failed to enqueue to ${roleName}:`, enqueueErr.message);
    // Recreate query and retry once
    roleState = await createRoleQuery(session, roleName);
    roleState.lastDispatchContent = content;
    roleState.lastDispatchFrom = fromSource;
    roleState.lastDispatchTaskId = taskId || null;
    roleState.lastDispatchTaskTitle = taskTitle || null;
    roleState.turnActive = true;
    roleState.accumulatedText = '';
    roleState.inputStream.enqueue({
      type: 'user',
      message: { role: 'user', content }
    });
  }

  sendStatusUpdate(session);
  console.log(`[Crew] Dispatched to ${roleName} from ${fromSource}${taskId ? ` (task: ${taskId})` : ''}`);
}
