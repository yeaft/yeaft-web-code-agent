import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import {
  RESTRICTED_TOOLS,
  createChildToolPolicy,
  validateToolGrants,
} from '../../../agent/yeaft/sub-agent/tool-access.js';

function tool(name, aliases = []) {
  return defineTool({
    name,
    aliases,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => name,
  });
}

function parentRegistry() {
  return new ToolRegistry().registerAll([
    tool('FileRead', ['Read']),
    tool('GitRead'),
    tool('Grep'),
    tool('Glob'),
    tool('ListDir'),
    tool('DiscoverTools'),
    tool('Bash', ['Shell']),
    tool('FileWrite'),
    tool('SpawnAgent', ['Agent']),
    tool('UpdateAgent'),
    tool('AskUser'),
    tool('RouteForward'),
    tool('CreateWorkItem'),
  ]);
}

function reviewer(overrides = {}) {
  return {
    personaData: {
      id: 'reviewer',
      tools: ['GitRead', 'Read', 'Grep', 'Glob', 'ListDir'],
    },
    allowTools: [],
    ...overrides,
  };
}

function childRegistry(parent, policy) {
  const child = new ToolRegistry();
  for (const registered of parent.getAllTools()) {
    if (policy.allows(registered)) child.register(registered);
  }
  return child;
}

describe('sub-agent tool access', () => {
  it('keeps reviewer read-only by default while implementer and no persona retain work tools', () => {
    const parent = parentRegistry();
    const reviewPolicy = createChildToolPolicy(parent, reviewer());
    const reviewChild = childRegistry(parent, reviewPolicy);
    expect(reviewChild.has('FileRead')).toBe(true);
    expect(reviewChild.has('Bash')).toBe(false);
    expect(reviewChild.has('FileWrite')).toBe(false);

    for (const agent of [{ personaData: { id: 'implementer', tools: [] } }, {}]) {
      const policy = createChildToolPolicy(parent, agent);
      expect(policy.allows(parent.get('Bash'))).toBe(true);
      expect(policy.allows(parent.get('FileWrite'))).toBe(true);
      expect(policy.allows(parent.get('SpawnAgent'))).toBe(false);
    }
  });

  it('adds and revokes explicit grants on refresh without mutating the parent', () => {
    const parent = parentRegistry();
    const parentNames = parent.names;
    const agent = reviewer();
    const policy = createChildToolPolicy(parent, agent);
    const child = childRegistry(parent, policy);

    expect(child.has('Bash')).toBe(false);
    expect(child.has('FileWrite')).toBe(false);

    agent.allowTools = ['Bash', 'FileWrite'];
    policy.refresh(child);
    expect(child.get('Bash')).toBe(parent.get('Bash'));
    expect(child.get('Shell')).toBe(parent.get('Bash'));
    expect(child.get('FileWrite')).toBe(parent.get('FileWrite'));

    agent.allowTools = [];
    policy.refresh(child);
    expect(child.has('Bash')).toBe(false);
    expect(child.has('Shell')).toBe(false);
    expect(child.has('FileWrite')).toBe(false);
    expect(child.has('FileRead')).toBe(true);
    expect(parent.names).toEqual(parentNames);
    expect(parent.has('Bash')).toBe(true);
    expect(parent.has('Shell')).toBe(true);
    expect(parent.has('FileWrite')).toBe(true);
  });

  it('validates available parent tools, canonicalizes aliases and rejects invalid entries', () => {
    const parent = parentRegistry();
    expect(validateToolGrants(['Shell', 'Bash', 'Read'], parent)).toEqual({
      ok: true,
      tools: ['Bash', 'FileRead'],
    });
    expect(validateToolGrants([], null)).toEqual({ ok: true, tools: [] });
    expect(validateToolGrants(['Missing'], parent)).toMatchObject({ ok: false });
    expect(validateToolGrants([''], parent)).toMatchObject({ ok: false });
    expect(validateToolGrants('Bash', parent)).toMatchObject({ ok: false });
    expect(validateToolGrants(Array.from({ length: 33 }, () => 'Bash'), parent)).toMatchObject({ ok: false });
  });

  it.each([
    ['SpawnAgent'],
    ['Agent'],
    ['UpdateAgent'],
    ['AskUser'],
    ['RouteForward'],
    ['CreateWorkItem'],
  ])('rejects restricted self-escalation grant %s', (name) => {
    const parent = parentRegistry();
    expect(RESTRICTED_TOOLS.has(name)).toBe(true);
    expect(validateToolGrants([name], parent)).toMatchObject({ ok: false });
  });

  it('does not allow aliases or MCP hot registration to manufacture authority', () => {
    const parent = parentRegistry();
    const agent = reviewer({ allowTools: ['Bash'] });
    const policy = createChildToolPolicy(parent, agent);
    const child = childRegistry(parent, policy);

    const fakeAliasTarget = tool('Bash');
    const fakeMcp = tool('mcp__server__write');
    child.register(fakeAliasTarget);
    child.register(fakeMcp);
    expect(child.get('Bash')).toBe(fakeAliasTarget);
    expect(child.has('mcp__server__write')).toBe(true);

    policy.refresh(child);
    expect(child.get('Bash')).toBe(parent.get('Bash'));
    expect(child.get('Shell')).toBe(parent.get('Bash'));
    expect(child.has('mcp__server__write')).toBe(false);
    expect(policy.allows(parent.get('Shell'))).toBe(true);
    expect(policy.allows(fakeAliasTarget)).toBe(false);
    expect(policy.allows(fakeMcp)).toBe(false);
  });
});
