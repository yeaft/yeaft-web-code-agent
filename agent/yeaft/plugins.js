/**
 * plugins.js — Agent-level selectable Yeaft capabilities.
 *
 * An Agent owns installed tools, skills, and MCP configuration. Missing plugin
 * fields retain historical behavior (everything enabled); explicit arrays are
 * allowlists and may intentionally be empty.
 */

function normalizeNameList(value, field) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`plugins.${field} must be an array`);

  const names = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error(`plugins.${field} entries must be non-empty strings`);
    }
    const name = raw.trim();
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Normalise persisted Agent plugin config while preserving inheritance. */
export function normalizePluginConfig(value) {
  // Only an omitted field inherits the legacy all-enabled behavior. An
  // explicit `null` is persisted schema, not absence, and must be rejected
  // so every reader can fail closed consistently.
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('plugins must be an object');
  }

  const out = {};
  for (const field of ['tools', 'skills', 'mcpServers']) {
    const names = normalizeNameList(value[field], field);
    if (names !== undefined) out[field] = names;
  }
  for (const key of Object.keys(value)) {
    if (!['tools', 'skills', 'mcpServers'].includes(key)) {
      throw new Error(`unknown plugins key: ${key}`);
    }
  }
  return out;
}

/**
 * Return an explicit deny-all policy for a persisted plugins schema error.
 * This is deliberately distinct from `{}`, whose missing fields inherit the
 * historical all-enabled behavior.
 */
export function createDenyAllPluginConfig() {
  return { tools: [], skills: [], mcpServers: [] };
}

export function isPluginNameEnabled(plugins, field, name) {
  if (!plugins || !Array.isArray(plugins[field])) return true;
  return plugins[field].includes(name);
}

/**
 * Keep the configured MCP catalog separate from the runtime connection set.
 * The catalog must retain disabled servers so users can enable them later;
 * runtimes must receive only the effective allowlisted subset.
 *
 * The caller owns the raw configured catalog; this helper never connects it.
 */
export function resolveMcpPluginPolicy(mcpConfig, plugins) {
  const configured = {
    ...(mcpConfig || {}),
    servers: Array.isArray(mcpConfig?.servers) ? mcpConfig.servers : [],
  };
  if (!Array.isArray(plugins?.mcpServers)) {
    return { configured, effective: configured };
  }

  const allowed = new Set(plugins.mcpServers);
  return {
    configured,
    effective: {
      ...configured,
      servers: configured.servers.filter(server => allowed.has(server?.name)),
    },
  };
}

/**
 * Live delegating view over a SkillManager. It does not mutate the shared
 * manager because Sessions and project runtimes reuse that manager.
 */
export function createPluginSkillManager(skillManager, plugins) {
  if (!skillManager) return null;
  const hasExplicitSkills = Array.isArray(plugins?.skills);
  const allowed = hasExplicitSkills ? new Set(plugins.skills) : null;
  const isAllowed = name => !allowed || allowed.has(name);
  const has = name => isAllowed(name) && !!skillManager.has?.(name);
  const list = (...args) => (skillManager.list?.(...args) || [])
    .filter(skill => isAllowed(skill?.name));
  const get = name => has(name) ? skillManager.get?.(name) || null : null;
  const resolve = name => has(name) ? skillManager.resolve?.(name) || null : null;
  const view = (name, filePath) => has(name) ? skillManager.view?.(name, filePath) || null : null;
  const findRelevant = (...args) => (skillManager.findRelevant?.(...args) || [])
    .filter(skill => isAllowed(skill?.name));
  const getPromptContent = name => has(name) ? skillManager.getPromptContent?.(name) || '' : '';

  return {
    has,
    get,
    resolve,
    list,
    view,
    findRelevant,
    getPromptContent,
    getRelevantPromptContent: (...args) => findRelevant(...args)
      .map(skill => getPromptContent(skill.name))
      .filter(Boolean)
      .join('\n\n'),
    listCategories: () => [...new Set(list().map(skill => skill.category).filter(Boolean))].sort(),
    get size() { return list().length; },
  };
}

const PLUGIN_SKILL_CONTENT_MAX_BYTES = 256 * 1024;

/**
 * Read one effective layered Skill from the full catalog manager, independently
 * of inference allowlists. Only the body and linked filenames belong to this
 * browser projection; never pass a linked file path to SkillManager.view().
 */
export function buildPluginSkillDetail({ skillManager } = {}, skillName) {
  if (typeof skillName !== 'string' || !skillName.trim()
    || skillName !== skillName.trim() || /[/\\\u0000-\u001f\u007f]/.test(skillName)
    || skillName === '.' || skillName === '..') {
    throw new Error('invalid skillName: expected a non-empty Skill name');
  }
  const viewed = skillManager?.view?.(skillName);
  const skill = viewed?.skill;
  if (!skill || skill.name !== skillName) throw new Error(`skill not found: ${skillName}`);

  let content = typeof skill.content === 'string' ? skill.content : '';
  const contentTruncated = Buffer.byteLength(content, 'utf8') > PLUGIN_SKILL_CONTENT_MAX_BYTES;
  if (contentTruncated) {
    const bytes = Buffer.from(content, 'utf8');
    let end = PLUGIN_SKILL_CONTENT_MAX_BYTES;
    // Do not decode an incomplete UTF-8 code point into a replacement character.
    while ((bytes[end] & 0xc0) === 0x80) end--;
    content = bytes.subarray(0, end).toString('utf8');
  }
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  return {
    name: skillName,
    description: typeof skill.description === 'string' ? skill.description : '',
    trigger: typeof skill.trigger === 'string' ? skill.trigger : '',
    keywords: strings(skill.keywords),
    category: typeof skill.category === 'string' ? skill.category : null,
    tier: typeof skill._tier === 'string' ? skill._tier : null,
    content,
    references: strings(viewed.references),
    templates: strings(viewed.templates),
    ...(contentTruncated ? { contentTruncated: true } : {}),
  };
}

/** Build a browser-safe catalog from already discovered Agent assets. */
export function buildPluginCatalog({ toolRegistry, skillManager, mcpConfig, mcpManager } = {}) {
  const tools = typeof toolRegistry?.getAllTools === 'function'
    ? toolRegistry.getAllTools()
      .filter(tool => !tool?.mcpServer)
      .map(tool => ({ id: tool.name, label: tool.name }))
      .sort((a, b) => a.label.localeCompare(b.label))
    : [];

  // Runtime authorization is keyed by Skill name, so this catalog must expose
  // only the effective layered entry per name. Source-level rows belong to the
  // management surface below; otherwise a project override would render two
  // allowlist toggles that both mutate the same name.
  const skills = (typeof skillManager?.list === 'function' ? skillManager.list() : [])
    .map(skill => ({
      id: skill.name,
      label: skill.name,
      description: skill.description || '',
      category: skill.category || null,
      tier: skill.tier || null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const skillSources = (typeof skillManager?.listSources === 'function' ? skillManager.listSources() : [])
    .map(skill => ({
      id: skill.id,
      name: skill.name,
      label: skill.name,
      description: skill.description || '',
      tier: skill.tier || null,
      managed: skill.managed === true,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || String(a.id).localeCompare(String(b.id)));

  const statusByName = new Map((mcpManager?.status?.() || [])
    .map(status => [status.name, status]));
  // A configured catalog is authoritative, including an explicit empty array.
  // Only callers that supplied no catalog at all use live status as a legacy
  // fallback.
  const configuredMcpServers = Array.isArray(mcpConfig?.servers)
    ? mcpConfig.servers
    : (mcpManager?.status?.() || []).map(status => ({ name: status.name, command: '' }));
  const mcpServers = configuredMcpServers
    .filter(server => typeof server?.name === 'string' && server.name)
    .map(server => {
      const status = statusByName.get(server.name);
      return {
        id: server.name,
        label: server.name,
        description: server.command || '',
        ready: status ? !!status.ready : null,
        toolCount: status?.toolCount || 0,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return { tools, skills, skillSources, mcpServers };
}
