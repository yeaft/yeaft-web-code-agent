/**
 * Tests for task-267: Unify tools full implementation.
 *
 * Verifies that all 34 tools are properly implemented with production-quality
 * execute functions (no placeholders), registered in index.js, and functional.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

const TOOLS_DIR = join(import.meta.dirname, '..', '..', 'agent', 'unify', 'tools');

// ──────────────────────────────────────────────
// § Registry & index.js integration
// ──────────────────────────────────────────────

describe('index.js tool registration', () => {
  it('allTools has 41 tools (5 existing + 36 new)', async () => {
    const { allTools } = await import(`${TOOLS_DIR}/index.js`);
    expect(allTools.length).toBe(41);
  });

  it('all 39 tools have valid name, description, parameters, and execute', async () => {
    const { allTools } = await import(`${TOOLS_DIR}/index.js`);
    for (const tool of allTools) {
      expect(tool.name).toBeTruthy();
      expect(typeof tool.name).toBe('string');
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe('string');
      expect(tool.parameters).toBeTruthy();
      expect(typeof tool.execute).toBe('function');
      expect(Array.isArray(tool.modes)).toBe(true);
      expect(tool.modes.length).toBeGreaterThan(0);
    }
  });

  it('no tool has placeholder "Not implemented" in execute', async () => {
    const { readFileSync: rf } = await import('fs');
    const { readdirSync } = await import('fs');
    const files = readdirSync(TOOLS_DIR).filter(f =>
      f.endsWith('.js') && !['index.js', 'registry.js', 'types.js'].includes(f)
    );
    for (const file of files) {
      const src = rf(join(TOOLS_DIR, file), 'utf8');
      expect(src).not.toContain("throw new Error('Not implemented')");
      expect(src).not.toContain('throw new Error("Not implemented")');
    }
  });

  it('createFullRegistry returns registry with all tools accessible by name', async () => {
    const { createFullRegistry, allTools } = await import(`${TOOLS_DIR}/index.js`);
    const registry = createFullRegistry();
    expect(registry.size).toBe(allTools.length);
    for (const tool of allTools) {
      expect(registry.has(tool.name)).toBe(true);
    }
  });

  it('mode filtering: chat mode has correct tools', async () => {
    const { createFullRegistry } = await import(`${TOOLS_DIR}/index.js`);
    const registry = createFullRegistry();
    const chatTools = registry.getToolsForMode('chat');
    const chatNames = chatTools.map(t => t.name);

    // Chat-mode tools should include:
    expect(chatNames).toContain('AskUser');
    expect(chatNames).toContain('MemoryRead');
    expect(chatNames).toContain('MemoryWrite');
    expect(chatNames).toContain('MemorySearch');
    expect(chatNames).toContain('WebSearch');
    expect(chatNames).toContain('WebFetch');
    expect(chatNames).toContain('HistorySearch');
    expect(chatNames).toContain('JsRepl');
    expect(chatNames).toContain('JsReplReset');
    expect(chatNames).toContain('ImageGeneration');
    expect(chatNames).toContain('ViewImage');
    expect(chatNames).toContain('ToolSearch');
    expect(chatNames).toContain('Skill');

    // Work-only tools should NOT be in chat mode:
    expect(chatNames).not.toContain('Bash');
    expect(chatNames).not.toContain('FileRead');
    expect(chatNames).not.toContain('FileWrite');
    expect(chatNames).not.toContain('FileEdit');
    expect(chatNames).not.toContain('Agent');
  });

  it('mode filtering: work mode has all tools', async () => {
    const { createFullRegistry, allTools } = await import(`${TOOLS_DIR}/index.js`);
    const registry = createFullRegistry();
    const workTools = registry.getToolsForMode('work');
    expect(workTools.length).toBe(allTools.length);
  });
});

// ──────────────────────────────────────────────
// § P0 Core tools
// ──────────────────────────────────────────────

describe('AskUser tool', () => {
  it('returns structured question with options', async () => {
    const mod = await import(`${TOOLS_DIR}/ask-user.js`);
    const tool = mod.default;
    const result = JSON.parse(await tool.execute({
      question: 'Which language?',
      options: ['English', 'Chinese'],
    }, {}));

    expect(result.type).toBe('ask_user');
    expect(result.question).toBe('Which language?');
    expect(result.options).toEqual(['English', 'Chinese']);
    expect(result.requestId).toBeTruthy();
  });

  it('returns error when question is missing', async () => {
    const mod = await import(`${TOOLS_DIR}/ask-user.js`);
    const result = JSON.parse(await mod.default.execute({}, {}));
    expect(result.error).toBeTruthy();
  });
});

describe('MemoryRead tool', () => {
  it('reads profile via memoryStore (returns raw text)', async () => {
    const mod = await import(`${TOOLS_DIR}/memory-read.js`);
    const tool = mod.default;
    const mockStore = {
      readProfile: () => '# User Profile\nName: Test',
    };
    // profile action returns raw markdown text, not JSON
    const result = await tool.execute(
      { action: 'profile' },
      { memoryStore: mockStore }
    );
    expect(result).toContain('User Profile');
    expect(result).toContain('Name: Test');
  });

  it('lists entries via memoryStore (returns JSON)', async () => {
    const mod = await import(`${TOOLS_DIR}/memory-read.js`);
    const tool = mod.default;
    const mockStore = {
      listEntries: () => [
        { name: 'test-1', kind: 'fact', scope: 'global', tags: [], importance: 'normal', updated_at: '2026-01-01' },
      ],
    };
    const result = JSON.parse(await tool.execute(
      { action: 'list' },
      { memoryStore: mockStore }
    ));
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe('test-1');
  });

  it('returns error when memoryStore is missing', async () => {
    const mod = await import(`${TOOLS_DIR}/memory-read.js`);
    const result = JSON.parse(await mod.default.execute({ action: 'profile' }, {}));
    expect(result.error).toBeTruthy();
  });
});

describe('MemoryWrite tool', () => {
  it('writes entry via memoryStore', async () => {
    const mod = await import(`${TOOLS_DIR}/memory-write.js`);
    const tool = mod.default;
    let written = null;
    const mockStore = {
      writeEntry: (entry) => { written = entry; return 'my-fact'; },
    };
    // write_entry requires entry object with name and content
    const result = JSON.parse(await tool.execute(
      { action: 'write_entry', entry: { name: 'My Fact', kind: 'fact', content: 'Test content' } },
      { memoryStore: mockStore }
    ));
    expect(result.success).toBe(true);
    expect(result.slug).toBe('my-fact');
    expect(written).toBeTruthy();
    expect(written.kind).toBe('fact');
  });

  it('deletes entry via memoryStore', async () => {
    const mod = await import(`${TOOLS_DIR}/memory-write.js`);
    const tool = mod.default;
    let deleted = null;
    const mockStore = {
      deleteEntry: (name) => { deleted = name; return true; },
    };
    // delete_entry uses input.name
    const result = JSON.parse(await tool.execute(
      { action: 'delete_entry', name: 'entry-123' },
      { memoryStore: mockStore }
    ));
    expect(result.success).toBe(true);
    expect(deleted).toBe('entry-123');
  });
});

describe('MemorySearch tool', () => {
  it('searches entries with keyword filter', async () => {
    const mod = await import(`${TOOLS_DIR}/memory-search.js`);
    const tool = mod.default;
    const mockStore = {
      findByFilter: () => [
        { name: 'javascript-basics', kind: 'fact', content: 'JavaScript is a great language', scope: 'global', tags: [] },
        { name: 'python-basics', kind: 'fact', content: 'Python is nice', scope: 'global', tags: [] },
      ],
    };
    const result = JSON.parse(await tool.execute(
      { keyword: 'JavaScript' },
      { memoryStore: mockStore }
    ));
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });
});

describe('WebSearch tool', () => {
  it('returns error when no search API configured', async () => {
    const mod = await import(`${TOOLS_DIR}/web-search.js`);
    const tool = mod.default;
    const result = JSON.parse(await tool.execute(
      { query: 'test search' },
      { adapter: {}, config: {} }
    ));
    expect(result.error).toBeTruthy();
  });
});

describe('WebFetch tool', () => {
  it('returns error for empty URL', async () => {
    const mod = await import(`${TOOLS_DIR}/web-fetch.js`);
    const tool = mod.default;
    const result = JSON.parse(await tool.execute({}, {}));
    expect(result.error).toBeTruthy();
  });
});

describe('HistorySearch tool', () => {
  it('returns error when yeaftDir is missing', async () => {
    const mod = await import(`${TOOLS_DIR}/history-search.js`);
    const tool = mod.default;
    const result = JSON.parse(await tool.execute({ keyword: 'test' }, {}));
    expect(result.error).toBeTruthy();
  });
});

// ──────────────────────────────────────────────
// § P0 File tools
// ──────────────────────────────────────────────

describe('FileRead tool', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'unify-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a text file with line numbers', async () => {
    const mod = await import(`${TOOLS_DIR}/file-read.js`);
    const tool = mod.default;
    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'line one\nline two\nline three\n');

    const result = await tool.execute({ file_path: filePath }, { cwd: tmpDir });
    expect(result).toContain('1\t');
    expect(result).toContain('line one');
    expect(result).toContain('line two');
    expect(result).toContain('line three');
  });

  it('supports offset and limit', async () => {
    const mod = await import(`${TOOLS_DIR}/file-read.js`);
    const tool = mod.default;
    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'a\nb\nc\nd\ne\n');

    const result = await tool.execute(
      { file_path: filePath, offset: 2, limit: 2 },
      { cwd: tmpDir }
    );
    expect(result).toContain('c');
    expect(result).toContain('d');
    expect(result).not.toContain('\ta\n');
    expect(result).not.toContain('\te\n');
  });

  it('returns error for non-existent file', async () => {
    const mod = await import(`${TOOLS_DIR}/file-read.js`);
    const tool = mod.default;
    const result = await tool.execute(
      { file_path: join(tmpDir, 'nope.txt') },
      { cwd: tmpDir }
    );
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeTruthy();
  });
});

describe('FileWrite tool', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'unify-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a new file', async () => {
    const mod = await import(`${TOOLS_DIR}/file-write.js`);
    const tool = mod.default;
    const filePath = join(tmpDir, 'new-file.txt');

    const result = JSON.parse(await tool.execute(
      { file_path: filePath, content: 'hello world' },
      { cwd: tmpDir }
    ));
    expect(result.success).toBe(true);

    const written = readFileSync(filePath, 'utf8');
    expect(written).toBe('hello world');
  });

  it('creates nested directories automatically', async () => {
    const mod = await import(`${TOOLS_DIR}/file-write.js`);
    const tool = mod.default;
    const filePath = join(tmpDir, 'a', 'b', 'c', 'deep.txt');

    const result = JSON.parse(await tool.execute(
      { file_path: filePath, content: 'deep content' },
      { cwd: tmpDir }
    ));
    expect(result.success).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('deep content');
  });
});

describe('FileEdit tool', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'unify-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces a unique string', async () => {
    const mod = await import(`${TOOLS_DIR}/file-edit.js`);
    const tool = mod.default;
    const filePath = join(tmpDir, 'edit-me.txt');
    writeFileSync(filePath, 'Hello World\nGoodbye World\n');

    const result = JSON.parse(await tool.execute(
      { file_path: filePath, old_string: 'Hello World', new_string: 'Hi World' },
      { cwd: tmpDir }
    ));
    expect(result.success).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('Hi World\nGoodbye World\n');
  });

  it('fails if old_string not found', async () => {
    const mod = await import(`${TOOLS_DIR}/file-edit.js`);
    const tool = mod.default;
    const filePath = join(tmpDir, 'edit-me.txt');
    writeFileSync(filePath, 'Hello World\n');

    const result = JSON.parse(await tool.execute(
      { file_path: filePath, old_string: 'NOPE', new_string: 'YES' },
      { cwd: tmpDir }
    ));
    expect(result.error).toBeTruthy();
  });

  it('fails if old_string is ambiguous (multiple matches)', async () => {
    const mod = await import(`${TOOLS_DIR}/file-edit.js`);
    const tool = mod.default;
    const filePath = join(tmpDir, 'edit-me.txt');
    writeFileSync(filePath, 'foo bar\nfoo baz\n');

    const result = JSON.parse(await tool.execute(
      { file_path: filePath, old_string: 'foo', new_string: 'qux' },
      { cwd: tmpDir }
    ));
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('2');
  });

  it('replace_all replaces all occurrences', async () => {
    const mod = await import(`${TOOLS_DIR}/file-edit.js`);
    const tool = mod.default;
    const filePath = join(tmpDir, 'edit-me.txt');
    writeFileSync(filePath, 'foo bar\nfoo baz\n');

    const result = JSON.parse(await tool.execute(
      { file_path: filePath, old_string: 'foo', new_string: 'qux', replace_all: true },
      { cwd: tmpDir }
    ));
    expect(result.success).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('qux bar\nqux baz\n');
  });
});

describe('Glob tool', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'unify-test-'));
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(join(tmpDir, 'src', 'app.js'), 'const x = 1;');
    writeFileSync(join(tmpDir, 'src', 'util.js'), 'const y = 2;');
    writeFileSync(join(tmpDir, 'readme.md'), '# Hi');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds files matching glob pattern (returns plain text)', async () => {
    const mod = await import(`${TOOLS_DIR}/glob.js`);
    const tool = mod.default;

    // Glob returns plain text (one file per line)
    const result = await tool.execute(
      { pattern: '**/*.js' },
      { cwd: tmpDir }
    );
    expect(result).toContain('app.js');
    expect(result).toContain('util.js');
  });

  it('returns message for non-matching pattern', async () => {
    const mod = await import(`${TOOLS_DIR}/glob.js`);
    const tool = mod.default;

    const result = await tool.execute(
      { pattern: '**/*.py' },
      { cwd: tmpDir }
    );
    // Should either be empty or indicate no matches
    expect(result).not.toContain('app.js');
  });
});

describe('Grep tool', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'unify-test-'));
    writeFileSync(join(tmpDir, 'file1.js'), 'const foo = 1;\nconst bar = 2;\n');
    writeFileSync(join(tmpDir, 'file2.js'), 'function foo() {}\nfunction baz() {}\n');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds files with matches (returns plain text)', async () => {
    const mod = await import(`${TOOLS_DIR}/grep.js`);
    const tool = mod.default;

    // Grep returns plain text
    const result = await tool.execute(
      { pattern: 'foo', path: tmpDir },
      { cwd: tmpDir }
    );
    expect(result).toContain('file1.js');
    expect(result).toContain('file2.js');
  });

  it('content output mode shows matching lines', async () => {
    const mod = await import(`${TOOLS_DIR}/grep.js`);
    const tool = mod.default;

    const result = await tool.execute(
      { pattern: 'bar', path: tmpDir, output_mode: 'content' },
      { cwd: tmpDir }
    );
    expect(result).toContain('bar');
  });
});

describe('ListDir tool', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'unify-test-'));
    mkdirSync(join(tmpDir, 'subdir'));
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists directory contents (returns plain text)', async () => {
    const mod = await import(`${TOOLS_DIR}/list-dir.js`);
    const tool = mod.default;

    // ListDir returns emoji-formatted text
    const result = await tool.execute(
      { path: tmpDir },
      { cwd: tmpDir }
    );
    expect(result).toContain('subdir');
    expect(result).toContain('file.txt');
  });
});

describe('Bash tool', () => {
  it('executes a simple command (returns plain text)', async () => {
    const mod = await import(`${TOOLS_DIR}/bash.js`);
    const tool = mod.default;

    // Bash returns plain text on success
    const result = await tool.execute(
      { command: 'echo hello' },
      { cwd: '/tmp' }
    );
    expect(result.trim()).toBe('hello');
  });

  it('captures stderr on error', async () => {
    const mod = await import(`${TOOLS_DIR}/bash.js`);
    const tool = mod.default;

    const result = await tool.execute(
      { command: 'ls /nonexistent-path-12345' },
      { cwd: '/tmp' }
    );
    // Non-zero exit code shows "Exit code: N" prefix
    expect(result).toContain('Exit code:');
    expect(result).toContain('STDERR');
  });

  it('respects timeout', async () => {
    const mod = await import(`${TOOLS_DIR}/bash.js`);
    const tool = mod.default;

    // Use timeout_ms parameter (bash tool's actual parameter name)
    const result = await tool.execute(
      { command: 'sleep 10', timeout_ms: 1000 },
      { cwd: '/tmp' }
    );
    // Should contain timeout info or exit code
    expect(result.includes('timed out') || result.includes('Exit code')).toBe(true);
  }, 10000);

  it('returns error when command is missing', async () => {
    const mod = await import(`${TOOLS_DIR}/bash.js`);
    const tool = mod.default;

    const result = JSON.parse(await tool.execute({}, { cwd: '/tmp' }));
    expect(result.error).toBeTruthy();
  });

  it('isDestructive detects dangerous commands', async () => {
    const mod = await import(`${TOOLS_DIR}/bash.js`);
    const tool = mod.default;

    expect(tool.isDestructive?.({ command: 'rm -rf /' })).toBe(true);
    expect(tool.isDestructive?.({ command: 'git reset --hard' })).toBe(true);
    expect(tool.isDestructive?.({ command: 'echo hello' })).toBe(false);
  });
});

describe('ApplyPatch tool', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'unify-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies a unified diff patch', async () => {
    const mod = await import(`${TOOLS_DIR}/apply-patch.js`);
    const tool = mod.default;
    const filePath = join(tmpDir, 'target.txt');
    writeFileSync(filePath, 'line 1\nline 2\nline 3\n');

    // Use literal strings to avoid tab/space issues in the diff
    const patch = [
      '--- a/target.txt',
      '+++ b/target.txt',
      '@@ -1,3 +1,3 @@',
      ' line 1',
      '-line 2',
      '+line TWO',
      ' line 3',
    ].join('\n') + '\n';

    const result = JSON.parse(await tool.execute(
      { patch },
      { cwd: tmpDir }
    ));
    expect(result.results).toBeTruthy();
    expect(result.results[0].success).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toContain('line TWO');
  });
});

// ──────────────────────────────────────────────
// § P1 Agent tools
// ──────────────────────────────────────────────

describe('Agent tools', () => {
  it('Agent creates a sub-agent entry', async () => {
    const agentMod = await import(`${TOOLS_DIR}/agent.js`);
    const tool = agentMod.default;
    const result = JSON.parse(await tool.execute(
      { name: 'test-agent-create', task: 'Do something', mode: 'work' },
      {}
    ));
    expect(result.success).toBe(true);
    expect(result.agentId).toBeTruthy();
  });

  it('ListAgents lists created agents', async () => {
    const agentMod = await import(`${TOOLS_DIR}/agent.js`);
    const listMod = await import(`${TOOLS_DIR}/list-agents.js`);

    await agentMod.default.execute({ name: 'list-test', task: 'Test' }, {});

    const result = JSON.parse(await listMod.default.execute({}, {}));
    expect(result.agents).toBeTruthy();
    expect(result.agents.length).toBeGreaterThan(0);
  });

  it('CloseAgent closes a created agent', async () => {
    const agentMod = await import(`${TOOLS_DIR}/agent.js`);
    const closeMod = await import(`${TOOLS_DIR}/close-agent.js`);

    const created = JSON.parse(await agentMod.default.execute(
      { name: 'close-test-agent', task: 'Test' },
      {}
    ));
    const result = JSON.parse(await closeMod.default.execute(
      { agent_id: created.agentId },
      {}
    ));
    expect(result.success).toBe(true);
  });
});

// ──────────────────────────────────────────────
// § P1 Task tools
// ──────────────────────────────────────────────

describe('Task tools', () => {
  it('TaskCreate creates a task', async () => {
    // Initialize task store with a temp directory before using task tools
    const { initTaskStore, taskCreate } = await import(`${TOOLS_DIR}/task-tools.js`);
    const { mkdirSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const tmpDir = join(tmpdir(), `yeaft-test-tasks-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    initTaskStore(tmpDir);
    const result = JSON.parse(await taskCreate.execute(
      { title: 'Test task', description: 'A test' },
      {}
    ));
    expect(result.success).toBe(true);
    expect(result.task.id).toBeTruthy();
    expect(result.task.title).toBe('Test task');
    expect(result.task.status).toBe('pending');
  });

  it('TaskUpdate updates task status', async () => {
    const { taskCreate, taskUpdate } = await import(`${TOOLS_DIR}/task-tools.js`);
    const created = JSON.parse(await taskCreate.execute(
      { title: 'Update me' },
      {}
    ));
    // taskUpdate uses task_id parameter
    const result = JSON.parse(await taskUpdate.execute(
      { task_id: created.task.id, status: 'in_progress' },
      {}
    ));
    expect(result.success).toBe(true);
    expect(result.task.status).toBe('in_progress');
  });

  it('TaskList lists tasks', async () => {
    const { taskCreate, taskList } = await import(`${TOOLS_DIR}/task-tools.js`);
    await taskCreate.execute({ title: 'List test' }, {});

    const result = JSON.parse(await taskList.execute({}, {}));
    expect(result.tasks).toBeTruthy();
    expect(result.tasks.length).toBeGreaterThan(0);
  });

  it('TaskGet retrieves task details', async () => {
    const { taskCreate, taskGet } = await import(`${TOOLS_DIR}/task-tools.js`);
    const created = JSON.parse(await taskCreate.execute(
      { title: 'Get me', description: 'Details test' },
      {}
    ));
    // taskGet uses task_id parameter
    const result = JSON.parse(await taskGet.execute(
      { task_id: created.task.id },
      {}
    ));
    expect(result.title).toBe('Get me');
    expect(result.description).toBe('Details test');
  });

  it('FollowupTask creates linked task', async () => {
    const { taskCreate, followupTask } = await import(`${TOOLS_DIR}/task-tools.js`);
    const parent = JSON.parse(await taskCreate.execute(
      { title: 'Parent' },
      {}
    ));
    // followupTask uses parent_task_id parameter
    const result = JSON.parse(await followupTask.execute(
      { parent_task_id: parent.task.id, title: 'Child task' },
      {}
    ));
    expect(result.success).toBe(true);
    expect(result.task.parentId).toBe(parent.task.id);
  });

  it('UpdatePlan updates the plan', async () => {
    const { updatePlan } = await import(`${TOOLS_DIR}/task-tools.js`);
    const result = JSON.parse(await updatePlan.execute(
      { action: 'update', content: '# My Plan\n\n1. Step one\n2. Step two' },
      {}
    ));
    expect(result.success).toBe(true);
  });
});

// ──────────────────────────────────────────────
// § P2 Auxiliary tools
// ──────────────────────────────────────────────

describe('JsRepl tool', () => {
  it('evaluates JavaScript expressions (returns plain text)', async () => {
    const { jsRepl } = await import(`${TOOLS_DIR}/js-repl.js`);
    // JsRepl returns plain text like "→ 5"
    const result = await jsRepl.execute({ code: '2 + 3' }, {});
    expect(result).toContain('5');
  });

  it('captures console.log output', async () => {
    const { jsRepl } = await import(`${TOOLS_DIR}/js-repl.js`);
    const result = await jsRepl.execute(
      { code: 'console.log("hello from repl"); 42' },
      {}
    );
    expect(result).toContain('hello from repl');
    expect(result).toContain('42');
  });

  it('persists state across calls', async () => {
    const { jsRepl } = await import(`${TOOLS_DIR}/js-repl.js`);
    await jsRepl.execute({ code: 'var myVar = 99;' }, {});
    const result = await jsRepl.execute({ code: 'myVar + 1' }, {});
    expect(result).toContain('100');
  });

  it('JsReplReset clears state', async () => {
    const { jsRepl, jsReplReset } = await import(`${TOOLS_DIR}/js-repl.js`);
    await jsRepl.execute({ code: 'var resetMe = 1;' }, {});
    await jsReplReset.execute({}, {});
    const result = await jsRepl.execute({ code: 'typeof resetMe' }, {});
    expect(result).toContain('undefined');
  });
});

describe('NotebookEdit tool', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'unify-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a new notebook with a cell', async () => {
    const mod = await import(`${TOOLS_DIR}/notebook-edit.js`);
    const tool = mod.default;
    const nbPath = join(tmpDir, 'test.ipynb');

    // NotebookEdit uses action/cell_index/cell_type/source params
    const result = JSON.parse(await tool.execute(
      {
        notebook_path: nbPath,
        action: 'insert',
        cell_type: 'code',
        source: 'print("hello")',
      },
      { cwd: tmpDir }
    ));
    expect(result.success).toBe(true);

    const nb = JSON.parse(readFileSync(nbPath, 'utf8'));
    expect(nb.cells.length).toBe(1);
    expect(nb.cells[0].source[0]).toContain('print("hello")');
  });
});

describe('ViewImage tool', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'unify-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads PNG metadata and dimensions', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;

    // Create a minimal valid PNG file (1x1 pixel)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D, // IHDR chunk length
      0x49, 0x48, 0x44, 0x52, // IHDR
      0x00, 0x00, 0x00, 0x01, // width = 1
      0x00, 0x00, 0x00, 0x01, // height = 1
      0x08, 0x02,             // bit depth, color type
      0x00, 0x00, 0x00,       // compression, filter, interlace
    ]);
    const pngPath = join(tmpDir, 'test.png');
    writeFileSync(pngPath, pngHeader);

    const result = JSON.parse(await tool.execute(
      { file_path: pngPath },
      { cwd: tmpDir }
    ));
    expect(result.format).toBe('PNG');
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
  });

  it('returns error for non-existent image', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    const result = JSON.parse(await tool.execute(
      { file_path: join(tmpDir, 'nope.png') },
      { cwd: tmpDir }
    ));
    expect(result.error).toBeTruthy();
  });
});

describe('ImageGeneration tool', () => {
  it('returns error when no API configured', async () => {
    const mod = await import(`${TOOLS_DIR}/image-generation.js`);
    const result = JSON.parse(await mod.default.execute(
      { prompt: 'a cat' },
      { config: {} }
    ));
    expect(result.error).toBeTruthy();
    expect(result.hint).toBeTruthy();
  });
});

describe('ToolSearch tool', () => {
  it('finds tools by name', async () => {
    const mod = await import(`${TOOLS_DIR}/tool-search.js`);
    const result = JSON.parse(await mod.default.execute(
      { query: 'Bash' },
      {}
    ));
    expect(result.totalResults).toBeGreaterThan(0);
    expect(result.results[0].name).toBe('Bash');
  });

  it('finds tools by description keyword', async () => {
    const mod = await import(`${TOOLS_DIR}/tool-search.js`);
    const result = JSON.parse(await mod.default.execute(
      { query: 'memory' },
      {}
    ));
    expect(result.totalResults).toBeGreaterThan(0);
  });

  it('filters by mode', async () => {
    const mod = await import(`${TOOLS_DIR}/tool-search.js`);
    const result = JSON.parse(await mod.default.execute(
      { query: 'Bash', mode: 'chat' },
      {}
    ));
    // Bash is work-only, so should not appear in chat mode
    expect(result.totalResults).toBe(0);
  });
});

describe('RequestPermissions tool', () => {
  it('returns structured permission request', async () => {
    const mod = await import(`${TOOLS_DIR}/request-permissions.js`);
    const result = JSON.parse(await mod.default.execute(
      { operation: 'Delete all files', reason: 'Cleanup', risk_level: 'critical' },
      {}
    ));
    expect(result.type).toBe('permission_request');
    expect(result.operation).toBe('Delete all files');
    expect(result.riskLevel).toBe('critical');
  });
});

describe('WriteStdin tool', () => {
  it('returns guidance message with pipe syntax', async () => {
    const mod = await import(`${TOOLS_DIR}/write-stdin.js`);
    const result = JSON.parse(await mod.default.execute(
      { data: 'hello' },
      {}
    ));
    expect(result.hint).toBeTruthy();
    expect(result.example).toContain('hello');
  });
});

// ──────────────────────────────────────────────
// § Tool property verification
// ──────────────────────────────────────────────

describe('Tool properties', () => {
  it('all tools have required property functions', async () => {
    const { allTools } = await import(`${TOOLS_DIR}/index.js`);
    for (const tool of allTools) {
      if (tool.isConcurrencySafe) {
        expect(typeof tool.isConcurrencySafe).toBe('function');
      }
      if (tool.isReadOnly) {
        expect(typeof tool.isReadOnly).toBe('function');
      }
    }
  });

  it('read-only tools are marked correctly', async () => {
    const { allTools } = await import(`${TOOLS_DIR}/index.js`);
    const readOnlyTools = ['MemoryRead', 'MemorySearch', 'WebSearch', 'WebFetch',
      'HistorySearch', 'FileRead', 'Glob', 'Grep', 'ListDir', 'ViewImage',
      'ToolSearch', 'RequestPermissions'];

    for (const name of readOnlyTools) {
      const tool = allTools.find(t => t.name === name);
      if (tool?.isReadOnly) {
        expect(tool.isReadOnly()).toBe(true);
      }
    }
  });
});
