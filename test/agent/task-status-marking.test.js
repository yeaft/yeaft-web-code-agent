import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for task status marking bug fixes (PR #322, task-131b).
 *
 * Covers 4 areas:
 * 1. computeCompletedTaskIds — exact matching (no more substring false positives)
 * 2. parseCompletedTasks primary — TASKS block parsing unchanged
 * 3. parseCompletedTasks fallback — plain text + knownTaskIds + completion keywords
 * 4. routing.js kanban assignee — resolvedKanbanTo takes priority over raw `to`
 */

let routingSource;

beforeAll(() => {
  routingSource = readFileSync(
    resolve(__dirname, '../../agent/crew/routing.js'), 'utf-8'
  );
});

// =====================================================================
// Replicate computeCompletedTaskIds (crewKanban.js)
// =====================================================================
function computeCompletedTaskIds(doneTasks, activeTasks) {
  const ids = new Set();
  if (doneTasks.length === 0) return ids;
  const activeTaskIdSet = new Set(activeTasks.map(at => at.id));
  for (const task of doneTasks) {
    if (task.taskId && activeTaskIdSet.has(task.taskId)) {
      // Primary: exact taskId match
      ids.add(task.taskId);
    } else if (!task.taskId) {
      // Fallback: exact title match only
      const t = task.text.toLowerCase().trim();
      if (!t) continue;
      for (const at of activeTasks) {
        if (t === at.title.toLowerCase().trim()) {
          ids.add(at.id);
        }
      }
    }
    // If task has a taskId but it doesn't match any active task, skip entirely
  }
  return ids;
}

// =====================================================================
// Replicate parseCompletedTasks (task-files.js)
// =====================================================================
function parseCompletedTasks(text, knownTaskIds) {
  const ids = new Set();

  // Primary: TASKS block parsing
  const match = text.match(/---TASKS---([\s\S]*?)---END_TASKS---/);
  if (match) {
    for (const line of match[1].split('\n')) {
      const m = line.match(/^-\s*\[[xX]\]\s*.+#(\S+)/);
      if (m) ids.add(m[1]);
    }
    return ids;
  }

  // Fallback: scan plain text for known taskId + completion keywords
  if (!knownTaskIds || knownTaskIds.length === 0) return ids;

  const completionPatterns = [
    /已完成/, /完成/, /已合并/, /合并/, /DONE/, /DONE_MERGED/, /MERGED/,
    /已关闭/, /关闭/, /✅/, /通过/, /passed/i, /merged/i, /completed/i
  ];

  for (const taskId of knownTaskIds) {
    const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^.*${escaped}.*$`, 'gm');
    let lineMatch;
    while ((lineMatch = re.exec(text)) !== null) {
      const line = lineMatch[0];
      if (completionPatterns.some(p => p.test(line))) {
        ids.add(taskId);
        break;
      }
    }
  }

  return ids;
}

// =====================================================================
// 1. computeCompletedTaskIds — exact matching
// =====================================================================
describe('computeCompletedTaskIds — exact matching', () => {
  const activeTasks = [
    { id: 'task-1', title: '修复 UI' },
    { id: 'task-2', title: '修复 UI 布局' },
    { id: 'task-3', title: '实现登录功能' }
  ];

  it('should match by exact taskId when taskId is present', () => {
    const doneTasks = [{ done: true, text: '实现登录功能', taskId: 'task-3' }];
    const result = computeCompletedTaskIds(doneTasks, activeTasks);
    expect(result.has('task-3')).toBe(true);
    expect(result.size).toBe(1);
  });

  it('should NOT fallback to title match when taskId is present but does not match', () => {
    // task has taskId "task-999" (not in activeTasks), text matches "修复 UI"
    // Old behavior would fallback to title match — new behavior skips entirely
    const doneTasks = [{ done: true, text: '修复 UI', taskId: 'task-999' }];
    const result = computeCompletedTaskIds(doneTasks, activeTasks);
    expect(result.size).toBe(0);
  });

  it('should match by exact title when no taskId (exact equality)', () => {
    const doneTasks = [{ done: true, text: '修复 UI', taskId: null }];
    const result = computeCompletedTaskIds(doneTasks, activeTasks);
    expect(result.has('task-1')).toBe(true);
    expect(result.size).toBe(1);
  });

  it('should NOT substring-match titles (old bug: "修复 UI" matching "修复 UI 布局")', () => {
    // "修复 UI" is a substring of "修复 UI 布局"
    // Old code: t.includes(title) || title.includes(t) would match both
    // New code: exact equality only → should only match task-1
    const doneTasks = [{ done: true, text: '修复 UI', taskId: null }];
    const result = computeCompletedTaskIds(doneTasks, activeTasks);
    expect(result.has('task-1')).toBe(true);
    expect(result.has('task-2')).toBe(false); // "修复 UI 布局" should NOT match
  });

  it('should NOT match when title is a superstring of active task title', () => {
    // Done task text is "修复 UI 布局 和配色" — old code: title.includes(t) would match
    const doneTasks = [{ done: true, text: '修复 UI 布局 和配色', taskId: null }];
    const result = computeCompletedTaskIds(doneTasks, activeTasks);
    expect(result.size).toBe(0);
  });

  it('should skip tasks with empty text', () => {
    const doneTasks = [{ done: true, text: '', taskId: null }];
    const result = computeCompletedTaskIds(doneTasks, activeTasks);
    expect(result.size).toBe(0);
  });

  it('should skip tasks with whitespace-only text', () => {
    const doneTasks = [{ done: true, text: '   ', taskId: null }];
    const result = computeCompletedTaskIds(doneTasks, activeTasks);
    expect(result.size).toBe(0);
  });

  it('should return empty set when doneTasks is empty', () => {
    const result = computeCompletedTaskIds([], activeTasks);
    expect(result.size).toBe(0);
  });

  it('should handle case-insensitive title matching', () => {
    const tasks = [{ id: 'task-X', title: 'Fix Login Bug' }];
    const doneTasks = [{ done: true, text: 'fix login bug', taskId: null }];
    const result = computeCompletedTaskIds(doneTasks, tasks);
    expect(result.has('task-X')).toBe(true);
  });

  it('should match multiple done tasks independently', () => {
    const doneTasks = [
      { done: true, text: '修复 UI', taskId: null },
      { done: true, text: '实现登录功能', taskId: 'task-3' }
    ];
    const result = computeCompletedTaskIds(doneTasks, activeTasks);
    expect(result.has('task-1')).toBe(true);
    expect(result.has('task-3')).toBe(true);
    expect(result.size).toBe(2);
  });
});

// =====================================================================
// 2. parseCompletedTasks — primary (TASKS block)
// =====================================================================
describe('parseCompletedTasks — TASKS block parsing', () => {
  it('should parse checked items with #taskId', () => {
    const text = `
---TASKS---
- [x] 实现功能 #task-1
- [ ] 待完成 #task-2
---END_TASKS---
`;
    const result = parseCompletedTasks(text);
    expect(result.has('task-1')).toBe(true);
    expect(result.has('task-2')).toBe(false);
    expect(result.size).toBe(1);
  });

  it('should parse uppercase X as checked', () => {
    const text = `
---TASKS---
- [X] 已完成功能 #task-A
---END_TASKS---
`;
    const result = parseCompletedTasks(text);
    expect(result.has('task-A')).toBe(true);
  });

  it('should return empty set when all tasks are unchecked', () => {
    const text = `
---TASKS---
- [ ] 未完成 #task-1
- [ ] 未完成 #task-2
---END_TASKS---
`;
    const result = parseCompletedTasks(text);
    expect(result.size).toBe(0);
  });

  it('should parse multiple checked items', () => {
    const text = `
---TASKS---
- [x] 功能A #task-1
- [x] 功能B #task-2
- [ ] 功能C #task-3
---END_TASKS---
`;
    const result = parseCompletedTasks(text);
    expect(result.size).toBe(2);
    expect(result.has('task-1')).toBe(true);
    expect(result.has('task-2')).toBe(true);
  });

  it('should NOT use fallback when TASKS block is present (even if empty)', () => {
    const text = `
task-1 已完成
---TASKS---
---END_TASKS---
`;
    // TASKS block present but empty → should NOT fallback to plain text scan
    const result = parseCompletedTasks(text, ['task-1']);
    expect(result.size).toBe(0);
  });

  it('should return empty set when text has no TASKS block and no knownTaskIds', () => {
    const text = '普通文本，没有 TASKS 块';
    const result = parseCompletedTasks(text);
    expect(result.size).toBe(0);
  });
});

// =====================================================================
// 3. parseCompletedTasks — fallback (plain text + knownTaskIds)
// =====================================================================
describe('parseCompletedTasks — fallback detection', () => {
  it('should detect taskId + completion keyword "已完成"', () => {
    const text = 'task-1 已完成，可以合并了。';
    const result = parseCompletedTasks(text, ['task-1', 'task-2']);
    expect(result.has('task-1')).toBe(true);
    expect(result.has('task-2')).toBe(false);
  });

  it('should detect taskId + completion keyword "DONE"', () => {
    const text = 'task-42 is DONE.';
    const result = parseCompletedTasks(text, ['task-42']);
    expect(result.has('task-42')).toBe(true);
  });

  it('should detect taskId + completion keyword "✅"', () => {
    const text = '✅ task-7 通过了所有测试。';
    const result = parseCompletedTasks(text, ['task-7']);
    expect(result.has('task-7')).toBe(true);
  });

  it('should detect taskId + completion keyword "merged" (case insensitive)', () => {
    const text = 'PR for task-5 has been Merged successfully.';
    const result = parseCompletedTasks(text, ['task-5']);
    expect(result.has('task-5')).toBe(true);
  });

  it('should NOT detect taskId without completion keyword', () => {
    const text = 'task-2 还需要更多时间开发。';
    const result = parseCompletedTasks(text, ['task-2']);
    expect(result.size).toBe(0);
  });

  it('should return empty when knownTaskIds is empty', () => {
    const text = 'task-1 已完成';
    const result = parseCompletedTasks(text, []);
    expect(result.size).toBe(0);
  });

  it('should return empty when knownTaskIds is undefined', () => {
    const text = 'task-1 已完成';
    const result = parseCompletedTasks(text);
    expect(result.size).toBe(0);
  });

  it('should detect multiple completed tasks in one text', () => {
    const text = `工作进展：
task-1 已完成，代码已合并。
task-2 还在开发中。
task-3 测试通过 ✅`;
    const result = parseCompletedTasks(text, ['task-1', 'task-2', 'task-3']);
    expect(result.has('task-1')).toBe(true);
    expect(result.has('task-2')).toBe(false);
    expect(result.has('task-3')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('should handle taskId with special regex characters safely', () => {
    // task-files.js escapes regex special chars — ensure no crash
    const text = 'task-1.0 已完成';
    const result = parseCompletedTasks(text, ['task-1.0']);
    expect(result.has('task-1.0')).toBe(true);
  });
});

// =====================================================================
// 4. routing.js — kanban assignee uses resolvedKanbanTo
// =====================================================================
describe('routing.js — kanban assignee', () => {
  it('should use resolvedKanbanTo in updateKanban call, not raw "to"', () => {
    // The source code should have: assignee: resolvedKanbanTo || to
    expect(routingSource).toContain('assignee: resolvedKanbanTo || to');
  });

  it('should NOT use just "to" as assignee', () => {
    // Old code was: assignee: to
    // New code: assignee: resolvedKanbanTo || to
    // Make sure the old pattern is gone
    const kanbanCall = routingSource.substring(
      routingSource.indexOf('updateKanban(session, {'),
      routingSource.indexOf('}).catch(e => console.warn')
    );
    // Should NOT contain "assignee: to," (raw) — should have resolvedKanbanTo
    expect(kanbanCall).not.toMatch(/assignee:\s*to\s*,/);
    expect(kanbanCall).toContain('resolvedKanbanTo || to');
  });

  it('should compute resolvedKanbanTo from resolveRoleName before updateKanban', () => {
    // resolvedKanbanTo should be defined before the updateKanban call
    const resolveIdx = routingSource.indexOf('resolvedKanbanTo = resolveRoleName');
    const updateIdx = routingSource.indexOf('updateKanban(session, {');
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeLessThan(updateIdx);
  });
});

// =====================================================================
// 5. role-output.js — passes knownTaskIds to parseCompletedTasks
// =====================================================================
describe('role-output.js — knownTaskIds integration', () => {
  let roleOutputSource;

  beforeAll(() => {
    roleOutputSource = readFileSync(
      resolve(__dirname, '../../agent/crew/role-output.js'), 'utf-8'
    );
  });

  it('should extract knownTaskIds from session.features.keys()', () => {
    expect(roleOutputSource).toContain('session.features.keys()');
  });

  it('should pass knownTaskIds to parseCompletedTasks', () => {
    expect(roleOutputSource).toContain('parseCompletedTasks(roleState.accumulatedText, knownTaskIds)');
  });
});
