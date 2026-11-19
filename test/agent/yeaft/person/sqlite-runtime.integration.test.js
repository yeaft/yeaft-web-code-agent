import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { createPersonService } from './fixture-adapter.js';
import { config, finalProposal } from './fixtures.js';

// Real runtime lifecycle against an isolated SQLite authority, with scripted inference.
describe('Person real SQLite runtime integration', () => {
  let yeaftDir;
  const services = [];
  const call = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
  const create = (namespace, adapter, more = {}) => {
    const service = createPersonService({ yeaftDir, namespace, config, adapter, embedding: { enabled: false }, effortEnabled: true, ...more });
    services.push(service); return service;
  };
  const waitIdle = async service => {
    for (let i = 0; i < 200; i++) {
      const snapshot = await call(service, 'snapshot');
      if (!snapshot.busy) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Person did not become idle');
  };
  beforeAll(async () => { yeaftDir = await mkdtemp(join(tmpdir(), 'person-sqlite-runtime-')); });
  afterAll(async () => {
    await Promise.all(services.map(s => s.close()));
    await rm(yeaftDir, { recursive: true, force: true });
  });

  it('retains a successful host write as recovery evidence and never replays its effects', async () => {
    const file = join(yeaftDir, 'recovery-once.txt');
    let count = 0, adapterError;
    const executions = vi.spyOn(PersonCapabilities.prototype, 'execute');
    const service = create('truncated-after-write', { async *stream(params) {
      try {
        count++;
        const context = JSON.parse(params.messages[0].content), p = finalProposal();
        if (count === 3) {
          yield { type: 'text_delta', text: '{"reply":"rejected-fragment-marker' };
          yield { type: 'usage', outputTokens: 4096 };
          yield { type: 'stop', stopReason: 'max_tokens' }; return;
        }
        if (count <= 2) p.next = { model: 'test/first', effort: null, reason: 'Write once.', capability: count === 1
          ? { id: 'catalog.view', args: { id: 'FileWrite' } }
          : { id: 'FileWrite', args: { file_path: file, content: 'written-once' } } };
        else {
          expect(context.outputRecovery.rejectedBeforeExecution).toBe(true);
          expect(context.capabilityResult).toMatchObject({ id: 'FileWrite', ok: true, sourceRef: expect.stringMatching(/^tool:/) });
          expect(context.sourceRefs).toContain(context.capabilityResult.sourceRef);
          expect(context.previousProposal).not.toHaveProperty('next');
          expect(params.messages.flatMap(m => m.toolCalls ?? []).filter(t => t.name === 'FileWrite')).toHaveLength(1);
          expect(JSON.stringify(context)).not.toContain('rejected-fragment-marker');
          expect(await readFile(file, 'utf8')).toBe('written-once');
        }
        yield { type: 'text_delta', text: JSON.stringify(p) };
        yield { type: 'stop', stopReason: 'end_turn' };
      } catch (error) { adapterError = error; throw error; }
    } }, { maxCalls: 4 });
    try {
      await call(service, 'open'); await call(service, 'send', { text: 'Write and report.', clientMessageId: 'write-recovery' });
      const snapshot = await waitIdle(service);
      if (adapterError) throw adapterError;
      expect(snapshot.latestEpisode.status).toBe('completed');
      expect(executions.mock.calls.map(([invocation]) => invocation.id)).toEqual(['catalog.view', 'FileWrite']);
      expect((await call(service, 'turns')).items[0].calls.map(c => c.status)).toEqual(['completed', 'completed', 'failed', 'completed', 'completed', 'completed']);
    } finally { executions.mockRestore(); }
  });

});
