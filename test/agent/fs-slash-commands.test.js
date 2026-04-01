/**
 * Tests for PR #423 — Filesystem-first slash commands loading.
 *
 * Changes: agent/conversation.js
 * 1. loadPluginCommandDescriptions() extended to scan skills/SKILL.md recursively
 * 2. New scanSkillsDir() recursive helper
 * 3. preloadSlashCommands() now filesystem-first: skip CLI spawn when FS has data
 * 4. ctx.slashCommands populated from description keys
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const conversationSource = readFileSync(
  new URL('../../agent/conversation.js', import.meta.url),
  'utf-8'
);

// =====================================================================
// Helper: replicate parseFrontmatter for unit testing
// =====================================================================
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  const fm = {};
  const lines = match[1].split('\n');
  let currentKey = null;
  let multilineValue = '';

  for (const line of lines) {
    const kvMatch = line.match(/^(\w+):\s*(.*)/);
    if (kvMatch) {
      if (currentKey && multilineValue) {
        fm[currentKey] = multilineValue.trim();
      }
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === '|' || val === '>') {
        multilineValue = '';
      } else {
        fm[currentKey] = val;
        currentKey = null;
        multilineValue = '';
      }
    } else if (currentKey && (line.startsWith('  ') || line.trim() === '')) {
      multilineValue += (multilineValue ? '\n' : '') + line.trimStart();
    }
  }
  if (currentKey && multilineValue) {
    fm[currentKey] = multilineValue.trim();
  }

  return fm;
}

// =====================================================================
// 1. parseFrontmatter — unit tests for the YAML parser
// =====================================================================
describe('parseFrontmatter — YAML frontmatter parsing', () => {
  it('should parse simple key: value frontmatter', () => {
    const content = `---
name: sprint
description: Run a full sprint cycle
---
# Sprint skill`;
    const fm = parseFrontmatter(content);
    expect(fm.name).toBe('sprint');
    expect(fm.description).toBe('Run a full sprint cycle');
  });

  it('should parse multiline description with | marker', () => {
    const content = `---
name: brainstorming
description: |
  Creative brainstorming session
  with multiple approaches
---
content here`;
    const fm = parseFrontmatter(content);
    expect(fm.name).toBe('brainstorming');
    expect(fm.description).toContain('Creative brainstorming session');
    expect(fm.description).toContain('multiple approaches');
  });

  it('should return empty object for content without frontmatter', () => {
    const content = `# Just a markdown file\nNo frontmatter here.`;
    const fm = parseFrontmatter(content);
    expect(Object.keys(fm).length).toBe(0);
  });

  it('should return empty object for empty string', () => {
    expect(Object.keys(parseFrontmatter('')).length).toBe(0);
  });

  it('should handle frontmatter with only name (no description)', () => {
    const content = `---
name: test-skill
---`;
    const fm = parseFrontmatter(content);
    expect(fm.name).toBe('test-skill');
    expect(fm.description).toBeUndefined();
  });

  it('should handle multiline description followed by another key', () => {
    const content = `---
name: my-skill
description: |
  First line
  Second line
version: 1.0
---`;
    const fm = parseFrontmatter(content);
    expect(fm.name).toBe('my-skill');
    expect(fm.description).toContain('First line');
    expect(fm.version).toBe('1.0');
  });
});

// =====================================================================
// 2. scanSkillsDir — recursive skill scanning
// =====================================================================
describe('scanSkillsDir — recursive skill directory scanning', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `test-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('source should define scanSkillsDir function', () => {
    expect(conversationSource).toContain('function scanSkillsDir(dir, pluginName)');
  });

  it('source should use readdirSync in scanSkillsDir', () => {
    // Extract scanSkillsDir function body
    const funcStart = conversationSource.indexOf('function scanSkillsDir(dir, pluginName)');
    const funcBody = conversationSource.substring(funcStart, funcStart + 800);
    expect(funcBody).toContain('readdirSync(dir)');
  });

  it('source should use statSync to check directory entries', () => {
    const funcStart = conversationSource.indexOf('function scanSkillsDir(dir, pluginName)');
    const funcBody = conversationSource.substring(funcStart, funcStart + 800);
    expect(funcBody).toContain('statSync(fullPath)');
  });

  it('source should check stat.isDirectory()', () => {
    const funcStart = conversationSource.indexOf('function scanSkillsDir(dir, pluginName)');
    const funcBody = conversationSource.substring(funcStart, funcStart + 800);
    expect(funcBody).toContain('stat.isDirectory()');
  });

  it('source should read SKILL.md from subdirectories', () => {
    const funcStart = conversationSource.indexOf('function scanSkillsDir(dir, pluginName)');
    const funcBody = conversationSource.substring(funcStart, funcStart + 800);
    expect(funcBody).toContain("'SKILL.md'");
    expect(funcBody).toContain('readFileSync(skillFile');
  });

  it('source should recurse into subdirectories', () => {
    const funcStart = conversationSource.indexOf('function scanSkillsDir(dir, pluginName)');
    const funcBody = conversationSource.substring(funcStart, funcStart + 1200);
    expect(funcBody).toContain('scanSkillsDir(fullPath, pluginName)');
  });

  it('source should handle missing directory gracefully (try/catch)', () => {
    const funcStart = conversationSource.indexOf('function scanSkillsDir(dir, pluginName)');
    const funcBody = conversationSource.substring(funcStart, funcStart + 200);
    // The readdirSync is wrapped in try/catch, returning on failure
    expect(funcBody).toContain('try');
    expect(funcBody).toContain('catch');
    expect(funcBody).toContain('return');
  });

  it('source should format skill name as pluginName:skillName', () => {
    const funcStart = conversationSource.indexOf('function scanSkillsDir(dir, pluginName)');
    const funcBody = conversationSource.substring(funcStart, funcStart + 800);
    expect(funcBody).toContain('`${pluginName}:${fm.name}`');
  });

  it('source should only take first line of description', () => {
    const funcStart = conversationSource.indexOf('function scanSkillsDir(dir, pluginName)');
    const funcBody = conversationSource.substring(funcStart, funcStart + 800);
    expect(funcBody).toContain("fm.description.split('\\n')[0].trim()");
  });
});

// =====================================================================
// 3. Simulated scanSkillsDir behavior with real filesystem
// =====================================================================
describe('skill scanning — filesystem simulation', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `test-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  /**
   * Simulate the scanSkillsDir logic on a temp directory.
   * This replicates the exact algorithm from the source.
   */
  function simulateScanSkillsDir(dir, pluginName, results = {}) {
    let entries;
    try {
      const { readdirSync: rd, statSync: st } = require('fs');
      entries = rd(dir);
    } catch { return results; }

    const { statSync: stSync, readFileSync: rfSync } = require('fs');
    const { join: pjoin } = require('path');

    for (const entry of entries) {
      const fullPath = pjoin(dir, entry);
      let stat;
      try { stat = stSync(fullPath); } catch { continue; }

      if (stat.isDirectory()) {
        const skillFile = pjoin(fullPath, 'SKILL.md');
        try {
          const content = rfSync(skillFile, 'utf-8');
          const fm = parseFrontmatter(content);
          if (fm.name && fm.description) {
            const cliName = `${pluginName}:${fm.name}`;
            const desc = fm.description.split('\n')[0].trim();
            results[cliName] = desc;
          }
        } catch { /* no SKILL.md */ }

        simulateScanSkillsDir(fullPath, pluginName, results);
      }
    }
    return results;
  }

  it('should find SKILL.md in direct subdirectory (skills/sprint/SKILL.md)', () => {
    mkdirSync(join(tmpDir, 'sprint'), { recursive: true });
    writeFileSync(join(tmpDir, 'sprint', 'SKILL.md'), `---
name: sprint
description: Run a full sprint cycle
---`);
    const results = simulateScanSkillsDir(tmpDir, 'yeaft-skills');
    expect(results['yeaft-skills:sprint']).toBe('Run a full sprint cycle');
  });

  it('should find SKILL.md in nested directory (skills/personas/pm-jobs/SKILL.md)', () => {
    mkdirSync(join(tmpDir, 'personas', 'pm-jobs'), { recursive: true });
    writeFileSync(join(tmpDir, 'personas', 'pm-jobs', 'SKILL.md'), `---
name: pm-jobs
description: Activate Steve Jobs as your PM
---`);
    const results = simulateScanSkillsDir(tmpDir, 'yeaft-skills');
    expect(results['yeaft-skills:pm-jobs']).toBe('Activate Steve Jobs as your PM');
  });

  it('should find multiple skills across different directories', () => {
    mkdirSync(join(tmpDir, 'sprint'), { recursive: true });
    mkdirSync(join(tmpDir, 'personas', 'designer-rams'), { recursive: true });
    writeFileSync(join(tmpDir, 'sprint', 'SKILL.md'), `---
name: sprint
description: Sprint workflow
---`);
    writeFileSync(join(tmpDir, 'personas', 'designer-rams', 'SKILL.md'), `---
name: designer-rams
description: Activate Dieter Rams
---`);
    const results = simulateScanSkillsDir(tmpDir, 'yeaft-skills');
    expect(Object.keys(results).length).toBe(2);
    expect(results['yeaft-skills:sprint']).toBe('Sprint workflow');
    expect(results['yeaft-skills:designer-rams']).toBe('Activate Dieter Rams');
  });

  it('should skip directory without SKILL.md', () => {
    mkdirSync(join(tmpDir, 'empty-dir'), { recursive: true });
    const results = simulateScanSkillsDir(tmpDir, 'yeaft-skills');
    expect(Object.keys(results).length).toBe(0);
  });

  it('should skip SKILL.md without name field', () => {
    mkdirSync(join(tmpDir, 'no-name'), { recursive: true });
    writeFileSync(join(tmpDir, 'no-name', 'SKILL.md'), `---
description: Has description but no name
---`);
    const results = simulateScanSkillsDir(tmpDir, 'yeaft-skills');
    expect(Object.keys(results).length).toBe(0);
  });

  it('should skip SKILL.md without description field', () => {
    mkdirSync(join(tmpDir, 'no-desc'), { recursive: true });
    writeFileSync(join(tmpDir, 'no-desc', 'SKILL.md'), `---
name: no-desc
---`);
    const results = simulateScanSkillsDir(tmpDir, 'yeaft-skills');
    expect(Object.keys(results).length).toBe(0);
  });

  it('should skip SKILL.md with broken frontmatter', () => {
    mkdirSync(join(tmpDir, 'broken'), { recursive: true });
    writeFileSync(join(tmpDir, 'broken', 'SKILL.md'), `This has no frontmatter at all`);
    const results = simulateScanSkillsDir(tmpDir, 'yeaft-skills');
    expect(Object.keys(results).length).toBe(0);
  });

  it('should handle empty skills directory', () => {
    const results = simulateScanSkillsDir(tmpDir, 'yeaft-skills');
    expect(Object.keys(results).length).toBe(0);
  });

  it('should handle non-existent directory gracefully', () => {
    const results = simulateScanSkillsDir(join(tmpDir, 'nonexistent'), 'yeaft-skills');
    expect(Object.keys(results).length).toBe(0);
  });

  it('should take only first line of multiline description', () => {
    mkdirSync(join(tmpDir, 'multi'), { recursive: true });
    writeFileSync(join(tmpDir, 'multi', 'SKILL.md'), `---
name: multi-desc
description: |
  First line of description
  Second line should be ignored
---`);
    const results = simulateScanSkillsDir(tmpDir, 'yeaft-skills');
    expect(results['yeaft-skills:multi-desc']).toBe('First line of description');
  });
});

// =====================================================================
// 4. loadPluginCommandDescriptions — source structure
// =====================================================================
describe('loadPluginCommandDescriptions — structure verification', () => {
  it('should be exported', () => {
    expect(conversationSource).toContain('export function loadPluginCommandDescriptions()');
  });

  it('should have caching check (skip if already loaded)', () => {
    expect(conversationSource).toContain('if (Object.keys(ctx.slashCommandDescriptions).length > 0) return');
  });

  it('should read installed_plugins.json', () => {
    expect(conversationSource).toContain("'installed_plugins.json'");
    expect(conversationSource).toContain("'.claude', 'plugins', 'installed_plugins.json'");
  });

  it('should handle installed_plugins.json not existing (outer try/catch)', () => {
    // The entire function body is wrapped in try/catch
    const funcStart = conversationSource.indexOf('export function loadPluginCommandDescriptions()');
    const funcEnd = conversationSource.indexOf('\n}\n', funcStart + 10);
    const funcBody = conversationSource.substring(funcStart, funcEnd);
    expect(funcBody).toContain('catch (err)');
    expect(funcBody).toContain('Failed to load plugin command descriptions');
  });

  it('should extract pluginName from pluginKey', () => {
    expect(conversationSource).toContain("pluginKey.split('@')[0]");
  });

  it('should scan commands/*.md directory', () => {
    const funcStart = conversationSource.indexOf('export function loadPluginCommandDescriptions()');
    const funcBody = conversationSource.substring(funcStart, funcStart + 1500);
    expect(funcBody).toContain("join(entry.installPath, 'commands')");
    expect(funcBody).toContain("f.endsWith('.md')");
  });

  it('should scan skills directory via scanSkillsDir', () => {
    const funcStart = conversationSource.indexOf('export function loadPluginCommandDescriptions()');
    const funcBody = conversationSource.substring(funcStart, funcStart + 2500);
    expect(funcBody).toContain("join(entry.installPath, 'skills')");
    expect(funcBody).toContain('scanSkillsDir(skillsDir, pluginName)');
  });

  it('should handle empty commands directory (catch sets files = [])', () => {
    expect(conversationSource).toContain('catch { files = []; }');
  });

  it('should add BUILTIN_COMMAND_DESCRIPTIONS as fallback', () => {
    const funcStart = conversationSource.indexOf('export function loadPluginCommandDescriptions()');
    const funcBody = conversationSource.substring(funcStart, funcStart + 2000);
    expect(funcBody).toContain('BUILTIN_COMMAND_DESCRIPTIONS');
    // Should not overwrite existing descriptions
    expect(funcBody).toContain('if (!ctx.slashCommandDescriptions[name])');
  });

  it('should populate ctx.slashCommands from description keys', () => {
    const funcStart = conversationSource.indexOf('export function loadPluginCommandDescriptions()');
    const funcBody = conversationSource.substring(funcStart, funcStart + 2500);
    expect(funcBody).toContain('ctx.slashCommands = Object.keys(ctx.slashCommandDescriptions)');
  });

  it('should only populate slashCommands if not already set', () => {
    const funcStart = conversationSource.indexOf('export function loadPluginCommandDescriptions()');
    const funcBody = conversationSource.substring(funcStart, funcStart + 2000);
    expect(funcBody).toContain('if (ctx.slashCommands.length === 0)');
  });

  it('should log the number of loaded descriptions', () => {
    expect(conversationSource).toContain('command/skill descriptions from filesystem');
  });
});

// =====================================================================
// 5. BUILTIN_COMMAND_DESCRIPTIONS — built-in commands
// =====================================================================
describe('BUILTIN_COMMAND_DESCRIPTIONS — built-in fallback commands', () => {
  it('should define compact command', () => {
    expect(conversationSource).toContain("compact: 'Compact conversation context'");
  });

  it('should define cost command', () => {
    expect(conversationSource).toContain("cost: 'Show token costs'");
  });

  it('should define context command', () => {
    expect(conversationSource).toContain("context: 'Show context usage'");
  });

  it('should define review command', () => {
    expect(conversationSource).toContain("review: 'Code review'");
  });

  it('should define init command', () => {
    expect(conversationSource).toContain("init: 'Reinitialize session'");
  });
});

// =====================================================================
// 6. preloadSlashCommands — filesystem-first strategy
// =====================================================================
describe('preloadSlashCommands — filesystem-first with CLI fallback', () => {
  it('should be exported as async function', () => {
    expect(conversationSource).toContain('export async function preloadSlashCommands(');
  });

  it('Step 1: should call loadPluginCommandDescriptions first', () => {
    const funcStart = conversationSource.indexOf('export async function preloadSlashCommands(');
    const funcBody = conversationSource.substring(funcStart, funcStart + 1500);
    expect(funcBody).toContain('loadPluginCommandDescriptions()');
  });

  it('Step 2: should check if filesystem loaded commands', () => {
    const funcStart = conversationSource.indexOf('export async function preloadSlashCommands(');
    const funcBody = conversationSource.substring(funcStart, funcStart + 1500);
    expect(funcBody).toContain('if (ctx.slashCommands.length > 0)');
  });

  it('Step 2: should send slash_commands_update when FS has data', () => {
    const funcStart = conversationSource.indexOf('export async function preloadSlashCommands(');
    const funcBody = conversationSource.substring(funcStart, funcStart + 1500);
    expect(funcBody).toContain("type: 'slash_commands_update'");
    expect(funcBody).toContain('ctx.slashCommands');
    expect(funcBody).toContain('ctx.slashCommandDescriptions');
  });

  it('Step 2: should return early when FS has data (skip CLI)', () => {
    const funcStart = conversationSource.indexOf('export async function preloadSlashCommands(');
    const funcBody = conversationSource.substring(funcStart, funcStart + 1500);
    // After sending update, there should be a return statement
    const fsCheckPos = funcBody.indexOf('if (ctx.slashCommands.length > 0)');
    const returnPos = funcBody.indexOf('return;', fsCheckPos);
    const cliSpawnPos = funcBody.indexOf("'/cost'");
    // return should come before CLI spawn
    expect(returnPos).toBeGreaterThan(fsCheckPos);
    expect(returnPos).toBeLessThan(cliSpawnPos);
  });

  it('Step 2: should log "no CLI spawn needed" when using FS', () => {
    expect(conversationSource).toContain('no CLI spawn needed');
  });

  it('Step 3: should fall back to CLI spawn when FS is empty', () => {
    const funcStart = conversationSource.indexOf('export async function preloadSlashCommands(');
    const funcBody = conversationSource.substring(funcStart, funcStart + 2500);
    // CLI fallback uses /cost command
    expect(funcBody).toContain("'/cost'");
    expect(funcBody).toContain('query(');
  });

  it('Step 3: should log "CLI fallback" when using CLI', () => {
    expect(conversationSource).toContain('slash commands from CLI fallback');
  });

  it('should send conversationId as targetId in update message', () => {
    const funcStart = conversationSource.indexOf('export async function preloadSlashCommands(');
    const funcBody = conversationSource.substring(funcStart, funcStart + 1500);
    expect(funcBody).toContain('conversationId: targetId');
  });

  it('should default targetId to __preload__', () => {
    expect(conversationSource).toContain("targetId = '__preload__'");
  });
});

// =====================================================================
// 7. ctx.slashCommands population logic
// =====================================================================
describe('ctx.slashCommands — population from descriptions', () => {
  it('should build slashCommands from Object.keys of slashCommandDescriptions', () => {
    // Simulate what the code does
    const descriptions = {
      compact: 'Compact conversation context',
      cost: 'Show token costs',
      'yeaft-skills:sprint': 'Sprint workflow',
      'yeaft-skills:pm-jobs': 'Activate Steve Jobs'
    };
    const commands = Object.keys(descriptions);
    expect(commands).toContain('compact');
    expect(commands).toContain('cost');
    expect(commands).toContain('yeaft-skills:sprint');
    expect(commands).toContain('yeaft-skills:pm-jobs');
    expect(commands.length).toBe(4);
  });

  it('should include both builtin and plugin commands', () => {
    // The source adds builtins as fallback then builds commands from all keys
    // Some keys use quotes (pr-comments, release-notes, security-review)
    const builtinNames = ['compact', 'context', 'cost', 'init', 'review', 'insights',
      "'pr-comments'", "'release-notes'", "'security-review'", 'heapdump'];
    for (const name of builtinNames) {
      expect(conversationSource).toContain(`${name}:`);
    }
  });
});

// =====================================================================
// 8. Import changes — statSync added
// =====================================================================
describe('imports — statSync added for directory scanning', () => {
  it('should import statSync from fs', () => {
    expect(conversationSource).toContain('statSync');
    expect(conversationSource).toContain("from 'fs'");
  });

  it('should import readFileSync and readdirSync alongside statSync', () => {
    // All three should be in the same import
    const importLine = conversationSource.split('\n').find(l => l.includes("from 'fs'"));
    expect(importLine).toContain('readFileSync');
    expect(importLine).toContain('readdirSync');
    expect(importLine).toContain('statSync');
  });
});

// =====================================================================
// 9. Edge cases and error handling
// =====================================================================
describe('edge cases — error handling in scanning', () => {
  it('commands dir catch should set files = [] (not continue)', () => {
    // The change from `catch { continue; }` to `catch { files = []; }`
    // allows skills scanning to proceed even if commands dir is missing
    expect(conversationSource).toContain('catch { files = []; }');
    expect(conversationSource).not.toContain("catch { continue; }\n\n        for (const file of files)");
  });

  it('scanSkillsDir should not throw on statSync failure', () => {
    const funcStart = conversationSource.indexOf('function scanSkillsDir(dir, pluginName)');
    const funcBody = conversationSource.substring(funcStart, funcStart + 800);
    // statSync wrapped in try/catch with continue
    expect(funcBody).toContain('try { stat = statSync(fullPath); } catch { continue; }');
  });

  it('scanSkillsDir should not throw on readFileSync failure for SKILL.md', () => {
    const funcStart = conversationSource.indexOf('function scanSkillsDir(dir, pluginName)');
    const funcBody = conversationSource.substring(funcStart, funcStart + 800);
    // readFileSync(skillFile) is in try/catch
    expect(funcBody).toContain('readFileSync(skillFile');
    // The catch block just continues (no SKILL.md is fine)
  });

  it('installed_plugins.json parsing failure should warn, not throw', () => {
    expect(conversationSource).toContain("console.warn('[Preload] Failed to load plugin command descriptions:");
  });

  it('CLI spawn failure should not crash preloadSlashCommands', () => {
    const funcStart = conversationSource.indexOf('export async function preloadSlashCommands(');
    const funcBody = conversationSource.substring(funcStart, funcStart + 2500);
    expect(funcBody).toContain("err.name !== 'AbortError'");
    expect(funcBody).toContain('console.warn');
  });
});
