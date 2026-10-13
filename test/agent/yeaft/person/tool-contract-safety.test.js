import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import fileEdit from '../../../../agent/yeaft/tools/file-edit.js';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { NATIVE_TOOL_MANIFESTS } from '../../../../agent/yeaft/person/native-tools.js';
import { validateToolArguments } from '../../../../agent/yeaft/person/tool-arguments.js';
import { PersonError } from '../../../../agent/yeaft/person/contracts.js';

const definition = () => ({ id: 'Script.identity', expectedVersion: 0, description: 'Identity', useWhen: 'Copy JSON', avoidWhen: '',
  inputDescription: 'JSON', outputDescription: 'JSON', code: 'return input;', tests: [{ input: 1, expected: 1 }] });
const setup = (repository = {}, options = {}) => {
  const cap = new PersonCapabilities(repository, 'owner', options);
  const tools = cap.executionTools();
  const schema = id => tools.find(t => t.name === id.replaceAll('.', '__')).parameters;
  const preflight = (id, args) => {
    validateToolArguments(args, schema(id));
    cap.preflight(cap.invocation(id.replaceAll('.', '__'), args));
  };
  return { cap, tools, schema, preflight };
};
const dirs = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('Person native tool safety contracts', () => {
  it('rejects an empty FileEdit needle in the canonical and emitted schemas', async () => {
    const execute = vi.fn();
    const { schema, preflight } = setup({}, { toolHost: { allowedToolIds: () => ['FileEdit'], execute } });
    expect(fileEdit.parameters.properties.old_string.minLength).toBe(1);
    expect(schema('FileEdit').properties.old_string.minLength).toBe(1);
    expect(() => preflight('FileEdit', { file_path: 'file', old_string: '', new_string: 'x' })).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_INPUT' }));
    expect(execute).not.toHaveBeenCalled();
    // Guard bypassing schema validation before even consulting the execution cwd.
    const result = await fileEdit.execute({ file_path: 'file', old_string: '', new_string: 'x' }, {
      get cwd() { throw new Error('filesystem dispatch must not begin'); },
    });
    expect(JSON.parse(result)).toMatchObject({ errorEffect: 'none', error: 'old_string must be non-empty text' });
  });

  it.each([false, true])('empty FileEdit remains bounded and inert on an existing file (replace_all=%s)', async replace_all => {
    const dir = await mkdtemp(join(tmpdir(), 'person-edit-safety-')); dirs.push(dir);
    const path = join(dir, 'file'); await writeFile(path, 'unchanged');
    // Bound the regression independently: the old synchronous infinite loop
    // would block Vitest's timeout if executed on its own thread.
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.module).then(async ({ default: tool }) => {
        parentPort.postMessage(await tool.execute(workerData.args, {}));
      }).catch(error => { throw error; });
    `, { eval: true, workerData: { module: new URL('../../../../agent/yeaft/tools/file-edit.js', import.meta.url).href,
      args: { file_path: path, old_string: '', new_string: 'x', replace_all } } });
    let timer;
    try {
      const result = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('FileEdit blocked on an empty needle')), 2000);
        worker.once('message', resolve); worker.once('error', reject);
      });
      expect(JSON.parse(result)).toMatchObject({ errorEffect: 'none', error: 'old_string must be non-empty text' });
      expect(await readFile(path, 'utf8')).toBe('unchanged');
    } finally { clearTimeout(timer); await worker.terminate(); }
  });

  it('advertises closed native root arguments without removing nested schema constraints', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const { cap, schema, preflight } = setup({}, { toolHost: { execute } });
    for (const manifest of NATIVE_TOOL_MANIFESTS) {
      expect(schema(manifest.id)).toEqual({ ...manifest.args, additionalProperties: false });
      const args = Object.fromEntries((manifest.args.required ?? []).map(key => [key, 'placeholder']));
      expect(() => validateToolArguments({ ...args, unexpected: true }, schema(manifest.id))).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_INPUT' }));
    }
    expect(() => preflight('FileWrite', { file_path: 'file', content: 'text' })).not.toThrow();
    await expect(cap.execute({ id: 'FileWrite', args: { file_path: 'file', content: 'text', unexpected: true } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
    await cap.execute({ id: 'FileWrite', args: { file_path: 'file', content: 'text' } });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('keeps Output.publish exactly-one sources in the wire schema', () => {
    const { schema } = setup();
    expect(schema('Output.publish').oneOf).toEqual([{ required: ['file_path'] }, { required: ['url'] }]);
    for (const args of [{}, { file_path: 'a', url: 'https://example.com' }]) {
      expect(() => validateToolArguments(args, schema('Output.publish'))).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_INPUT' }));
    }
    for (const args of [{ file_path: 'a' }, { url: 'https://example.com', title: 'Link' }]) {
      expect(() => validateToolArguments(args, schema('Output.publish'))).not.toThrow();
    }
  });

  it('expresses required identifiers, lengths, safe offsets and creation constraints', () => {
    const { preflight, schema } = setup();
    for (const [id, args] of [
      ['Execution.read', {}], ['Execution.read', { callId: 'x'.repeat(129) }],
      ['Execution.read', { callId: 'valid', episodeId: '../foreign' }],
      ['Execution.read', { callId: 'valid', offset: Number.MAX_SAFE_INTEGER + 1 }],
      ['Execution.read', { callId: 'valid', maxBytes: 3 }],
      ['catalog.view', { id: 'x'.repeat(129) }],
      ['Capability.create', { ...definition(), id: 'Script.Bad' }],
      ['Capability.create', { ...definition(), id: `Script.${'x'.repeat(49)}` }],
      ['Capability.create', { ...definition(), expectedVersion: Number.MAX_SAFE_INTEGER + 1 }],
      ['Capability.create', { ...definition(), description: 'x'.repeat(401) }],
      ['Capability.create', { ...definition(), code: 'x'.repeat(8193) }],
      ['Capability.create', { ...definition(), tests: [] }],
      ['Capability.create', { ...definition(), tests: [{ input: 1 }] }],
    ]) expect(() => validateToolArguments(args, schema(id))).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_INPUT' }));
    expect(() => preflight('Capability.create', definition())).not.toThrow();
    expect(() => preflight('Execution.read', { callId: 'valid', episodeId: 'ep', offset: Number.MAX_SAFE_INTEGER, maxBytes: 4 })).not.toThrow();
  });

  it('preflights byte budgets and cross-field semantics without executing IO or scripts', () => {
    const effect = vi.fn(() => { throw new Error('must not execute'); });
    const { preflight, schema } = setup({ recall: effect, saveCreatedCapability: effect, saveOutput: effect, executionRead: effect },
      { episode: { id: 'ep', ownerId: 'owner' }, toolHost: { execute: effect } });
    for (const [id, args] of [
      ['Output.publish', { url: 'https://user:secret@example.com' }],
      ['Output.publish', { url: 'https://example.com', title: '中'.repeat(81) }],
      ['Capability.create', { ...definition(), description: '中'.repeat(134) }],
      ['Capability.create', { ...definition(), tests: [{ input: 'x'.repeat(4096), expected: 1 }] }],
      ['Capability.create', { ...definition(), tests: Array.from({ length: 8 }, () => ({ input: 'x'.repeat(3000), expected: 'x'.repeat(3000) })) }],
      ['Recall', { kind: 'messages', query: '中'.repeat(67) }],
      ['Recall', { kind: 'messages', cursor: 'not-a-page' }],
      ['PresentResponse', { summary: 'Verified', blocks: [{ type: 'chart', style: 'bar', labels: ['one'], series: [{ label: 'series', values: [1, 2] }] }] }],
    ]) {
      expect(() => validateToolArguments(args, schema(id))).not.toThrow();
      expect(() => preflight(id, args)).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_INPUT' }));
    }
    expect(effect).not.toHaveBeenCalled();
    expect(() => preflight('Recall', { kind: 'messages', cursor: 'lm:0123456789abcdef0123456789abcdef:1' })).not.toThrow();
  });

  it('preflights created-script JSON budgets without invoking the guest', () => {
    const record = { ...definition(), version: 1, revision: 'current' };
    const { preflight, schema } = setup({}, { created: [record] });
    expect(schema(record.id).required).toEqual(['input']);
    expect(() => validateToolArguments({}, schema(record.id))).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_INPUT' }));
    expect(() => preflight(record.id, { input: 'x'.repeat(8192) })).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_INPUT' }));
    expect(() => preflight(record.id, { input: { valid: [1, null, true] } })).not.toThrow();
  });

  it('never disguises repository or host failures as retry-safe argument errors', async () => {
    const error = new PersonError('INVALID_REQUEST');
    const recall = vi.fn(async () => { throw error; });
    const execute = vi.fn(async () => { throw error; });
    const { cap, preflight } = setup({ recall }, { toolHost: { execute } });
    for (const [id, args] of [['Recall', { kind: 'messages' }], ['FileWrite', { file_path: 'file', content: 'text' }]]) {
      expect(() => preflight(id, args)).not.toThrow();
      await expect(cap.execute({ id, args })).rejects.toBe(error);
    }
    expect(recall).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce();
  });

  it('validates composed/boolean schemas without dropping exactly-one constraints', () => {
    const schema = { type: 'object', properties: { left: { type: 'string' }, right: { type: 'string' } },
      additionalProperties: false, allOf: [{ oneOf: [{ required: ['left'] }, { required: ['right'] }] }, { not: { required: ['forbidden'] } }] };
    expect(() => validateToolArguments({ left: 'yes' }, schema)).not.toThrow();
    expect(() => validateToolArguments({ left: 'yes', right: 'no' }, schema)).toThrow();
    expect(() => validateToolArguments({}, false)).toThrow();
    expect(() => validateToolArguments({ extra: 1 }, { type: 'object', additionalProperties: { type: 'string' } })).toThrow();
    expect(() => validateToolArguments({ extra: 'ok' }, { type: 'object', additionalProperties: { type: 'string' } })).not.toThrow();
  });
});
