/**
 * memory/segment.js — DESIGN-H2-AMS §1.
 *
 * A Memory Segment is Dream LLM's secondary processing of raw messages:
 * a self-contained semantic chunk (one segment per topic). NOT a copy
 * of messages — messages already live in conversation/messages/.
 *
 * Physical layout: each scope's `memory.md` is multiple segments
 * concatenated, each with a YAML frontmatter block and a body.
 *
 *   ---
 *   id: seg_<8hex>
 *   scope: feature/auth
 *   kind: decision        # fact|preference|decision|lesson|relation|goal|context
 *   tags: [auth, jwt]
 *   sourceMessages: [m_142, m_143]
 *   createdAt: 2026-04-29T10:11:12Z
 *   updatedAt: 2026-04-29T10:11:12Z
 *   ---
 *   <body — natural language, multi-sentence, detail preserved>
 *
 * Robustness rules:
 *   - Frontmatter is OPTIONAL. Body-only blocks (no `---`) are treated
 *     as one anonymous segment; missing fields are filled with defaults.
 *   - Partial frontmatter is OK: only `id` is auto-computed when
 *     absent; `kind` defaults to "context"; tags/sourceMessages default
 *     to []; timestamps default to now.
 *   - `scope` may be absent in frontmatter — the parser falls back to
 *     the caller-supplied `defaultScope` (typically derived from the
 *     memory.md file path).
 *
 * Round-trip: serializeSegments → parseSegments yields equivalent
 * segments (modulo whitespace).
 */

import { createHash } from 'node:crypto';

/**
 * @typedef {object} Segment
 * @property {string}   id              seg_<8hex>
 * @property {string}   scope
 * @property {string}   kind
 * @property {string[]} tags
 * @property {string[]} sourceMessages
 * @property {string}   createdAt
 * @property {string}   updatedAt
 * @property {string}   body
 */

export const KIND_VALUES = new Set([
  'fact', 'preference', 'decision', 'lesson', 'relation', 'goal', 'context',
]);

const SCOPE_RE = /^(user|chat\/[\w-]+(?:\/vp\/[\w-]+)?|session\/[\w-]+(?:\/(?:user|vp\/[\w-]+|topic\/[\w-]+(?:\/[\w-]+)?))?)$/;

/**
 * Compute a stable id from segment content. Same body + scope + kind →
 * same id, even across rewrites of unchanged content.
 *
 * @param {{ scope: string, kind: string, body: string }} parts
 * @returns {string}
 */
export function computeSegmentId({ scope, kind, body }) {
  const h = createHash('sha256')
    .update(`${scope}\0${kind}\0${body.trim()}`)
    .digest('hex')
    .slice(0, 8);
  return `seg_${h}`;
}

/**
 * Validate + normalize raw segment data. Throws only on truly missing
 * essentials (scope + body). Everything else gets a default.
 *
 * @param {Partial<Segment>} raw
 * @returns {Segment}
 */
export function makeSegment(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('makeSegment: object required');
  }
  const scope = String(raw.scope || '').trim();
  if (!SCOPE_RE.test(scope)) {
    throw new Error(`makeSegment: invalid or missing scope "${scope}"`);
  }
  const body = String(raw.body || '').trim();
  if (!body) throw new Error('makeSegment: body required');

  let kind = String(raw.kind || 'context').trim();
  if (!KIND_VALUES.has(kind)) kind = 'context';

  const tags = Array.isArray(raw.tags)
    ? raw.tags.map(t => String(t).trim()).filter(Boolean)
    : [];
  const sourceMessages = Array.isArray(raw.sourceMessages)
    ? raw.sourceMessages.map(t => String(t).trim()).filter(Boolean)
    : [];

  const now = new Date().toISOString();
  const createdAt = raw.createdAt || now;
  const updatedAt = raw.updatedAt || createdAt;
  const id = raw.id || computeSegmentId({ scope, kind, body });

  return { id, scope, kind, tags, sourceMessages, createdAt, updatedAt, body };
}

/**
 * Parse a memory.md text into segments. Tolerant by design:
 *   - Empty / whitespace input → [].
 *   - Body-only (no frontmatter) → one anonymous segment using
 *     `defaultScope`.
 *   - Multi-block input → split on `---` boundaries; each block may
 *     have full, partial, or no frontmatter.
 *
 * Blocks that would fail validation (e.g. no scope and no defaultScope)
 * are silently dropped — the writer can always re-emit canonical form.
 *
 * @param {string} text
 * @param {{ defaultScope?: string }} [opts]
 * @returns {Segment[]}
 */
export function parseSegments(text, opts = {}) {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.replace(/^﻿/, '').trim();
  if (!trimmed) return [];
  const defaultScope = opts.defaultScope || '';

  // Case 1: no `---` at all → single anonymous block.
  if (!/^---\s*$/m.test(trimmed)) {
    return tryMake({ body: trimmed }, defaultScope);
  }

  // Case 2: split into blocks. A block starts at a line that is exactly
  // `---`, optionally preceded by blank line(s). We walk line-by-line.
  const lines = trimmed.split('\n');
  const blocks = [];
  let i = 0;
  // Skip leading blanks
  while (i < lines.length && !lines[i].trim()) i += 1;
  // If the first non-blank line is not `---`, treat the prefix up to
  // the first `---` as a body-only segment.
  if (lines[i] !== undefined && lines[i].trim() !== '---') {
    const start = i;
    while (i < lines.length && lines[i].trim() !== '---') i += 1;
    const prefix = lines.slice(start, i).join('\n').trim();
    if (prefix) blocks.push({ frontmatter: '', body: prefix });
  }
  // Now i points at `---` or end. Each iteration: `---` ... `---` ... body
  while (i < lines.length) {
    if (lines[i].trim() !== '---') { i += 1; continue; }
    // Found opening `---`. Find closing `---`.
    const fmStart = i + 1;
    let j = fmStart;
    while (j < lines.length && lines[j].trim() !== '---') j += 1;
    if (j >= lines.length) {
      // Unterminated frontmatter — treat the rest as body.
      const body = lines.slice(fmStart).join('\n').trim();
      if (body) blocks.push({ frontmatter: '', body });
      break;
    }
    const fm = lines.slice(fmStart, j).join('\n');
    // Body runs from j+1 until the next `---` line (or end).
    let k = j + 1;
    while (k < lines.length && lines[k].trim() !== '---') k += 1;
    const body = lines.slice(j + 1, k).join('\n').trim();
    blocks.push({ frontmatter: fm, body });
    i = k;
  }

  const out = [];
  for (const blk of blocks) {
    if (!blk.body) continue;
    const fm = blk.frontmatter ? parseFrontmatter(blk.frontmatter) : {};
    out.push(...tryMake({ ...fm, body: blk.body }, defaultScope));
  }
  return out;
}

function tryMake(raw, defaultScope) {
  const scope = raw.scope || defaultScope;
  if (!scope) return [];
  try {
    return [makeSegment({ ...raw, scope })];
  } catch {
    return [];
  }
}

/**
 * Serialize a list of segments back to memory.md text. Round-trips with
 * parseSegments.
 *
 * @param {Segment[]} segments
 * @returns {string}
 */
export function serializeSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  return segments.map(serializeOne).join('\n\n') + '\n';
}

function serializeOne(seg) {
  const fm = [
    `id: ${seg.id}`,
    `scope: ${seg.scope}`,
    `kind: ${seg.kind}`,
    `tags: [${seg.tags.map(yamlInlineString).join(', ')}]`,
    `sourceMessages: [${seg.sourceMessages.map(yamlInlineString).join(', ')}]`,
    `createdAt: ${seg.createdAt}`,
    `updatedAt: ${seg.updatedAt}`,
  ].join('\n');
  return `---\n${fm}\n---\n${seg.body}`;
}

function yamlInlineString(s) {
  if (/^[\w./-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

/**
 * Tiny YAML-frontmatter parser sized for our schema. Handles:
 *   key: value
 *   key: [a, b, "c d"]
 *   key: 2026-04-29T10:11:12Z   (returned as raw string)
 * Unknown lines are ignored.
 *
 * @param {string} text
 * @returns {Record<string, any>}
 */
function parseFrontmatter(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_]\w*):\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = parseYamlScalarOrArray(m[2].trim());
  }
  return out;
}

function parseYamlScalarOrArray(raw) {
  if (!raw) return '';
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevelCommas(inner).map(stripYamlString);
  }
  return stripYamlString(raw);
}

function splitTopLevelCommas(s) {
  const parts = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== '\\') inStr = !inStr;
    if (c === ',' && !inStr) { parts.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function stripYamlString(s) {
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  return s;
}
