import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../../../../agent/yeaft/conversation/persist.js';
import { searchMessages } from '../../../../agent/yeaft/conversation/search.js';
import {
  closeConversationHistoryIndexes, searchConversationIndex, loadConversationOutlineFromIndex,
} from '../../../../agent/yeaft/conversation/history-index.js';
import { conversationIndexManifestPath } from '../../../../agent/yeaft/conversation/history-index-state.js';

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-fold-transcript-'));
  roots.push(root);
  return { root, store: new ConversationStore(root), sessionId: 'fold-transcript' };
}
afterEach(async () => {
  await closeConversationHistoryIndexes();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fold is a context replacement, never a transcript deletion', () => {
  it('replays a 120-call turn plus later turns, progress and image identities across repeated folds, pages and reader restarts', async () => {
    const { root, store, sessionId } = fixture();
    const append = row => store.append({ sessionId, ...row });
    const expected = [];
    const arcs = [];
    for (let turn = 0; turn < 3; turn++) {
      expected.push(append({ role: 'user', content: `question ${turn}`, imageAssetIds: [`user-image-${turn}`] }));
      const arc = [];
      for (let call = 0; call < (turn === 0 ? 120 : 40); call++) {
        const id = `call-${turn}-${call}`;
        const assistant = append({ role: 'assistant', content: `progress ${turn}/${call}`, responseKind: 'progress',
          turnId: `turn-${turn}`, speakerVpId: 'vp', providerState: { secret: 'private' }, thinkingBlocks: ['private'],
          toolCalls: [{ id, name: 'Bash', input: { command: 'echo ok' } }] });
        expected.push(assistant);
        arc.push(assistant, append({ role: 'tool', toolCallId: id, content: 'private tool result', speakerVpId: 'vp' }));
      }
      const image = append({ role: 'assistant', content: '', imageAssetIds: [`result-image-${turn}`], speakerVpId: 'vp' });
      expected.push(image);
      arc.push(image);
      arcs.push(arc);
      expected.push(append({ role: 'assistant', content: `answer ${turn}`, responseKind: 'result', speakerVpId: 'vp' }));
    }
    // A UI page has a raw scan budget, not a guarantee of complete turns.
    // Drain its exclusive cursors, including empty pages, to reconstruct history.
    const transcript = (reader, turns = 1) => {
      const messages = [];
      let cursor = null;
      for (let n = 0; n < 100; n++) {
        const page = reader.loadVisibleBySession(sessionId, cursor, turns);
        messages.unshift(...page.messages);
        if (!page.hasMore) return messages;
        expect(page.nextBeforeSeq).toEqual(expect.any(Number));
        if (cursor !== null) expect(page.nextBeforeSeq).toBeLessThan(cursor);
        cursor = page.nextBeforeSeq;
      }
      throw new Error('history pagination did not terminate');
    };
    const beforeFold = transcript(store, 10);
    expect(beforeFold.map(row => row.id)).toEqual(expected.map(row => row.id));
    const first = store.foldMessages(arcs[0], { role: 'user', content: 'private fold one', sessionId, _reflection: true });
    store.foldMessages([first, ...arcs[1], ...arcs[2]], { role: 'user', content: 'private fold two', sessionId, _reflection: true });
    for (const flags of [{ internal: true }, { systemOnly: true }, { systemOnlyMessage: true }, { userAuthored: false }]) {
      append({ role: 'user', content: 'private control', ...flags });
    }
    append({ role: 'user', content: '<task-result secret>private control</task-result>' });
    store.moveToCold(arcs[0][0].id);
    for (const reader of [store, new ConversationStore(root)]) {
      const messages = transcript(reader, 10);
      expect(messages).toEqual(beforeFold.map(row => row.id === arcs[0][0].id ? { ...row, cold: true } : row));
      expect(messages.map(row => row.id)).toEqual(expected.map(row => row.id));
      expect(JSON.stringify(messages)).not.toContain('private');
      expect(messages.filter(row => row.toolCalls).flatMap(row => row.toolCalls)).toHaveLength(200);
      expect(transcript(reader).map(row => row.id)).toEqual(expected.map(row => row.id));
      const delta = [];
      let cursor = 0;
      for (let n = 0; n < 100; n++) {
        const chunk = reader.loadAfterSeqByGroup(sessionId, cursor, { limit: 7, maxBytes: 2500 });
        delta.push(...chunk.messages);
        expect(chunk.latestSeq).toBeGreaterThan(cursor);
        cursor = chunk.latestSeq;
        if (!chunk.hasMoreAfter) break;
      }
      expect(delta.map(row => row.id)).toEqual(expected.map(row => row.id));
      expect(reader.loadOlderBySession(sessionId, first.seq, 10).messages.map(row => row.id)).toContain(arcs[0][0].id);
      const hit = reader.searchVisibleBySession(sessionId, 'progress 0/0').results[0];
      expect(hit.sourceMessageIds).toContain(arcs[0][0].id);
      expect(reader.loadVisibleOutlineBySession(sessionId, { includeTotal: true }).results.some(entry => entry.sourceMessageIds.includes(arcs[0][0].id))).toBe(true);
      expect(reader.loadVisibleWindowBySession(sessionId, Number(arcs[0][0].id.slice(1)), {
        sourceMessageIds: [arcs[0][0].id], entryStartSeq: Number(arcs[0][0].id.slice(1)),
      }).messages.map(row => row.id)).toContain(arcs[0][0].id);
      const context = reader.loadRecentBySession(sessionId, Infinity, { includeReflections: true });
      expect(context.filter(row => row._reflection).map(row => row.content)).toEqual(['private fold two']);
      expect(context.some(row => row.toolCalls || row.imageAssetIds?.[0]?.startsWith('result-image'))).toBe(false);
      expect(reader.loadSessionHistoryForVp(sessionId, 'vp').some(row => row.toolCalls)).toBe(false);
      expect((await reader.loadProviderHistoryBySession(sessionId, 20)).some(row => row.toolCalls)).toBe(false);
    }
    expect(searchMessages(root, 'progress 0/0').map(row => row.id)).toContain(arcs[0][0].id);
    expect(searchMessages(root, 'private')).toEqual([]);
    expect((await searchConversationIndex(root, sessionId, 'progress 0/0')).results[0].sourceMessageIds).toContain(arcs[0][0].id);
  });

  it('keeps legacy markdown and mixed-format folded records visible while filtering control rows', () => {
    const { root, store, sessionId } = fixture();
    const legacy = join(root, 'groups', sessionId, 'conversation', 'messages');
    mkdirSync(legacy, { recursive: true });
    const write = (id, role, content, flags = '') => writeFileSync(join(legacy, `${id}.md`),
      `---\nid: ${id}\nrole: ${role}\nsessionId: ${sessionId}\n${flags}---\n${content}`);
    write('m0001', 'user', 'legacy question');
    write('m0002', 'assistant', 'legacy progress');
    write('m0003', 'user', 'legacy secret', 'internal: true\n');
    store.foldMessages([{ id: 'm0002' }], { role: 'user', content: 'legacy summary', sessionId, _reflection: true });
    const reader = new ConversationStore(root);
    expect(reader.loadVisibleBySession(sessionId, null, 10).messages.map(row => row.content)).toEqual(['legacy question', 'legacy progress']);
    expect(reader.loadAfterSeqByGroup(sessionId, 1).messages.map(row => row.content)).toEqual(['legacy progress']);
    expect(reader.searchVisibleBySession(sessionId, 'legacy progress').results).toHaveLength(1);
    expect(reader.loadRecentBySession(sessionId, Infinity).map(row => row.content)).toEqual(['legacy question']);
    const newest = store.append({ role: 'assistant', content: 'new JSONL reply', sessionId });
    write(newest.id, 'assistant', 'stale duplicate');
    const mixed = new ConversationStore(root);
    expect(mixed.loadAfterSeqByGroup(sessionId, 0, { limit: 1 }).messages.map(row => row.content)).toEqual(['legacy question']);
    expect(mixed.loadVisibleBySession(sessionId, null, 10).messages.map(row => row.content))
      .toEqual(['legacy question', 'legacy progress', 'new JSONL reply']);
    expect(searchMessages(root, 'legacy secret')).toEqual([]);
  });

  it('keeps folded originals during maintenance rewrites, including cold rows', () => {
    const { root, store, sessionId } = fixture();
    const user = store.append({ role: 'user', content: 'question', sessionId, threadId: 'source' });
    const progress = store.append({ role: 'assistant', content: 'progress', sessionId, threadId: 'source' });
    store.foldMessages([progress], { role: 'user', content: 'private summary', sessionId, _reflection: true });
    store.moveToCold(progress.id);
    expect(store.reassignThread('source', 'target')).toBe(2);
    // Exercise a dirty rewrite of the same segment, not just a no-op sweep.
    const directory = join(root, 'sessions', sessionId, 'conversation');
    const index = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8'));
    const segmentPath = join(directory, 'segments', index.segments[0].file);
    writeFileSync(segmentPath, readFileSync(segmentPath, 'utf8') + JSON.stringify({
      id: 'm9999', seq: 9999, role: 'assistant', sessionId: 'orphan', content: 'remove me',
    }) + '\n');
    const reader = new ConversationStore(root);
    expect(reader.compactOrphans({ keepGroupIds: [sessionId] }).removed).toBe(1);
    const restarted = new ConversationStore(root);
    expect(restarted.loadVisibleBySession(sessionId, null, 10).messages).toEqual([
      expect.objectContaining({ id: user.id, threadId: 'target' }),
      expect.objectContaining({ id: progress.id, threadId: 'target', cold: true }),
    ]);
    expect(restarted.loadRecentBySession(sessionId, Infinity, { includeReflections: true }).map(row => row.content))
      .toEqual(['question', 'private summary']);
  });

  it('invalidates an old browser projection at the same head and revision without changing physical lineage or context', () => {
    const { root, store, sessionId } = fixture();
    store.append({ role: 'user', content: 'question', sessionId });
    const progress = store.append({ role: 'assistant', content: 'folded progress', sessionId });
    store.foldMessages([progress], { role: 'user', content: 'private summary', sessionId, _reflection: true });
    const directory = join(root, 'sessions', sessionId, 'conversation');
    const indexBefore = readFileSync(join(directory, 'index.json'), 'utf8');
    const lineageBefore = readFileSync(join(directory, 'lineage.json'), 'utf8');
    const index = JSON.parse(indexBefore);
    // Pre-upgrade browsers received the physical metadata, after fold already
    // removed progress. No append occurs during the reader/software upgrade.
    const legacyCache = { streamId: index.streamId, revision: index.revision, headSeq: index.nextSeq - 1 };
    const contextBefore = store.loadRecentBySession(sessionId, Infinity, { includeReflections: true });
    for (const reader of [store, new ConversationStore(root)]) {
      const current = reader.getSessionHistoryMetadata(sessionId);
      expect(current).toEqual({ ...legacyCache, streamId: `${legacyCache.streamId}:visible-v2` });
      expect(current.streamId === legacyCache.streamId && current.revision === legacyCache.revision).toBe(false);
      // Reusing that cursor would yield no rows, so an identity mismatch must
      // cause a snapshot rather than a delta (enforced by the bridge).
      expect(reader.loadAfterSeqByGroup(sessionId, legacyCache.headSeq).messages).toEqual([]);
      expect(reader.loadVisibleBySession(sessionId, null, 10).messages.map(row => row.id)).toContain(progress.id);
      expect(reader.loadRecentBySession(sessionId, Infinity, { includeReflections: true })).toEqual(contextBefore);
    }
    expect(readFileSync(join(directory, 'index.json'), 'utf8')).toBe(indexBefore);
    expect(readFileSync(join(directory, 'lineage.json'), 'utf8')).toBe(lineageBefore);
  });

  it('rebuilds a pre-fix SQLite cache even when source files and mutation revisions are unchanged', async () => {
    const { root, store, sessionId } = fixture();
    const row = store.append({ role: 'user', content: 'cached folded needle', sessionId });
    store.foldMessages([row], { role: 'user', content: 'summary', sessionId, _reflection: true });
    await searchConversationIndex(root, sessionId, 'needle');
    await closeConversationHistoryIndexes();
    const path = conversationIndexManifestPath(root, sessionId);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const db = new DatabaseSync(manifest.databasePath);
    db.exec('DELETE FROM entries;');
    db.close();
    writeFileSync(path, JSON.stringify({ ...manifest, indexSchemaVersion: 2 }));
    // Outline normally permits stale snapshots: a schema-2 snapshot must not
    // use that fast path, even with an unchanged source mutation revision.
    const outline = await loadConversationOutlineFromIndex(root, sessionId);
    expect(outline.results.map(hit => hit.messageId)).toEqual([row.id]);
    const result = await searchConversationIndex(root, sessionId, 'needle');
    expect(result.results.map(hit => hit.messageId)).toEqual([row.id]);
    expect(result.indexGeneration).toBeGreaterThan(manifest.generation);
    expect(JSON.parse(readFileSync(path, 'utf8')).indexSchemaVersion).toBe(3);
    await closeConversationHistoryIndexes();
    const reopened = await searchConversationIndex(root, sessionId, 'needle');
    expect(reopened.indexGeneration).toBe(result.indexGeneration);
    expect(reopened.results.map(hit => hit.messageId)).toEqual([row.id]);
  });
});
