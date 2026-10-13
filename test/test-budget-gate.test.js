import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { CORE_TEST_FILES, E2E_TEST_FILES, REVIEWED_TEST_FILES, isTestFile } from '../scripts/test-suite-manifest.mjs';
import {
  checkCaseBudget,
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

  it('recognizes test files without counting support modules', () => {
    expect(isTestFile('e2e/tests/new.spec.js')).toBe(true);
    expect(isTestFile('test/new.test.js')).toBe(true);
    expect(isTestFile('test/helpers/support.js')).toBe(false);
    expect(isTestFile('e2e/helpers/support.js')).toBe(false);
  });

  it('only runs the CLI when invoked as the entry module', () => {
    const windowsEntry = 'C:\\repo\\scripts\\check-test-budget.mjs';
    expect(isMainModule(pathToFileURL(windowsEntry).href, windowsEntry)).toBe(true);
    expect(isMainModule(import.meta.url, windowsEntry)).toBe(false);
  });

  it('enforces the combined case budget and rejects invalid counts', () => {
    expect(TEST_CASE_LIMIT).toBe(500);
    expect(checkCaseBudget({ unit: 450, browser: 50 })).toMatchObject({ total: 500, exceeded: false });
    expect(checkCaseBudget({ unit: 451, browser: 50 })).toMatchObject({ total: 501, exceeded: true });
    expect(() => checkCaseBudget({ unit: NaN, browser: 0 })).toThrow('Invalid collected test count');
    expect(() => checkCaseBudget({ unit: -1, browser: 0 })).toThrow('Invalid collected test count');
  });

  it('counts all browser specs, including skipped/parameterized instances, but not project replicas', () => {
    expect(countBrowserCases({ suites: [{ specs: [{ tests: [{ projectName: 'chromium' }, { projectName: 'smoke', expectedStatus: 'skipped' }] }], suites: [{ specs: [{}, {}] }] }] })).toBe(3);
    expect(() => countBrowserCases({ errors: [{ message: 'broken collection' }] })).toThrow('broken collection');
  });
});
