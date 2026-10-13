import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPersonToolHost, NATIVE_TOOL_IDS, NATIVE_TOOL_MANIFESTS } from '../../../../agent/yeaft/person/native-tools.js';
import { PersonCapabilities, CAPABILITY_LIMITS } from '../../../../agent/yeaft/person/capabilities.js';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { digest, bytes } from '../../../../agent/yeaft/person/contracts.js';
import { assembleContext, PersonRuntime } from '../../../../agent/yeaft/person/runtime.js';
import { createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { config, finalProposal } from './fixtures.js';
import { randomUUID } from 'node:crypto';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import fileWrite from '../../../../agent/yeaft/tools/file-write.js';

const directories = [], services = [];
const call = (s, op, payload = {}) => s.request({ ownerId: 'alice', op, payload });
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'person-native-')); directories.push(dir); return dir; }
async function idle(s) {
  for (let i = 0; i < 300; i++) {
    const snapshot = await call(s, 'snapshot');
    if (!snapshot.busy) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Person did not finish');
}
function create(yeaftDir, workDir, fn, extra = {}) {
  const adapter = { async *stream(params) {
    const input = JSON.parse(params.messages[0].content), p = finalProposal(input.state.version);
    p.concepts = []; p.state.focusConceptIds = []; p.activity.sourceRefs = [input.trigger.ref];
    fn(input, p);
    yield { type: 'text_delta', text: JSON.stringify(p) };
    yield { type: 'stop', stopReason: 'end_turn' };
  } };
  const service = createPersonService({ yeaftDir, workDir, config, adapter, embedding: { enabled: false }, ...extra });
  services.push(service); return service;
}
function use(p, id, args) { p.next = { model: 'test/first', effort: null, reason: 'Use the actual native operation.', capability: { id, args } }; }
async function capability(yeaftDir, workDir) {
  return new PersonCapabilities({}, 'alice', { episode: { id: 'episode' }, toolHost: createPersonToolHost({ yeaftDir, workDir, config }) });
}

afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(services.splice(0).map(s => s.close()));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Person supported native host tools', () => {
  it('uses real temporary files through one cognitive model; default budget supports a complete multi-operation turn', async () => {
    const root = await directory(), workDir = join(root, 'workspace'), yeaftDir = join(root, 'instance');
    await mkdir(workDir); await mkdir(yeaftDir);
    const operations = [
      ['FileWrite', { file_path: 'nested/example.txt', content: 'hello native\nsecond\n' }],
      ['FileRead', { file_path: 'nested/example.txt' }],
      ['FileEdit', { file_path: 'nested/example.txt', old_string: 'native', new_string: 'Person' }],
      ['Glob', { path: '.', pattern: '**/*.txt' }],
      ['Grep', { path: '.', pattern: 'Person', output_mode: 'content' }],
      ['ListDir', { path: 'nested' }],
      ['ApplyPatch', { patch: '--- a/nested/example.txt\n+++ b/nested/example.txt\n@@ -1,2 +1,2 @@\n-hello Person\n+hello patched\n second\n' }],
    ];
    const seen = [], results = [];
    const s = create(yeaftDir, workDir, (input, p) => {
      const index = seen.length; seen.push(input);
      expect(input.environment.cwd).toBe(workDir);
      expect(input.capabilities.nativeTools).toEqual(NATIVE_TOOL_IDS);
      if (input.capabilityResult?.sourceRef) {
        results.push(input.capabilityResult);
        expect(input.sourceRefs).toContain(input.capabilityResult.sourceRef);
      }
      if (index < operations.length * 2) {
        const [id, args] = operations[Math.floor(index / 2)];
        use(p, index % 2 ? id : 'catalog.view', index % 2 ? args : { id });
      }
    });
    await call(s, 'open');
    await call(s, 'send', { text: 'Create, read, edit and find the example in this workspace.', clientMessageId: 'files' });
    expect((await idle(s)).latestEpisode.status).toBe('completed');
    expect(seen).toHaveLength(15); expect(results).toHaveLength(7);
    expect(results.every(r => r.ok)).toBe(true);
    expect(results.find(r => r.id === 'FileRead').output).toContain('hello native');
    expect(results.find(r => r.id === 'Glob').output).toContain('nested/example.txt');
    expect(results.find(r => r.id === 'Grep').output).toContain('hello Person');
    expect(await readFile(join(workDir, 'nested/example.txt'), 'utf8')).toBe('hello patched\nsecond\n');
    expect(await readdir(yeaftDir)).not.toContain('sessions');
    const traces = []; let cursor = null;
    do { const page = await call(s, 'traces', { limit: 50, cursor }); traces.push(...page.items); cursor = page.nextCursor; } while (cursor);
    expect(traces.filter(t => t.kind === 'capability_result' && NATIVE_TOOL_IDS.includes(t.capability.id))).toHaveLength(7);
    for (const t of traces.filter(t => t.result?.sourceRef)) {
      expect(t.result.sha256).toBe(digest(t.result.output));
      expect(t.capabilityManifest).toEqual(t.result.source.capability);
    }
  });

  it('keeps complete native contracts reachable, prepared and rendered; refuses unprepared/forged calls', async () => {
    const cap = await capability(await directory(), await directory());
    await expect(cap.execute({ id: 'FileWrite', args: { file_path: 'never', content: 'x' } })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    for (const id of NATIVE_TOOL_IDS) {
      const contract = await cap.execute({ id: 'catalog.view', args: { id } });
      expect(contract).toMatchObject({ args: { type: 'object' }, source: { kind: 'native-tool' } });
      expect(bytes(cap.context())).toBeLessThanOrEqual(CAPABILITY_LIMITS.activeBytes);
      cap.activate(cap.context()); expect(cap.executionManifest(id)).not.toBeNull();
    }
    await cap.execute({ id: 'catalog.view', args: { id: 'NotebookEdit' } });
    const projection = cap.context(); projection.find(m => m.id === 'NotebookEdit').revision = 'forged';
    cap.activate(projection); expect(cap.executionManifest('NotebookEdit')).toBeNull();
    const provider = await createPersonProvider({ config, adapter: {} });
    await cap.execute({ id: 'catalog.view', args: { id: 'FileRead' } });
    const context = assembleContext({ snapshot: { person: { id: 'p', soul: 'Honesty.', soulRevision: 1 }, state: { version: 0 }, messages: [], concepts: [] },
      episode: { id: 'e', kind: 'think', text: '' }, provider, selection: provider.defaultSelection,
      activeCapabilities: cap.context(), capabilityMap: cap.catalog(), remainingCalls: 2 });
    expect(context.activeCapabilities.find(m => m.id === 'FileRead').args.required).toContain('file_path');
    cap.activate(context.activeCapabilities); expect(cap.executionManifest('FileRead')).not.toBeNull();
  });
});

// Joined tool-result evidence uses real SQLite repositories in an isolated directory.
{
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const selection = { model: 'test/first', effort: null };
  const capability = { id: 'FileWrite', args: { file_path: 'effect.txt', content: 'real after-effect 中' } };
  const capabilityManifest = NATIVE_TOOL_MANIFESTS.find(m => m.id === 'FileWrite');
  const manifest = { id: capabilityManifest.id, version: capabilityManifest.version, revision: capabilityManifest.revision };
  const input = (workerId = 'worker') => ({ kind: 'think', text: 'Write once', clientMessageId: randomUUID(), workerId, budget: { calls: 4, timeoutMs: 2000 } });

  describe('Person joined tool evidence: SQLite', () => {
    let dir, repositories, runtimes, release;
    const repo = (namespace = 'default') => {
      const r = new SqlitePersonRepository({ yeaftDir: dir, namespace, leaseMs: 60000 });
      repositories.push(r); return r;
    };
    beforeEach(async () => {
      repositories = []; runtimes = []; release = null;
      dir = await mkdtemp(join(tmpdir(), 'person-tool-finalizer-'));
    });
    afterEach(async () => {
      release?.();
      await Promise.all(runtimes.map(r => r.close()));
      await Promise.all(repositories.map(r => r.close()));
      await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks();
    });
    it('cancel joins a delayed real FileWrite and retains raw result without success experience or another model call', async () => {
      const r = repo(), began = deferred(), gate = deferred(), aborted = deferred(); release = gate.resolve;
      const real = fileWrite.execute;
      let raw;
      vi.spyOn(fileWrite, 'execute').mockImplementation(async (args, ctx) => {
        ctx.signal.addEventListener('abort', aborted.resolve, { once: true });
        began.resolve(); await gate.promise; raw = await real(args, ctx); return raw;
      });
      let calls = 0;
      const adapter = { async *stream(params) {
        const context = JSON.parse(params.messages[0].content), p = finalProposal(context.state.version);
        p.concepts = []; p.state.focusConceptIds = []; p.activity.sourceRefs = [context.trigger.ref];
        const invocation = ++calls === 1 ? { id: 'catalog.view', args: { id: 'FileWrite' } } : capability;
        p.next = { ...selection, reason: 'Write the real file', capability: invocation };
        yield { type: 'text_delta', text: JSON.stringify(p) }; yield { type: 'stop', stopReason: 'end_turn' };
      } };
      const provider = await createPersonProvider({ config, adapter });
      const runtime = new PersonRuntime({ repository: r, getProvider: async () => provider, workDir: dir, yeaftDir: dir, config }); runtimes.push(runtime);
      await r.open('alice');
      const { episode } = await r.admit('alice', input(runtime.workerId));
      runtime.start(episode);
      await began.promise;
      let stopped = false;
      const stopping = (async () => {
        await r.cancel('alice', episode.id); await runtime.cancel(episode.id);
        stopped = true;
      })();
      await aborted.promise; await sleep(20); expect(stopped).toBe(false);
      gate.resolve(); await stopping;
      expect(await readFile(join(dir, 'effect.txt'), 'utf8')).toBe(capability.args.content);
      expect(calls).toBe(2); expect(runtime.running.size).toBe(0);
      const traces = (await r.list('alice', 'traces', { limit: 50 })).items;
      const archives = traces.filter(t => t.kind === 'capability_finalized'); expect(archives).toHaveLength(1);
      const code = 'CANCELLED';
      expect(archives[0]).toMatchObject({ capability, capabilityManifest: manifest, afterTerminal: true, accepted: false, terminalCode: code,
        result: { ok: true, output: raw, sha256: digest(raw), rawBytes: Buffer.byteLength(raw), source: { implementation: capabilityManifest.source } } });
      expect(archives[0].result.sourceRef).toBe(`tool:${episode.id}:${archives[0].callId}:FileWrite:${digest(raw)}`);
      expect(traces.filter(t => ['capability_result', 'capability_failed'].includes(t.kind) && (t.capability?.id ?? t.capabilityId) === 'FileWrite')).toEqual([]);
      expect((await r.getPerson('alice')).capabilityExperience ?? []).toEqual([]);
      const snapshot = await r.snapshot('alice'); expect(snapshot.state.version).toBe(0);
      expect(snapshot.latestEpisode).toMatchObject({ status: 'cancelled', terminalCode: code });
      expect(snapshot.messages.filter(m => m.role === 'assistant')).toEqual([]);
      await r.close(); const reopened = repo();
      expect((await reopened.list('alice', 'traces', { limit: 50 })).items.find(t => t.kind === 'capability_finalized')).toEqual(archives[0]);
    }, 10000);
  });

}
