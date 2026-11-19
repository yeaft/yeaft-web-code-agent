import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';

let root, repos, schedulers, services;
const admission = { workerId: 'autonomy-test', budget: { calls: null } };

function repo() { const r = new SqlitePersonRepository({ yeaftDir: root }); repos.push(r); return r; }
function edit(r, update) {
  const db = new DatabaseSync(r.dbPath);
  try {
    const record = JSON.parse(db.prepare("SELECT record FROM persons WHERE ownerId = 'alice'").get().record);
    update(record);
    db.prepare("UPDATE persons SET record = ? WHERE ownerId = 'alice'").run(JSON.stringify(record));
  } finally { db.close(); }
}
const due = r => edit(r, p => { p.autonomy.nextAt = 0; });

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'person-autonomy-')); repos = []; schedulers = []; services = []; });
afterEach(async () => {
  await Promise.all(schedulers.map(s => s.close()));
  await Promise.all(services.map(s => s.close()));
  await Promise.all(repos.map(r => r.close()));
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it('requires new explicit consent after upgrade and serializes autonomous admissions across workers without a user message', async () => {
  const a = repo(), b = repo();
  expect((await a.open('alice')).person.settings.autonomyEnabled).toBe(false);
  edit(a, p => { p.settings.autonomyEnabled = true; }); // pre-feature durable setting is not consent
  expect((await a.open('alice')).person.settings.autonomyEnabled).toBe(false);
  expect((await a.autonomyOwners()).owners).toEqual([]);
  expect(await a.autonomyAdmit('alice', admission)).toBeNull();
  await a.settings('alice', { autonomyEnabled: true }); due(a);
  const results = await Promise.all([a.autonomyAdmit('alice', admission), b.autonomyAdmit('alice', admission)]);
  const admitted = results.find(Boolean);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(admitted.episode).toMatchObject({ ownerId: 'alice', namespace: 'default', kind: 'autonomous', messageId: null,
    scheduling: { origin: 'autonomous', observationOnly: true, authorization: false, reason: 'idle' } });
  expect((await a.list('alice', 'messages')).items).toHaveLength(0);
  await a.executionControl(admitted.episode, { status: 'paused' });
  due(a);
  expect(await b.autonomyAdmit('alice', admission)).toBeNull();
  await expect(a.heartbeat(admitted.episode)).resolves.toBeUndefined();
});
