/**
 * task-321 — Strengthen taskId propagation so all role messages attach
 * to the correct feature card.
 *
 * Three chokepoints fixed:
 *   1. dispatchToRole: currentTask is sticky. A dispatch that omits the
 *      taskId no longer clears the previous currentTask, so standby /
 *      shorthand / bare-dispatch flows keep attaching messages to the
 *      right feature.
 *   2. appendTaskRecord: auto-creates the feature file when missing, so
 *      the first role to mention a taskId (PM or not) will always cause
 *      .crew/context/features/{taskId}.md to exist.
 *   3. executeRoute: when a ROUTE has no `task:` field, fall back to
 *      sender's roleState.currentTask.taskId → session.messageHistory
 *      last non-system taskId, and mirror the inferred id back onto the
 *      route object so downstream writers see it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, existsSync, readFileSync as read } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { appendTaskRecord } from '../../agent/crew/task-files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const routingJs = readFileSync(join(ROOT, 'agent/crew/routing.js'), 'utf8');
const taskFilesJs = readFileSync(join(ROOT, 'agent/crew/task-files.js'), 'utf8');

// =====================================================================
// 1. dispatchToRole: sticky currentTask (task-321 fix 1)
// =====================================================================
describe('dispatchToRole — sticky currentTask across dispatches', () => {
  // Extract the dispatchToRole function body for source-level assertions.
  const fn = routingJs.match(/export async function dispatchToRole\b[\s\S]*?^}/m)?.[0] || '';

  it('still assigns currentTask when a taskId is supplied', () => {
    expect(fn).toMatch(/if\s*\(\s*taskId\s*\)\s*\{\s*roleState\.currentTask\s*=\s*\{/);
  });

  it('preserves previous taskTitle when new dispatch omits one', () => {
    // New code reads `taskTitle || roleState.currentTask?.taskTitle || null`
    // so a bare follow-up dispatch does not wipe an earlier taskTitle.
    expect(fn).toMatch(/taskTitle\s*\|\|\s*roleState\.currentTask\?\.taskTitle/);
  });

  it('never unconditionally nulls currentTask', () => {
    // Defensive: the code must not contain a blanket `currentTask = null`
    // inside dispatchToRole — that would undo task-321.
    expect(fn).not.toMatch(/roleState\.currentTask\s*=\s*null/);
  });

  it('references task-321 in an explanatory comment', () => {
    expect(fn).toMatch(/task-321/);
  });
});

// =====================================================================
// 2. executeRoute: taskId fallback chain (task-321 fix 3)
// =====================================================================
describe('executeRoute — taskId fallback when ROUTE omits `task:`', () => {
  // task-335: per-target dispatch logic was extracted into _dispatchOneTarget.
  // The fallback chain still lives in executeRoute (run once per fan-out),
  // but the per-target ensureTaskFile / appendTaskRecord lines moved to the
  // helper. Match both bodies to keep coverage stable across the refactor.
  const fnExec = routingJs.match(/export async function executeRoute\b[\s\S]*?^}/m)?.[0] || '';
  const fnDispatch = routingJs.match(/async function _dispatchOneTarget\b[\s\S]*?^}/m)?.[0] || '';
  const fn = fnExec + '\n' + fnDispatch;

  it('destructures `to, summary, taskId, taskTitle` (re-assignable for fallback)', () => {
    // task-335: `to` is now derived from `route.toList[]` (loop variable),
    // so the executeRoute body destructures `summary, taskId, taskTitle`
    // and pulls `to` per-iteration. The intent — re-assignable bindings
    // for the fallback chain — is preserved.
    expect(fnExec).toMatch(/let\s+\{\s*summary,\s*taskId,\s*taskTitle\s*\}\s*=\s*route/);
    expect(fnExec).toMatch(/for\s*\(\s*const\s+to\s+of\s+toList\s*\)/);
  });

  it('consults sender roleState.currentTask when taskId missing', () => {
    expect(fn).toMatch(/session\.roleStates\?\.get\(fromRole\)/);
    expect(fn).toMatch(/currentTask\?\.taskId/);
  });

  it('scans session.messageHistory backwards for a non-system taskId', () => {
    expect(fn).toMatch(/session\.messageHistory/);
    expect(fn).toMatch(/h\.from\s*!==\s*['"]system['"][\s\S]*?h\.taskId/);
  });

  it('mirrors the inferred taskId back onto the route object', () => {
    expect(fn).toMatch(/route\.taskId\s*=\s*taskId/);
  });

  it('drops the old PM-only guard for ensureTaskFile', () => {
    // Old: `fromRoleConfig?.isDecisionMaker && taskTitle && to !== 'human'`
    // New: any role with an effective title may trigger creation.
    // The combined guard "isDecisionMaker && taskTitle && to !== 'human'"
    // is gone; only "to !== 'human'" + effectiveTitle gates creation now.
    expect(fn).not.toMatch(/isDecisionMaker\s*&&\s*taskTitle\s*&&\s*to\s*!==\s*['"]human['"]/);
    expect(fn).toMatch(/effectiveTitle\s*&&\s*to\s*!==\s*['"]human['"]/);
  });

  it('passes { taskTitle } opts into appendTaskRecord', () => {
    expect(fn).toMatch(/appendTaskRecord\([\s\S]*?\{\s*taskTitle:\s*effectiveTitle\s*\}/);
  });
});

// =====================================================================
// 3. appendTaskRecord: functional test — auto-creates missing file
// =====================================================================
describe('appendTaskRecord — auto-create feature file on first append', () => {
  let tmpDir;
  let session;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'task-321-'));
    await fs.mkdir(join(tmpDir, 'context', 'features'), { recursive: true });
    session = {
      sharedDir: tmpDir,
      language: 'zh-CN',
      roles: new Map([
        ['prev-1', { displayName: '产品审查-Linus', icon: '🎨', isDecisionMaker: false }],
        ['pm', { displayName: 'PM-乔布斯', icon: '🧭', isDecisionMaker: true }],
      ]),
      features: new Map(),
      roleStates: new Map(),
      messageHistory: [],
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the feature file when it did not exist (non-PM first mention)', async () => {
    const filePath = join(tmpDir, 'context', 'features', 'task-999.md');
    expect(existsSync(filePath)).toBe(false);

    await appendTaskRecord(session, 'task-999', 'prev-1', 'first review note', {
      taskTitle: 'Fix review rubric',
    });

    expect(existsSync(filePath)).toBe(true);
    const content = read(filePath, 'utf8');
    expect(content).toContain('task-999');
    expect(content).toContain('Fix review rubric');
    expect(content).toContain('first review note');
    // Role label appears in the appended record
    expect(content).toMatch(/🎨\s*产品审查-Linus/);
  });

  it('recovers title from session.features cache when opts.taskTitle omitted', async () => {
    session.features.set('task-888', { taskId: 'task-888', taskTitle: 'Cached title', createdAt: Date.now() });
    await appendTaskRecord(session, 'task-888', 'prev-1', 'note');
    const content = read(join(tmpDir, 'context', 'features', 'task-888.md'), 'utf8');
    expect(content).toContain('Cached title');
  });

  it('falls back to taskId as title when everything else is missing', async () => {
    await appendTaskRecord(session, 'task-777', 'prev-1', 'bare note');
    const content = read(join(tmpDir, 'context', 'features', 'task-777.md'), 'utf8');
    // Title line must contain task-777 (both as id and as fallback title)
    expect(content).toMatch(/task-777/);
    expect(content).toContain('bare note');
  });

  it('appends to an existing file without re-creating it', async () => {
    const filePath = join(tmpDir, 'context', 'features', 'task-666.md');
    await fs.writeFile(filePath, '# Feature: existing\n- task-id: task-666\n');

    await appendTaskRecord(session, 'task-666', 'pm', 'second line', { taskTitle: 'existing' });
    const content = read(filePath, 'utf8');
    // Original header preserved
    expect(content).toMatch(/^# Feature: existing\n/);
    // Appended record present
    expect(content).toContain('second line');
    expect(content).toMatch(/PM-乔布斯/);
  });

  it('accepts the legacy 4-arg signature (backward compatibility)', async () => {
    // Ensures call sites that still pass only 4 args keep working.
    await appendTaskRecord(session, 'task-555', 'prev-1', 'legacy call');
    const content = read(join(tmpDir, 'context', 'features', 'task-555.md'), 'utf8');
    expect(content).toContain('legacy call');
  });
});

// =====================================================================
// 4. task-files.js — source-level assertions on appendTaskRecord
// =====================================================================
describe('appendTaskRecord source — task-321 fix 2', () => {
  const fn = taskFilesJs.match(/export async function appendTaskRecord\b[\s\S]*?^}/m)?.[0] || '';

  it('accepts an opts parameter with default {}', () => {
    expect(fn).toMatch(/appendTaskRecord\s*\(\s*session\s*,\s*taskId\s*,\s*roleName\s*,\s*summary\s*,\s*opts\s*=\s*\{\}\s*\)/);
  });

  it('calls ensureTaskFile when the file does not exist', () => {
    expect(fn).toMatch(/ensureTaskFile\(session,\s*taskId,\s*recoveredTitle/);
  });

  it('resolves recoveredTitle from opts.taskTitle / session.features / taskId', () => {
    expect(fn).toMatch(/opts\.taskTitle/);
    expect(fn).toMatch(/session\.features\?\.get\(taskId\)\?\.taskTitle/);
    // Final fallback to the taskId itself
    expect(fn).toMatch(/\|\|\s*taskId/);
  });

  it('still logs the append at the end', () => {
    expect(fn).toMatch(/Task record appended/);
  });

  it('references task-321 in an explanatory comment (file-level)', () => {
    expect(taskFilesJs).toMatch(/task-321/);
  });
});
