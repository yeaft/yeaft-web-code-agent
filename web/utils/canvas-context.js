/**
 * Canvas Context Reference store — per-route reactive references created from
 * FileCanvasView (doc quotes, images, video timestamps) and consumed by ChatInput.
 */

const FALLBACK_ROUTE_KEY = '__active__';
const MAX_REFS_PER_ROUTE = 6;

const contextMap = (typeof Vue !== 'undefined' && typeof Vue.reactive === 'function')
  ? Vue.reactive({})
  : {};

let refSequence = 0;

function normalizeRouteKey(routeKey) {
  const key = typeof routeKey === 'string' ? routeKey.trim() : '';
  return key || FALLBACK_ROUTE_KEY;
}

function ensureList(routeKey) {
  const key = normalizeRouteKey(routeKey);
  if (!Array.isArray(contextMap[key])) {
    contextMap[key] = [];
  }
  return contextMap[key];
}

function basenameOf(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  const parts = raw.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || raw;
}

/**
 * Format seconds into 'MM:SS' or 'HH:MM:SS'.
 *
 * @param {number} sec
 * @returns {string}
 */
export function formatTimestampLabel(sec) {
  const numeric = Number(sec);
  const total = Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = n => String(n).padStart(2, '0');
  if (hrs > 0) {
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

function normalizeRef(ref = {}) {
  const kind = ref.kind === 'image' || ref.kind === 'video' ? ref.kind : 'doc';
  const filePath = String(ref.filePath || '').trim();
  const fileName = String(ref.fileName || '').trim() || basenameOf(filePath) || 'untitled';
  const rawSnippet = typeof ref.snippet === 'string' ? ref.snippet.trim() : '';
  const snippet = rawSnippet ? rawSnippet.slice(0, 800) : undefined;

  const lineStartNum = Number(ref.lineStart);
  const lineEndNum = Number(ref.lineEnd);
  const lineStart = Number.isInteger(lineStartNum) && lineStartNum > 0 ? lineStartNum : undefined;
  const lineEnd = Number.isInteger(lineEndNum) && lineEndNum > 0
    ? (lineStart && lineEndNum < lineStart ? lineStart : lineEndNum)
    : lineStart;

  const rawTs = ref.timestampSec;
  const tsNum = rawTs === '' || rawTs == null ? NaN : Number(rawTs);
  const timestampSec = Number.isFinite(tsNum) && tsNum >= 0 ? Math.floor(tsNum) : undefined;
  const timestampLabel = timestampSec !== undefined
    ? (String(ref.timestampLabel || '').trim() || formatTimestampLabel(timestampSec))
    : (String(ref.timestampLabel || '').trim() || undefined);

  return {
    id: String(ref.id || `canvas-ref-${Date.now()}-${++refSequence}`),
    kind,
    filePath,
    fileName,
    ...(snippet ? { snippet } : {}),
    ...(lineStart !== undefined ? { lineStart } : {}),
    ...(lineEnd !== undefined ? { lineEnd } : {}),
    ...(timestampSec !== undefined ? { timestampSec } : {}),
    ...(timestampLabel ? { timestampLabel } : {}),
    createdAt: Number(ref.createdAt) || Date.now(),
  };
}

/**
 * Add a Canvas Context Reference for a route (deduped, capped at 6 per route).
 * Dispatches `canvas-context-added` on `window`.
 *
 * @param {string} routeKey
 * @param {object} ref
 * @returns {object}
 */
export function addCanvasContextRef(routeKey, ref) {
  const key = normalizeRouteKey(routeKey);
  const list = ensureList(key);
  const normalized = normalizeRef(ref);

  const existing = list.find(item => (
    item.kind === normalized.kind
    && item.filePath === normalized.filePath
    && (item.snippet || '') === (normalized.snippet || '')
    && (item.timestampSec ?? null) === (normalized.timestampSec ?? null)
  ));

  const target = existing || normalized;
  if (!existing) {
    list.push(normalized);
    if (list.length > MAX_REFS_PER_ROUTE) {
      list.splice(0, list.length - MAX_REFS_PER_ROUTE);
    }
  }

  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent('canvas-context-added', {
      detail: { routeKey: key, ref: target },
    }));
  }

  return target;
}

/**
 * Remove a single Canvas Context Reference by id.
 *
 * @param {string} routeKey
 * @param {string} id
 */
export function removeCanvasContextRef(routeKey, id) {
  const list = ensureList(routeKey);
  const idx = list.findIndex(item => item.id === id);
  if (idx >= 0) {
    list.splice(idx, 1);
  }
}

/**
 * Remove only the Canvas Context References whose id is in `ids` for a route,
 * preserving any references added while an async send was in flight.
 *
 * @param {string} routeKey
 * @param {Iterable<string>} ids
 */
export function removeCanvasContextRefsByIds(routeKey, ids) {
  if (!ids) return;
  const idSet = new Set(Array.isArray(ids) ? ids : [...ids]);
  if (idSet.size === 0) return;
  const key = normalizeRouteKey(routeKey);
  const list = contextMap[key];
  if (!Array.isArray(list) || list.length === 0) return;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (idSet.has(list[i]?.id)) {
      list.splice(i, 1);
    }
  }
}

/**
 * Clear all Canvas Context References for a route.
 *
 * @param {string} routeKey
 */
export function clearCanvasContextRefs(routeKey) {
  const list = ensureList(routeKey);
  if (list.length > 0) {
    list.splice(0, list.length);
  }
}

/**
 * Clear all Canvas Context References across every route (e.g. logout / auth reset).
 */
export function clearAllCanvasContextRefs() {
  for (const key of Object.keys(contextMap)) {
    if (Array.isArray(contextMap[key])) {
      contextMap[key].splice(0, contextMap[key].length);
    }
    delete contextMap[key];
  }
}

/**
 * Return the reactive array of Canvas Context References for a route.
 *
 * @param {string} routeKey
 * @returns {Array<object>}
 */
export function getCanvasContextRefs(routeKey) {
  return ensureList(routeKey);
}

function neutralizeSnippetMentions(text) {
  return String(text ?? '').replace(/(^|[\s(])@([A-Za-z0-9_\-\u4e00-\u9fff])/g, '$1@\u200B$2');
}

/**
 * Format Canvas Context References into a clean Markdown quote block prefix
 * prepended to outgoing chat messages.
 *
 * @param {Array<object>} refs
 * @returns {string}
 */
export function formatCanvasContextPrefix(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return '';

  const blocks = [];
  for (const ref of refs) {
    if (!ref) continue;
    const labelPath = ref.filePath || ref.fileName || 'file';
    if (ref.kind === 'image') {
      blocks.push(`> [Canvas Image] \`${labelPath}\``);
      continue;
    }
    if (ref.kind === 'video') {
      const ts = ref.timestampLabel || (ref.timestampSec != null ? formatTimestampLabel(ref.timestampSec) : '');
      const header = ts
        ? `> [Canvas Video] \`${labelPath}\` @ ${ts}`
        : `> [Canvas Video] \`${labelPath}\``;
      if (ref.snippet) {
        const lines = String(ref.snippet)
          .split(/\r?\n/)
          .map(line => `> ${neutralizeSnippetMentions(line)}`);
        blocks.push([header, ...lines].join('\n'));
      } else {
        blocks.push(header);
      }
      continue;
    }
    // Default: 'doc'
    let lineRange = '';
    if (ref.lineStart != null && ref.lineEnd != null && ref.lineEnd !== ref.lineStart) {
      lineRange = ` (L${ref.lineStart}-L${ref.lineEnd})`;
    } else if (ref.lineStart != null) {
      lineRange = ` (L${ref.lineStart})`;
    }
    const header = `> [Canvas Doc] \`${labelPath}\`${lineRange}`;
    if (ref.snippet) {
      const lines = String(ref.snippet)
        .split(/\r?\n/)
        .map(line => `> ${neutralizeSnippetMentions(line)}`);
      blocks.push([header, ...lines].join('\n'));
    } else {
      blocks.push(header);
    }
  }

  return blocks.join('\n\n');
}
