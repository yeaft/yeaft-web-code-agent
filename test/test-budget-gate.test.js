import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { CORE_TEST_FILES, E2E_TEST_FILES, REVIEWED_TEST_FILES, isTestFile } from '../scripts/test-suite-manifest.mjs';
import {
  checkCaseBudget,
  collectUnitCases,
  countBrowserCases,
  isMainModule,
  TEST_CASE_LIMIT,
  validateCoreTestFiles,
} from '../scripts/check-test-budget.mjs';

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
  });

  it('collects real skip/todo/each cases without executing them and rejects collection errors', async () => {
    expect(isTestFile('e2e/tests/new.spec.js')).toBe(true);
    expect(isTestFile('test/helpers/support.js')).toBe(false);
    const root = await mkdtemp(join(tmpdir(), 'yeaft-budget-fixture-'));
    try {
      await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
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

  it('only runs the CLI when invoked as the entry module', () => {
    const windowsEntry = 'C:\\repo\\scripts\\check-test-budget.mjs';
    expect(isMainModule(pathToFileURL(windowsEntry).href, windowsEntry)).toBe(true);
    expect(isMainModule(import.meta.url, windowsEntry)).toBe(false);
  });

  it('enforces the combined case budget and rejects invalid counts', () => {
    expect(TEST_CASE_LIMIT).toBe(755);
    expect(checkCaseBudget({ unit: 673, browser: 82 })).toMatchObject({ total: 755, exceeded: false });
    expect(checkCaseBudget({ unit: 674, browser: 82 })).toMatchObject({ total: 756, exceeded: true });
    expect(() => checkCaseBudget({ unit: NaN, browser: 0 })).toThrow('Invalid collected test count');
    expect(() => checkCaseBudget({ unit: -1, browser: 0 })).toThrow('Invalid collected test count');
  });

  it('counts all browser specs, including skipped/parameterized instances, but not project replicas', () => {
    expect(countBrowserCases({ suites: [{ specs: [{ tests: [{ projectName: 'chromium' }, { projectName: 'smoke', expectedStatus: 'skipped' }] }], suites: [{ specs: [{}, {}] }] }] })).toBe(3);
    expect(() => countBrowserCases({ errors: [{ message: 'broken collection' }] })).toThrow('broken collection');
  });
});
