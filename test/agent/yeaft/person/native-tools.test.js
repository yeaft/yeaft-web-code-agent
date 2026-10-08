import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPersonToolHost, NATIVE_TOOL_IDS, NATIVE_TOOL_MANIFESTS, projectNativeResult } from '../../../../agent/yeaft/person/native-tools.js';
import { PersonCapabilities, inspectCapabilities, CAPABILITY_LIMITS } from '../../../../agent/yeaft/person/capabilities.js';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { digest, bytes, validateProposal, PersonError } from '../../../../agent/yeaft/person/contracts.js';
import { assembleContext } from '../../../../agent/yeaft/person/runtime.js';
import { createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { config, finalProposal } from './fixtures.js';
import fileWrite from '../../../../agent/yeaft/tools/file-write.js';
import bash from '../../../../agent/yeaft/tools/bash.js';

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
async function execute(cap, id, args) {
  await cap.execute({ id: 'catalog.view', args: { id } });
  cap.activate(cap.context());
  return cap.execute({ id, args }, { callId: 'call' });
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

  it('restores native familiarity only from matching execution and implementation revisions', async () => {
    const dir = await directory(), workDir = await directory();
    await writeFile(join(workDir, 'observed.txt'), 'native observation');
    let n = 0;
    const first = create(dir, workDir, (_input, p) => {
      if (++n === 1) use(p, 'catalog.view', { id: 'FileRead' });
      if (n === 2) use(p, 'FileRead', { file_path: 'observed.txt' });
    });
    await call(first, 'open'); await call(first, 'think', { text: 'Read example', clientMessageId: 'experience' });
    expect((await idle(first)).latestEpisode.status).toBe('completed');
    await first.close();
    let rendered;
    const second = create(dir, workDir, input => { rendered = input; });
    await call(second, 'think', { text: 'Consider prior experience', clientMessageId: 'familiar' });
    expect((await idle(second)).latestEpisode.status).toBe('completed');
    const familiar = rendered.capabilities.active.find(m => m.id === 'FileRead');
    const manifest = NATIVE_TOOL_MANIFESTS.find(m => m.id === 'FileRead');
    expect(familiar).toMatchObject({ version: manifest.version, revision: manifest.revision, source: manifest.source,
      availability: { layer: 'familiar', experience: { observedSuccesses: 1, usefulness: 'not-evaluated' } } });
    const stale = new PersonCapabilities({}, 'alice', { experience: [{ id: manifest.id, version: manifest.version,
      revision: 'old-implementation', observations: [{ outcome: 'succeeded', triggerKind: 'think', usedAt: new Date().toISOString() }] }] });
    expect(stale.context().some(m => m.id === manifest.id)).toBe(false);
  });

  it('reads Git through the real safe GitRead implementation in deployment cwd', async () => {
    const dir = await directory(); execFileSync('git', ['init', '-q', dir]);
    const cap = await capability(await directory(), dir);
    const result = await execute(cap, 'GitRead', { operation: 'status' });
    expect(result.ok).toBe(true); expect(result.output).toContain(dir);
    const invalid = await execute(cap, 'GitRead', { operation: 'show', revision: '--help' });
    expect(invalid).toMatchObject({ ok: false, code: 'TOOL_FAILED' });
  });

  it('executes a real foreground shell and preserves native nonzero-exit/error-effect contracts', async () => {
    const dir = await directory(), cap = await capability(await directory(), dir);
    const result = await execute(cap, 'Bash', { command: 'printf native-shell > shell.txt; cat shell.txt' });
    // This CI host must provide the native process-tree containment requirement.
    expect(result).toMatchObject({ ok: true, output: 'native-shell' });
    expect(await readFile(join(dir, 'shell.txt'), 'utf8')).toBe('native-shell');
    const failure = await execute(cap, 'Bash', { command: 'printf failure; exit 7' });
    expect(failure).toMatchObject({ ok: false, errorEffect: 'unknown', replaySafe: false });
    expect(JSON.parse(failure.output)).toMatchObject({ code: 'bash_exit_nonzero', exitCode: 7, output: 'failure' });
    expect(await execute(cap, 'Bash', { command: 'touch forbidden', background: true })).toMatchObject({ ok: false, code: 'UNSUPPORTED', errorEffect: 'none' });
  });

  it('loads the real layered native Skill library but never moves Person scripts into Session skills', async () => {
    const dir = await directory(), workDir = await directory();
    await mkdir(join(dir, 'skills')); await mkdir(join(workDir, '.yeaft/skills'), { recursive: true });
    await writeFile(join(dir, 'skills/person-test.md'), '---\nname: person-test\ndescription: instance method\n---\ninstance instructions');
    await writeFile(join(workDir, '.yeaft/skills/person-test.md'), '---\nname: person-test\ndescription: project method\n---\nproject instructions');
    const cap = await capability(dir, workDir);
    const result = await execute(cap, 'Skill', { action: 'view', name: 'person-test' });
    expect(result.ok).toBe(true); expect(JSON.parse(result.output).content).toContain('project instructions');
    expect(await readdir(dir)).toEqual(['skills']);
  });

  it('uses the actual WebFetch and WebSearch dispatch with mocked network and verifiable source hashes', async () => {
    const fetch = vi.fn(async (url, options) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const data = url.startsWith('https://search.invalid')
        ? { results: [{ title: 'Native documentation', url: 'https://docs.invalid/page', snippet: 'External evidence' }] }
        : '<html><body><h1>Actual fetched text</h1></body></html>';
      return new Response(typeof data === 'string' ? data : JSON.stringify(data), { status: 200,
        headers: { 'content-type': typeof data === 'string' ? 'text/html' : 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    const host = createPersonToolHost({ workDir: await directory(), yeaftDir: await directory(), config: { search: { searchApiUrl: 'https://search.invalid?q={query}', disableHtmlFallback: true } } });
    const options = { callId: 'c', episodeId: 'e' };
    const fetched = await host.execute('WebFetch', { url: 'https://docs.invalid/page' }, options);
    expect(fetched.ok).toBe(true); expect(fetched.output).toContain('Actual fetched text');
    expect(fetched.sourceRef).toBe(`tool:e:c:WebFetch:${digest(fetched.output)}`);
    const searched = await host.execute('WebSearch', { query: 'native tools', limit: 1 }, options);
    expect(searched.ok).toBe(true); expect(searched.output).toContain('Native documentation');
    expect(searched.source.implementation).toEqual(NATIVE_TOOL_MANIFESTS.find(m => m.id === 'WebSearch').source);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('records external observation provenance without manufacturing user-reported lineage', async () => {
    const provider = await createPersonProvider({ config, adapter: {} });
    const capabilityResult = { id: 'WebFetch', ok: true, output: 'external fact', sourceRef: 'tool:e:c:WebFetch:hash' };
    const context = assembleContext({ snapshot: { person: { id: 'p', soul: 'Honesty.' }, state: { version: 0 }, messages: [], concepts: [] },
      episode: { id: 'e', kind: 'dream', text: '' }, provider, selection: provider.defaultSelection, capabilityResult, remainingCalls: 1 });
    expect(context.sources.get(capabilityResult.sourceRef)).toEqual({ kind: 'external-tool-observation', reportedSourceRefs: [] });
    const p = finalProposal(); p.concepts[0].sourceRefs = [capabilityResult.sourceRef];
    const rules = { stateVersion: 0, sourceRefs: context.sourceRefs, concepts: context.concepts, sources: context.sources, catalog: provider.catalog };
    expect(validateProposal(p, rules)).toBe(p);
    p.concepts[0].epistemicState = 'reported'; expect(() => validateProposal(p, rules)).toThrow();
  });

  it('persists raw large output separately from the bounded escaped UTF-8 model projection', async () => {
    const dir = await directory(), workDir = await directory(), content = '中\\\"'.repeat(18000);
    await writeFile(join(workDir, 'large.txt'), content);
    const seen = [];
    const s = create(dir, workDir, (input, p) => {
      seen.push(input);
      if (seen.length === 1) use(p, 'catalog.view', { id: 'FileRead' });
      if (seen.length === 2) use(p, 'FileRead', { file_path: 'large.txt' });
    });
    await call(s, 'open'); await call(s, 'think', { text: 'Read large file', clientMessageId: 'large' });
    expect((await idle(s)).latestEpisode.status).toBe('completed');
    const projected = seen[2].capabilityResult;
    expect(projected).toMatchObject({ ok: true, truncated: true });
    expect(bytes(projected)).toBeLessThanOrEqual(8192);
    const raw = (await call(s, 'traces', { limit: 50 })).items.find(t => t.kind === 'capability_result' && t.capability.id === 'FileRead').result;
    expect(raw.output).toContain(content.slice(0, 10000)); expect(bytes(raw)).toBeGreaterThan(8192);
    // Native FileRead has its own bounded pagination, before model projection.
    expect(raw.output).toContain('Continue with');
    expect(projected.sha256).toBe(digest(raw.output));
    expect(projected.sourceRef).toBe(raw.sourceRef);
    expect(projectNativeResult(raw).output).not.toContain('\ufffd');
  });

  it('inspection exposes real native schema/module revisions without loading skills, configuration or executing tools', async () => {
    const execute = vi.spyOn(fileWrite, 'execute'), fetch = vi.spyOn(globalThis, 'fetch');
    const page = inspectCapabilities([], { cursor: null, limit: 50 });
    expect(page.items).toHaveLength(5 + NATIVE_TOOL_IDS.length);
    const file = page.items.find(m => m.id === 'FileWrite');
    expect(file.source).toEqual(file.contract.source);
    expect(file.source.revision).toBe(digest(await readFile(new URL('../../../../agent/yeaft/tools/file-write.js', import.meta.url), 'utf8')));
    expect(file.contract.revision).toBe(NATIVE_TOOL_MANIFESTS.find(m => m.id === 'FileWrite').revision);
    expect(file.contract.access).toBe('host-effect');
    for (const id of ['AskUser', 'HistorySearch', 'SpawnAgent', 'ListTasks', 'ViewImage', 'EnterWorktree']) expect(page.items.find(m => m.id === id)).toBeUndefined();
    expect(execute).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('failed file writes are failed experience, never a success or rollback promise', async () => {
    const dir = await directory(), workDir = await directory();
    await writeFile(join(workDir, 'parent'), 'do not overwrite');
    const seen = [];
    const s = create(dir, workDir, (input, p) => {
      seen.push(input);
      if (seen.length === 1) use(p, 'catalog.view', { id: 'FileWrite' });
      if (seen.length === 2) use(p, 'FileWrite', { file_path: 'parent/child', content: 'x' });
    });
    await call(s, 'open'); await call(s, 'think', { text: 'Write example', clientMessageId: 'failure' });
    expect((await idle(s)).latestEpisode.status).toBe('completed');
    expect(seen[2].capabilityResult).toMatchObject({ ok: false, code: 'TOOL_FAILED', errorEffect: 'unknown' });
    const traces = (await call(s, 'traces', { limit: 50 })).items;
    expect(traces.find(t => t.kind === 'capability_failed')).toMatchObject({ capabilityId: 'FileWrite', code: 'TOOL_FAILED', capabilityManifest: { id: 'FileWrite', version: 1 } });
    expect(traces.filter(t => t.kind === 'capability_result' && t.capability.id === 'FileWrite')).toEqual([]);
    expect(await readFile(join(workDir, 'parent'), 'utf8')).toBe('do not overwrite');
  });

  it.each(['cancel', 'close'])('%s joins an already-started asynchronous write and admits no overlapping local effects', async mode => {
    const dir = await directory(), workDir = await directory();
    let started, release;
    const began = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const real = fileWrite.execute;
    vi.spyOn(fileWrite, 'execute').mockImplementation(async (input, ctx) => { started(); await gate; return real(input, ctx); });
    let n = 0;
    const s = create(dir, workDir, (_input, p) => {
      if (++n === 1) use(p, 'catalog.view', { id: 'FileWrite' });
      if (n === 2) use(p, 'FileWrite', { file_path: 'effect.txt', content: 'completed effect' });
    });
    await call(s, 'open'); const admission = await call(s, 'think', { text: 'Write', clientMessageId: 'cancel-write' });
    await began;
    let completed = false;
    const stopping = (mode === 'cancel' ? call(s, 'cancel', { episodeId: admission.episodeId }) : s.close()).then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(completed).toBe(false);
    let repeated;
    if (mode === 'cancel') {
      await expect(call(s, 'think', { text: 'Overlap', clientMessageId: 'overlap' })).rejects.toMatchObject({ code: 'BUSY' });
      let repeatCompleted = false;
      repeated = call(s, 'cancel', { episodeId: admission.episodeId }).then(result => { repeatCompleted = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 20)); expect(repeatCompleted).toBe(false);
    }
    release(); await stopping; await repeated;
    expect(await readFile(join(workDir, 'effect.txt'), 'utf8')).toBe('completed effect');
    expect(n).toBe(2);
  });

  it('network cancellation reaches the real tool AbortSignal and is joined', async () => {
    let started, joined = false;
    const began = new Promise(resolve => { started = resolve; });
    vi.stubGlobal('fetch', async (_url, { signal }) => {
      started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      await new Promise(resolve => setTimeout(resolve, 20)); joined = true;
      throw signal.reason;
    });
    const controller = new AbortController(), host = createPersonToolHost({ workDir: await directory(), yeaftDir: await directory(), config });
    const pending = host.execute('WebFetch', { url: 'https://cancel.invalid' }, { signal: controller.signal, callId: 'c', episodeId: 'e' });
    await began; controller.abort(new PersonError('CANCELLED'));
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' }); expect(joined).toBe(true);
  });

  it('registry timeout joins the underlying promise and cannot become a safe success', async () => {
    let finished = false;
    vi.spyOn(fileWrite, 'execute').mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 35)); finished = true; return 'late success'; });
    const old = fileWrite.timeoutMs; fileWrite.timeoutMs = 5;
    try {
      const host = createPersonToolHost({ workDir: await directory(), yeaftDir: await directory(), config });
      const result = await host.execute('FileWrite', { file_path: 'x', content: 'x' });
      expect(finished).toBe(true);
      expect(result).toMatchObject({ ok: false, code: 'TOOL_TIMEOUT', terminal: true, errorEffect: 'unknown', replaySafe: false });
    } finally { fileWrite.timeoutMs = old; }
  });

  it('unknown shell termination is terminal rather than replay-safe or success', async () => {
    vi.spyOn(bash, 'execute').mockResolvedValue(JSON.stringify({ error: 'timeout', code: 'bash_timeout_unconfirmed', failureType: 'timeout_unconfirmed', errorEffect: 'unknown' }));
    const host = createPersonToolHost({ workDir: await directory(), yeaftDir: await directory(), config });
    expect(await host.execute('Bash', { command: 'unknown' })).toMatchObject({ ok: false, terminal: true, replaySafe: false, errorEffect: 'unknown' });
  });
});
