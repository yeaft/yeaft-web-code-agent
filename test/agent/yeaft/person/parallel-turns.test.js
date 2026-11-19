import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { config } from './fixtures.js';

const resources = [];
afterEach(async () => { for (const { service, repository, dir } of resources.splice(0)) {
  await service?.close(); await repository?.close(); await rm(dir, { recursive: true, force: true });
} vi.restoreAllMocks(); });

const text = value => [{ type: 'text_delta', text: value }, { type: 'stop', stopReason: 'end_turn' }];

it('runs concurrent service turns, routes supplements, shares only public sibling context and controls one without stopping another', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'person-parallel-service-'));
  const requests = [], releases = [];
  const adapter = { async *stream(params) {
    if (params.maxTokens === 256) {
      yield* text(params.messages[0].content.includes('supplement-first')
        ? JSON.stringify({ decision: 'related', targetThreadId: first.episodeId }) : '{"decision":"unrelated"}'); return;
    }
    requests.push(params);
    await new Promise(resolve => releases.push(resolve));
    yield* text('public result');
  } };
  const service = createPersonService({ yeaftDir: dir, workDir: dir, config, adapter, embedding: { enabled: false } });
  resources.push({ service, dir });
  const call = (op, payload = {}) => service.request({ ownerId: 'alice', op, payload });
  const until = async predicate => { for (let i = 0; i < 250; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('not reached'); };
  await call('open');
  const first = await call('send', { text: 'first', clientMessageId: 'one' });
  await until(() => requests.length === 1);
  const second = await call('send', { text: 'second', clientMessageId: 'two' });
  await until(() => requests.length === 2);
  expect(second.episodeId).not.toBe(first.episodeId);
  const more = await call('send', { text: 'supplement-first', clientMessageId: 'three' });
  expect(more).toMatchObject({ episodeId: first.episodeId, rootMessageId: first.messageId, deliveryState: 'queued' });
  expect((await call('snapshot')).activeEpisodes).toHaveLength(2);
  expect((await call('executions')).active).toHaveLength(2);
  await call('pause', { episodeId: first.episodeId });
  expect((await call('snapshot')).activeEpisodes.find(e => e.episodeId === first.episodeId).status).toBe('pausing');
  await call('resume', { episodeId: first.episodeId });
  releases[0](); await until(() => requests.length === 3);
  expect(JSON.stringify(requests[2].messages)).toContain(second.episodeId);
  await call('cancel', { episodeId: first.episodeId });
  expect((await call('snapshot')).activeEpisodes.map(e => e.episodeId)).toEqual([second.episodeId]);
  await call('cancel');
  expect((await call('snapshot')).busy).toBe(false);
  for (const release of releases) release();
});

it('keeps a live sibling native FileRead private at bootstrap while publishing its public context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'person-parallel-private-'));
  const marker = 'PRIVATE_NATIVE_FILE_CONTENT_7391';
  await writeFile(join(dir, 'private.txt'), marker);
  let first, siblingRequest, readResult;
  const held = [];
  const adapter = { async *stream(params) {
    if (params.maxTokens === 256) { yield* text('{"decision":"unrelated"}'); return; }
    const trigger = JSON.parse(params.messages[0].content).trigger;
    if (trigger.text === 'read private fixture') {
      const result = params.messages.find(message => message.role === 'tool' && message.toolCallId === 'read');
      if (!result) {
        yield { type: 'tool_call', id: 'read', name: 'FileRead', input: { file_path: 'private.txt' } };
        yield { type: 'stop', stopReason: 'tool_use' }; return;
      }
      readResult = JSON.parse(result.content);
    } else siblingRequest = params;
    await new Promise(resolve => held.push(resolve));
  } };
  const service = createPersonService({ yeaftDir: dir, workDir: dir, config, adapter, embedding: { enabled: false } });
  resources.push({ service, dir });
  const call = (op, payload = {}) => service.request({ ownerId: 'alice', op, payload });
  try {
    await call('open'); first = await call('send', { text: 'read private fixture', clientMessageId: 'private' });
    await vi.waitFor(() => expect(readResult?.output).toContain(marker));
    await call('send', { text: 'independent public question', clientMessageId: 'public' });
    await vi.waitFor(() => expect(siblingRequest).toBeDefined());
    const rendered = JSON.stringify(siblingRequest);
    expect(rendered).not.toContain(marker);
    expect(rendered).toContain(first.episodeId);
    expect(rendered).toContain('read private fixture');
    expect((await call('snapshot')).activeEpisodes).toHaveLength(2);
  } finally { for (const release of held) release(); }
});
