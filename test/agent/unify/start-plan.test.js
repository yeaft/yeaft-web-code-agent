/**
 * start-plan.test.js — tests for the `StartPlan` tool.
 *
 * Coverage:
 *   - tool shape (name, description, parameters, execute) is valid
 *   - `topic` is required; missing / blank → plain-text error
 *   - default template is returned when no VP override is present
 *   - VP `planInstruction` override wins when ctx.vpPersona.planInstruction is set
 *   - whitespace-only override falls back to default
 *   - vpPersona present but missing planInstruction key falls back to default
 *   - language: 'zh' is honored when the template carries lang sections
 *   - guiding fields (stuckAt, userProblem, expectedScale, additionalContext)
 *     are echoed back; empty / missing ones are skipped
 *   - the result includes a TodoWrite handoff line
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

describe('StartPlan tool', () => {
  it('exposes a valid tool definition', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const tool = mod.default;
    expect(tool.name).toBe('StartPlan');
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(50);
    expect(tool.parameters?.type).toBe('object');
    expect(tool.parameters?.required).toEqual(['topic']);
    expect(typeof tool.execute).toBe('function');
  });

  it('rejects missing topic with plain-text error', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const out = await mod.default.execute({}, {});
    // Plain text — same shape as the success path so the LLM doesn't
    // need a JSON-vs-text branch to read this tool's output.
    expect(typeof out).toBe('string');
    expect(out).toMatch(/^Error: topic is required/i);
    // Sanity: not JSON.
    expect(() => JSON.parse(out)).toThrow();
  });

  it('rejects blank topic with plain-text error', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const out = await mod.default.execute({ topic: '   ' }, {});
    expect(out).toMatch(/^Error: topic is required/i);
  });

  it('returns default template when no VP planInstruction is set', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const out = await mod.default.execute({ topic: 'add dark mode' }, {});
    expect(out).toContain('<plan-instruction>');
    expect(out).toContain('</plan-instruction>');
    // The default template ships specific framing — check a sentinel phrase
    // that wouldn't appear in a per-VP override.
    expect(out).toMatch(/planning mode|TodoWrite/i);
    expect(out).toContain('<topic>');
    expect(out).toContain('add dark mode');
    expect(out).toContain('</topic>');
    // Handoff nudge to land the plan.
    expect(out).toMatch(/TodoWrite/);
  });

  it('uses the VP planInstruction override when present', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const override = 'JOBS-STYLE: cut features, ship one thing, then iterate.';
    const ctx = { vpPersona: { vpId: 'jobs', planInstruction: override } };
    const out = await mod.default.execute({ topic: 'launch v2' }, ctx);
    expect(out).toContain('<plan-instruction>');
    expect(out).toContain(override);
    expect(out).toContain('launch v2');
    // The default template's sentinel phrases must NOT appear when overridden.
    expect(out).not.toMatch(/Restate the problem in one sentence/);
  });

  it('falls back to default when planInstruction is empty string', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const ctx = { vpPersona: { vpId: 'alice', planInstruction: '' } };
    const out = await mod.default.execute({ topic: 'fix bug 42' }, ctx);
    // Default template phrase should appear.
    expect(out).toMatch(/planning mode|TodoWrite/);
  });

  it('falls back to default when planInstruction is whitespace-only', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const ctx = { vpPersona: { vpId: 'alice', planInstruction: '   \n\t  ' } };
    const out = await mod.default.execute({ topic: 'fix bug 42' }, ctx);
    // Default template phrase should appear; the whitespace must NOT
    // appear inside the plan-instruction block.
    expect(out).toMatch(/planning mode|TodoWrite/);
    expect(out).not.toMatch(/<plan-instruction>\s*\n\s*\n\s*<\/plan-instruction>/);
  });

  it('falls back to default when vpPersona is present but lacks planInstruction', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const ctx = { vpPersona: { vpId: 'alice', displayName: 'Alice' } };
    const out = await mod.default.execute({ topic: 'fix bug 42' }, ctx);
    expect(out).toMatch(/planning mode|TodoWrite/);
  });

  it('echoes guiding fields back when provided', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const out = await mod.default.execute({
      topic: 'plan migration',
      userProblem: 'database is overloaded under spike traffic',
      stuckAt: 'unsure whether sharding or read-replicas is right',
      expectedScale: '~ 8 tables, ~ 2 weeks',
      additionalContext: 'must keep zero-downtime during cutover',
    }, {});
    expect(out).toContain('<guiding-context>');
    expect(out).toContain('userProblem:');
    expect(out).toContain('database is overloaded under spike traffic');
    expect(out).toContain('stuckAt:');
    expect(out).toContain('unsure whether sharding or read-replicas is right');
    expect(out).toContain('expectedScale:');
    expect(out).toContain('additionalContext:');
    expect(out).toContain('zero-downtime during cutover');
  });

  it('omits the guiding-context block when no guiding fields are passed', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const out = await mod.default.execute({ topic: 'simple plan' }, {});
    expect(out).not.toContain('<guiding-context>');
  });

  it('skips blank guiding fields silently', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const out = await mod.default.execute({
      topic: 'tidy plan',
      userProblem: '   ',
      stuckAt: '',
      additionalContext: 'real context here',
    }, {});
    expect(out).toContain('additionalContext: real context here');
    expect(out).not.toContain('userProblem:');
    expect(out).not.toContain('stuckAt:');
  });

  it('honors language: zh on ctx.config when resolving the default template', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    // Even if the template has no zh-specific section, the resolution must
    // not crash and must still return a usable instruction. (The shipped
    // template currently has no lang markers, so zh falls back to the
    // whole body — verify that fallback is safe.)
    const out = await mod.default.execute({ topic: 'plan zh' }, { config: { language: 'zh' } });
    expect(out).toContain('<plan-instruction>');
    expect(out).toMatch(/TodoWrite/);
  });

  it('is declared concurrency-safe and read-only', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const tool = mod.default;
    expect(tool.isConcurrencySafe?.()).toBe(true);
    expect(tool.isReadOnly?.()).toBe(true);
  });
});

describe('VP planInstruction frontmatter', () => {
  it('vp-store parseRoleMd surfaces planInstruction when present', async () => {
    const { parseRoleMd } = await import(`${ROOT}/agent/unify/vp/vp-store.js`);
    const src = [
      '---',
      'id: planner',
      'name: Planner',
      'role: Architect',
      'planInstruction: "Use a 3-step plan and call TodoWrite immediately."',
      '---',
      'Body here.',
    ].join('\n');
    const { meta, body } = parseRoleMd(src);
    expect(meta.planInstruction).toBe('Use a 3-step plan and call TodoWrite immediately.');
    expect(body).toBe('Body here.');
  });

  it('loadVpFromDir populates planInstruction (default empty when missing)', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { loadVpFromDir } = await import(`${ROOT}/agent/unify/vp/vp-store.js`);

    const tmp = mkdtempSync(join(tmpdir(), 'vp-plan-'));
    try {
      const dir = join(tmp, 'planner');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'role.md'), [
        '---',
        'id: planner',
        'name: Planner',
        'role: Architect',
        'planInstruction: "Always start with risk."',
        '---',
        'Persona body.',
      ].join('\n'));
      const vp = loadVpFromDir(dir);
      expect(vp).not.toBeNull();
      expect(vp.planInstruction).toBe('Always start with risk.');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('loadVpFromDir defaults planInstruction to empty string when frontmatter omits it', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { loadVpFromDir } = await import(`${ROOT}/agent/unify/vp/vp-store.js`);

    const tmp = mkdtempSync(join(tmpdir(), 'vp-plan-'));
    try {
      const dir = join(tmp, 'noplan');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'role.md'), [
        '---',
        'id: noplan',
        'name: NoPlan',
        'role: Dev',
        '---',
        'Body.',
      ].join('\n'));
      const vp = loadVpFromDir(dir);
      expect(vp).not.toBeNull();
      expect(vp.planInstruction).toBe('');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('readVp surfaces planInstruction', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { readVp } = await import(`${ROOT}/agent/unify/vp/vp-crud.js`);

    const tmp = mkdtempSync(join(tmpdir(), 'vp-plan-readvp-'));
    try {
      const libDir = tmp;
      const dir = join(libDir, 'jobs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'role.md'), [
        '---',
        'id: jobs',
        'name: Steve',
        'role: PM',
        'planInstruction: "Cut features first."',
        '---',
        'persona body',
      ].join('\n'));
      const vp = readVp('jobs', { libDir });
      expect(vp).not.toBeNull();
      expect(vp.planInstruction).toBe('Cut features first.');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('getDefaultPlanInstruction', () => {
  it('returns a non-empty default template', async () => {
    const { getDefaultPlanInstruction } = await import(`${ROOT}/agent/unify/prompts.js`);
    const out = getDefaultPlanInstruction('en');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(50);
    expect(out).toMatch(/TodoWrite/);
  });

  // Regression: the default template MUST tell the LLM to keep going after
  // TodoWrite. The original wording said "Do not execute the steps in this
  // turn ... ends after the TodoWrite call" which made the engine loop exit
  // (engine.js:1721 — stop_reason='end_turn' terminates the turn) and group
  // VPs went silent after writing the plan. This assertion locks the new
  // contract — if a future "tidy the wording" PR re-introduces stop-here
  // language, this test will fail before the bug ships.
  it('default instruction tells the LLM to continue executing after the plan', async () => {
    const { getDefaultPlanInstruction } = await import(`${ROOT}/agent/unify/prompts.js`);
    const out = getDefaultPlanInstruction('en');
    // Positive signal: "keep going" / "same turn" / "start executing"
    expect(out).toMatch(/keep going|same turn|start executing/i);
    // Negative signal: must NOT carry the old stop-here phrasing.
    expect(out).not.toMatch(/do not execute the steps in this turn/i);
    expect(out).not.toMatch(/this turn ends after the .?TodoWrite/i);
  });
});
