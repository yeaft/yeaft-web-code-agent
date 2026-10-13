import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';

import { config, finalProposal } from './fixtures.js';

const probe = new DatabaseSync(':memory:');
let hasFts = false;
try { probe.exec('CREATE VIRTUAL TABLE f USING fts5(t)'); hasFts = true; } catch {} finally { probe.close(); }
const services = [], directories = [];
const call = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'person-local-service-')); directories.push(dir); return dir; }
function create(yeaftDir, more = {}) {
  const service = createPersonService({ yeaftDir, config, embedding: { enabled: false }, ...more });
  services.push(service); return service;
}
const adapterFor = fn => ({ async *stream(params) {
  const input = JSON.parse(params.messages[0].content);
  const proposal = fn(input);
  yield { type: 'text_delta', text: JSON.stringify(proposal) };
  yield { type: 'stop', stopReason: 'end_turn' };
} });
function final(input) {
  const proposal = finalProposal(input.state.version);
  proposal.concepts[0].expectedRevision = input.concepts.find(c => c.id === 'curiosity')?.revision ?? 0;
  proposal.concepts[0].sourceRefs = input.sourceRefs;
  return proposal;
}
async function idle(service) {
  for (let i = 0; i < 200; i++) {
    const snapshot = await call(service, 'snapshot');
    if (!snapshot.busy) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('activity did not finish');
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
describe('SQLite is the instance-local Person authority', () => {
  it('does not start cognition or download models on status/open/restart and keeps identity, messages and state', async () => {
    const dir = await directory();
    const think = vi.fn(final);
    const service = create(dir, { adapter: adapterFor(think) });
    expect(await readdir(dir)).toEqual([]);
    expect(await call(service, 'status')).toMatchObject({ storage: 'sqlite', configured: true, storageReady: true, modelReady: true, autonomySupported: false });
    const opened = await call(service, 'open');
    expect(think).not.toHaveBeenCalled();
    const request = { text: '我想保留长期的好奇心。', clientMessageId: 'message-1' };
    const accepted = await call(service, 'send', request);
    expect(await call(service, 'send', request)).toMatchObject({ episodeId: accepted.episodeId, duplicate: true });
    expect((await idle(service)).state.version).toBe(1);
    expect(think).toHaveBeenCalledTimes(1);
    const traces = await call(service, 'traces');
    expect(traces.items[0].kind).toBe('committed');
    await service.close();
    const restarted = create(dir, { adapter: adapterFor(think) });
    expect((await call(restarted, 'open')).person.id).toBe(opened.person.id);
    expect((await call(restarted, 'snapshot')).state.version).toBe(1);
    expect((await call(restarted, 'messages')).items).toHaveLength(2);
    expect(think).toHaveBeenCalledTimes(1);
    expect((await readdir(join(dir, 'person'))).some(name => name === 'models')).toBe(false);
  });

  it('uses scoped local FTS recall inside a real Person turn and records search provenance', async () => {
    const dir = await directory();
    const seen = [];
    const adapter = adapterFor(input => {
      seen.push(input);
      const p = final(input);
      const n = seen.length;
      if (n === 1) p.next = { model: 'test/first', effort: null, reason: 'Inspect recall.', capability: { id: 'catalog.view', args: { id: 'Recall' } } };
      if (n === 2) p.next = { model: 'test/first', effort: null, reason: 'Find prior words.', capability: { id: 'Recall', args: { kind: 'messages', query: hasFts ? '长期 好奇心' : '长期', limit: 2 } } };
      return p;
    });
    const service = create(dir, { adapter });
    await call(service, 'open');
    await call(service, 'send', { text: '我希望长期保留好奇心。', clientMessageId: 'recall-1' });
    const snapshot = await idle(service);
    expect(snapshot.latestEpisode.status).toBe('completed');
    expect(seen).toHaveLength(3);
    expect(seen[2].capabilityResult.items.map(item => item.text)).toContain('我希望长期保留好奇心。');
    expect(seen[2].sourceRefs.some(ref => ref.startsWith('message:'))).toBe(true);
    expect((await readdir(join(dir, 'person')))).toContain('recall.db');
    expect((await call(service, 'traces', { limit: 50 })).items.some(trace => trace.kind === 'capability_result' && trace.capability.id === 'Recall')).toBe(true);
    await call(service, 'open', {}, 'bob');
    expect((await call(service, 'messages', {}, 'bob')).items).toEqual([]);
  });
});
