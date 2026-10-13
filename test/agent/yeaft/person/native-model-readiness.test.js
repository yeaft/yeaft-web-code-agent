import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPersonService } from '../../../../agent/yeaft/person/service.js';

import { config, finalProposal } from './fixtures.js';

const services = [], directories = [];
const request = (service, op, payload = {}) => service.request({ ownerId: 'alice', op, payload });
const nativeConfig = () => ({ ...structuredClone(config), availableModels: [
  { ...config.availableModels[0], contextWindow: 32768 },
  { ...config.availableModels[1], contextWindow: 100000 },
] });
async function service(native, adapter) {
  const dir = await mkdtemp(join(tmpdir(), 'person-readiness-')); directories.push(dir);
  const instance = createPersonService({ yeaftDir: dir, config: native, adapter, embedding: { enabled: false } });
  services.push(instance); return instance;
}
async function idle(instance) {
  for (let i = 0; i < 200; i++) {
    const snapshot = await request(instance, 'snapshot');
    if (!snapshot.busy) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Person did not finish');
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(instance => instance.close()));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('native execution model readiness', () => {
  it('does not advertise or dispatch a 32K model unable to fit the static native request', async () => {
    const native = nativeConfig(); native.availableModels = [native.availableModels[0]];
    const stream = vi.fn();
    const instance = await service(native, { stream });
    await request(instance, 'open');
    const status = await request(instance, 'status');
    expect(status).toMatchObject({ modelReady: false, storageReady: true, effectiveModelCandidates: [], availableModels: [] });
    expect(status.reason).toMatch(/context window.*native tool schemas.*final-cognition reserve/i);
    await request(instance, 'think', { clientMessageId: 'small-window' });
    expect((await idle(instance)).latestEpisode).toMatchObject({ status: 'failed', terminalCode: 'MODEL_UNAVAILABLE' });
    expect(stream).not.toHaveBeenCalled();
  });

  it('keeps stale explicit settings visible and unready after their model window shrinks', async () => {
    const native = structuredClone(config), stream = vi.fn();
    const instance = await service(native, { stream });
    await request(instance, 'open');
    await request(instance, 'settings', { modelCandidates: ['test/first'], defaultModel: 'test/first' });
    native.availableModels[0].contextWindow = 32768;
    const status = await request(instance, 'status');
    expect(status).toMatchObject({ modelReady: false, modelCandidates: ['test/first'], defaultModel: 'test/first',
      effectiveModelCandidates: [], effectiveDefaultModel: null });
    expect(status.availableModels.map(model => model.id)).toEqual(['test/second']);
    expect(status.reason).toContain('native tool schemas');
    await request(instance, 'think', { clientMessageId: 'shrunk-window' });
    expect((await idle(instance)).latestEpisode).toMatchObject({ status: 'failed', terminalCode: 'MODEL_SELECTION' });
    expect(stream).not.toHaveBeenCalled();
    await request(instance, 'settings', { modelCandidates: [], defaultModel: null });
    expect(await request(instance, 'status')).toMatchObject({ modelReady: true, effectiveModelCandidates: ['test/second'] });
  });

  it('runs a compatible explicit subset without escaping it in either native phase', async () => {
    const stream = vi.fn(async function* (params) {
      const input = JSON.parse(params.messages[0].content);
      yield { type: 'text_delta', text: params.tools.length ? 'Execution complete.' : JSON.stringify(finalProposal(input.state.version)) };
      yield { type: 'stop', stopReason: 'end_turn' };
    });
    const instance = await service(nativeConfig(), { stream });
    await request(instance, 'open');
    await request(instance, 'settings', { modelCandidates: ['test/second'], defaultModel: 'test/second' });
    expect(await request(instance, 'status')).toMatchObject({ modelReady: true, effectiveModelCandidates: ['test/second'], effectiveDefaultModel: 'test/second' });
    expect(stream).not.toHaveBeenCalled();
    await request(instance, 'think', { clientMessageId: 'compatible-window' });
    expect((await idle(instance)).latestEpisode.status).toBe('completed');
    expect(stream).toHaveBeenCalledTimes(2);
    expect(stream.mock.calls.map(([params]) => params.model)).toEqual(['test/second', 'test/second']);
    expect(stream.mock.calls[0][0].tools.some(tool => tool.name === 'Bash')).toBe(true);
    expect(stream.mock.calls[1][0].tools).toEqual([]);
  });
});
