import { describe, expect, it } from 'vitest';
import { runPersonScript, testPersonScript, scriptInput } from '../../../../agent/yeaft/person/script-executor.js';

// Real QuickJS/WASM execution, no mocked VM or claimed Node vm sandbox.
describe('Person pure script executor', () => {
  it('runs parameterized JSON transformations and starts with fresh state', async () => {
    const code = 'globalThis.counter = (globalThis.counter || 0) + 1; return {count:counter, total:input.reduce((a,b)=>a+b,0)};';
    expect(await runPersonScript(code, [1, 2])).toEqual({ ok: true, output: { count: 1, total: 3 } });
    expect(await runPersonScript(code, [8, 4])).toEqual({ ok: true, output: { count: 1, total: 12 } });
    const special = JSON.parse('{"__proto__":{"value":1},"quotes":"\\\"\\n","中文":true}');
    expect(await runPersonScript('return input;', special)).toEqual({ ok: true, output: special });
  });

  it('has no host process, environment, filesystem, network, timers, imports or Node constructors', async () => {
    const code = 'return [typeof process,typeof require,typeof fetch,typeof setTimeout,typeof console,typeof Buffer,(new Function("return typeof process"))()];';
    expect(await runPersonScript(code, null)).toEqual({ ok: true, output: Array(7).fill('undefined') });
    expect((await runPersonScript('return process.env;', null)).ok).toBe(false);
    expect((await runPersonScript('return require("node:fs").readFileSync("/etc/passwd");', null)).ok).toBe(false);
  });

  it.each(['return undefined;', 'return Promise.resolve(1);', 'return NaN;', 'return new Date();', 'return 1n;', 'const a={}; a.a=a; return a;', 'return "a".repeat(20000);', 'throw new Error("secret");', 'return ('])('rejects non-JSON, oversized, erroneous or asynchronous code: %s', async code => {
    const result = await runPersonScript(code, null);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('terminates unbounded CPU and memory without blocking the host', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      expect((await runPersonScript('while(true) {}', null)).ok).toBe(false);
      expect((await runPersonScript('let a=[]; while(true) a.push("x".repeat(100000));', null)).ok).toBe(false);
      expect(ticks).toBeGreaterThan(1);
      expect(await runPersonScript('return input+1;', 2)).toEqual({ ok: true, output: 3 });
    } finally { clearInterval(timer); }
  });

  it('joins cancelled execution and remains usable afterwards', async () => {
    const controller = new AbortController();
    const error = new Error('cancel');
    const running = runPersonScript('while(true){}', null, { signal: controller.signal });
    setTimeout(() => controller.abort(error), 10);
    await expect(running).rejects.toBe(error);
    await expect(runPersonScript('return 1;', null, { signal: controller.signal })).rejects.toBe(error);
    expect(await runPersonScript('return 2;', null)).toEqual({ ok: true, output: 2 });
  });

  it('retains actual test evidence, reports mismatch and never counts a skipped case', async () => {
    const definition = { code: 'return input.reduce((a,b)=>a+b,0);', tests: [{ input: [], expected: 0 }, { input: [2, 4], expected: 6 }] };
    expect(await testPersonScript(definition)).toMatchObject({ ok: true, evidence: { engine: 'quickjs', testsPassed: 2, testedAt: expect.any(String) } });
    definition.tests[1].expected = 7;
    expect(await testPersonScript(definition)).toEqual({ ok: false, code: 'SCRIPT_TEST_FAILED', testsPassed: 1, failedTest: 1, actual: 6 });
  });
  it('compiles only function bodies and cannot falsify output with guest intrinsics', async () => {
    const escape = '})(null); return "42"; const ignored = (function(input) {';
    expect((await runPersonScript(escape, null)).ok).toBe(false);
    expect((await runPersonScript('Number.isFinite=()=>true; return NaN;', null)).ok).toBe(false);
    expect(await runPersonScript('JSON.stringify=()=>"42"; return 0;', null)).toEqual({ ok: true, output: 0 });
    expect((await runPersonScript('let n=0; return {get x(){return n++ === 0 ? 1 : NaN}};', null)).ok).toBe(false);
    expect((await runPersonScript('return {toJSON(){return 42}};', null)).ok).toBe(false);
    expect(await runPersonScript('Object.prototype.toJSON=()=>42; Array.prototype.toJSON=()=>99; Object.keys=()=>[]; return {a:[1,2]};', null)).toEqual({ ok: true, output: {a:[1,2]} });
  });

  it('enforces JSON-encoded byte budgets and never invokes input getters', async () => {
    expect(() => scriptInput('\\'.repeat(8192))).toThrow();
    expect(() => scriptInput('x'.repeat(8190))).not.toThrow();
    expect(() => scriptInput('x'.repeat(8191))).toThrow();
    let accessed = false;
    expect(() => scriptInput({get secret(){accessed = true; return 1}})).toThrow();
    expect(accessed).toBe(false);
  });

  it.each([null, false, 0, ''])('rejects even falsey cancellation reason %s', async reason => {
    const controller = new AbortController();
    const running = runPersonScript('while(true){}', null, { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 1);
    const outcome = await running.then(value => ({resolved:value}), error => ({rejected:error}));
    expect(outcome).toEqual({rejected:reason});
  });

});
