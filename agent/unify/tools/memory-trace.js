/**
 * memory-trace.js — task-334f R6 §Δ24.3.
 *
 * Given a memory id, return the full entry (including sourceRef) plus the
 * original source messages referenced by sourceRef.msgIds / timeWindow.
 *
 * Hard guardrails (task-334f):
 *   - Results are returned to the current turn ONLY. Nothing is written back
 *     to memory; the extraction lane sees its own copy.
 *   - Does not do cross-group fan-out. A trace is anchored to one groupId.
 */

import { defineTool } from './types.js';

const MAX_BYTES = 64 * 1024;

export default defineTool({
  name: 'memory_trace',
  description: `Trace a memory entry back to its original source messages.

Use this when a recalled memory body is insufficient and you need the raw
discussion. Returns the full memory entry (with sourceRef) plus the source
messages from the group jsonl log.

Parameters:
  - memId (required): the memory id (from recall)
  - expand: "full" (default, exact msgIds) | "window" (expand around timeWindow)

Returns JSON: { memory, messages[], truncated? }.
The result is NOT written back to memory — it is context for the current turn
only.`,
  parameters: {
    type: 'object',
    properties: {
      memId:  { type: 'string', description: 'Memory entry id' },
      expand: { type: 'string', enum: ['full', 'window'], default: 'full' },
    },
    required: ['memId'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const memId = input?.memId;
    if (!memId || typeof memId !== 'string') {
      return JSON.stringify({ error: 'memId required (string)' });
    }
    const expand = input?.expand === 'window' ? 'window' : 'full';

    const store = ctx?.memoryShardStore;
    if (!store) {
      return JSON.stringify({ error: 'R6 memory shard store not initialised' });
    }
    const entry = store.get(memId);
    if (!entry) {
      return JSON.stringify({ error: `memory entry not found: ${memId}` });
    }

    const sourceRef = entry.sourceRef || null;
    if (!sourceRef) {
      return JSON.stringify({
        memory: entry,
        messages: [],
        note: 'entry has no sourceRef (pure declaration)',
      });
    }

    const coordinator = ctx?.coordinator;
    const groupId = sourceRef.groupId;
    if (!coordinator || !groupId) {
      return JSON.stringify({
        memory: entry,
        messages: [],
        note: 'no group coordinator available',
      });
    }

    const group = typeof coordinator.openGroup === 'function'
      ? coordinator.openGroup(groupId)
      : null;
    if (!group) {
      return JSON.stringify({
        memory: entry,
        messages: [],
        note: `group ${groupId} not resolvable`,
      });
    }

    const messages = [];
    let bytes = 0;
    let truncated = false;

    if (expand === 'full' && Array.isArray(sourceRef.msgIds) && sourceRef.msgIds.length) {
      const targetSet = new Set(sourceRef.msgIds);
      // Walk only the smallest overlapping range instead of streaming all.
      const first = sourceRef.msgIds[0];
      const last  = sourceRef.msgIds[sourceRef.msgIds.length - 1];
      const iter = typeof group.readMessageRange === 'function'
        ? group.readMessageRange(first, last)
        : group.streamMessages();
      for (const msg of iter) {
        if (!targetSet.has(msg.id)) continue;
        const chunk = estimateBytes(msg);
        if (bytes + chunk > MAX_BYTES) { truncated = true; break; }
        messages.push(msg);
        bytes += chunk;
      }
    } else if (expand === 'window' && sourceRef.timeWindow) {
      // timeWindow is "ISO..ISO"; best-effort textual compare works for ULIDs/ISO.
      const [t0, t1] = String(sourceRef.timeWindow).split('..');
      for (const msg of group.streamMessages()) {
        const ts = msg.ts || '';
        if (t0 && ts < t0) continue;
        if (t1 && ts > t1) break;
        const chunk = estimateBytes(msg);
        if (bytes + chunk > MAX_BYTES) { truncated = true; break; }
        messages.push(msg);
        bytes += chunk;
      }
    }

    return JSON.stringify({
      memory: entry,
      messages,
      ...(truncated ? { truncated: true } : {}),
    });
  },
});

function estimateBytes(msg) {
  try {
    return Buffer.byteLength(JSON.stringify(msg), 'utf8');
  } catch {
    return 512;
  }
}
