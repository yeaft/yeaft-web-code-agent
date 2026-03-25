/**
 * Tests for Conductor V5 — conductor-claude.js
 *
 * Covers: parseCreateTask, parseForwardTask, buildConductorSystemPrompt,
 *         session ID persistence, V5 CREATE_TASK with workDir+scenario
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let src;
beforeAll(() => {
  src = readFileSync(join(process.cwd(), 'agent/conductor/conductor-claude.js'), 'utf-8');
});

// ── Replicate parseCreateTask for functional tests ──────────────────

function parseCreateTask(text) {
  const regex = /---CREATE_TASK---\s*\n([\s\S]*?)---END_CREATE_TASK---/g;
  const tasks = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/^title:\s*(.+)/im);
    const workDirMatch = block.match(/^workDir:\s*(.+)/im);
    const scenarioMatch = block.match(/^scenario:\s*(.+)/im);
    if (titleMatch) {
      tasks.push({
        title: titleMatch[1].trim(),
        workDir: workDirMatch ? workDirMatch[1].trim() : '',
        scenario: scenarioMatch ? scenarioMatch[1].trim() : 'dev'
      });
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
    const taskIdMatch = block.match(/^taskId:\s*(.+)/im);
    const messageMatch = block.match(/^message:\s*([\s\S]*?)$/im);
    if (taskIdMatch) {
      forwards.push({
        taskId: taskIdMatch[1].trim(),
        message: messageMatch ? messageMatch[1].trim() : ''
      });
    }
  }
  return forwards;
}

// ── parseCreateTask (V5: workDir + scenario) ────────────────────────

describe('parseCreateTask', () => {
  it('should parse title, workDir, scenario from CREATE_TASK block', () => {
    const text = `---CREATE_TASK---
title: 实现登录功能
workDir: /home/user/project
scenario: dev
---END_CREATE_TASK---`;
    const tasks = parseCreateTask(text);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('实现登录功能');
    expect(tasks[0].workDir).toBe('/home/user/project');
    expect(tasks[0].scenario).toBe('dev');
  });

  it('should default scenario to dev when missing', () => {
    const text = `---CREATE_TASK---
title: Fix bug
workDir: /tmp/project
---END_CREATE_TASK---`;
    const tasks = parseCreateTask(text);
    expect(tasks[0].scenario).toBe('dev');
  });

  it('should default workDir to empty string when missing', () => {
    const text = `---CREATE_TASK---
title: Quick fix
---END_CREATE_TASK---`;
    const tasks = parseCreateTask(text);
    expect(tasks[0].workDir).toBe('');
  });

  it('should parse multiple CREATE_TASK blocks', () => {
    const text = `---CREATE_TASK---
title: Task A
workDir: /a
scenario: dev
---END_CREATE_TASK---
Some text
---CREATE_TASK---
title: Task B
workDir: /b
scenario: writing
---END_CREATE_TASK---`;
    const tasks = parseCreateTask(text);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe('Task A');
    expect(tasks[1].title).toBe('Task B');
    expect(tasks[1].scenario).toBe('writing');
  });

  it('should return empty array when no blocks found', () => {
    expect(parseCreateTask('Hello world')).toEqual([]);
  });

  it('should ignore blocks without title', () => {
    const text = `---CREATE_TASK---
workDir: /tmp
---END_CREATE_TASK---`;
    expect(parseCreateTask(text)).toEqual([]);
  });

  it('should handle various scenario values', () => {
    for (const scenario of ['dev', 'writing', 'trading', 'video']) {
      const text = `---CREATE_TASK---\ntitle: T\nscenario: ${scenario}\n---END_CREATE_TASK---`;
      expect(parseCreateTask(text)[0].scenario).toBe(scenario);
    }
  });
});

// ── parseForwardTask ────────────────────────────────────────────────

describe('parseForwardTask', () => {
  it('should parse taskId and message', () => {
    const text = `---FORWARD_TASK---
taskId: task-abc123
message: 请加上单元测试
---END_FORWARD_TASK---`;
    const forwards = parseForwardTask(text);
    expect(forwards).toHaveLength(1);
    expect(forwards[0].taskId).toBe('task-abc123');
    expect(forwards[0].message).toBe('请加上单元测试');
  });

  it('should return empty when no blocks found', () => {
    expect(parseForwardTask('no blocks here')).toEqual([]);
  });

  it('should ignore blocks without taskId', () => {
    const text = `---FORWARD_TASK---
message: orphan
---END_FORWARD_TASK---`;
    expect(parseForwardTask(text)).toEqual([]);
  });

  it('should default message to empty when missing', () => {
    const text = `---FORWARD_TASK---
taskId: task-123
---END_FORWARD_TASK---`;
    const fwd = parseForwardTask(text);
    expect(fwd[0].message).toBe('');
  });
});

// ── buildConductorSystemPrompt ──────────────────────────────────────

describe('buildConductorSystemPrompt', () => {
  it('should include task summary injection from conductor.tasks', () => {
    expect(src).toContain('conductor.tasks');
    expect(src).toContain('taskLines');
  });

  it('should include workDir and scenario in task summary line', () => {
    expect(src).toContain('workDir=');
    expect(src).toContain('scenario=');
  });

  it('should include active actors in summary', () => {
    expect(src).toContain('activeActors');
    expect(src).toContain("actors='");
  });

  it('should require workDir and scenario in CREATE_TASK format', () => {
    expect(src).toContain('workDir: <项目工作路径>');
    expect(src).toContain('scenario: <dev|writing|trading|video>');
  });

  it('should not include old session.workDir pattern', () => {
    expect(src).not.toContain('session.workDir');
  });
});

// ── Claude Session ID Persistence ───────────────────────────────────

describe('Claude session ID persistence', () => {
  it('should save to claude-session.json in conductor home', () => {
    expect(src).toContain("join(dir, 'claude-session.json')");
  });

  it('should load from claude-session.json', () => {
    expect(src).toContain("join(getConductorHome(), 'claude-session.json')");
  });

  it('should no longer take sessionDataDir parameter', () => {
    // V5: functions don't take dir as first arg anymore
    expect(src).toContain('async function saveConductorSessionId(claudeSessionId)');
    expect(src).toContain('async function loadConductorSessionId()');
    expect(src).toContain('async function clearConductorSessionId()');
  });
});

// ── CREATE_TASK handler flow ────────────────────────────────────────

describe('CREATE_TASK handler', () => {
  it('should generate unique taskId with timestamp + random', () => {
    expect(src).toContain("Date.now().toString(36)");
    expect(src).toContain("Math.random().toString(36)");
  });

  it('should call initTaskDir to create task directory + worktree', () => {
    expect(src).toContain('initTaskDir(ct.workDir, taskId)');
  });

  it('should register task in state.json', () => {
    expect(src).toContain('updateTaskInState(taskId, taskEntry)');
  });

  it('should add task to conductor.tasks map', () => {
    expect(src).toContain('conductor.tasks.set(taskId, taskEntry)');
  });

  it('should send task_created output and conductor_task_created message', () => {
    expect(src).toContain("'task_created'");
    expect(src).toContain("type: 'conductor_task_created'");
  });

  it('should include workDir and scenario in task entry', () => {
    expect(src).toContain('workDir: ct.workDir');
    expect(src).toContain('scenario: ct.scenario');
  });
});

// ── FORWARD_TASK handler ────────────────────────────────────────────

describe('FORWARD_TASK handler', () => {
  it('should look up task from conductor.tasks', () => {
    expect(src).toContain('conductor.tasks.get(ft.taskId)');
  });

  it('should push message to task inbox', () => {
    expect(src).toContain('task.inbox.push');
  });

  it('should send task_forwarded output', () => {
    expect(src).toContain("'task_forwarded'");
  });

  it('should warn on unknown task', () => {
    expect(src).toContain('Unknown task');
  });
});

// ── Export parse functions for testing ───────────────────────────────

describe('Exports', () => {
  it('should export parseCreateTask and parseForwardTask', () => {
    expect(src).toContain('export { parseCreateTask, parseForwardTask }');
  });
});
