import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isValidTaskId,
  sanitizeKanbanSummary,
  updateKanban,
  readKanban,
} from '../../../agent/crew/task-files.js';

/**
 * Build a minimal session-like object compatible with updateKanban().
 */
async function mkSession(language = 'zh-CN') {
  const dir = await fs.mkdtemp(join(tmpdir(), 'crew-kanban-'));
  return {
    language,
    sharedDir: dir,
    features: new Map(),
    roles: new Map(),
    roleStates: new Map(),
    _completedTaskIds: new Set(),
  };
}

async function rm(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('isValidTaskId', () => {
  it('accepts task-<digits>', () => {
    expect(isValidTaskId('task-289')).toBe(true);
    expect(isValidTaskId('task-1')).toBe(true);
  });
  it('accepts slug-style feature ids', () => {
    expect(isValidTaskId('fix-crew-kanban-task-management')).toBe(true);
  });
  it('rejects placeholders and bare numbers', () => {
    expect(isValidTaskId('<task-id>')).toBe(false);
    expect(isValidTaskId('task-XX')).toBe(false);
    expect(isValidTaskId('task-xx')).toBe(false);
    expect(isValidTaskId('279')).toBe(false);
    expect(isValidTaskId('')).toBe(false);
    expect(isValidTaskId('   ')).toBe(false);
    expect(isValidTaskId(null)).toBe(false);
    expect(isValidTaskId(undefined)).toBe(false);
  });
});

describe('sanitizeKanbanSummary', () => {
  it('returns "-" for empty input', () => {
    expect(sanitizeKanbanSummary('')).toBe('-');
    expect(sanitizeKanbanSummary(null)).toBe('-');
  });
  it('collapses newlines to single space', () => {
    const s = sanitizeKanbanSummary('line1\nline2\nline3');
    expect(s).toBe('line1 line2 line3');
  });
  it('strips horizontal rules and headings', () => {
    const s = sanitizeKanbanSummary('priority: high\n---\n## 观察\n内容');
    expect(s).not.toContain('---');
    expect(s).not.toContain('##');
    expect(s).toContain('priority: high');
    expect(s).toContain('内容');
  });
  it('escapes pipe chars', () => {
    const s = sanitizeKanbanSummary('a | b | c');
    expect(s).toBe('a \\| b \\| c');
  });
  it('truncates to 80 chars with ellipsis', () => {
    const long = 'x'.repeat(200);
    const s = sanitizeKanbanSummary(long);
    expect(s.length).toBe(80);
    expect(s.endsWith('…')).toBe(true);
  });
  it('honours custom maxLen', () => {
    const s = sanitizeKanbanSummary('abcdef', 3);
    expect(s).toBe('ab…');
  });
  it('handles ROUTE-style summary without breaking the table', () => {
    const route = `修复看板
priority: high
---

## 症状
第一行  | 第二列
- 点 1
- 点 2`;
    const s = sanitizeKanbanSummary(route);
    expect(s).not.toMatch(/[\r\n]/);
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s).not.toContain('---');
    expect(s).not.toMatch(/##\s/);
  });
});

describe('updateKanban', () => {
  let session;
  beforeEach(async () => {
    session = await mkSession('zh-CN');
  });
  afterEach(async () => {
    await rm(session.sharedDir);
  });

  it('rejects invalid task ids without creating a row', async () => {
    await updateKanban(session, {
      taskId: '<task-id>',
      taskTitle: 'x',
      assignee: 'dev-1',
      status: 'dev',
      summary: 'nope',
    });
    const content = await readKanban(session);
    expect(content).not.toContain('<task-id>');
    expect(content).not.toContain('| x |');
  });

  it('writes a valid row with sanitized single-line summary', async () => {
    const longSummary = `修复看板 bug
---
## 症状
表格被撑坏
- 行 1
- 行 2`;
    await updateKanban(session, {
      taskId: 'task-100',
      taskTitle: '测试任务',
      assignee: 'dev-1',
      status: '🔨 开发中',
      summary: longSummary,
    });
    const content = await readKanban(session);
    expect(content).toContain('| task-100 |');
    // Find the row
    const row = content.split('\n').find(l => l.includes('| task-100 |'));
    expect(row).toBeDefined();
    // Row must not contain newlines aside from its own ending and must not contain markdown structural artefacts
    expect(row).not.toContain('---');
    expect(row).not.toMatch(/##\s/);
    // Summary cell exists (last cell before empty)
    const cells = row.split('|').map(c => c.trim());
    // cells: ['', 'task-100', '测试任务', 'dev-1', '🔨 开发中', '<summary>', '']
    const summaryCell = cells[5];
    expect(summaryCell.length).toBeLessThanOrEqual(80);
    expect(summaryCell).not.toContain('\n');
  });

  it('update REPLACES summary rather than appending', async () => {
    await updateKanban(session, {
      taskId: 'task-101',
      taskTitle: 'T',
      assignee: 'dev-1',
      status: 'dev',
      summary: 'initial route summary from pm',
    });
    await updateKanban(session, {
      taskId: 'task-101',
      summary: 'dev-1 reports progress #2',
    });
    const content = await readKanban(session);
    expect(content).toContain('dev-1 reports progress #2');
    expect(content).not.toContain('initial route summary from pm');
  });

  it('active count equals number of visible active rows', async () => {
    await updateKanban(session, {
      taskId: 'task-200',
      taskTitle: 'A',
      assignee: 'dev-1',
      status: 'dev',
      summary: 'a',
    });
    await updateKanban(session, {
      taskId: 'task-201',
      taskTitle: 'B',
      assignee: 'dev-2',
      status: 'dev',
      summary: 'b',
    });
    const content = await readKanban(session);
    const activeHeaderMatch = content.match(/## 🔨 [^(]*\((\d+)\)/);
    expect(activeHeaderMatch).toBeTruthy();
    const declared = parseInt(activeHeaderMatch[1], 10);
    const rows = content
      .split('\n')
      .filter(l => /^\| task-\d+ \|/.test(l));
    expect(rows.length).toBe(declared);
  });

  it('cleans up existing placeholder/illegal rows on next write', async () => {
    // Seed a dirty kanban file with placeholder + bare number + task-XX
    const kanbanPath = join(session.sharedDir, 'context', 'kanban.md');
    await fs.mkdir(join(session.sharedDir, 'context'), { recursive: true });
    await fs.writeFile(
      kanbanPath,
      `# 工作看板
> 最后更新: 2026/4/17 13:00:00

## 🔨 进行中 (3)
| task-id | 标题 | 负责人 | 状态 | 最新进展 |
|---------|------|--------|------|----------|
| <task-id> | <标题> | - | - | - |
| task-289 | task-289 | dev-1 | 🔨 开发中 | 初始摘要 |
| 279 | Unify Sidebar Redesign | - | - | - |

## ✅ 已完成 (2)
| task-id | 标题 | 负责人 |
|---------|------|--------|
| task-XX | 任务标题 | - |
| task-100 | 合法任务 | dev-3 |
`
    );

    // Trigger a clean write via any valid update
    await updateKanban(session, {
      taskId: 'task-289',
      summary: 'updated',
    });

    const content = await readKanban(session);
    expect(content).not.toContain('<task-id>');
    expect(content).not.toContain('task-XX');
    expect(content).not.toMatch(/^\| 279 \|/m);
    expect(content).toContain('task-289');
    expect(content).toContain('task-100');
    // Count should equal 1 active, 1 completed
    const activeHeader = content.match(/## 🔨 [^(]*\((\d+)\)/);
    const doneHeader = content.match(/## ✅ [^(]*\((\d+)\)/);
    expect(activeHeader[1]).toBe('1');
    expect(doneHeader[1]).toBe('1');
  });
});
