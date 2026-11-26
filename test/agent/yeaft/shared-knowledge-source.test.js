import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS, openDiscoveryStore } from '../../../agent/yeaft/session-discovery/store.js';
import { runDailySharedKnowledge } from '../../../agent/yeaft/shared-knowledge/flow.js';
import { openKnowledgeSourceWorker } from '../../../agent/yeaft/shared-knowledge/scheduler.js';
import { listDigestSessions, readDigestSource } from '../../../agent/yeaft/shared-knowledge/source.js';
import { claimKnowledgeJob, commitKnowledgeBatch, openKnowledgeWriter, readKnowledgeWatermark } from '../../../agent/yeaft/shared-knowledge/store.js';

const createdAt = '2025-01-01T00:00:00.000Z';
const options = { bootstrapSince: 100, cutoff: 200 };
const msg = (seq, role, ts, extra) => ({ id: `m${seq}`, seq, role, ts, sessionId: 's', content: `${role} ${seq}`, ...extra });
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');

describe('daily shared knowledge digest source', () => {
  let root, dir, conversation, segments, first;
  const read = extra => readDigestSource(root, 's', { ...options, ...extra });
  function putMeta(id, extra = {}) {
    mkdirSync(join(root, 'sessions', id), { recursive: true });
    writeFileSync(join(root, 'sessions', id, 'session.json'), JSON.stringify({ id, createdAt, workDir: 'workspace', ...extra }));
  }
  function manifest(...ids) {
    writeFileSync(join(root, 'sessions-manifest.json'), JSON.stringify({ version: 1, sessions: ids.map(id => ({ id, path: join(root, 'sessions', id), createdAt })) }));
  }
  const lineage = (path, streamId) => writeFileSync(join(path, 'lineage.json'), JSON.stringify({ streamId }));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'digest-source-'));
    dir = join(root, 'sessions', 's');
    conversation = join(dir, 'conversation');
    segments = join(conversation, 'segments');
    first = join(segments, '000001.jsonl');
    mkdirSync(segments, { recursive: true });
    putMeta('s');
    manifest('s');
    lineage(conversation, 'stream');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('lists local manifest IDs without card eligibility, and rejects task, archived and unlisted Sessions', () => {
    putMeta('task', { task: { enabled: false } });
    putMeta('unlisted');
    putMeta('archived');
    renameSync(join(root, 'sessions', 'archived'), join(root, 'sessions', '.archived-archived'));
    manifest('s', 'task', 'archived');
    expect(listDigestSessions(root)).toEqual(['s', 'task']);
    for (const id of ['task', 'archived', 'unlisted', '../outside']) expect(readDigestSource(root, id, options)).toBeNull();
    expect(read()).toMatchObject({ messages: [], lastSeq: -1, workDir: 'workspace' });
  });

  it('supplies standalone user text, never advances on ignored rows, and reads a later final response', () => {
    writeFileSync(first, jsonl([
      msg(0, 'user', 99), msg(1, 'user', 100, { content: 'Use UTC.' }),
      msg(2, 'assistant', 110, { responseKind: 'progress', turnId: 'one' }),
      msg(3, 'tool', 150), msg(4, 'user', 151, { userAuthored: false }),
    ]));
    const before = read();
    expect(before).toMatchObject({ lastSeq: 1, messages: [{ seq: 1, role: 'user', messageId: 'm1', createdAt: 100, text: 'Use UTC.' }] });
    appendFileSync(first, jsonl([msg(5, 'assistant', 200, { responseKind: 'result', turnId: 'one', content: [{ type: 'text', text: 'Final' }, { type: 'toolCall', text: 'Hidden' }] })]));
    const after = read({ watermark: before });
    expect(after).toMatchObject({ lastSeq: 5, messages: [{ seq: 5, role: 'assistant', messageId: 'm5', createdAt: 200, text: 'Final' }] });
    expect(read({ watermark: after })).toMatchObject({ lastSeq: 5, messages: [] });
  });

  it('finds an in-place finalization below the cursor even with a fresh segment index', () => {
    const progress = msg(2, 'assistant', 150, { responseKind: 'progress', stopReason: 'end_turn' });
    writeFileSync(first, jsonl([msg(1, 'user', 100), progress]));
    writeFileSync(join(segments, '000002.jsonl'), jsonl([msg(3, 'user', 160)]));
    const before = read();
    expect(before.lastSeq).toBe(3);
    expect(before.messages.map(m => m.seq)).toEqual([1, 3]);

    const finalized = jsonl([msg(1, 'user', 100), { ...progress, responseKind: 'result' }]);
    writeFileSync(first, finalized);
    writeFileSync(join(conversation, 'index.json'), JSON.stringify({ version: 2, streamId: 'stream', segments: [
      { file: '000001.jsonl', firstSeq: 1, lastSeq: 2, count: 2, bytes: Buffer.byteLength(finalized) },
    ] }));
    const after = read({ watermark: before });
    expect(after.messages.map(m => m.seq)).toEqual([2]);
    expect(after).toMatchObject({ lastSeq: 3, pendingSeqs: [] });
    expect(before.pendingSeqs).toEqual([2]);
    expect(read({ watermark: after })).toMatchObject({ lastSeq: 3, pendingSeqs: [], messages: [] });
  });

  it('tracks only visible potentially-final progress within the time window', () => {
    const progress = (seq, ts, extra) => msg(seq, 'assistant', ts, { responseKind: 'progress', ...extra });
    const rows = [
      progress(1, 99, { stopReason: 'end_turn' }),
      progress(2, 100, { stopReason: 'stop_sequence' }),
      progress(3, 200),
      progress(4, 150, { stopReason: 'tool_use' }),
      progress(5, 150, { stopReason: 'error' }),
      progress(6, 150, { stopReason: 'end_turn', incomplete: true }),
      progress(7, 150, { stopReason: 'end_turn', internal: true }),
      progress(8, 150, { toolCalls: [{ id: 'tool' }] }),
      progress(9, 201, { stopReason: 'end_turn' }),
      msg(10, 'user', 199),
    ];
    writeFileSync(first, jsonl(rows));
    const before = read();
    expect(before).toMatchObject({ lastSeq: -1, messages: [], pendingSeqs: [2, 3] });
    rows[8].responseKind = 'result';
    writeFileSync(first, jsonl(rows));
    expect(read({ watermark: before, cutoff: 201 })).toMatchObject({ lastSeq: 10, pendingSeqs: [2, 3], messages: [{ seq: 9 }, { seq: 10 }] });
  });

  it('fails the scan rather than dropping pending rows when the tracking bound is exceeded', () => {
    writeFileSync(first, jsonl(Array.from({ length: 16_385 }, (_, seq) =>
      msg(seq, 'assistant', 150, { responseKind: 'progress' }))));
    expect(() => read()).toThrow(/Too many digest pending sequences/);
  });

  it('does not bypass bootstrap filtering when the first scan only saved pending rows', () => {
    const progress = msg(2, 'assistant', 150, { responseKind: 'progress', stopReason: 'end_turn' });
    writeFileSync(first, jsonl([progress]));
    const before = read();
    writeFileSync(first, jsonl([msg(1, 'user', 99), { ...progress, responseKind: 'result' }]));
    expect(read({ watermark: before })).toMatchObject({ lastSeq: 2, pendingSeqs: [], messages: [{ seq: 2 }] });
  });

  it('keeps the original five-day floor after a partial first run and in later slots', async () => {
    const at = 6 * DAY_MS;
    const floor = at - 5 * DAY_MS;
    const wide = '字'.repeat(4_100);
    writeFileSync(first, jsonl([
      msg(1, 'user', floor, { content: wide }),
      msg(2, 'user', at - 1, { content: wide }),
      msg(3, 'user', floor - 1, { content: 'out-of-window history' }),
      msg(4, 'user', at - 2, { content: wide }),
    ]));
    const run = (slot, cutoff, onExtract) => runDailySharedKnowledge({
      slot, cutoff, clock: () => cutoff,
      openSource: signal => openKnowledgeSourceWorker(root, signal),
      openModel: async () => ({ config: { primaryModel: 'fake' }, adapter: {
        call: async ({ messages }) => ({ text: onExtract(JSON.parse(messages[0].content).messages.map(row => row.seq)) }),
      } }),
    });
    const attempts = [];
    expect(await run(20260101, at, seqs => {
      attempts.push(seqs);
      return attempts.length === 1 ? '{"items":[]}' : '{"items":null}';
    })).toMatchObject({ status: 'partial', messages: 2, failedSessions: 1 });
    expect(attempts).toEqual([[1, 2], [4]]);
    const db = openKnowledgeWriter(root);
    try { expect(readKnowledgeWatermark(db, 's').lastSeq).toBe(2); } finally { db.close(); }

    const retried = [];
    const collect = seqs => { retried.push(seqs); return '{"items":[]}'; };
    expect(await run(20260101, at, collect)).toMatchObject({ status: 'empty', messages: 1 });
    appendFileSync(first, jsonl([msg(5, 'user', floor - 1), msg(6, 'user', floor)]));
    expect(await run(20260102, at + DAY_MS, collect)).toMatchObject({ status: 'empty', messages: 1 });
    expect(retried).toEqual([[4], [6]]);
  });

  it('upgrades ef924de20 watermarks in place without replaying preexisting holes', () => {
    writeFileSync(first, jsonl([msg(1, 'user', 100), msg(2, 'assistant', 120, { responseKind: 'result' }),
      msg(3, 'user', 140), msg(4, 'assistant', 150, { responseKind: 'progress' }), msg(5, 'user', 160)]));
    const { identity, generation } = read();
    const legacy = openDiscoveryStore(root);
    try {
      legacy.exec(`
        CREATE TABLE knowledge_job (
          id INTEGER PRIMARY KEY CHECK (id = 1), bootstrap_since INTEGER NOT NULL,
          completed_slot INTEGER, lease TEXT, lease_until INTEGER
        );
        CREATE TABLE knowledge_watermarks (
          session_id TEXT PRIMARY KEY, identity TEXT NOT NULL, generation TEXT NOT NULL, seq INTEGER NOT NULL
        );
        INSERT INTO knowledge_job(id, bootstrap_since, completed_slot) VALUES (1, 100, 1);
      `);
      legacy.prepare('INSERT INTO knowledge_watermarks VALUES (?, ?, ?, ?)').run('s', identity, generation, 3);
    } finally { legacy.close(); }

    const upgraded = openKnowledgeWriter(root);
    try {
      const watermark = readKnowledgeWatermark(upgraded, 's');
      expect(watermark).toEqual({ identity, generation, lastSeq: 3, pendingSeqs: [] });
      const job = { slot: 1, now: 1, bootstrapSince: 110, leaseMs: 100 };
      expect(claimKnowledgeJob(upgraded, job)).toEqual({ status: 'done' });
      const claim = claimKnowledgeJob(upgraded, { ...job, slot: 2 });
      expect(claim).toMatchObject({ status: 'claimed', bootstrapSince: 100 });
      const next = read({ watermark });
      expect(next).toMatchObject({ messages: [{ seq: 5 }], pendingSeqs: [4], lastSeq: 5 });
      expect(commitKnowledgeBatch(upgraded, { root, lease: claim.lease, actions: [], watermarks: [next], now: 1 })).toBe(true);
    } finally { upgraded.close(); }
    const reopened = openKnowledgeWriter(root);
    try {
      expect(readKnowledgeWatermark(reopened, 's')).toEqual({ identity, generation, lastSeq: 5, pendingSeqs: [4] });
    } finally { reopened.close(); }
  });

  it('persists pending-only first scans and drops deleted pending rows without advancing', () => {
    writeFileSync(first, jsonl([msg(2, 'assistant', 150, { responseKind: 'progress', stopReason: 'end_turn' })]));
    const before = read();
    expect(before).toMatchObject({ lastSeq: -1, pendingSeqs: [2], messages: [] });
    expect(() => read({ watermark: { ...before, pendingSeqs: Array(16_385).fill(2) } })).toThrow(/Too many digest pending sequences/);
    const db = openKnowledgeWriter(root);
    try {
      expect(readKnowledgeWatermark(db, 's')).toBeNull();
      const { lease } = claimKnowledgeJob(db, { slot: 1, now: 1, leaseMs: 100, bootstrapSince: 100 });
      expect(commitKnowledgeBatch(db, { root, lease, actions: [], watermarks: [before], now: 1 })).toBe(true);
    } finally { db.close(); }
    const reopened = openKnowledgeWriter(root);
    try {
      const watermark = readKnowledgeWatermark(reopened, 's');
      expect(watermark).toEqual({ identity: before.identity, generation: before.generation, lastSeq: -1, pendingSeqs: [2] });
      writeFileSync(join(conversation, 'deleted-turns.jsonl'), jsonl([{
        version: 1, sessionId: 's', turnId: 't', deletionId: 'deleted', messageIds: ['m2'],
        anchorMessageIds: [], clientMessageIds: [], executionIds: [], referenceIds: [],
      }]));
      const after = read({ watermark });
      expect(after.generation).not.toBe(before.generation);
      expect(after).toMatchObject({ identity: before.identity, lastSeq: -1, pendingSeqs: [], messages: [] });
    } finally { reopened.close(); }
  });

  it('does not advance past a future message even when a subsequent row has an earlier timestamp', () => {
    writeFileSync(first, jsonl([msg(1, 'user', 100), msg(2, 'assistant', 201, { responseKind: 'result' }), msg(3, 'user', 150)]));
    const before = read();
    expect(before.messages.map(m => m.seq)).toEqual([1]);
    expect(read({ watermark: before, cutoff: 201 }).messages.map(m => m.seq)).toEqual([2, 3]);
  });

  it('scrubs deleted turns without resetting the cursor; replacement lineage bootstraps again', () => {
    writeFileSync(first, jsonl([msg(1, 'user', 150), msg(2, 'user', 150)]));
    const before = read();
    appendFileSync(first, jsonl([msg(3, 'assistant', 90), msg(4, 'user', 150)]));
    writeFileSync(join(conversation, 'deleted-turns.jsonl'), jsonl([{
      version: 1, sessionId: 's', turnId: 't', deletionId: 'deleted', messageIds: ['m4'],
      anchorMessageIds: [], clientMessageIds: [], executionIds: [], referenceIds: [],
    }]));
    const after = read({ watermark: before });
    expect(after.identity).toBe(before.identity);
    expect(after.generation).not.toBe(before.generation);
    expect(after.messages).toEqual([]);
    expect(after.lastSeq).toBe(3);
    lineage(conversation, 'new-stream');
    const replacement = read({ watermark: after });
    expect(replacement.identity).not.toBe(after.identity);
    expect(replacement.messages.map(m => m.seq)).toEqual([1, 2]);
  });

  it('reads legacy markdown and gives existing segment content precedence', () => {
    const legacy = join(conversation, 'cold');
    mkdirSync(legacy);
    for (const id of ['m1', 'm2']) writeFileSync(join(legacy, `${id}.md`), `---\nid: ${id}\nrole: user\ntime: 1970-01-01T00:00:00.150Z\n---\nLegacy text\n`);
    // Old imports may retain their original numeric seq under a rewritten ID.
    writeFileSync(first, jsonl([msg(2, 'user', 150, { seq: 9001 })]));
    expect(read().messages.map(m => m.text)).toEqual(['Legacy text', 'user 2']);
  });

  it('excludes inherited origins without blocking local rows or exposing their legacy duplicates', () => {
    const legacy = join(conversation, 'cold');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'm1.md'), '---\nid: m1\nrole: user\ntime: 1970-01-01T00:00:00.150Z\n---\nLegacy duplicate\n');
    writeFileSync(first, jsonl([
      msg(1, 'user', 150, { origin: { sessionId: 'other', streamId: 'stream', messageId: 'm9' } }),
      msg(2, 'assistant', 201, { origin: { sessionId: 's', streamId: 'old-stream', messageId: 'm2' } }),
      msg(3, 'user', 150, { origin: { sessionId: 's', streamId: 'stream', messageId: 'm3' } }),
      msg(4, 'user', 150),
      msg(5, 'assistant', 150, { origin: { sessionId: 's' } }),
    ]));
    const before = read();
    expect(before.messages.map(m => m.seq)).toEqual([3, 4]);
    expect(before.lastSeq).toBe(4);
    expect(read({ watermark: before, cutoff: 201 })).toMatchObject({ messages: [], lastSeq: 4 });
  });

  it('throws on incomplete JSONL, an unreadable manifest and cancellation', () => {
    writeFileSync(first, jsonl([msg(1, 'user', 150)]) + '{');
    expect(() => read()).toThrow(/Incomplete digest segment/);
    const signal = AbortSignal.abort();
    expect(() => read({ signal })).toThrow(/abort/i);
    expect(() => listDigestSessions(root, { signal })).toThrow(/abort/i);
    writeFileSync(join(root, 'sessions-manifest.json'), '{}');
    expect(() => listDigestSessions(root)).toThrow(/manifest/i);
  });

  it('skips verified old segments but fails closed if required bytes exceed the scan budget', () => {
    const oldSize = 9 * 1024 * 1024;
    writeFileSync(first, Buffer.alloc(oldSize)); // Oversized; readable only via a proven sequence exclusion.
    writeFileSync(join(conversation, 'index.json'), JSON.stringify({ version: 2, streamId: 'stream', segments: [
      { file: '000001.jsonl', firstSeq: 1, lastSeq: 10, count: 10, bytes: oldSize },
    ] }));
    writeFileSync(join(segments, '000002.jsonl'), jsonl([msg(11, 'user', 150)]));
    expect(() => read()).toThrow(/Incomplete digest source scan/);
    const watermark = { generation: 'old', identity: JSON.stringify([createdAt, 'stream']), lastSeq: 10 };
    expect(read({ watermark }).messages.map(m => m.seq)).toEqual([11]);
    expect(() => read({ watermark: { ...watermark, pendingSeqs: [2] } })).toThrow(/Incomplete digest source scan/);
    appendFileSync(first, jsonl([msg(12, 'user', 150)]));
    expect(() => read({ watermark })).toThrow(/Incomplete digest source scan/);
  });
});
