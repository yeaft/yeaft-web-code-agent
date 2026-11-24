import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CORE_TEST_FILES, E2E_TEST_FILES, REVIEWED_TEST_FILES, isTestFile, normalizeTestPath } from './test-suite-manifest.mjs';

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

export function validateCoreTestFiles({ rootDir = process.cwd(), files = null } = {}) {
  const discovered = new Set((files || [...walkFiles(resolve(rootDir, 'test')), ...walkFiles(resolve(rootDir, 'e2e/tests'))])
    .map(file => normalizeTestPath(relative(rootDir, resolve(rootDir, file))))
    .filter(isTestFile));
  const expected = new Set(REVIEWED_TEST_FILES);
  const missing = REVIEWED_TEST_FILES.filter(file => !discovered.has(file));
  const unexpected = [...discovered].filter(file => !expected.has(file)).sort();
  return { missing, unexpected, count: discovered.size };
}

/** Require the current collection, not a count/cache, to cover the reviewed files. */
export function assertCollectedTestFiles(files, { rootDir = process.cwd(), expectedFiles, label }) {
  const collected = files.map(file => normalizeTestPath(relative(rootDir, resolve(rootDir, file))));
  const expected = new Set(expectedFiles);
  const missing = expectedFiles.filter(file => !collected.includes(file));
  const unexpected = collected.filter(file => !expected.has(file));
  if (missing.length || unexpected.length || new Set(collected).size !== collected.length) {
    throw new Error(`${label} collection incomplete or filtered: missing [${missing.join(', ')}], unexpected [${unexpected.join(', ')}], duplicate files: ${new Set(collected).size !== collected.length}`);
  }
}

/** Count logical browser cases once, even when several projects run them. */
export function countBrowserCases(report, { rootDir = process.cwd(), expectedFiles } = {}) {
  if (report.errors?.length) throw new Error(`Browser collection failed: ${report.errors.map(error => error.message).join('; ')}`);
  let count = 0;
  function visit(suites) {
    for (const suite of suites) {
      count += (suite.specs || []).length;
      visit(suite.suites || []);
    }
  }
  visit(report.suites || []);
  if (expectedFiles) {
    if (!report.config?.rootDir || report.config.shard) throw new Error('Browser collection incomplete or filtered');
    assertCollectedTestFiles((report.suites || []).map(suite => resolve(report.config.rootDir, suite.file)), {
      rootDir, expectedFiles, label: 'Browser',
    });
    if (!count) throw new Error('Browser collection incomplete');
  }
  return count;
}

/** Public Vitest collections include skip/todo and expanded each cases. */
export function countUnitCases(result, { rootDir = process.cwd(), expectedFiles, executed = false } = {}) {
  const errors = [...result.unhandledErrors];
  let count = 0;
  for (const module of result.testModules) {
    errors.push(...module.errors());
    for (const suite of module.children.allSuites()) errors.push(...suite.errors());
    if (executed && !module.ok()) errors.push(new Error(`Tests failed or incomplete: ${module.moduleId}`));
    for (const test of module.children.allTests()) {
      count++;
      if (executed && test.result().state === 'pending') errors.push(new Error(`Test did not finish: ${test.fullName}`));
    }
  }
  if (errors.length) throw new Error(`Unit collection/execution failed: ${errors.map(error => error?.message || String(error)).join('; ')}`);
  if (expectedFiles) assertCollectedTestFiles(result.testModules.map(module => module.moduleId), { rootDir, expectedFiles, label: 'Unit' });
  if (!count) throw new Error('Unit collection incomplete');
  return count;
}

/** Close collection resources without blocking an isolated collector forever. */
export async function closeUnitCollector(context, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      context.close().then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Reject run/collection filters even when they leave every file in the list. */
export function assertUnfilteredUnitRun(context, specifications) {
  for (const config of [context.config, ...context.projects.map(project => project.config)]) {
    if (config.testNamePattern || config.changed || config.related?.length || config.project?.length
      || config.filters?.length || config.shard || config.tagsFilter?.length || config.bail
      || config.experimental?.preParse || config.allowOnly === true
      || config.dangerouslyIgnoreUnhandledErrors || config.onUnhandledError) {
      throw new Error('Unit collection/execution must not be filtered or ignore errors');
    }
  }
  if (specifications.some(specification => specification.testNamePattern || specification.testLines?.length
    || specification.testIds?.length || specification.testTagsFilter?.length)) {
    throw new Error('Unit collection/execution must not use filtered specifications');
  }
}

/** Vitest CLI list drops skip/todo. The public collection API retains them. */
export async function collectUnitCases({ rootDir = process.cwd(), configFile = 'vitest.focus.config.js', expectedFiles } = {}) {
  const { createVitest } = await import('vitest/node');
  const context = await createVitest('test', {
    root: rootDir, config: resolve(rootDir, configFile), watch: false, reporters: [], allowOnly: false,
  });
  try {
    await context.standalone();
    const specifications = await context.globTestSpecifications();
    assertUnfilteredUnitRun(context, specifications);
    if (expectedFiles) assertCollectedTestFiles(specifications.map(specification => specification.moduleId), { rootDir, expectedFiles, label: 'Unit' });
    const result = await context.collectTests(specifications);
    return countUnitCases(result, { rootDir, expectedFiles: expectedFiles || specifications.map(specification => normalizeTestPath(relative(rootDir, specification.moduleId))) });
  } finally {
    if (!await closeUnitCollector(context)) {
      console.warn('Unit collection teardown timed out; exiting isolated collector after validated collection.');
    }
  }
}

/** Browser list is always fresh and unfiltered, regardless of configured grep. */
export function collectBrowserCases({ rootDir = process.cwd(), configFile = 'e2e/playwright.config.js', expectedFiles = E2E_TEST_FILES } = {}) {
  const require = createRequire(import.meta.url);
  const wrapper = resolve(dirname(fileURLToPath(import.meta.url)), 'test-suite-playwright.config.mjs');
  const browserReport = execFileSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', `--config=${wrapper}`,
    '--list', '--reporter=json', '--forbid-only'], {
    cwd: rootDir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60000,
    env: { ...process.env, YEAFT_TEST_SUITE_PLAYWRIGHT_CONFIG: resolve(rootDir, configFile) },
  });
  return countBrowserCases(JSON.parse(browserReport), { rootDir, expectedFiles });
}

/** Bound the isolated collector so import side effects cannot hang the gate. */
export function collectTestCaseCounts({ rootDir = process.cwd() } = {}) {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'yeaft-test-suite-'));
  const outputFile = resolve(outputDir, 'tests.json');
  try {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--collect-unit', outputFile, 'vitest.focus.config.js', '--reviewed'], {
      cwd: rootDir, stdio: 'pipe', timeout: 180000,
    });
    const unit = JSON.parse(readFileSync(outputFile, 'utf8'));
    return { unit, browser: collectBrowserCases({ rootDir }) };
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

export function isMainModule(moduleUrl, entryPath = process.argv[1]) {
  return Boolean(entryPath) && moduleUrl === pathToFileURL(resolve(entryPath)).href;
}

export function assertReviewedTestFiles({ rootDir = process.cwd() } = {}) {
  const result = validateCoreTestFiles({ rootDir });
  if (result.missing.length || result.unexpected.length) {
    throw new Error(`Missing reviewed test files: [${result.missing.join(', ')}]; Unreviewed test files: [${result.unexpected.join(', ')}]`);
  }
}

export function reportCaseCounts({ unit, browser }) {
  for (const count of [unit, browser]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid collected test count');
  }
  const total = unit + browser;
  console.log(`Suite: ${unit} Vitest cases + ${browser} browser cases = ${total} cases`);
  return { unit, browser, total };
}

function main() {
  try {
    assertReviewedTestFiles();
    reportCaseCounts(collectTestCaseCounts());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  if (process.argv[2] === '--collect-unit') {
    try {
      writeFileSync(process.argv[3], JSON.stringify(await collectUnitCases({
        configFile: process.argv[4] || 'vitest.focus.config.js',
        expectedFiles: process.argv[5] === '--reviewed' ? CORE_TEST_FILES : undefined,
      })));
      // Some collected modules open DB workers at import time. No test body ran;
      // exit the isolated process instead of waiting on those unrelated handles.
      process.exit(0);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  } else main();
}
