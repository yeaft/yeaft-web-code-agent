import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import fileEdit from '../../../../agent/yeaft/tools/file-edit.js';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';

import { validateToolArguments } from '../../../../agent/yeaft/person/tool-arguments.js';

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

});
