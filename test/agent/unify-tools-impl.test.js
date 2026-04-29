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
  it('allTools has 45 tools (H2.f.4: -6 thread tools)', async () => {
    const { allTools } = await import(`${TOOLS_DIR}/index.js`);
    expect(allTools.length).toBe(45);
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

  it('task-297: all tools are exposed regardless of mode (no filtering)', async () => {
    const { createFullRegistry, allTools } = await import(`${TOOLS_DIR}/index.js`);
    const registry = createFullRegistry();
    // getToolDefs/getToolNames no longer accept a mode arg; all registered tools are returned.
    const defs = registry.getToolDefs();
    expect(defs.length).toBe(allTools.length);

    const names = registry.getToolNames();
    // Chat-side tools
    expect(names).toContain('AskUser');
    expect(names).toContain('MemoryRead');
    expect(names).toContain('WebSearch');
    // Previously work-only tools should also be available now
    expect(names).toContain('Agent');
    expect(names).toContain('SendMessage');
    // Dev tools
    expect(names).toContain('Bash');
    expect(names).toContain('FileRead');
    expect(names).toContain('Grep');
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

describe('memory_search tool (task-287: path-based file loader)', () => {
  it('errors when paths is empty', async () => {
    const mod = await import(`${TOOLS_DIR}/memory-search.js`);
    const tool = mod.default;
    const result = JSON.parse(await tool.execute(
      { paths: [] },
      { yeaftDir: '/tmp/nonexistent-yeaft-dir' }
    ));
    expect(result.error).toBeTruthy();
  });
});

describe('memory_query tool (task-287: fuzzy atomic entry search)', () => {
  it('searches entries via memoryStore.findByFilter', async () => {
    const mod = await import(`${TOOLS_DIR}/memory-query.js`);
    const tool = mod.default;
    const mockStore = {
      findByFilter: () => [
        { name: 'javascript-basics', kind: 'fact', content: 'JavaScript is a great language', scope: 'global', tags: [], _score: 2 },
      ],
      search: () => [],
    };
    const result = JSON.parse(await tool.execute(
      { keywords: ['JavaScript'] },
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
      { name: 'test-agent-create', task: 'Do something' },
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
// § P1 Feature tools
// ──────────────────────────────────────────────

describe('Feature tools', () => {
  it('FeatureCreate creates a feature', async () => {
    // Initialize feature store with a temp directory before using feature tools
    const { initFeatureStore, featureCreate } = await import(`${TOOLS_DIR}/feature-tools.js`);
    const { mkdirSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const tmpDir = join(tmpdir(), `yeaft-test-features-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    initFeatureStore(tmpDir);
    const result = JSON.parse(await featureCreate.execute(
      { title: 'Test feature', description: 'A test' },
      {}
    ));
    expect(result.success).toBe(true);
    expect(result.feature.id).toBeTruthy();
    expect(result.feature.title).toBe('Test feature');
    expect(result.feature.status).toBe('pending');
  });

  it('FeatureUpdate updates feature status', async () => {
    const { featureCreate, featureUpdate } = await import(`${TOOLS_DIR}/feature-tools.js`);
    const created = JSON.parse(await featureCreate.execute(
      { title: 'Update me' },
      {}
    ));
    const result = JSON.parse(await featureUpdate.execute(
      { feature_id: created.feature.id, status: 'in_progress' },
      {}
    ));
    expect(result.success).toBe(true);
    expect(result.feature.status).toBe('in_progress');
  });

  it('FeatureList lists features', async () => {
    const { featureCreate, featureList } = await import(`${TOOLS_DIR}/feature-tools.js`);
    await featureCreate.execute({ title: 'List test' }, {});

    const result = JSON.parse(await featureList.execute({}, {}));
    expect(result.features).toBeTruthy();
    expect(result.features.length).toBeGreaterThan(0);
  });

  it('FeatureGet retrieves feature details', async () => {
    const { featureCreate, featureGet } = await import(`${TOOLS_DIR}/feature-tools.js`);
    const created = JSON.parse(await featureCreate.execute(
      { title: 'Get me', description: 'Details test' },
      {}
    ));
    const result = JSON.parse(await featureGet.execute(
      { feature_id: created.feature.id },
      {}
    ));
    expect(result.title).toBe('Get me');
    expect(result.description).toBe('Details test');
  });

  it('FollowupFeature creates linked feature', async () => {
    const { featureCreate, followupFeature } = await import(`${TOOLS_DIR}/feature-tools.js`);
    const parent = JSON.parse(await featureCreate.execute(
      { title: 'Parent' },
      {}
    ));
    const result = JSON.parse(await followupFeature.execute(
      { parent_feature_id: parent.feature.id, title: 'Child feature' },
      {}
    ));
    expect(result.success).toBe(true);
    expect(result.feature.parentId).toBe(parent.feature.id);
  });

  it('UpdatePlan updates the plan', async () => {
    const { updatePlan } = await import(`${TOOLS_DIR}/feature-tools.js`);
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

  it('JsRepl reset:true clears state (task-333b merged behaviour)', async () => {
    const { jsRepl } = await import(`${TOOLS_DIR}/js-repl.js`);
    await jsRepl.execute({ code: 'var resetMe = 1;' }, {});
    await jsRepl.execute({ reset: true }, {});
    const result = await jsRepl.execute({ code: 'typeof resetMe' }, {});
    expect(result).toContain('undefined');
  });

  it('JsReplReset deprecated alias still works and is marked DEPRECATED (task-333b)', async () => {
    const { jsRepl, jsReplReset } = await import(`${TOOLS_DIR}/js-repl.js`);
    expect(jsReplReset.name).toBe('JsReplReset');
    expect(jsReplReset.description).toContain('DEPRECATED');
    await jsRepl.execute({ code: 'var aliasReset = 42;' }, {});
    await jsReplReset.execute({}, {});
    const after = await jsRepl.execute({ code: 'typeof aliasReset' }, {});
    expect(after).toContain('undefined');
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

  // Minimal valid 1x1 PNG header (enough bytes for dim parsing).
  const PNG_1x1 = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, // IHDR chunk length
    0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x00, 0x01, // width = 1
    0x00, 0x00, 0x00, 0x01, // height = 1
    0x08, 0x02,             // bit depth, color type
    0x00, 0x00, 0x00,       // compression, filter, interlace
  ]);

  it('reads PNG metadata and dimensions', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    const pngPath = join(tmpDir, 'test.png');
    writeFileSync(pngPath, PNG_1x1);

    const result = JSON.parse(await tool.execute(
      { file_path: pngPath },
      { cwd: tmpDir }
    ));
    expect(result.format).toBe('PNG');
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
  });

  it('returns a base64 data URI usable as an LLM image block', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    const pngPath = join(tmpDir, 'test.png');
    writeFileSync(pngPath, PNG_1x1);

    const result = JSON.parse(await tool.execute(
      { file_path: pngPath },
      { cwd: tmpDir }
    ));
    expect(result.media_type).toBe('image/png');
    expect(typeof result.image).toBe('string');
    expect(result.image.startsWith('data:image/png;base64,')).toBe(true);
    // Round-trip: the base64 payload decodes back to the original bytes.
    const b64 = result.image.slice('data:image/png;base64,'.length);
    expect(Buffer.from(b64, 'base64').equals(PNG_1x1)).toBe(true);
  });

  it('maps jpg and jpeg to image/jpeg media_type', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    // Minimal JPEG SOI+EOI with SOF0 marker giving dim 1x1.
    const jpg = Buffer.from([
      0xFF, 0xD8, // SOI
      0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, // SOF0 w=1 h=1
      0xFF, 0xD9, // EOI
    ]);
    const jpgPath = join(tmpDir, 'test.jpg');
    writeFileSync(jpgPath, jpg);
    const result = JSON.parse(await tool.execute(
      { file_path: jpgPath },
      { cwd: tmpDir }
    ));
    expect(result.format).toBe('JPEG');
    expect(result.media_type).toBe('image/jpeg');
  });

  it('returns error for non-existent image', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    const result = JSON.parse(await tool.execute(
      { file_path: join(tmpDir, 'nope.png') },
      { cwd: tmpDir }
    ));
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/not found/i);
  });

  it('rejects `..` path segments outright', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    const result = JSON.parse(await tool.execute(
      { file_path: '../../../etc/passwd' },
      { cwd: tmpDir }
    ));
    expect(result.error).toMatch(/\.\./);
  });

  it('rejects absolute paths outside cwd and allowlist', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    // Pick an absolute path that is NOT under tmpDir.
    const foreign = '/tmp/definitely-not-under-the-project.png';
    const result = JSON.parse(await tool.execute(
      { file_path: foreign },
      { cwd: tmpDir }
    ));
    expect(result.error).toMatch(/allowlist|outside/i);
    // prev-3 P2: error text must nudge the user toward a concrete fix.
    expect(result.error).toMatch(/Absolute path/);
    expect(result.error).toMatch(/imageAllowlist/);
  });

  it('honours ctx.imageAllowlist for explicit external dirs', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    // Put the image in tmpDir but use a *different* cwd, then whitelist tmpDir.
    const pngPath = join(tmpDir, 'ok.png');
    writeFileSync(pngPath, PNG_1x1);
    const otherCwd = mkdtempSync(join(tmpdir(), 'unify-other-'));
    try {
      const result = JSON.parse(await tool.execute(
        { file_path: pngPath },
        { cwd: otherCwd, imageAllowlist: [tmpDir] }
      ));
      expect(result.error).toBeUndefined();
      expect(result.format).toBe('PNG');
    } finally {
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });

  it('rejects unsupported formats (svg, bmp, ico)', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    const svgPath = join(tmpDir, 'test.svg');
    writeFileSync(svgPath, '<svg/>');
    const result = JSON.parse(await tool.execute(
      { file_path: svgPath },
      { cwd: tmpDir }
    ));
    expect(result.error).toMatch(/unsupported/i);
    expect(result.supported).toContain('.png');
  });

  it('rejects files larger than the configured size cap', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    const bigPath = join(tmpDir, 'big.png');
    // Write >1 MiB of zeros and inject a 1 MiB cap via ctx — avoids
    // writing 20 MiB to the test disk while still exercising the check.
    const bytes = 1 * 1024 * 1024 + 1;
    writeFileSync(bigPath, Buffer.alloc(bytes));
    const result = JSON.parse(await tool.execute(
      { file_path: bigPath },
      { cwd: tmpDir, maxImageBytes: 1 * 1024 * 1024 }
    ));
    expect(result.error).toMatch(/exceeds/i);
    // prev-3 P1-A: error must include a resize/crop nudge + config.json hint.
    expect(result.error).toMatch(/resize|crop/i);
    expect(result.error).toMatch(/maxImageBytes/);
    expect(result.error).toMatch(/config\.json/);
    expect(result.size).toBe(bytes);
    expect(result.maxSize).toBe(1 * 1024 * 1024);
  });

  it('default max size is 20 MiB when ctx.maxImageBytes is not set', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    // Just under the default cap to confirm the default is 20 MiB (not 10).
    // 11 MiB would have been rejected by the pre-config 10-MiB cap; 11 MiB
    // under the 20-MiB default must now pass the size check.
    const mediumPath = join(tmpDir, 'medium.png');
    // Start with the valid PNG header so format/dimension checks pass,
    // then pad to 11 MiB.
    const pad = Buffer.alloc(11 * 1024 * 1024 - PNG_1x1.length);
    writeFileSync(mediumPath, Buffer.concat([PNG_1x1, pad]));
    const result = JSON.parse(await tool.execute(
      { file_path: mediumPath },
      { cwd: tmpDir }
    ));
    expect(result.error).toBeUndefined();
    expect(result.media_type).toBe('image/png');
  });

  it('rejects directories', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    const dir = join(tmpDir, 'adir.png');
    mkdirSync(dir);
    const result = JSON.parse(await tool.execute(
      { file_path: dir },
      { cwd: tmpDir }
    ));
    expect(result.error).toMatch(/regular file/i);
  });

  it('errors when file_path is missing or not a string', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    const r1 = JSON.parse(await tool.execute({}, { cwd: tmpDir }));
    expect(r1.error).toMatch(/required/i);
    const r2 = JSON.parse(await tool.execute({ file_path: 123 }, { cwd: tmpDir }));
    expect(r2.error).toMatch(/required/i);
  });

  it('HEIC gets a specific conversion hint, not generic "unsupported"', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    const heicPath = join(tmpDir, 'iphone.heic');
    writeFileSync(heicPath, Buffer.alloc(16)); // content irrelevant
    const result = JSON.parse(await tool.execute(
      { file_path: heicPath },
      { cwd: tmpDir }
    ));
    expect(result.error).toMatch(/HEIC/);
    expect(result.error).toMatch(/sips/i);
    // Must NOT be the generic "Unsupported image format" bucket.
    expect(result.error).not.toMatch(/^Unsupported image format/);
  });

  it('.jfif is recognised as JPEG', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    // Minimal JPEG (SOI + SOF0 + EOI), saved as .jfif.
    const jpg = Buffer.from([
      0xFF, 0xD8,
      0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01,
      0xFF, 0xD9,
    ]);
    const p = join(tmpDir, 'paste.jfif');
    writeFileSync(p, jpg);
    const result = JSON.parse(await tool.execute(
      { file_path: p },
      { cwd: tmpDir }
    ));
    expect(result.error).toBeUndefined();
    expect(result.media_type).toBe('image/jpeg');
    expect(result.format).toBe('JPEG');
  });

  it('`..` rejection includes a self-correcting hint', async () => {
    // prev-3 P2 defense-in-depth: the `..` error should tell the LLM
    // what to do instead, not just what went wrong.
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    const result = JSON.parse(await tool.execute(
      { file_path: '../escape.png' },
      { cwd: tmpDir }
    ));
    expect(result.error).toMatch(/\.\./);
    expect(result.error).toMatch(/relative|allowlisted/i);
  });

  it('description includes when-to-call / when-not / path examples (prev-3 P1-B)', async () => {
    const mod = await import(`${TOOLS_DIR}/view-image.js`);
    const tool = mod.default;
    const desc = tool.description || '';
    expect(desc).toMatch(/when to call/i);
    expect(desc).toMatch(/when not to call/i);
    // At least one concrete path example
    expect(desc).toMatch(/screenshots|docs\/assets|Downloads/);
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

describe('ToolSearch tool (removed in task-333b)', () => {
  it('is no longer registered in allTools', async () => {
    const { allTools } = await import(`${TOOLS_DIR}/index.js`);
    expect(allTools.find(t => t.name === 'ToolSearch')).toBeUndefined();
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

describe('WriteStdin tool (removed in task-333b)', () => {
  it('is no longer registered in allTools', async () => {
    const { allTools } = await import(`${TOOLS_DIR}/index.js`);
    expect(allTools.find(t => t.name === 'WriteStdin')).toBeUndefined();
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
      'RequestPermissions'];

    for (const name of readOnlyTools) {
      const tool = allTools.find(t => t.name === name);
      if (tool?.isReadOnly) {
        expect(tool.isReadOnly()).toBe(true);
      }
    }
  });
});
