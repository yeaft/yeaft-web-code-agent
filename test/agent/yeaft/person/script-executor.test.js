import { describe, expect, it } from 'vitest';

import { runPersonScript } from '../../../../agent/yeaft/person/script-executor.js';

// Real QuickJS/WASM execution, no mocked VM or claimed Node vm sandbox.
describe('Person pure script executor', () => {
  it('has no host process, environment, filesystem, network, timers, imports or Node constructors', async () => {
    const code = 'return [typeof process,typeof require,typeof fetch,typeof setTimeout,typeof console,typeof Buffer,(new Function("return typeof process"))()];';
    expect(await runPersonScript(code, null)).toEqual({ ok: true, output: Array(7).fill('undefined') });
    expect((await runPersonScript('return process.env;', null)).ok).toBe(false);
    expect((await runPersonScript('return require("node:fs").readFileSync("/etc/passwd");', null)).ok).toBe(false);
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

});
