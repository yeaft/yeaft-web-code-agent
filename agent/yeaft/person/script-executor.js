import { Worker } from 'node:worker_threads';
import { isDeepStrictEqual } from 'node:util';
import { bytes, fail } from './contracts.js';

const MAX_WORKERS = 4;
let active = 0;

/** JSON-only values, bounded before crossing the guest boundary. */
export function scriptInput(value) {
  let remaining = 8192;
  const ancestors = new Set();
  const spend = n => { remaining -= n; if (remaining < 0) fail('INVALID_REQUEST'); };
  function visit(v, depth) {
    if (depth > 32) fail('INVALID_REQUEST');
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) { spend(bytes(JSON.stringify(v))); return; }
    if (!v || typeof v !== 'object' || ancestors.has(v) || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) fail('INVALID_REQUEST');
    const array = Array.isArray(v), keys = Object.keys(v);
    if (Reflect.ownKeys(v).length !== keys.length + (array ? 1 : 0) || (array && keys.length !== v.length)) fail('INVALID_REQUEST');
    spend(2 + Math.max(0, keys.length - 1)); ancestors.add(v);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i], d = Object.getOwnPropertyDescriptor(v, key);
      if (!Object.hasOwn(d, 'value') || (array && key !== String(i))) fail('INVALID_REQUEST');
      if (!array) spend(bytes(JSON.stringify(key)) + 1);
      visit(d.value, depth + 1);
    }
    ancestors.delete(v);
  }
  visit(value, 0);
  return value;
}

/** Pure JSON -> JSON computation. No permissions can be requested by guest code.
 * Worker is joined on success, failure and cancellation; no user script lives on.
 * This does not claim arbitrary native-code isolation or semantic correctness. */
export async function runPersonScript(code, input, { signal } = {}) {
  signal?.throwIfAborted();
  if (typeof code !== 'string' || !code.trim() || bytes(code) > 8192) fail('INVALID_REQUEST');
  scriptInput(input);
  if (active >= MAX_WORKERS) return { ok: false, code: 'SCRIPT_BUSY' };
  active++;
  let worker, timer, onAbort;
  try {
    return await new Promise((resolve, reject) => {
      let finished = false;
      const finish = async (result, cancelled = false) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        await worker?.terminate().catch(() => {});
        if (cancelled) reject(signal.reason); else resolve(result);
      };
      onAbort = () => finish(null, true);
      try {
        worker = new Worker(new URL('./script-worker.js', import.meta.url), {
          workerData: { code, input }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
        });
        worker.on('message', result => {
          try {
            if (result?.ok === true) scriptInput(result.output);
            else if (result?.ok !== false) throw new Error('Invalid worker result');
            void finish(result);
          } catch { void finish({ ok: false, code: 'SCRIPT_OUTPUT' }); }
        });
        worker.on('error', () => { void finish({ ok: false, code: 'SCRIPT_EXECUTION' }); });
        worker.on('exit', () => { void finish({ ok: false, code: 'SCRIPT_EXECUTION' }); });
        timer = setTimeout(() => { void finish({ ok: false, code: 'SCRIPT_TIMEOUT' }); }, 3000);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      } catch { void finish({ ok: false, code: 'SCRIPT_EXECUTION' }); }
    });
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    active--;
  }
}

/** Every case gets a fresh VM; test output is evidence only for the supplied cases. */
export async function testPersonScript(definition, { signal } = {}) {
  let testsPassed = 0;
  for (const [index, test] of definition.tests.entries()) {
    const result = await runPersonScript(definition.code, test.input, { signal });
    signal?.throwIfAborted();
    if (!result.ok) return { ...result, testsPassed, failedTest: index };
    if (!isDeepStrictEqual(result.output, test.expected)) return { ok: false, code: 'SCRIPT_TEST_FAILED', testsPassed, failedTest: index, actual: result.output };
    testsPassed++;
  }
  return { ok: true, evidence: { engine: 'quickjs', testsPassed, testedAt: new Date().toISOString() } };
}
