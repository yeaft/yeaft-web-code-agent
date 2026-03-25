import { describe, it, expect } from 'vitest';

/**
 * Tests for Conductor Claude instruction parsing.
 *
 * Replicates parseCreateTask and parseForwardTask from
 * agent/conductor/conductor-claude.js to avoid SDK/context side effects.
 */

// =====================================================================
// Replicate parsing functions for isolated testing
// =====================================================================

function parseCreateTask(text) {
  const regex = /---CREATE_TASK---\s*\n([\s\S]*?)---END_CREATE_TASK---/g;
  const tasks = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/title:\s*(.+)/i);
    if (titleMatch) {
      tasks.push({ title: titleMatch[1].trim() });
    }
  }
  return tasks;
}

function parseForwardTask(text) {
  const regex = /---FORWARD_TASK---\s*\n([\s\S]*?)---END_FORWARD_TASK---/g;
  const forwards = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const taskIdMatch = block.match(/taskId:\s*(.+)/i);
    const messageMatch = block.match(/message:\s*([\s\S]+)/i);
    if (taskIdMatch) {
      forwards.push({
        taskId: taskIdMatch[1].trim(),
        message: messageMatch ? messageMatch[1].trim() : ''
      });
    }
  }
  return forwards;
}

// Helper: buildTaskContext
function buildTaskContext(session) {
  if (session.tasks.size === 0) return null;
  const lines = ['当前工作路径: ' + (session.workDir || '(未设置)'), '', '活跃任务:'];
  for (const t of session.tasks.values()) {
    lines.push(`- ${t.taskId}: ${t.title} [${t.phase} ${t.progress}%] @ ${t.workDir}`);
  }
  return lines.join('\n');
}

// Helper: buildConductorSystemPrompt (excerpt for testing)
function buildConductorSystemPrompt(session) {
  const taskSummaries = Array.from(session.tasks.values())
    .map(t => `- ${t.taskId}: ${t.title} [${t.phase} ${t.progress}%] @ ${t.workDir}`)
    .join('\n');

  return `# Conductor — 交响乐指挥台

你是 Conductor，项目的总指挥。你的职责是：
1. **分类消息**：判断用户的输入是简单问答还是需要创建任务

## 当前工作路径
${session.workDir || '(未设置)'}

## 当前活跃任务
${taskSummaries || '(无)'}`;
}

// =====================================================================
// Tests
// =====================================================================

describe('parseCreateTask', () => {
  it('should parse a single CREATE_TASK instruction', () => {
    const text = `好的，我来为你创建任务。

---CREATE_TASK---
title: 实现用户登录功能
---END_CREATE_TASK---

任务已创建。`;

    const tasks = parseCreateTask(text);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('实现用户登录功能');
  });

  it('should parse multiple CREATE_TASK instructions', () => {
    const text = `我会创建两个任务：

---CREATE_TASK---
title: 前端组件开发
---END_CREATE_TASK---

---CREATE_TASK---
title: 后端 API 设计
---END_CREATE_TASK---

两个任务已创建。`;

    const tasks = parseCreateTask(text);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe('前端组件开发');
    expect(tasks[1].title).toBe('后端 API 设计');
  });

  it('should return empty array when no instructions found', () => {
    const text = '这是一段普通的回答，没有任何指令。';
    const tasks = parseCreateTask(text);
    expect(tasks).toHaveLength(0);
  });

  it('should return empty array for empty input', () => {
    expect(parseCreateTask('')).toHaveLength(0);
  });

  it('should handle title with special characters', () => {
    const text = `---CREATE_TASK---
title: 修复 bug #123 — 用户名含 <script> 时崩溃
---END_CREATE_TASK---`;

    const tasks = parseCreateTask(text);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('修复 bug #123 — 用户名含 <script> 时崩溃');
  });

  it('should handle title with leading/trailing whitespace', () => {
    const text = `---CREATE_TASK---
title:    添加暗色主题
---END_CREATE_TASK---`;

    const tasks = parseCreateTask(text);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('添加暗色主题');
  });

  it('should skip block without title field', () => {
    const text = `---CREATE_TASK---
description: 这个block没有title
---END_CREATE_TASK---`;

    const tasks = parseCreateTask(text);
    expect(tasks).toHaveLength(0);
  });

  it('should handle case-insensitive title field', () => {
    const text = `---CREATE_TASK---
Title: 大写开头的标题
---END_CREATE_TASK---`;

    const tasks = parseCreateTask(text);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('大写开头的标题');
  });

  it('should handle title field with TITLE in uppercase', () => {
    const text = `---CREATE_TASK---
TITLE: 全大写标题字段
---END_CREATE_TASK---`;

    const tasks = parseCreateTask(text);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('全大写标题字段');
  });

  it('should not match incomplete delimiters', () => {
    const text = `---CREATE_TASK---
title: 缺少结束标记`;

    const tasks = parseCreateTask(text);
    expect(tasks).toHaveLength(0);
  });

  it('should not match reversed delimiters', () => {
    const text = `---END_CREATE_TASK---
title: 标记顺序颠倒
---CREATE_TASK---`;

    const tasks = parseCreateTask(text);
    expect(tasks).toHaveLength(0);
  });

  it('should handle text with only delimiters and no content', () => {
    const text = `---CREATE_TASK---
---END_CREATE_TASK---`;

    const tasks = parseCreateTask(text);
    expect(tasks).toHaveLength(0);
  });

  it('should handle mixed content with markdown code blocks', () => {
    const text = `这里有代码块：

\`\`\`
---CREATE_TASK---
title: 这是代码块里的，应该被匹配
---END_CREATE_TASK---
\`\`\`

还有一个真正的：
---CREATE_TASK---
title: 真正的任务
---END_CREATE_TASK---`;

    // Note: regex doesn't distinguish code blocks, both will be parsed
    const tasks = parseCreateTask(text);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.some(t => t.title === '真正的任务')).toBe(true);
  });

  it('should handle multiple extra fields in block (only extract title)', () => {
    const text = `---CREATE_TASK---
title: 任务标题
priority: high
assignee: dev-1
---END_CREATE_TASK---`;

    const tasks = parseCreateTask(text);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('任务标题');
    expect(tasks[0]).not.toHaveProperty('priority');
  });
});

describe('parseForwardTask', () => {
  it('should parse a single FORWARD_TASK instruction', () => {
    const text = `收到，我把消息转给对应任务。

---FORWARD_TASK---
taskId: task-abc123
message: 请优先处理登录页面的样式问题
---END_FORWARD_TASK---`;

    const forwards = parseForwardTask(text);
    expect(forwards).toHaveLength(1);
    expect(forwards[0].taskId).toBe('task-abc123');
    expect(forwards[0].message).toBe('请优先处理登录页面的样式问题');
  });

  it('should parse multiple FORWARD_TASK instructions', () => {
    const text = `---FORWARD_TASK---
taskId: task-001
message: 前端请加上loading状态
---END_FORWARD_TASK---

---FORWARD_TASK---
taskId: task-002
message: 后端请添加错误码文档
---END_FORWARD_TASK---`;

    const forwards = parseForwardTask(text);
    expect(forwards).toHaveLength(2);
    expect(forwards[0].taskId).toBe('task-001');
    expect(forwards[1].taskId).toBe('task-002');
  });

  it('should return empty array when no forward instructions found', () => {
    const text = '普通文本回复';
    expect(parseForwardTask(text)).toHaveLength(0);
  });

  it('should return empty array for empty input', () => {
    expect(parseForwardTask('')).toHaveLength(0);
  });

  it('should handle forward with empty message', () => {
    const text = `---FORWARD_TASK---
taskId: task-xyz
---END_FORWARD_TASK---`;

    const forwards = parseForwardTask(text);
    expect(forwards).toHaveLength(1);
    expect(forwards[0].taskId).toBe('task-xyz');
    expect(forwards[0].message).toBe('');
  });

  it('should handle multi-line message', () => {
    const text = `---FORWARD_TASK---
taskId: task-multi
message: 第一行
第二行
第三行
---END_FORWARD_TASK---`;

    const forwards = parseForwardTask(text);
    expect(forwards).toHaveLength(1);
    expect(forwards[0].taskId).toBe('task-multi');
    // message captures everything after "message: " to END
    expect(forwards[0].message).toContain('第一行');
  });

  it('should skip block without taskId', () => {
    const text = `---FORWARD_TASK---
message: 没有taskId的消息
---END_FORWARD_TASK---`;

    const forwards = parseForwardTask(text);
    expect(forwards).toHaveLength(0);
  });

  it('should handle taskId with special characters', () => {
    const text = `---FORWARD_TASK---
taskId: task-lxyz123-ab56
message: test
---END_FORWARD_TASK---`;

    const forwards = parseForwardTask(text);
    expect(forwards).toHaveLength(1);
    expect(forwards[0].taskId).toBe('task-lxyz123-ab56');
  });

  it('should handle case-insensitive field names', () => {
    const text = `---FORWARD_TASK---
TaskId: task-case
Message: 大小写测试
---END_FORWARD_TASK---`;

    const forwards = parseForwardTask(text);
    expect(forwards).toHaveLength(1);
    expect(forwards[0].taskId).toBe('task-case');
    expect(forwards[0].message).toBe('大小写测试');
  });

  it('should not match incomplete delimiters', () => {
    const text = `---FORWARD_TASK---
taskId: task-incomplete
message: 缺少结束标记`;

    expect(parseForwardTask(text)).toHaveLength(0);
  });
});

describe('Mixed CREATE_TASK and FORWARD_TASK', () => {
  it('should parse both instruction types from same text', () => {
    const text = `我会创建一个新任务并给现有任务发消息：

---CREATE_TASK---
title: 新的优化任务
---END_CREATE_TASK---

---FORWARD_TASK---
taskId: task-existing
message: 请注意新任务可能影响你的工作
---END_FORWARD_TASK---`;

    const creates = parseCreateTask(text);
    const forwards = parseForwardTask(text);

    expect(creates).toHaveLength(1);
    expect(creates[0].title).toBe('新的优化任务');
    expect(forwards).toHaveLength(1);
    expect(forwards[0].taskId).toBe('task-existing');
  });

  it('should handle text with no instructions of either type', () => {
    const text = '这只是一个简单的回答。';
    expect(parseCreateTask(text)).toHaveLength(0);
    expect(parseForwardTask(text)).toHaveLength(0);
  });
});

describe('buildTaskContext', () => {
  it('should return null when no tasks exist', () => {
    const session = { tasks: new Map(), workDir: '/project' };
    expect(buildTaskContext(session)).toBeNull();
  });

  it('should include work dir and task list', () => {
    const session = {
      workDir: '/home/user/project',
      tasks: new Map([
        ['task-1', { taskId: 'task-1', title: '登录功能', phase: 'dev', progress: 50, workDir: '/home/user/project' }],
        ['task-2', { taskId: 'task-2', title: '测试用例', phase: 'test', progress: 0, workDir: '/home/user/project' }]
      ])
    };

    const context = buildTaskContext(session);
    expect(context).toContain('当前工作路径: /home/user/project');
    expect(context).toContain('task-1: 登录功能 [dev 50%]');
    expect(context).toContain('task-2: 测试用例 [test 0%]');
  });

  it('should show (未设置) when workDir is null', () => {
    const session = {
      workDir: null,
      tasks: new Map([
        ['task-1', { taskId: 'task-1', title: 'test', phase: 'created', progress: 0, workDir: '' }]
      ])
    };

    const context = buildTaskContext(session);
    expect(context).toContain('当前工作路径: (未设置)');
  });
});

describe('buildConductorSystemPrompt', () => {
  it('should include workDir in prompt', () => {
    const session = { workDir: '/home/user/project', tasks: new Map() };
    const prompt = buildConductorSystemPrompt(session);
    expect(prompt).toContain('/home/user/project');
  });

  it('should show (未设置) when workDir is null', () => {
    const session = { workDir: null, tasks: new Map() };
    const prompt = buildConductorSystemPrompt(session);
    expect(prompt).toContain('(未设置)');
  });

  it('should show (无) when no tasks exist', () => {
    const session = { workDir: '/project', tasks: new Map() };
    const prompt = buildConductorSystemPrompt(session);
    expect(prompt).toContain('(无)');
  });

  it('should list active tasks in prompt', () => {
    const session = {
      workDir: '/project',
      tasks: new Map([
        ['t1', { taskId: 't1', title: '开发功能A', phase: 'dev', progress: 30, workDir: '/project' }]
      ])
    };

    const prompt = buildConductorSystemPrompt(session);
    expect(prompt).toContain('t1: 开发功能A [dev 30%] @ /project');
    expect(prompt).not.toContain('(无)');
  });
});
