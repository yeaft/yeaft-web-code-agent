import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CORE_TEST_FILES, E2E_TEST_FILES, REVIEWED_TEST_FILES, isTestFile, normalizeTestPath } from './test-suite-manifest.mjs';

// Reviewed baseline across Vitest AND Playwright, including skipped/each cases.
// Deliberate growth requires reviewing the coverage tradeoff and this budget.
export const TEST_CASE_LIMIT = 500;

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

/** Count logical browser cases once, even when several projects run them. */
export function countBrowserCases(report) {
  if (report.errors?.length) throw new Error(`Browser collection failed: ${report.errors.map(error => error.message).join('; ')}`);
  let count = 0;
  function visit(suites) {
    for (const suite of suites) {
      count += (suite.specs || []).length;
      visit(suite.suites || []);
    }
  }
  visit(report.suites || []);
  return count;
}

export function checkCaseBudget({ unit, browser }, limit = TEST_CASE_LIMIT) {
  for (const count of [unit, browser]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid collected test count');
  }
  const total = unit + browser;
  return { unit, browser, total, limit, exceeded: total > limit };
}

/** Collect every committed case, not just the default Vitest manifest. No tests execute. */
export function collectTestCaseCounts({ rootDir = process.cwd() } = {}) {
  const require = createRequire(import.meta.url);
  const vitestCli = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const playwrightCli = require.resolve('@playwright/test/cli');
  const outputDir = mkdtempSync(resolve(tmpdir(), 'yeaft-test-budget-'));
  const outputFile = resolve(outputDir, 'tests.json');
  try {
    execFileSync(process.execPath, [vitestCli, 'list', '--config=vitest.focus.config.js', `--root=${rootDir}`, `--json=${outputFile}`], {
      cwd: rootDir, stdio: 'pipe', timeout: 180000,
    });
    const unit = JSON.parse(readFileSync(outputFile, 'utf8')).length;
    const browserReport = execFileSync(process.execPath, [playwrightCli, 'test', '--config=e2e/playwright.config.js', '--list', '--reporter=json'], {
      cwd: rootDir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60000,
    });
    return { unit, browser: countBrowserCases(JSON.parse(browserReport)) };
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

export function isMainModule(moduleUrl, entryPath = process.argv[1]) {
  return Boolean(entryPath) && moduleUrl === pathToFileURL(resolve(entryPath)).href;
}

function main() {
  const result = validateCoreTestFiles();
  if (result.missing.length) console.error(`Missing reviewed test files:\n- ${result.missing.join('\n- ')}`);
  if (result.unexpected.length) console.error(`Unreviewed test files:\n- ${result.unexpected.join('\n- ')}`);
  if (result.missing.length || result.unexpected.length) {
    process.exitCode = 1;
    return;
  }

  const budget = checkCaseBudget(collectTestCaseCounts());
  console.log(`Suite: ${CORE_TEST_FILES.length} Vitest files / ${budget.unit} cases + ${E2E_TEST_FILES.length} browser files / ${budget.browser} cases = ${budget.total}/${budget.limit} cases`);
  if (budget.exceeded) {
    console.error('Test budget exceeded. Remove redundant cases or explicitly review a small budget increase for new critical coverage. Do not hide cases with skip or exclude.');
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) main();
