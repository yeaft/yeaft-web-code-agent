import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { MongoPersonRepository } from '../../../../agent/yeaft/person/repository.js';

const manifest = (id = 'Recall', version = 1, revision = 'a'.repeat(64)) => ({ id, version, revision });
const result = (callId = 'call-1', m = manifest()) => ({ callId, capability: { id: m.id, args: { query: 'private query' } },
  capabilityManifest: m, result: { instructions: 'not authority', access: 'read-only', items: ['private result'] } });
const input = (id = randomUUID(), kind = 'send') => ({ kind, text: kind === 'send' ? 'hello' : '', clientMessageId: id, workerId: 'worker', budget: { calls: 4, timeoutMs: 5000 } });

// Mongo is deliberately opt-in to an isolated replica set, never the online DB.
for (const backend of ['sqlite', 'mongo']) {
  const suite = backend === 'mongo' && !process.env.PERSON_TEST_MONGO_URI ? describe.skip : describe;
  suite(`Person capability experience: ${backend} persistence`, () => {
    let yeaftDir, repositories, inspector, MongoClient, dbName;
    const repo = (namespace = 'default') => {
      const r = backend === 'sqlite' ? new SqlitePersonRepository({ yeaftDir, namespace, leaseMs: 60000 })
        : new MongoPersonRepository({ uri: process.env.PERSON_TEST_MONGO_URI, dbName, namespace, MongoClient, leaseMs: 60000 });
      repositories.push(r); return r;
    };
    const sql = (r, fn) => { const db = new DatabaseSync(r.dbPath); try { return fn(db); } finally { db.close(); } };
    const patchPerson = async (r, fields, remove = []) => {
      if (backend === 'mongo') {
        await inspector.db(dbName).collection('person_persons').updateOne(r.scope('alice'), {
          ...(Object.keys(fields).length ? { $set: fields } : {}), ...(remove.length ? { $unset: Object.fromEntries(remove.map(k => [k, ''])) } : {}),
        });
      } else sql(r, db => {
        const p = JSON.parse(db.prepare('SELECT record FROM persons WHERE namespace = ? AND ownerId = ?').get(r.namespace, 'alice').record);
        Object.assign(p, fields); remove.forEach(k => delete p[k]);
        db.prepare('UPDATE persons SET record = ? WHERE namespace = ? AND ownerId = ?').run(JSON.stringify(p), r.namespace, 'alice');
      });
    };
    beforeEach(async () => {
      repositories = [];
      if (backend === 'sqlite') yeaftDir = await mkdtemp(join(tmpdir(), 'person-capability-experience-'));
      else {
        const module = process.env.PERSON_TEST_MONGO_DRIVER ? pathToFileURL(process.env.PERSON_TEST_MONGO_DRIVER).href : 'mongodb';
        ({ MongoClient } = await import(/* @vite-ignore */ module));
        dbName = `person_experience_test_${randomUUID().replaceAll('-', '')}`;
        inspector = new MongoClient(process.env.PERSON_TEST_MONGO_URI); await inspector.connect();
      }
    });
    afterEach(async () => {
      await Promise.all(repositories.map(r => r.close()));
      if (inspector) { await inspector.db(dbName).dropDatabase(); await inspector.close(); }
      if (yeaftDir) await rm(yeaftDir, { recursive: true, force: true });
    });

    it('durably stores only execution metadata separately from cognitive state and UI snapshots', async () => {
      const r = repo(); await r.open('alice');
      const { episode } = await r.admit('alice', input());
      expect((await r.context(episode)).capabilityExperience).toEqual([]);
      await r.append(episode, 'capability_result', result());
      const experience = (await r.context(episode)).capabilityExperience;
      expect(experience).toEqual([{ ...manifest(), observations: [{ episodeId: episode.id, callId: 'call-1', triggerKind: 'send',
        outcome: 'succeeded', code: null, usedAt: expect.any(String) }] }]);
      const usedAt = experience[0].observations[0].usedAt;
      expect(new Date(usedAt).toISOString()).toBe(usedAt);
      expect((await r.getPerson('alice')).capabilityExperience).toEqual(experience);
      expect((await r.context(episode)).state).not.toHaveProperty('capabilityExperience');
      const snapshot = await r.snapshot('alice');
      expect(JSON.stringify(snapshot)).not.toContain('capabilityExperience');
      expect(JSON.stringify(experience)).not.toMatch(/private|instructions|access|query|result|args|permissions|useful/);
      await r.close();
      const reopened = repo();
      expect((await reopened.context(episode)).capabilityExperience).toEqual(experience);
      await reopened.cancel('alice');
      const next = await reopened.admit('alice', input());
      expect((await reopened.context(next.episode)).capabilityExperience).toEqual(experience);
    });

    it('ignores discovery, intrinsic Think, proposals and unversioned legacy traces; old persons default empty', async () => {
      const r = repo(); await r.open('alice');
      const { episode } = await r.admit('alice', input());
      await patchPerson(r, {}, ['capabilityExperience']);
      for (const id of ['catalog.search', 'catalog.view', 'Think']) {
        await r.append(episode, 'capability_result', result(id, manifest(id)));
        await r.append(episode, 'capability_failed', { callId: id, capabilityId: id, capabilityManifest: manifest(id), code: 'UNSUPPORTED' });
      }
      await r.append(episode, 'activity', result());
      const legacy = result(); delete legacy.capabilityManifest;
      await r.append(episode, 'capability_result', legacy);
      await r.append(episode, 'capability_failed', { callId: 'not-executed', capabilityId: 'Unknown', code: 'UNSUPPORTED' });
      expect((await r.context(episode)).capabilityExperience).toEqual([]);
      expect((await r.getPerson('alice')).capabilityExperience).toBeUndefined();
    });

    it('preserves failures as technical demotion inputs, invalidates changed versions/revisions and uses stored trigger kind', async () => {
      const r = repo(); await r.open('alice');
      const { episode } = await r.admit('alice', input(undefined, 'dream'));
      await r.append({ ...episode, kind: 'send' }, 'capability_result', result());
      await r.append(episode, 'capability_failed', { callId: 'failed', capabilityId: 'Recall', capabilityManifest: manifest(), code: 'CONTEXT_LIMIT', result: 'private failure' });
      let entry = (await r.context(episode)).capabilityExperience[0];
      expect(entry.observations.map(o => [o.callId, o.triggerKind, o.outcome, o.code])).toEqual([
        ['failed', 'dream', 'failed', 'CONTEXT_LIMIT'], ['call-1', 'dream', 'succeeded', null],
      ]);
      await r.append(episode, 'capability_result', result('version-2', manifest('Recall', 2)));
      entry = (await r.context(episode)).capabilityExperience[0];
      expect(entry.version).toBe(2); expect(entry.observations.map(o => o.callId)).toEqual(['version-2']);
      await r.append(episode, 'capability_result', result('revision-2', manifest('Recall', 2, 'b'.repeat(64))));
      entry = (await r.context(episode)).capabilityExperience[0];
      expect(entry.revision).toBe('b'.repeat(64)); expect(entry.observations.map(o => o.callId)).toEqual(['revision-2']);
    });

    it('bounds latest observations to eight and least-recent entries to sixteen, including duplicate worker appends', async () => {
      const r = repo(), second = repo(); await r.open('alice');
      const { episode } = await r.admit('alice', input());
      await Promise.all([r.append(episode, 'capability_result', result()), second.append(episode, 'capability_result', result())]);
      expect((await r.context(episode)).capabilityExperience[0].observations).toHaveLength(1);
      for (let i = 2; i <= 12; i++) await r.append(episode, 'capability_result', result(`call-${i}`));
      const beforeDuplicate = (await r.context(episode)).capabilityExperience;
      expect(beforeDuplicate[0].observations.map(o => o.callId)).toEqual([12, 11, 10, 9, 8, 7, 6, 5].map(i => `call-${i}`));
      await r.append(episode, 'capability_result', result('call-5'));
      expect((await r.context(episode)).capabilityExperience).toEqual(beforeDuplicate);
      for (let i = 1; i <= 15; i++) await r.append(episode, 'capability_result', result(`skill-call-${i}`, manifest(`Skill.${i}`)));
      await r.append(episode, 'capability_result', result('refresh'));
      await r.append(episode, 'capability_result', result('skill-call-16', manifest('Skill.16')));
      const entries = (await r.context(episode)).capabilityExperience;
      expect(entries).toHaveLength(16);
      expect(entries.map(e => e.id)).toContain('Recall');
      expect(entries.map(e => e.id)).not.toContain('Skill.1');
      await r.cancel('alice');
      const next = await r.admit('alice', input());
      await r.append(next.episode, 'capability_result', result('refresh'));
      expect((await r.context(next.episode)).capabilityExperience.find(e => e.id === 'Recall').observations.slice(0, 2).map(o => o.episodeId)).toEqual([next.episode.id, episode.id]);
    });

    it('isolates namespace/owner/person and rejects forged episode identities', async () => {
      const r = repo(), other = repo('other');
      await Promise.all([r.open('alice'), r.open('bob'), other.open('alice')]);
      const { episode } = await r.admit('alice', input());
      const bob = await r.admit('bob', input()), stranger = await other.admit('alice', input());
      await r.append(episode, 'capability_result', result());
      expect((await r.context(bob.episode)).capabilityExperience).toEqual([]);
      expect((await other.context(stranger.episode)).capabilityExperience).toEqual([]);
      for (const forged of [{ ...episode, namespace: 'other' }, { ...episode, personId: 'person-other' }, { ...episode, ownerId: 'bob' }]) {
        await expect(r.append(forged, 'capability_result', result('forged'))).rejects.toMatchObject({ code: 'STALE' });
      }
      await expect(other.append(episode, 'capability_result', result('forged'))).rejects.toMatchObject({ code: 'STALE' });
      expect((await r.context(episode)).capabilityExperience[0].observations).toHaveLength(1);
    });

    it('atomically rejects invalid metadata without changing person counters, trace or prior experience', async () => {
      const r = repo(); await r.open('alice');
      const { episode } = await r.admit('alice', input());
      await r.append(episode, 'capability_result', result());
      const before = await r.getPerson('alice'), traces = await r.list('alice', 'traces', { limit: 50 });
      const invalid = [
        { ...result('bad'), capabilityManifest: null },
        { ...result('bad'), capabilityManifest: { ...manifest(), instructions: 'untrusted' } },
        result('bad', manifest('Recall', 0)), result('bad', manifest('Recall', 1.5)), result('bad', manifest('Recall', '1')),
        result('bad', manifest('Recall', 1, 'not-sha256')), result('bad', manifest('Recall', 1, 'a'.repeat(65))),
        { ...result('bad'), capabilityManifest: manifest('Different') },
        { ...result('bad'), callId: '' }, { ...result('bad'), callId: 'x'.repeat(129) },
        { ...result('bad'), capability: {} },
      ];
      for (const data of invalid) await expect(r.append(episode, 'capability_result', data)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      for (const code of [undefined, null, {}, 'x'.repeat(129), 'private\ntext']) {
        await expect(r.append(episode, 'capability_failed', { callId: 'bad', capabilityId: 'Recall', capabilityManifest: manifest(), code })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      }
      expect(await r.getPerson('alice')).toEqual(before);
      expect(await r.list('alice', 'traces', { limit: 50 })).toEqual(traces);
    });

    it('rolls experience back if the trace insert fails after the person mutation', async () => {
      const r = repo(); await r.open('alice');
      const { episode } = await r.admit('alice', input());
      const before = await r.getPerson('alice'), traces = await r.list('alice', 'traces', { limit: 50 });
      if (backend === 'sqlite') sql(r, db => db.exec("CREATE TRIGGER reject_probe BEFORE INSERT ON traces WHEN json_extract(NEW.record, '$.rollbackProbe') = 1 BEGIN SELECT RAISE(ABORT, 'probe'); END;"));
      // Mongo stores arbitrary payload fields only in JSON; reject by the fixed kind projection.
      else await inspector.db(dbName).command({ collMod: 'person_traces', validator: { kind: { $ne: 'capability_result' } } });
      await expect(r.append(episode, 'capability_result', { ...result(), rollbackProbe: 1 })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      expect(await r.getPerson('alice')).toEqual(before);
      expect(await r.list('alice', 'traces', { limit: 50 })).toEqual(traces);
    });

    it.each(['cancel', 'lease'])('fences late success and failure after %s with no experience or trace writes', async mode => {
      const r = repo(); await r.open('alice');
      const { episode } = await r.admit('alice', input());
      await r.append(episode, 'capability_result', result());
      if (mode === 'cancel') await r.cancel('alice');
      else await patchPerson(r, { leaseUntil: new Date(0) });
      const before = await r.getPerson('alice'), traces = await r.list('alice', 'traces', { limit: 50 });
      await expect(r.append(episode, 'capability_result', result('late'))).rejects.toMatchObject({ code: 'STALE' });
      await expect(r.append(episode, 'capability_failed', { callId: 'late-failure', capabilityId: 'Recall', capabilityManifest: manifest(), code: 'TIMEOUT' })).rejects.toMatchObject({ code: 'STALE' });
      expect(await r.getPerson('alice')).toEqual(before);
      expect(await r.list('alice', 'traces', { limit: 50 })).toEqual(traces);
    });
  });
}
