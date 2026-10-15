import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { assembleContext } from '../../../../agent/yeaft/person/runtime.js';

const resources = [];
afterEach(async () => { for (const { repository, dir } of resources) { await repository.close(); await rm(dir, { recursive: true, force: true }); } resources.length = 0; });

describe('bounded diverse Dream context', () => {
  it('mixes recent user, rotating older user and concept kinds without letting assistant progress crowd out cancellation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'person-dream-context-'));
    const repository = new SqlitePersonRepository({ yeaftDir: dir, namespace: 'dream-context', leaseMs: 30000 });
    resources.push({ repository, dir });
    await repository.open('alice'); await repository.open('bob');
    const db = new DatabaseSync(repository.dbPath);
    const scope = db.prepare("SELECT namespace, ownerId, personId FROM persons WHERE ownerId = 'alice'").get();
    const insertMessage = db.prepare('INSERT INTO messages(namespace,ownerId,personId,id,seq,revision,text,record) VALUES(?,?,?,?,?,?,?,?)');
    const insertConcept = db.prepare('INSERT INTO concepts(namespace,ownerId,personId,id,revision,updatedAt,statement,record) VALUES(?,?,?,?,?,?,?,?)');
    db.exec('BEGIN');
    for (let seq = 1; seq <= 100; seq++) {
      const message = { ...scope, id: `user-${seq}`, seq, revision: 1, role: 'user', text: seq === 100 ? 'Stop the experiment. Do not trade.' : `user interest ${seq}`, createdAt: new Date(seq).toISOString() };
      insertMessage.run(...Object.values(scope), message.id, seq, 1, message.text, JSON.stringify(message));
    }
    for (let seq = 101; seq <= 202; seq++) {
      const message = { ...scope, id: `assistant-${seq}`, seq, revision: 1, role: 'assistant', replyKind: seq <= 200 ? 'progress' : 'final', text: 'Still optimizing returns.', createdAt: new Date(seq).toISOString() };
      insertMessage.run(...Object.values(scope), message.id, seq, 1, message.text, JSON.stringify(message));
    }
    const kinds = ['claim', 'question', 'method', 'self-model', 'scenario', 'interest'];
    for (let i = 0; i < 90; i++) {
      const concept = { ...scope, id: `concept-${String(i).padStart(3, '0')}`, revision: 3, kind: kinds[i % 6], statement: `independent area ${i}`, epistemicState: 'hypothesis', sourceRefs: ['message:user-1:1'], updatedAt: new Date(i + 1).toISOString() };
      insertConcept.run(...Object.values(scope), concept.id, 3, i + 1, concept.statement, JSON.stringify(concept));
    }
    db.prepare("UPDATE states SET record = json_set(record, '$.focusConceptIds', json(?)) WHERE ownerId = 'alice'").run(JSON.stringify(['concept-000', 'concept-001']));
    db.prepare("UPDATE persons SET record = json_set(record, '$.messageSeq', 202) WHERE ownerId = 'alice'").run();
    db.exec('COMMIT'); db.close();
    const think = await repository.admit('alice', { kind: 'think', text: '', clientMessageId: 'think', workerId: 'worker', budget: {} });
    const thinkContext = await repository.context(think.episode);
    expect(thinkContext.messages).toHaveLength(12);
    expect(thinkContext.messages[0]).toMatchObject({ id: 'user-100', text: 'Stop the experiment. Do not trade.' });
    expect(thinkContext.latestUserInstruction).toEqual(thinkContext.messages[0]);
    expect(thinkContext.concepts.length).toBeLessThanOrEqual(24);
    await repository.finish(think.episode, 'failed', 'INTERRUPTED');
    const admit = id => repository.admit('alice', { kind: 'dream', text: '', clientMessageId: id, workerId: 'worker', budget: {} });
    const { episode } = await admit('dream-1');
    const first = await repository.context(episode);
    expect(await repository.context(episode)).toEqual(first);
    expect(first.messages.length).toBeLessThanOrEqual(12);
    expect(first.messages.filter(m => m.role === 'user')).toHaveLength(10);
    expect(first.messages.some(m => m.replyKind === 'progress')).toBe(false);
    expect(first.messages.filter(m => m.role === 'user').at(-1).id).toBe('user-100');
    expect(first.messages.filter(m => m.role === 'assistant')).toHaveLength(2);
    expect(first.messages.at(-1).id).toBe('assistant-202');
    expect(first.latestUserInstruction).toMatchObject({ id: 'user-100', text: 'Stop the experiment. Do not trade.' });
    expect(first.concepts.length).toBeLessThanOrEqual(24);
    expect(first.concepts.slice(0, 2).map(c => c.id)).toEqual(['concept-000', 'concept-001']);
    const old = first.concepts.filter(c => Number(c.id.slice(8)) < 84 && Number(c.id.slice(8)) > 1);
    expect(new Set(old.map(c => c.kind))).toEqual(new Set(kinds));
    // Actual rendered memory refs retain exact revisions, never synthetic sample IDs.
    const assembled = assembleContext({ snapshot: first, episode, selection: { model: 'test/first', effort: null },
      provider: { catalog: [{ id: 'test/first', contextWindow: 100000, maxOutput: 4096, efforts: [] }] } });
    for (const record of first.messages) expect(assembled.sourceRefs.has(`message:${record.id}:1`)).toBe(true);
    for (const record of first.concepts) expect(assembled.sourceRefs.has(`concept:${record.id}:3`)).toBe(true);
    await repository.finish(episode, 'failed', 'INTERRUPTED');
    const next = await admit('dream-2');
    const second = await repository.context(next.episode);
    expect(second.contextSelection).toMatchObject({ strategy: 'dream-diverse', limits: { messages: 12, focusedConcepts: 12, recentConcepts: 6, olderConcepts: 6 } });
    expect(second.messages.filter(m => Number(m.id.slice(5)) < 95).map(m => m.id)).not.toEqual(first.messages.filter(m => Number(m.id.slice(5)) < 95).map(m => m.id));
    expect(second.concepts.filter(c => Number(c.id.slice(8)) < 84 && Number(c.id.slice(8)) > 1).map(c => c.id)).not.toEqual(old.map(c => c.id));
    await repository.finish(next.episode, 'failed', 'INTERRUPTED');
    const bob = await repository.admit('bob', { kind: 'dream', text: '', clientMessageId: 'bob', workerId: 'worker', budget: {} });
    expect((await repository.context(bob.episode)).messages).toEqual([]);
    expect((await repository.context(bob.episode)).concepts).toEqual([]);
  });
});
