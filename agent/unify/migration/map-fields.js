/**
 * map-fields.js — Pure mapping functions for task-334i migration.
 *
 * Spec: .crew/context/task-334i-migration-spec.md §M2
 *
 * Converts old `~/.yeaft/` markdown frontmatter shapes into the shapes
 * consumed by the 334o storage primitives (JSONL log rows for messages,
 * shard-store entries for memory, JSON for task metadata).
 *
 * All functions here are pure: no fs, no Date.now(), no randomness
 * (the caller supplies IDs + timestamps).
 *
 * Exported:
 *   - parseFrontmatter(raw) → { meta, body }
 *   - mapMessageMdToJsonl({ meta, body, originalId, fallbackTaskId }) → row
 *   - mapMemoryEntry({ meta, body, now }) → { shard, entry }
 *   - mapTaskMeta({ meta, taskId }) → task.json
 *   - splitCoordinatorTurns(raw) → [ { id, role, ts, body } ]
 *   - shardForMemoryKind(kind) → shard name
 *   - LEGACY_GROUP_ID, LEGACY_VP_ID — constants
 */

export const LEGACY_GROUP_ID = 'legacy-main';
export const LEGACY_VP_ID = 'unify-legacy';
export const MIGRATION_AUTHOR = 'system:migration-v0-to-v1';

const MEMORY_SHARD_BY_KIND = {
  skill: 'skill',
  preference: 'preferences',
  relation: 'relations',
  lesson: 'lessons',
};
const MEMORY_DEFAULT_SHARD = 'project-legacy';

/**
 * Parse YAML-ish frontmatter from a markdown string.
 *
 * Input:
 *   ---
 *   key: value
 *   list: [a, b]
 *   ---
 *   body text...
 *
 * Returns { meta: {}, body: string }. On malformed input, returns
 * { meta: null, body: raw }.
 */
export function parseFrontmatter(raw) {
  if (typeof raw !== 'string') return { meta: null, body: '' };
  const trimmed = raw.replace(/^\uFEFF/, '');
  if (!trimmed.startsWith('---')) return { meta: null, body: trimmed };

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx < 0) return { meta: null, body: trimmed };

  const header = trimmed.slice(3, endIdx).replace(/^\r?\n/, '');
  const rest = trimmed.slice(endIdx + 4).replace(/^\r?\n/, '');

  const meta = {};
  for (const lineRaw of header.split('\n')) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    meta[key] = parseScalar(value);
  }
  return { meta, body: rest };
}

function parseScalar(v) {
  if (v === '' || v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  // Array: [a, b, c] or [a,b,c]
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => parseScalar(s.trim()));
  }
  // Quoted string
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  // Numeric (plain integer / float)
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * Translate a legacy conversation message md into the JSONL row shape
 * emitted by 334o jsonl-log.
 *
 * Input: { meta, body, originalId (string used to form id prefix),
 *          fallbackTaskId (nullable) }
 *
 * Output: a plain object ready for jsonl-log.append().
 */
export function mapMessageMdToJsonl({ meta, body, originalId, fallbackTaskId = null }) {
  if (!meta) {
    // Corrupted input — caller decides whether to skip or keep. We still
    // return a minimally-valid row so the migration can continue if it wants.
    return {
      id: `msg_legacy_${originalId}`,
      ts: null,
      type: 'chat',
      authorKind: 'unknown',
      authorId: 'unknown',
      groupId: LEGACY_GROUP_ID,
      taskId: fallbackTaskId,
      body: typeof body === 'string' ? body : '',
      mentions: [],
      replyTo: null,
      viaTool: null,
      _corrupted: true,
    };
  }

  const role = meta.role;
  let type = 'chat';
  let authorKind = 'user';
  let authorId = 'user:self';
  if (role === 'assistant') {
    authorKind = 'vp';
    authorId = LEGACY_VP_ID;
  } else if (role === 'tool') {
    type = 'tool';
    authorKind = 'tool';
    authorId = meta.tool || 'tool:legacy';
  } else if (role && role !== 'user') {
    authorKind = 'unknown';
    authorId = `unknown:${role}`;
  }

  return {
    id: `msg_legacy_${originalId}`,
    ts: meta.time || meta.ts || null,
    type,
    authorKind,
    authorId,
    groupId: LEGACY_GROUP_ID,
    taskId: fallbackTaskId,
    body: typeof body === 'string' ? body : '',
    mentions: [],
    replyTo: null,
    viaTool: null,
  };
}

/**
 * Route a legacy memory entry to the correct shard filename.
 */
export function shardForMemoryKind(kind) {
  if (!kind) return MEMORY_DEFAULT_SHARD;
  return MEMORY_SHARD_BY_KIND[kind] || MEMORY_DEFAULT_SHARD;
}

/**
 * Translate a legacy memory entry md into a shard-store entry.
 *
 * Input: { meta, body, now (iso string used for authoredAt/migration ts),
 *          id (pre-generated) }
 *
 * Output: { shard, entry } ready for shardStore.put().
 *         entry.body is a serialised frontmatter + body string (the
 *         shard-store keeps opaque text between START/END markers, so we
 *         pre-serialise the new YAML here).
 */
export function mapMemoryEntry({ meta, body, id, now }) {
  if (!meta) return null;
  const kind = meta.kind || 'fact';
  const shard = shardForMemoryKind(kind);
  const tags = Array.isArray(meta.tags) ? meta.tags.slice() : [];
  const pinned = meta.importance === 'high';
  const createdAt = meta.created_at || now;
  const updatedAt = meta.updated_at || createdAt;

  const entryMeta = {
    id,
    kind,
    tags,
    pinned,
    sourceRef: {
      groupId: LEGACY_GROUP_ID,
      taskId: null,
      msgIds: [],
      timeWindow: [createdAt, updatedAt],
      hint: `migrated from v0 memory/entries/${meta.name || 'unknown'}.md`,
    },
    authoredBy: MIGRATION_AUTHOR,
    createdAt,
    updatedAt,
    supersedes: null,
    supersededBy: null,
  };

  const serialisedBody = serialiseEntryBody(entryMeta, body);

  return {
    shard,
    entry: {
      id,
      shard,
      body: serialisedBody,
      meta: {
        kind,
        tags,
        pinned,
      },
    },
  };
}

function serialiseEntryBody(meta, body) {
  const lines = ['---'];
  lines.push(`id: ${meta.id}`);
  lines.push(`kind: ${meta.kind}`);
  lines.push(`tags: [${meta.tags.map((t) => JSON.stringify(t)).join(', ')}]`);
  lines.push(`pinned: ${meta.pinned}`);
  lines.push(`authoredBy: ${JSON.stringify(meta.authoredBy)}`);
  lines.push(`createdAt: ${JSON.stringify(meta.createdAt)}`);
  lines.push(`updatedAt: ${JSON.stringify(meta.updatedAt)}`);
  lines.push('sourceRef:');
  lines.push(`  groupId: ${meta.sourceRef.groupId}`);
  lines.push(`  taskId: ${meta.sourceRef.taskId ?? 'null'}`);
  lines.push(`  msgIds: []`);
  lines.push(`  timeWindow: [${JSON.stringify(meta.sourceRef.timeWindow[0])}, ${JSON.stringify(meta.sourceRef.timeWindow[1])}]`);
  lines.push(`  hint: ${JSON.stringify(meta.sourceRef.hint)}`);
  lines.push(`supersedes: null`);
  lines.push(`supersededBy: null`);
  lines.push('---');
  lines.push('');
  lines.push(typeof body === 'string' ? body.trim() : '');
  return lines.join('\n');
}

/**
 * Map a legacy task meta.md (YAML frontmatter) into a task.json payload.
 */
export function mapTaskMeta({ meta, taskId }) {
  const m = meta || {};
  return {
    id: taskId,
    groupId: LEGACY_GROUP_ID,
    initiatorVpId: LEGACY_VP_ID,
    members: [LEGACY_VP_ID],
    relatedTaskIds: [],
    status: m.status || 'archived',
    description: m.description || '',
    createdAt: m.created_at || null,
    updatedAt: m.updated_at || m.created_at || null,
    _legacy: true,
  };
}

/**
 * Split a coordinator.md file into turns.
 *
 * Rule (spec §M2.3): break on markdown H2 `## ` headings. Each turn becomes
 * one row. Turns with a heading in the form `## <role> @ <ts>` have role/ts
 * extracted; otherwise role='system', ts=null.
 *
 * Returns an array of { index, role, ts, body } — caller turns them into
 * full JSONL rows (adding id etc).
 */
export function splitCoordinatorTurns(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const lines = raw.split('\n');
  const turns = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) turns.push(current);
      const header = line.slice(3).trim();
      const atIdx = header.lastIndexOf(' @ ');
      let role = header;
      let ts = null;
      if (atIdx > 0) {
        role = header.slice(0, atIdx).trim();
        ts = header.slice(atIdx + 3).trim() || null;
      }
      current = { index: turns.length, role: role || 'system', ts, body: '' };
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line;
    }
  }
  if (current) turns.push(current);
  // Trim trailing blank lines in bodies.
  for (const t of turns) t.body = t.body.replace(/\n+$/, '');
  return turns;
}
