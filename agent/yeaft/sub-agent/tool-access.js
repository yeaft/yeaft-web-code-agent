/**
 * Child tool authorization policy.
 *
 * Persona tools are the baseline. `agent.allowTools` is an additional,
 * replaceable allowlist of canonical tools from the parent registry. Bash is
 * deliberately not wrapped or narrowed here: granting Bash grants the actual
 * parent shell tool, including its write capabilities.
 */
import { getPersona } from '../personas.js';

const MAX_TOOL_GRANTS = 32;
const TOOL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

export const RESTRICTED_TOOLS = new Set([
  'SpawnAgent',
  'Agent',          // legacy alias
  'UpdateAgent',
  'PromptAgent',
  'SendMessage',    // legacy alias
  'WaitAgent',
  'CloseAgent',
  'ListAgents',
  'RouteForward',
  'AskUser',
  'CreateWorkItem',
]);

function canonicalTool(parentRegistry, name) {
  if (!parentRegistry || typeof parentRegistry.get !== 'function') return null;
  const tool = parentRegistry.get(name);
  return tool && typeof tool.name === 'string' ? tool : null;
}

function isRestricted(tool, requestedName = null) {
  return RESTRICTED_TOOLS.has(tool?.name) || (requestedName && RESTRICTED_TOOLS.has(requestedName));
}

/**
 * Validate and canonicalize explicit child grants.
 *
 * @param {unknown} names
 * @param {import('../tools/registry.js').ToolRegistry|null} parentRegistry
 * @returns {{ ok: true, tools: string[] }|{ ok: false, error: string }}
 */
export function validateToolGrants(names, parentRegistry) {
  if (!Array.isArray(names)) {
    return { ok: false, error: 'allow_tools must be an array of tool names' };
  }
  if (names.length > MAX_TOOL_GRANTS) {
    return { ok: false, error: `allow_tools may contain at most ${MAX_TOOL_GRANTS} names` };
  }
  if (!parentRegistry || typeof parentRegistry.get !== 'function') {
    return names.length === 0
      ? { ok: true, tools: [] }
      : { ok: false, error: 'parent tool registry is unavailable' };
  }

  const tools = [];
  const seen = new Set();
  for (const value of names) {
    if (typeof value !== 'string' || !value.trim()) {
      return { ok: false, error: 'allow_tools entries must be non-empty tool names' };
    }
    const name = value.trim();
    if (!TOOL_NAME_RE.test(name)) {
      return { ok: false, error: `Invalid tool name: ${name}` };
    }
    const tool = canonicalTool(parentRegistry, name);
    if (!tool) return { ok: false, error: `Parent tool is not available: ${name}` };
    if (isRestricted(tool, name)) {
      return { ok: false, error: `Tool cannot be granted to a child agent: ${tool.name}` };
    }
    if (!seen.has(tool.name)) {
      seen.add(tool.name);
      tools.push(tool.name);
    }
  }
  return { ok: true, tools };
}

function unregisterTool(registry, tool) {
  registry.unregister(tool.name);
  for (const alias of tool.aliases || []) registry.unregister(alias);
}

/**
 * Create a live policy for one child. `refresh()` reconciles only the child
 * registry; the parent registry is used as the source of canonical ToolDef
 * objects and is never mutated.
 *
 * @param {import('../tools/registry.js').ToolRegistry|null} parentRegistry
 * @param {object|null} agent
 * @returns {{ allows(tool: object): boolean, refresh(childRegistry: import('../tools/registry.js').ToolRegistry): void }}
 */
export function createChildToolPolicy(parentRegistry, agent) {
  const preset = agent?.personaData || getPersona(agent?.persona);
  const baseline = preset && preset.id !== 'implementer'
    ? new Set([
      ...preset.tools.map(name => canonicalTool(parentRegistry, name)?.name || (name === 'Read' ? 'FileRead' : name)),
      'DiscoverTools',
    ])
    : null;

  const allows = (tool) => {
    if (!tool || typeof tool.name !== 'string' || isRestricted(tool)) return false;

    // Require the exact ToolDef owned by the parent. This prevents aliases or a
    // child-local/MCP hot registration from manufacturing an allowed name.
    if (canonicalTool(parentRegistry, tool.name) !== tool) return false;
    if (baseline === null || baseline.has(tool.name)) return true;

    for (const name of agent?.allowTools || []) {
      const granted = canonicalTool(parentRegistry, name);
      if (granted === tool && !isRestricted(granted, name)) return true;
    }
    return false;
  };

  const refresh = (childRegistry) => {
    if (!childRegistry
        || typeof childRegistry.getAllTools !== 'function'
        || typeof childRegistry.register !== 'function'
        || typeof childRegistry.unregister !== 'function') return;

    for (const tool of childRegistry.getAllTools()) {
      if (!allows(tool)) unregisterTool(childRegistry, tool);
    }
    if (!parentRegistry || typeof parentRegistry.getAllTools !== 'function') return;
    for (const tool of parentRegistry.getAllTools()) {
      if (!allows(tool)) continue;
      const current = childRegistry.get(tool.name);
      if (current && current !== tool) unregisterTool(childRegistry, current);
      if (childRegistry.get(tool.name) !== tool) childRegistry.register(tool);
    }
  };

  return { allows, refresh };
}
