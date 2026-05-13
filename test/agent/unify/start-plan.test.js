/**
 * start-plan.test.js — tests for the `start_plan` tool.
 *
 * Coverage:
 *   - tool shape (name, description, parameters, execute) is valid
 *   - `topic` is required; missing / blank → error
 *   - default template is returned when no VP override is present
 *   - VP `planInstruction` override wins when ctx.vpPersona.planInstruction is set
 *   - guiding fields (stuck_at, user_problem, expected_scale, additional_context)
 *     are echoed back; empty / missing ones are skipped
 *   - the result includes a TodoWrite handoff line
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

describe('start_plan tool', () => {
  it('exposes a valid tool definition', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const tool = mod.default;
    expect(tool.name).toBe('start_plan');
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(50);
    expect(tool.parameters?.type).toBe('object');
    expect(tool.parameters?.required).toEqual(['topic']);
    expect(typeof tool.execute).toBe('function');
  });

  it('rejects missing topic', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const out = await mod.default.execute({}, {});
    // Error path returns JSON.
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/topic is required/i);
  });

  it('rejects blank topic', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const out = await mod.default.execute({ topic: '   ' }, {});
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/topic is required/i);
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

  it('echoes guiding fields back when provided', async () => {
    const mod = await import(`${ROOT}/agent/unify/tools/start-plan.js`);
    const out = await mod.default.execute({
      topic: 'plan migration',
      user_problem: 'database is overloaded under spike traffic',
      stuck_at: 'unsure whether sharding or read-replicas is right',
      expected_scale: '~ 8 tables, ~ 2 weeks',
      additional_context: 'must keep zero-downtime during cutover',
    }, {});
    expect(out).toContain('<guiding-context>');
    expect(out).toContain('user_problem:');
    expect(out).toContain('database is overloaded under spike traffic');
    expect(out).toContain('stuck_at:');
    expect(out).toContain('unsure whether sharding or read-replicas is right');
    expect(out).toContain('expected_scale:');
    expect(out).toContain('additional_context:');
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
      user_problem: '   ',
      stuck_at: '',
      additional_context: 'real context here',
    }, {});
    expect(out).toContain('additional_context: real context here');
    expect(out).not.toContain('user_problem:');
    expect(out).not.toContain('stuck_at:');
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
});
