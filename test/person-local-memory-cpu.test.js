import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalPersonMemory } from '../agent/yeaft/person/local-memory.js';

// Explicit opt-in: first run downloads the pinned q8 model (no private data).
// YEAFT_CPU_RECALL_SMOKE=1 npm run test:focus -- test/person-local-memory-cpu.test.js
// YEAFT_CPU_RECALL_SMOKE_DIR can preserve an instance-local model cache between runs.
it.skipIf(process.env.YEAFT_CPU_RECALL_SMOKE !== '1')('real pinned CPU model: cross-language semantic retrieval and cached offline restart', async () => {
  const ownDir = !process.env.YEAFT_CPU_RECALL_SMOKE_DIR;
  const dir = process.env.YEAFT_CPU_RECALL_SMOKE_DIR || await mkdtemp(path.join(tmpdir(), 'person-real-cpu-'));
  const records = [
    { id: 'vehicle', revision: 1, text: 'The automobile needs maintenance because its engine is broken.' },
    { id: 'fruit', revision: 1, text: 'Fresh oranges and apples make a delicious fruit salad.' },
    { id: 'database', revision: 1, text: 'PostgreSQL backups protect the database against data loss.' },
  ];
  const repository = {
    async searchChanges(owner, { after }) {
      const items = records.map((record, i) => ({ seq: i + 1, kind: 'messages', id: record.id, revision: 1, record })).filter(item => item.seq > after);
      return { items, lastSeq: 3, hasMore: false };
    },
    async resolveMemories(owner, kind, refs) { return refs.map(ref => records.find(record => record.id === ref.id && record.revision === ref.revision)).filter(Boolean); },
    async recall() { return { items: [], nextCursor: null }; },
  };
  let memory;
  try {
    memory = new LocalPersonMemory({ repository, yeaftDir: dir, namespace: 'cpu-smoke', timeoutMs: 300000 });
    const online = await memory.recall('smoke', { query: '汽车发动机坏了，需要修理', limit: 1 });
    expect(online.retrieval).toMatchObject({ mode: 'hybrid', semantic: true, degraded: false });
    expect(online.items[0].id).toBe('vehicle');
    await memory.close();
    memory = new LocalPersonMemory({ repository, yeaftDir: dir, namespace: 'cpu-smoke', embedding: { allowDownload: false }, timeoutMs: 120000 });
    const offline = await memory.recall('smoke', { query: '如何防止数据库丢失数据', limit: 1 });
    expect(offline.retrieval).toMatchObject({ semantic: true, degraded: false });
    expect(offline.items[0].id).toBe('database');
  } finally {
    await memory?.close();
    if (ownDir) await rm(dir, { recursive: true, force: true });
  }
}, 420000);
