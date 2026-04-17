/**
 * subagent-v1.test.js — Tests for SubagentSpec contract, personas, budget enforcement.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateSpec,
  checkBudget,
  budgetExceededResult,
  getAgentRegistry,
  _resetAgentRegistry,
} from '../../../agent/unify/tools/agent.js';
import agentTool from '../../../agent/unify/tools/agent.js';
import {
  loadPersonas,
  getPersona,
  listPersonaIds,
  parseFrontmatter,
  _resetPersonaCache,
} from '../../../agent/unify/personas.js';

describe('personas: frontmatter parser', () => {
  it('parses id/name/description scalar fields', () => {
    const src = `---\nid: explorer\nname: Explorer\ndescription: Fast scout\n---\nBody here.`;
    const { meta, body } = parseFrontmatter(src);
    expect(meta.id).toBe('explorer');
    expect(meta.name).toBe('Explorer');
    expect(meta.description).toBe('Fast scout');
    expect(body).toBe('Body here.');
  });

  it('parses list fields', () => {
    const src = `---\nid: x\ntools:\n  - Read\n  - Grep\n---\nB`;
    const { meta } = parseFrontmatter(src);
    expect(meta.tools).toEqual(['Read', 'Grep']);
  });

  it('returns empty meta on no frontmatter', () => {
    const { meta, body } = parseFrontmatter('just body');
    expect(meta).toEqual({});
    expect(body).toBe('just body');
  });
});

describe('personas: loading', () => {
  beforeEach(() => _resetPersonaCache());

  it('loads all 4 preset personas', () => {
    const personas = loadPersonas({ fresh: true });
    const ids = Array.from(personas.keys()).sort();
    expect(ids).toEqual(['explorer', 'implementer', 'researcher', 'reviewer']);
  });

  it('explorer persona has read-only tools and fast tier', () => {
    const p = getPersona('explorer');
    expect(p).toBeDefined();
    expect(p.modelTier).toBe('fast');
    expect(p.tools).toContain('Read');
    expect(p.tools).toContain('Grep');
    expect(p.tools).not.toContain('Bash');
    expect(p.tools).not.toContain('FileEdit');
  });

  it('implementer persona has primary tier + work tools', () => {
    const p = getPersona('implementer');
    expect(p.modelTier).toBe('primary');
    expect(p.tools).toContain('Bash');
    expect(p.tools).toContain('FileEdit');
  });

  it('reviewer persona is primary tier + read-only', () => {
    const p = getPersona('reviewer');
    expect(p.modelTier).toBe('primary');
    expect(p.tools).not.toContain('Bash');
    expect(p.tools).not.toContain('FileEdit');
  });

  it('researcher persona has web tools, fast tier', () => {
    const p = getPersona('researcher');
    expect(p.modelTier).toBe('fast');
    expect(p.tools).toContain('WebSearch');
    expect(p.tools).toContain('WebFetch');
  });

  it('getPersona returns undefined for unknown id', () => {
    expect(getPersona('nope')).toBeUndefined();
    expect(getPersona('')).toBeUndefined();
    expect(getPersona(null)).toBeUndefined();
  });

  it('listPersonaIds returns all 4', () => {
    expect(listPersonaIds().sort()).toEqual(['explorer', 'implementer', 'researcher', 'reviewer']);
  });

  it('each persona has non-empty system prompt body', () => {
    for (const id of listPersonaIds()) {
      const p = getPersona(id);
      expect(p.systemPrompt.length).toBeGreaterThan(20);
    }
  });
});

describe('SubagentSpec: validateSpec', () => {
  it('rejects non-object input', () => {
    expect(validateSpec(null).ok).toBe(false);
    expect(validateSpec('').ok).toBe(false);
  });

  it('rejects missing name', () => {
    const r = validateSpec({ mission: 'do stuff' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/name/);
  });

  it('rejects missing task AND mission', () => {
    const r = validateSpec({ name: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/task or mission/);
  });

  it('accepts legacy task-only spec (back-compat)', () => {
    const r = validateSpec({ name: 'x', task: 'do stuff' });
    expect(r.ok).toBe(true);
    expect(r.spec.mission).toBe('do stuff');
    expect(r.spec.task).toBe('do stuff');
  });

  it('accepts mission-only spec', () => {
    const r = validateSpec({ name: 'x', mission: 'ship feature' });
    expect(r.ok).toBe(true);
    expect(r.spec.mission).toBe('ship feature');
    expect(r.spec.task).toBe('ship feature');
  });

  it('rejects unknown persona', () => {
    const r = validateSpec({ name: 'x', task: 't', persona: 'wizard' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown persona/);
  });

  it('accepts known persona', () => {
    const r = validateSpec({ name: 'x', task: 't', persona: 'explorer' });
    expect(r.ok).toBe(true);
    expect(r.spec.persona).toBe('explorer');
  });

  it('rejects non-object expected_output', () => {
    const r = validateSpec({ name: 'x', task: 't', expected_output: 'schema' });
    expect(r.ok).toBe(false);
  });

  it('accepts JSON-schema expected_output', () => {
    const r = validateSpec({
      name: 'x', task: 't',
      expected_output: { type: 'object', properties: { result: { type: 'string' } } },
    });
    expect(r.ok).toBe(true);
    expect(r.spec.expected_output.type).toBe('object');
  });

  it('rejects negative/zero budget values', () => {
    expect(validateSpec({ name: 'x', task: 't', budget: { max_tokens: 0 } }).ok).toBe(false);
    expect(validateSpec({ name: 'x', task: 't', budget: { max_turns: -1 } }).ok).toBe(false);
    expect(validateSpec({ name: 'x', task: 't', budget: { wall_time_ms: 0 } }).ok).toBe(false);
  });

  it('accepts positive budget values', () => {
    const r = validateSpec({
      name: 'x', task: 't',
      budget: { max_tokens: 1000, max_turns: 5, wall_time_ms: 30000 },
    });
    expect(r.ok).toBe(true);
    expect(r.spec.budget.max_tokens).toBe(1000);
  });
});

describe('Budget enforcement: checkBudget', () => {
  it('returns exceeded:false when no budget', () => {
    const agent = { budget: null, usage: { tokens: 999999, turns: 99, startedAt: 0 } };
    expect(checkBudget(agent).exceeded).toBe(false);
  });

  it('detects max_tokens breach', () => {
    const agent = { budget: { max_tokens: 100 }, usage: { tokens: 100, turns: 0, startedAt: 0 } };
    const r = checkBudget(agent, 1);
    expect(r.exceeded).toBe(true);
    expect(r.limit).toBe('max_tokens');
  });

  it('detects max_turns breach', () => {
    const agent = { budget: { max_turns: 3 }, usage: { tokens: 0, turns: 3, startedAt: 0 } };
    const r = checkBudget(agent, 1);
    expect(r.exceeded).toBe(true);
    expect(r.limit).toBe('max_turns');
  });

  it('detects wall_time_ms breach', () => {
    const agent = { budget: { wall_time_ms: 1000 }, usage: { tokens: 0, turns: 0, startedAt: 0 } };
    const r = checkBudget(agent, 2000);
    expect(r.exceeded).toBe(true);
    expect(r.limit).toBe('wall_time_ms');
  });

  it('does NOT trigger when under limits', () => {
    const agent = {
      budget: { max_tokens: 100, max_turns: 3, wall_time_ms: 5000 },
      usage: { tokens: 50, turns: 1, startedAt: 0 },
    };
    expect(checkBudget(agent, 1000).exceeded).toBe(false);
  });
});

describe('Budget exceeded envelope', () => {
  it('returns status + partial_output + reason', () => {
    const agent = { partial_output: 'draft...', usage: { tokens: 200, turns: 2 } };
    const env = budgetExceededResult(agent, 'max_tokens (100) reached');
    expect(env.status).toBe('budget_exceeded');
    expect(env.partial_output).toBe('draft...');
    expect(env.reason).toMatch(/max_tokens/);
    expect(env.usage.tokens).toBe(200);
  });

  it('falls back to result when partial_output empty', () => {
    const env = budgetExceededResult({ result: 'final' }, 'done');
    expect(env.partial_output).toBe('final');
  });
});

describe('Agent.execute: back-compat + new fields', () => {
  beforeEach(() => _resetAgentRegistry());

  it('back-compat: string task still works', async () => {
    const out = JSON.parse(await agentTool.execute({ name: 'legacy', task: 'do stuff' }));
    expect(out.success).toBe(true);
    expect(out.agentId).toMatch(/^agent-/);
  });

  it('persists mission, persona, budget, expected_output on the agent record', async () => {
    const out = JSON.parse(await agentTool.execute({
      name: 'scout',
      mission: 'find all api routes',
      persona: 'explorer',
      budget: { max_turns: 5 },
      expected_output: { type: 'array' },
    }));
    expect(out.success).toBe(true);
    const agent = getAgentRegistry().get(out.agentId);
    expect(agent.mission).toBe('find all api routes');
    expect(agent.persona).toBe('explorer');
    expect(agent.personaData.tools).toContain('Read');
    expect(agent.budget.max_turns).toBe(5);
    expect(agent.expected_output.type).toBe('array');
    expect(agent.usage).toBeDefined();
    expect(agent.usage.tokens).toBe(0);
    expect(agent.trace).toEqual([]);
  });

  it('rejects invalid persona', async () => {
    const out = JSON.parse(await agentTool.execute({
      name: 'x', task: 't', persona: 'wizard',
    }));
    expect(out.error).toMatch(/unknown persona/);
  });

  it('rejects missing mission+task', async () => {
    const out = JSON.parse(await agentTool.execute({ name: 'x' }));
    expect(out.error).toMatch(/task or mission/);
  });

  it('rejects duplicate name', async () => {
    await agentTool.execute({ name: 'dup', task: 't' });
    const out = JSON.parse(await agentTool.execute({ name: 'dup', task: 't' }));
    expect(out.error).toMatch(/already exists/);
  });
});
