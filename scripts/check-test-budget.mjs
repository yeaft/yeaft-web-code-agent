import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CORE_TEST_FILES, E2E_TEST_FILES, REVIEWED_TEST_FILES, isTestFile, normalizeTestPath } from './test-suite-manifest.mjs';

// Reviewed baseline across Vitest AND Playwright, including skipped/each cases.
// Deliberate growth requires reviewing the coverage tradeoff and this budget.
// +1 distinct safety regression: scoped task archive recovery across restart.
// Recoverable read -> actual edit/validation extends the existing SQLite loop case.
// +37 reviewed user-centered Person closure/autonomy regressions:
// 8 goal validation + 3 host wait/control + 2 native continuation/no-progress;
// 9 durable scheduler/provenance + 5 user understanding/Dream context/behavior;
// 2 test-adapter non-replay + 6 UI polling/consent + 2 light/dark browser cases.
// These cover distinct new protocol/control boundaries; existing cases are retained.
// +3 query-progress boundaries: bridge side effects, frontend ownership, browser lifecycle.
// +24: history boundary (7), progress evidence (9), Engine lifecycle (6),
// and delegation identity/result-revision safety (2). No retired cases excluded.
// +6 PR #1846 review regressions: repaired-command revalidation, distinct negative
// reads, two reporting-time completion paths, timeout safety, validation blockers.
// Delegation/UI recovery extend existing lifecycle cases without extra cases.
// +6 SVG preview boundaries: editable/default mode, opaque URL/stale decode,
// responsive edit/undo/save/zoom, animated image security, invalid-source recovery,
// and zoom ownership disposal. Legacy string API coverage extends the URL case.
// +34 reviewed live-inbox boundaries: 18 storage/runtime delivery and dispatch
// regressions, 2 cancellation-generation interleavings, 10 UI/controller state
// and attribution cases, 2 mock-UI and 2 real relay/SQLite/filesystem browser cases.
// Related assertions extend existing cases; no prior coverage is excluded.
// +3 VP inspector boundaries: execution/reuse/skip accounting, streamed usage
// cache/retry deltas, and accessible token/failure disclosure with legacy frames.
// Bounded metadata/security and mobile layout extend existing cases.
// +4 reviewed Person navigation browser cases: short-reply reserve exit and
// Latest ownership while history is pending, each on desktop/light and 320px/dark.
// Origin identity and follow-growth assertions extend existing cases.
// +37 reviewed tool-reliability regressions: 6 project-document write gates,
// 3 GitRead argument boundaries, 3 image ownership/size cases, 18 web
// lifecycle/evidence/query-isolation/presentation, and 7 recent-stats/UI cases.
// Historical failures and all existing safety checks remain visible.
// +2 review regressions: web advice is not evidence; diagnostic credentials stay private.
// +10 reviewed pressure-compaction boundaries: 7 provider-copy cases covering
// low pressure, protocol/text/error preservation, structured JSON, parallel batches,
// Unicode accounting, multimodal integrity and bounded fallback; 1 Engine overflow
// recovery/non-replay case and 2 actual-delivery async acknowledgement windows.
// Reflection removal extends the existing long-investigation case; none excluded.
// +2 review regressions: exact unsafe JSON numbers/deep fallback, and a real
// Engine continuation after deeply nested external tool output.
// +25 reviewed Session fork/merge boundaries: 10 durable identity/order/rollback,
// 6 active-ingress/task runtime, 6 owner/Agent/capability/dispatch server cases,
// and 3 browser capability/correlation/navigation cases. No prior tests removed.
// +11 reviewed mobile navigation boundaries: 4 bilingual focus/identity/control
// cases and 7 browser layout/theme/breakpoint/recovery/scope cases. Existing
// inbox, outputs and inspector coverage is retained through the new action entry.
// +5 reviewed CSV preview cases: quoted/Unicode values, malformed recovery,
// bounded parsing, inert paginated rendering, and responsive edit/undo/save browser flow.
// +23 reviewed Plugin Center boundaries: 9 store ordering/recovery/auth, 6 navigation,
// 5 bilingual/detail/form UI and 3 real relay/browser cases. No prior tests removed.
// +7 reviewed plugin refinements: 3 Agent/relay detail boundaries, 3 frontend
// ownership/Prompt/picker regressions and 1 multi-theme responsive picker browser case.
// +9 non-text preview safety: 7 binary/MIME/private-Office/fallback transport+UI
// and restore ownership boundaries; 2 native audio/download responsive browser cases.
// +6 spreadsheet boundaries: real XLS/XLSX data, bounded projection, stable view/TSV,
// shared table interaction, worker lifecycle/security and a real Files/Agent browser flow.
// Existing CSV edit/error cases are retained and extended, not replaced.
// +49 reviewed Session-backed task boundaries: 18 durable scheduler/ingress,
// recovery/race/CAS/Project authority cases; 7 owner/capability/SQLite relay
// cases; 9 shared-UX cases including active-run pause; 9 scoped store/protocol/
// notification cases; 6 real browser flows including mobile/theme geometry and
// cross-tab stale edits. Existing Session, Work Center, sidebar and plugin
// regressions remain intact.
export const TEST_CASE_LIMIT = 804;

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

/** Vitest CLI list drops skip/todo. The public collection API retains them. */
export async function collectUnitCases({ rootDir = process.cwd(), configFile = 'vitest.focus.config.js' } = {}) {
  const { createVitest } = await import('vitest/node');
  const context = await createVitest('test', {
    root: rootDir, config: resolve(rootDir, configFile), watch: false, reporters: [],
  });
  try {
    await context.init();
    const specifications = await context.globTestSpecifications();
    const result = await context.collectTests(specifications);
    const errors = [...result.unhandledErrors];
    let count = 0;
    for (const module of result.testModules) {
      errors.push(...module.errors());
      for (const suite of module.children.allSuites()) errors.push(...suite.errors());
      for (const test of module.children.allTests()) count++;
    }
    if (errors.length) throw new Error(`Unit collection failed: ${errors.map(error => error?.message || String(error)).join('; ')}`);
    if (result.testModules.length !== specifications.length || !count) throw new Error('Unit collection incomplete');
    return count;
  } finally {
    if (!await closeUnitCollector(context)) {
      console.warn('Unit collection teardown timed out; exiting isolated collector after validated collection.');
    }
  }
}

/** Bound the isolated collector so import side effects cannot hang the gate. */
export function collectTestCaseCounts({ rootDir = process.cwd() } = {}) {
  const require = createRequire(import.meta.url);
  const playwrightCli = require.resolve('@playwright/test/cli');
  const outputDir = mkdtempSync(resolve(tmpdir(), 'yeaft-test-budget-'));
  const outputFile = resolve(outputDir, 'tests.json');
  try {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--collect-unit', outputFile], {
      cwd: rootDir, stdio: 'pipe', timeout: 180000,
    });
    const unit = JSON.parse(readFileSync(outputFile, 'utf8'));
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

if (isMainModule(import.meta.url)) {
  if (process.argv[2] === '--collect-unit') {
    try {
      writeFileSync(process.argv[3], JSON.stringify(await collectUnitCases({ configFile: process.argv[4] || 'vitest.focus.config.js' })));
      // Some collected modules open DB workers at import time. No test body ran;
      // exit the isolated process instead of waiting on those unrelated handles.
      process.exit(0);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  } else main();
}
