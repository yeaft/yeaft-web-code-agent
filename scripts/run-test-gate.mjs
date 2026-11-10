import process from 'node:process';
import { resolve } from 'node:path';
import { CORE_TEST_FILES } from './test-suite-manifest.mjs';
import {
  assertCollectedTestFiles,
  assertReviewedTestFiles,
  assertUnfilteredUnitRun,
  collectBrowserCases,
  countUnitCases,
  isMainModule,
  reportCaseBudget,
  TEST_CASE_LIMIT,
} from './check-test-budget.mjs';

/** Execute once; only this run's public Vitest collection can satisfy the gate. */
export async function runUnitTestsWithBudget({
  rootDir = process.cwd(), configFile = 'vitest.config.js', expectedFiles = CORE_TEST_FILES,
  browser, limit = TEST_CASE_LIMIT,
} = {}) {
  // Match Vitest CLI's environment before config/module imports.
  process.env.TEST = 'true';
  process.env.VITEST = 'true';
  process.env.NODE_ENV ??= 'test';
  const { createVitest } = await import('vitest/node');
  let context;
  let reason;
  const reporter = {
    onTestRunStart(specifications) {
      assertUnfilteredUnitRun(context, specifications);
      assertCollectedTestFiles(specifications.map(specification => specification.moduleId), { rootDir, expectedFiles, label: 'Unit' });
    },
    onTestRunEnd(_modules, _errors, endReason) { reason = endReason; },
  };
  context = await createVitest('test', {
    root: rootDir, config: resolve(rootDir, configFile), watch: false,
    allowOnly: false, fileParallelism: false, reporters: ['default', reporter],
  });
  try {
    assertUnfilteredUnitRun(context, []);
    const result = await context.start();
    const unit = countUnitCases(result, { rootDir, expectedFiles, executed: true });
    if (reason !== 'passed') throw new Error(`Unit test run did not complete successfully: ${reason || 'no end event'}`);
    return reportCaseBudget({ unit, browser }, limit);
  } finally {
    // Use Vitest's own CLI teardown/timeout semantics; never force success.
    await context.exit();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error('npm test does not accept filters/options; use npm run test:focus -- <files/options>');
    assertReviewedTestFiles();
    const browser = collectBrowserCases();
    await runUnitTestsWithBudget({ browser });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
