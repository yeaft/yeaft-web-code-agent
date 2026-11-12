import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { CORE_TEST_FILES, E2E_TEST_FILES, REVIEWED_TEST_FILES, isTestFile } from '../scripts/test-suite-manifest.mjs';
import {
  assertCollectedTestFiles,
  assertUnfilteredUnitRun,
  checkCaseBudget,
  collectBrowserCases,
  collectUnitCases,
  countBrowserCases,
  isMainModule,
  TEST_CASE_LIMIT,
  validateCoreTestFiles,
} from '../scripts/check-test-budget.mjs';

const nodeModules = dirname(dirname(createRequire(import.meta.url).resolve('vitest/package.json')));

describe('test budget gate', () => {
  it('rejects missing or unreviewed unit and browser files', () => {
    const missingResult = validateCoreTestFiles({ files: [] });
    expect(missingResult.missing).toContain(CORE_TEST_FILES[0]);
    expect(missingResult.missing).toContain(E2E_TEST_FILES[0]);
    const unexpectedResult = validateCoreTestFiles({ files: ['test/new-regression.test.js', 'e2e/tests/new.spec.js'] });
    expect(unexpectedResult.unexpected).toEqual(['e2e/tests/new.spec.js', 'test/new-regression.test.js']);
    expect(validateCoreTestFiles({ files: REVIEWED_TEST_FILES })).toEqual({ missing: [], unexpected: [], count: REVIEWED_TEST_FILES.length });
    expect(REVIEWED_TEST_FILES).toEqual([...CORE_TEST_FILES, ...E2E_TEST_FILES]);
    expect(new Set(REVIEWED_TEST_FILES).size).toBe(REVIEWED_TEST_FILES.length);
    expect(() => assertCollectedTestFiles(CORE_TEST_FILES, { expectedFiles: CORE_TEST_FILES, label: 'Unit' })).not.toThrow();
    for (const files of [CORE_TEST_FILES.slice(1), [...CORE_TEST_FILES, CORE_TEST_FILES[0]], [...CORE_TEST_FILES, 'test/unreviewed.test.js']]) {
      expect(() => assertCollectedTestFiles(files, { expectedFiles: CORE_TEST_FILES, label: 'Unit' })).toThrow('incomplete or filtered');
    }
    for (const config of [
      { testNamePattern: /only this/ }, { related: ['source.js'] }, { changed: true },
      { shard: { index: 1, count: 2 } }, { project: ['subset'] }, { filters: ['subset'] },
      { tagsFilter: ['smoke'] }, { bail: 1 }, { experimental: { preParse: true } },
      { allowOnly: true }, { dangerouslyIgnoreUnhandledErrors: true }, { onUnhandledError() {} },
    ]) {
      expect(() => assertUnfilteredUnitRun({ config, projects: [] }, [])).toThrow('must not be filtered');
      expect(() => assertUnfilteredUnitRun({ config: {}, projects: [{ config }] }, [])).toThrow('must not be filtered');
    }
    for (const specification of [{ testNamePattern: /subset/ }, { testLines: [1] }, { testIds: ['id'] }, { testTagsFilter: ['smoke'] }]) {
      expect(() => assertUnfilteredUnitRun({ config: {}, projects: [] }, [specification])).toThrow('filtered specifications');
    }
  });

  it('collects real skip/todo/each cases without executing them and rejects collection errors', async () => {
    expect(isTestFile('e2e/tests/new.spec.js')).toBe(true);
    expect(isTestFile('test/helpers/support.js')).toBe(false);
    const root = await mkdtemp(join(tmpdir(), 'yeaft-budget-fixture-'));
    try {
      await symlink(nodeModules, join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      await writeFile(join(root, 'vitest.config.mjs'), 'export default { test: { include: ["probe.test.js"], pool: "forks", fileParallelism: false } };');
      await writeFile(join(root, 'probe.test.js'), `import { describe, it } from 'vitest';
        const never = () => { throw new Error('test bodies must not execute'); };
        it('normal', never);
        it.skip('skipped', never);
        it.todo('todo');
        it.each([1, 2])('expanded %s', never);
        describe.skip('skipped suite', () => { it('child', never); });
      `);
      expect(await collectUnitCases({ rootDir: root, configFile: 'vitest.config.mjs' })).toBe(6);
      await writeFile(join(root, 'probe.test.js'), 'throw new Error("fixture collection failed");');
      await expect(collectUnitCases({ rootDir: root, configFile: 'vitest.config.mjs' })).rejects.toThrow('fixture collection failed');

      // A real Vitest close hook that never settles must not block the isolated
      // CLI. Collection errors still fail and must never publish a count.
      await writeFile(join(root, 'vitest.config.mjs'), `export default {
        plugins: [{ name: 'blocked-close', configureVitest({ vitest }) {
          vitest.onClose(() => new Promise(() => {}));
        } }],
        test: { include: ['probe.test.js'], pool: 'forks', fileParallelism: false }
      };`);
      const cli = join(process.cwd(), 'scripts/check-test-budget.mjs');
      const output = join(root, 'count.json');
      const run = promisify(execFile);
      await writeFile(join(root, 'probe.test.js'), `import { it } from 'vitest';
        it.skip('must count', () => { throw new Error('must not run'); });`);
      const success = await run(process.execPath, [cli, '--collect-unit', output, 'vitest.config.mjs'], { cwd: root, timeout: 20000 });
      expect(success.stderr).toContain('teardown timed out');
      expect(JSON.parse(await readFile(output, 'utf8'))).toBe(1);
      await rm(output);
      await writeFile(join(root, 'probe.test.js'), 'throw new Error("blocked-close collection failure");');
      await expect(run(process.execPath, [cli, '--collect-unit', output, 'vitest.config.mjs'], { cwd: root, timeout: 20000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('blocked-close collection failure') });
      await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);

  it('executes each module once and gates the live collection without masking failures or filters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yeaft-single-pass-fixture-'));
    const run = promisify(execFile);
    const runner = pathToFileURL(join(process.cwd(), 'scripts/run-test-gate.mjs')).href;
    const config = 'export default { test: { include: ["probe.test.js"], pool: "forks", fileParallelism: false CONFIG } };';
    const source = `import { describe, it } from 'vitest';
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(join(root, 'imports'))}, 'x');
      const body = () => appendFileSync(${JSON.stringify(join(root, 'bodies'))}, 'x');
      it('normal', body);
      it.skip('skip', () => { throw new Error('must not run'); });
      it.todo('todo');
      it.each([1, 2])('each %s', body);
      it.skip.each([1, 2])('skip each %s', body);
      it.todo.each([1, 2])('todo each %s');
      describe.skip('skipped suite', () => { it('child', body); });
      describe.skip.each([1, 2])('nested %s', () => { it.each([1, 2])('child %s', body); });
      it('dynamic skip', ctx => { body(); ctx.skip(); });
    `;
    try {
      await symlink(nodeModules, join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      await writeFile(join(root, 'run.mjs'), `import { runUnitTestsWithBudget } from ${JSON.stringify(runner)};
        try { await runUnitTestsWithBudget({ rootDir: process.cwd(), configFile: 'vitest.config.mjs', expectedFiles: ['probe.test.js'], browser: 2, limit: 17 }); }
        catch (error) { console.error(error.message); process.exitCode = 1; }
      `);
      await writeFile(join(root, 'vitest.config.mjs'), config.replace(' CONFIG', ''));
      await writeFile(join(root, 'probe.test.js'), source);
      const success = await run(process.execPath, ['run.mjs'], { cwd: root, timeout: 15000 });
      expect(success.stdout).toContain('15 cases');
      expect(success.stdout).toContain('17/17 cases');
      expect(await readFile(join(root, 'imports'), 'utf8')).toBe('x');
      expect(await readFile(join(root, 'bodies'), 'utf8')).toBe('xxxx');
      const rejectRun = (message) => expect(run(process.execPath, ['run.mjs'], { cwd: root, timeout: 15000 }))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(message) });
      // Growth, ordinary failures, suite collection errors and unhandled errors
      // all fail using fresh execution, never a previously published count.
      await writeFile(join(root, 'probe.test.js'), `${source}\nit('new case', () => {});`);
      await rejectRun('Test budget exceeded');
      await writeFile(join(root, 'probe.test.js'), "import { it } from 'vitest'; it('failure', () => { throw new Error('fixture assertion failure'); });");
      await rejectRun('fixture assertion failure');
      await writeFile(join(root, 'probe.test.js'), "throw new Error('fixture import failure');");
      await rejectRun('fixture import failure');
      await writeFile(join(root, 'probe.test.js'), "import { describe } from 'vitest'; describe('broken suite', () => { throw new Error('fixture suite failure'); });");
      await rejectRun('fixture suite failure');
      await writeFile(join(root, 'probe.test.js'), "import { it } from 'vitest'; it('unhandled', async () => { Promise.reject(new Error('fixture unhandled failure')); await new Promise(resolve => setTimeout(resolve, 20)); });");
      await rejectRun('fixture unhandled failure');
      await writeFile(join(root, 'probe.test.js'), `${source}\nit.only('focused', () => {});`);
      await rejectRun('only');
      await writeFile(join(root, 'probe.test.js'), source);
      for (const extra of [', testNamePattern: "normal"', ', tagsFilter: ["smoke"]', ', exclude: ["probe.test.js"]', ', include: ["absent.test.js"]']) {
        await writeFile(join(root, 'vitest.config.mjs'), config.replace(' CONFIG', extra));
        await rejectRun(extra.includes('Pattern') || extra.includes('tagsFilter') ? 'must not be filtered' : 'incomplete or filtered');
      }
      await writeFile(join(root, 'other.test.js'), "import { it } from 'vitest'; it('other', () => {});");
      await writeFile(join(root, 'vitest.config.mjs'), config.replace('["probe.test.js"]', '["*.test.js"]').replace(' CONFIG', ', exclude: ["probe.test.js"]'));
      await rejectRun('incomplete or filtered');
      await rm(join(root, 'other.test.js'));
      await writeFile(join(root, 'vitest.config.mjs'), config.replace(' CONFIG', ''));
      await rm(join(root, 'probe.test.js'));
      await rejectRun('incomplete or filtered');
      await expect(run(process.execPath, [join(process.cwd(), 'scripts/run-test-gate.mjs'), '--exclude=anything'], { cwd: root, timeout: 15000 }))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('does not accept filters/options') });
      // Vitest exit() force-exits after a stuck teardown. The budget error
      // must already own the exit code before cleanup can terminate the process.
      await writeFile(join(root, 'probe.test.js'), "import { it } from 'vitest'; for (let i=0;i<18;i++) it('pass '+i,()=>{});");
      await writeFile(join(root, 'global.mjs'), `export default function () {
        return () => { setInterval(() => {}, 1000); return new Promise(() => {}); };
      }`);
      await writeFile(join(root, 'vitest.config.mjs'), config.replace(' CONFIG', ', teardownTimeout: 100, globalSetup: ["./global.mjs"]'));
      const timedOut = await run(process.execPath, ['run.mjs'], { cwd: root, timeout: 15000 }).catch(error => error);
      expect(timedOut.code).toBe(1);
      expect(timedOut.stdout).toContain('20/17 cases');
      expect(timedOut.stderr).toContain('close timed out');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);

  it('only runs the CLI when invoked as the entry module', () => {
    const windowsEntry = 'C:\\repo\\scripts\\check-test-budget.mjs';
    expect(isMainModule(pathToFileURL(windowsEntry).href, windowsEntry)).toBe(true);
    expect(isMainModule(import.meta.url, windowsEntry)).toBe(false);
  });

  it('enforces the combined case budget and rejects invalid counts', () => {
    expect(TEST_CASE_LIMIT).toBe(1022);
    expect(checkCaseBudget({ unit: 914, browser: 108 })).toMatchObject({ total: 1022, exceeded: false });
    expect(checkCaseBudget({ unit: 915, browser: 108 })).toMatchObject({ total: 1023, exceeded: true });
    expect(() => checkCaseBudget({ unit: NaN, browser: 0 })).toThrow('Invalid collected test count');
    expect(() => checkCaseBudget({ unit: -1, browser: 0 })).toThrow('Invalid collected test count');
  });

  it('counts all browser specs, including skipped/parameterized instances, but not project replicas', async () => {
    expect(countBrowserCases({ suites: [{ specs: [{ tests: [{ projectName: 'chromium' }, { projectName: 'smoke', expectedStatus: 'skipped' }] }], suites: [{ specs: [{}, {}] }] }] })).toBe(3);
    expect(() => countBrowserCases({ errors: [{ message: 'broken collection' }] })).toThrow('broken collection');
    const root = await mkdtemp(join(tmpdir(), 'yeaft-browser-budget-fixture-'));
    try {
      await symlink(nodeModules, join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      const config = `export default { testDir: '.', grep: /no match/, grepInvert: /normal/, projects: [{ name: 'one' }, { name: 'two' }] CONFIG };`;
      await writeFile(join(root, 'playwright.config.mjs'), config.replace(' CONFIG', ''));
      await writeFile(join(root, 'probe.spec.js'), `import { test } from '@playwright/test';
        test('normal', () => {});
        test.skip('skipped', () => {});
        test.fixme('todo', () => {});
        for (const n of [1, 2]) test('each ' + n, () => {});
        test.describe.skip('suite', () => { test('child', () => {}); });
      `);
      const collect = () => collectBrowserCases({ rootDir: root, configFile: 'playwright.config.mjs', expectedFiles: ['probe.spec.js'] });
      expect(collect()).toBe(6);
      await writeFile(join(root, 'playwright.config.mjs'), config.replace(' CONFIG', ', testIgnore: ["probe.spec.js"]'));
      expect(collect).toThrow();
      await writeFile(join(root, 'playwright.config.mjs'), config.replace(' CONFIG', ''));
      await writeFile(join(root, 'probe.spec.js'), "throw new Error('browser fixture collection failure');");
      expect(collect).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);
});
