import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isValidTaskId,
  sanitizeKanbanSummary,
  sanitizeKanbanCell,
  sanitizeKanbanFile,
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
  it('truncates to 120 chars with ellipsis', () => {
    const long = 'x'.repeat(300);
    const s = sanitizeKanbanSummary(long);
    expect(s.length).toBe(120);
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
    expect(s.length).toBeLessThanOrEqual(120);
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
    expect(summaryCell.length).toBeLessThanOrEqual(120);
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

describe('sanitizeKanbanCell', () => {
  it('folds newlines and trims', () => {
    expect(sanitizeKanbanCell('a\nb\nc')).toBe('a b c');
    expect(sanitizeKanbanCell('  hello  ')).toBe('hello');
  });
  it('escapes pipe and returns "-" for empty', () => {
    expect(sanitizeKanbanCell('a|b')).toBe('a\\|b');
    expect(sanitizeKanbanCell('')).toBe('-');
    expect(sanitizeKanbanCell(null)).toBe('-');
    expect(sanitizeKanbanCell(undefined)).toBe('-');
  });
});

describe('serialize-layer sanitize (defense-in-depth)', () => {
  let session;
  beforeEach(async () => {
    session = await mkSession('zh-CN');
  });
  afterEach(async () => {
    await fs.rm(session.sharedDir, { recursive: true, force: true });
  });

  it('strips newlines/markdown even if entry.summary bypasses the write path', async () => {
    // Seed a dirty existing file whose parsed summary column already has
    // junk (simulates an upstream that somehow dumped ROUTE raw text in).
    // Because the parser sanitizes the summary, this tests the full path.
    const kanbanPath = join(session.sharedDir, 'context', 'kanban.md');
    await fs.mkdir(join(session.sharedDir, 'context'), { recursive: true });
    // Pipes inside summary escape to \| in valid written files; but here we
    // just verify the final serialize always runs sanitize.
    await fs.writeFile(
      kanbanPath,
      `# 工作看板
> 最后更新: 2026/4/17 14:00:00

## 🔨 进行中 (1)
| task-id | 标题 | 负责人 | 状态 | 最新进展 |
|---------|------|--------|------|----------|
| task-500 | T | dev-1 | 🔨 | priority: high ---  ## obs content |

## ✅ 已完成 (0)
`
    );
    // Trigger pure migration write
    await sanitizeKanbanFile(session);
    const content = await readKanban(session);
    const row = content.split('\n').find(l => l.startsWith('| task-500 '));
    expect(row).toBeDefined();
    expect(row).not.toMatch(/[\r\n]/);
    expect(row).not.toContain('---');
    // "##" should not survive as markdown heading marker
    expect(row).not.toMatch(/##\s/);
  });

  it('sanitizes taskTitle/assignee at serialize time too', async () => {
    // Pass a title with a newline and a pipe directly through updateKanban
    await updateKanban(session, {
      taskId: 'task-501',
      taskTitle: 'has|pipe\nand newline',
      assignee: 'dev-1',
      status: 'dev',
      summary: 'ok',
    });
    const content = await readKanban(session);
    const row = content.split('\n').find(l => l.startsWith('| task-501 '));
    expect(row).toBeDefined();
    expect(row.split('\n').length).toBe(1);
    // Pipe inside title must be escaped (\|), not raw |
    const cells = row.split('|').map(c => c.trim());
    // Expected cells: ['', 'task-501', '<title with \\| intact>', 'dev-1', 'dev', 'ok', '']
    expect(cells[1]).toBe('task-501');
    expect(cells[2]).toContain('has\\');
    expect(cells[2]).not.toMatch(/^has\|pipe$/);
  });

  it('summary width is ≤120 chars in final serialized file', async () => {
    const long = 'y'.repeat(500);
    await updateKanban(session, {
      taskId: 'task-502',
      taskTitle: 'T',
      assignee: 'dev-1',
      status: 'dev',
      summary: long,
    });
    const content = await readKanban(session);
    const row = content.split('\n').find(l => l.startsWith('| task-502 '));
    const cells = row.split('|').map(c => c.trim());
    const summaryCell = cells[5];
    expect(summaryCell.length).toBeLessThanOrEqual(120);
    expect(summaryCell.endsWith('…')).toBe(true);
  });
});

describe('sanitizeKanbanFile (startup migration)', () => {
  let session;
  beforeEach(async () => {
    session = await mkSession('zh-CN');
  });
  afterEach(async () => {
    await fs.rm(session.sharedDir, { recursive: true, force: true });
  });

  it('returns false when kanban.md does not exist', async () => {
    const ran = await sanitizeKanbanFile(session);
    expect(ran).toBe(false);
  });

  it('returns false for falsy session', async () => {
    expect(await sanitizeKanbanFile(null)).toBe(false);
    expect(await sanitizeKanbanFile({})).toBe(false);
  });

  it('rewrites file, removes placeholders, keeps valid rows', async () => {
    const kanbanPath = join(session.sharedDir, 'context', 'kanban.md');
    await fs.mkdir(join(session.sharedDir, 'context'), { recursive: true });
    await fs.writeFile(
      kanbanPath,
      `# 工作看板
> 最后更新: 2026/4/17 13:00:00

## 🔨 进行中 (4)
| task-id | 标题 | 负责人 | 状态 | 最新进展 |
|---------|------|--------|------|----------|
| <task-id> | <标题> | - | - | - |
| task-289 | 清理 kanban | dev-1 | 🔨 开发中 | priority: high
---
## 症状
行被撑坏 |
| 279 | Unify Sidebar Redesign | - | - | - |
| task-225, task-226 | 合并 id | - | - | - |

## ✅ 已完成 (3)
| task-id | 标题 | 负责人 |
|---------|------|--------|
| task-XX | 任务标题 | - |
| <task-id> | <标题> | - |
| task-100 | 合法任务 | dev-3 |
`
    );
    const ran = await sanitizeKanbanFile(session);
    expect(ran).toBe(true);

    const content = await readKanban(session);
    // Forbidden rows
    expect(content).not.toContain('<task-id>');
    expect(content).not.toContain('<标题>');
    expect(content).not.toContain('task-XX');
    expect(content).not.toMatch(/^\| 279 \|/m);
    expect(content).not.toContain('task-225, task-226');
    // Kept rows
    expect(content).toContain('task-289');
    expect(content).toContain('task-100');
    // Active/completed counts should match visible valid rows
    const activeRows = content.split('\n').filter(l => /^\| task-\d+ \|/.test(l) && content.slice(0, content.indexOf(l)).lastIndexOf('## 🔨') > content.slice(0, content.indexOf(l)).lastIndexOf('## ✅'));
    expect(activeRows.length).toBe(1);
    const activeHeader = content.match(/## 🔨 [^(]*\((\d+)\)/);
    const doneHeader = content.match(/## ✅ [^(]*\((\d+)\)/);
    expect(activeHeader[1]).toBe('1');
    expect(doneHeader[1]).toBe('1');
  });

  it('is idempotent — second run leaves file stable', async () => {
    const kanbanPath = join(session.sharedDir, 'context', 'kanban.md');
    await fs.mkdir(join(session.sharedDir, 'context'), { recursive: true });
    await fs.writeFile(
      kanbanPath,
      `# 工作看板
> 最后更新: 2026/4/17 13:00:00

## 🔨 进行中 (1)
| task-id | 标题 | 负责人 | 状态 | 最新进展 |
|---------|------|--------|------|----------|
| task-600 | 干净 | dev-1 | 🔨 | 单行摘要 |

## ✅ 已完成 (0)
`
    );
    await sanitizeKanbanFile(session);
    const first = await readKanban(session);
    // Ignore the "最后更新" timestamp for comparison
    const strip = s => s.replace(/> 最后更新:.*$/m, '').replace(/> Last updated:.*$/m, '');
    await sanitizeKanbanFile(session);
    const second = await readKanban(session);
    expect(strip(second)).toBe(strip(first));
  });
});
