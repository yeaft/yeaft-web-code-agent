import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
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
// +7 reviewed task calendar cases: 3 form/preview/capability boundaries,
// 3 recurrence validation/advance/reopen boundaries and 1 multi-theme browser flow.
// +1 task-as-Session browser lifecycle: shared sorting/Project moves and visibility.
// +1 rendered task/Settings control contract: actual cascade, theme-aware switches,
// quiet hover/focus/disabled actions and stable full-height columns across themes.
// +1 task effort capability boundary: Agent-scoped catalog, model changes,
// incompatible override reset and disabled inheritance/unsupported models.
// +5 mobile composer keyboard regressions: 4 component ownership/send-gate cases
// and 1 browser newline/button/desktop/rotation flow. Existing task and Person
// mobile send flows now exercise explicit buttons; prior coverage is retained.
// +14 reviewed user-level sidebar ratio boundaries: 8 Server ownership/validation/
// persistence cases, 4 frontend lifecycle/queue/rollback/input cases and 2 actual
// browser light/dark drag/keyboard/cross-device/mobile/short-height flows.
// Existing first-paint, task and plugin sidebar coverage is retained.
// +1 review regression: parent/child drag cancellation during cross-device refresh;
// short-height extreme-ratio geometry extends the existing browser cases.
// +2 Task Session read boundaries: selection receipts across hydration/new runs,
// and exact foreground visibility versus other Agents/covered/background views.
// Real sidebar/read/reload behavior extends the existing notification browser case.
// +2 per-user shortcut layout regressions: mixed-field queued optimistic writes,
// and failed compact-save rollback with queued ratio / account-switch fencing.
// Migration, auth isolation and cross-desktop geometry extend existing cases.
// +2 reviewed Task status boundaries: inline region/Escape modal ownership and
// pending manual-request deduplication with paused schedule preservation.
// Header geometry and close/reopen busy retention extend existing browser cases.
// +8 reviewed sidebar control boundaries: 3 project chat/task mode and ownership
// cases; 5 browser hover/focus/vertical disclosure, touch/narrow-screen and both
// sidebar creation surfaces. Existing cross-device layout cases remain intact.
// +40 VP scenario/compatibility boundaries: 17 exact-stock migration and user-data
// preservation cases, 17 rendered catalog/Agent-snapshot/auth cases, 3 durable Session/
// Agent-create cases, 2 Server null-default envelope cases and 1 real relay/browser
// lifecycle across themes/sizes. Historical defaults/tests are retained.
// +2 folder/section preference boundaries: per-key optimistic queue/rollback/auth
// fencing and component restore/focus/create behavior. Server migration/merge and
// real cross-client persistence extend existing cases without replacing coverage.
// +5 Responses EOF boundaries: transport classification, successful restart/
// continuation with one dispatch, bounded/disabled retries, cancellation and
// post-publication non-replay. Malformed-drain EOF extends existing safety cases.
// +2 public reply boundaries: shared execution/cognition guidance and byte reserves,
// plus actual native dispatch/delivery/final-cognition integration. These assert
// plumbing, not that a scripted model has demonstrated judgment or concise prose.
// +5 bounded history paging regressions: gesture budget, CLI/Yeaft async layout
// ownership, key/touch/cache/session lifecycle, desktop/light and narrow/dark browser.
// +3 terminal ownership boundaries: independent result/metadata settlement,
// scoped orphan reconciliation, and production-browser animation/result styles.
// +6 Unix upgrade safety boundaries: canonical install lock, private handoff,
// fail-open prevention, real shell contention/recovery, version/failure fencing,
// and opt-in real systemd cgroup survival. Existing tests remain intact.
// +2 Session fork recovery boundaries: real TaskManager restart, durable checkpoint,
// legacy human-root recovery, unknown provenance, cold-boot input and stale cleanup.
// Whole-copy browser coverage extends the existing fork/merge relay case.
// +1 Session toolbar contract: bilingual mobile page reload and no manual
// message replay on either viewport. Actual reload extends existing browser coverage.
// +14 ResponseEnhance boundaries: input/result validation, single-call transport,
// cancellation, Engine live route, Person loop/usage, SQLite persistence and
// real private-host/SQLite integration, child request-budget, non-verifying goal evidence,
// deadline ownership, inherited-effort payload and crash-recovery unknown usage. No prior cases removed or hidden.
// +5 identity boundaries: colliding legacy fork records/lineage, identical-time occurrences,
// stale-seq bootstrap, named-chat recovery and abandoned-lock non-takeover.
// +2 review regressions: stable rewind/snapshot/lineage across segments and
// distinct legacy hot/cold/segment rows versus proven migration shadows.
// +1 review regression: existing lineage namespaces and internal non-human causal roots.
// +1 SQLite mutex permission boundary: best-effort and strict read-only writes.
// +4 Skill shortcut recovery boundaries: early Agent-isolated snapshot retention,
// authoritative catalogue migration, Task/ordinary Session relay/browser recovery,
// and warm cached project runtime catalogue replay after refresh/reconnect.
// +7 harness latency safety cases: retained-only read references, raw Engine
// evidence, real process wait+log, bounded/owned cursors, follow-up waits,
// bilingual versioned handoff and single-pass gate failure/collection contracts.
// +13 account-wide Task read boundaries: 8 Server persistence/auth/atomicity/
// journal/race cases, 4 frontend offline/migration/scope/desktop-notice cases,
// and 1 independent-browser device/read/reconnect flow. Existing cases retained.
// +2 independent review regressions: renewable JWT socket ownership and
// deleted-Session exact-run proof. Snapshot-only/reopen coverage extends cases.
// +10 LLM draft/request ownership regressions: delayed/shared updates, exact save snapshots,
// continued typing, failure/timeout, Agent lifecycle, clean refresh, readiness-only reads, and desktop/mobile browser flows.
// +3 Fable effort boundaries: family inference, catalog/Session/wire integration,
// and real catalog-driven browser selection/persistence. Existing cases retained.
// +23 Anthropic protocol and continuity boundaries: 14 Engine completion/prefix,
// 4 gateway/origin/prefix, 5 stream/metadata/trace cases; +3 model capability
// and +1 bridge terminal propagation regression. Existing cases retained.
// +2 independent review regressions: paused server operations cannot replay
// when native state is disabled or unsupported. Stop-sequence extends existing Person case.
// +4 PresentResponse wire regressions: manual/adaptive thinking (including
// prefix-enforced models) and no-thinking preserve native tool pairs and publications.
// +1 managed-provider effort persistence/dispatch regression after API-based effort.
// +7 signed-output budget regressions: estimate fallback, cache-exclusive and
// cache-inclusive usage, repeated continuation, exhausted windows, manual thinking
// and extraBody settings that must not exceed the final wire output ceiling.
// +5 review regressions: manual/extraBody widening with room, manual widening
// beyond a tighter remaining window, and stream/call exact-ceiling compatibility.
// +3 usage-anchor regressions: missing SSE/JSON usage and partial input reports
// cannot erase the known prefix lower bound across a third request.
// +7 VP error-detail boundaries: bounded broker retention/ownership/dedup (3),
// visible engine/thrown-error bridge propagation (2), scoped accessible UI (1),
// and real relay/browser navigation/snapshot/mobile/legacy recovery (1).
// +3 model-apply boundaries: bounded target-only persistence, immediate preview/
// ordered acknowledgement/send ownership, and owner-scoped Server delta hydration.
// Live Engine refresh and browser latency assertions extend existing cases.
// +2 Messages thinking-display regressions: stream/call route/model/config matrix
// and final child effort-cap behavior, without adding cases per matrix row.
// +3 signed-tail boundaries: SSE/JSON usage calibration with immutable sampled
// prefixes and durable originals (2), and structured/multimodal unsent sampling (1).
export const TEST_CASE_LIMIT = 1040;

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
  const wrapper = resolve(dirname(fileURLToPath(import.meta.url)), 'test-budget-playwright.config.mjs');
  const browserReport = execFileSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', `--config=${wrapper}`,
    '--list', '--reporter=json', '--forbid-only'], {
    cwd: rootDir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60000,
    env: { ...process.env, YEAFT_BUDGET_PLAYWRIGHT_CONFIG: resolve(rootDir, configFile) },
  });
  return countBrowserCases(JSON.parse(browserReport), { rootDir, expectedFiles });
}

/** Bound the isolated collector so import side effects cannot hang the gate. */
export function collectTestCaseCounts({ rootDir = process.cwd() } = {}) {
  const outputDir = mkdtempSync(resolve(tmpdir(), 'yeaft-test-budget-'));
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

export function reportCaseBudget(counts, limit = TEST_CASE_LIMIT) {
  const budget = checkCaseBudget(counts, limit);
  console.log(`Suite: ${CORE_TEST_FILES.length} Vitest files / ${budget.unit} cases + ${E2E_TEST_FILES.length} browser files / ${budget.browser} cases = ${budget.total}/${budget.limit} cases`);
  if (budget.exceeded) {
    throw new Error('Test budget exceeded. Remove redundant cases or explicitly review a small budget increase for new critical coverage. Do not hide cases with skip or exclude.');
  }
  return budget;
}

function main() {
  try {
    assertReviewedTestFiles();
    reportCaseBudget(collectTestCaseCounts());
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
