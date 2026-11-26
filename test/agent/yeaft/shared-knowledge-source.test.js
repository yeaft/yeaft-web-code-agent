import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDigestSessions, readDigestSource } from '../../../agent/yeaft/shared-knowledge/source.js';

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
    expect(after.messages.map(m => m.seq)).toEqual([3]);
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
    appendFileSync(first, jsonl([msg(12, 'user', 150)]));
    expect(() => read({ watermark })).toThrow(/Incomplete digest source scan/);
  });
});
