// Built-in command descriptions (fallback when dynamic descriptions not available)
export const BUILTIN_DESCRIPTIONS = {
  '/compact': 'Compact context',
  '/context': 'Show context usage',
  '/cost': 'Show token costs',
  '/init': 'Reinitialize session',
  '/doctor': 'Check health status',
  '/memory': 'View/edit memory',
  '/model': 'View/switch model',
  '/review': 'Code review',
  '/mcp': 'MCP server status',
  '/skills': 'List available skills',
  '/btw': 'Side question (no history)',
  '/insights': 'Session insights',
  '/pr-comments': 'PR comment review',
  '/release-notes': 'Generate release notes',
  '/security-review': 'Security review',
};

// Commands handled by the web client itself (not sent to Claude)
export const WEB_ONLY_COMMANDS = new Set(['/btw']);

// Built-in CLI command names (used for grouping)
const BUILTIN_NAMES = new Set(Object.keys(BUILTIN_DESCRIPTIONS));

// Legacy alias — some code references SYSTEM_SKILLS / SYSTEM_SKILL_NAMES
export const SYSTEM_SKILLS = BUILTIN_DESCRIPTIONS;
export const SYSTEM_SKILL_NAMES = BUILTIN_NAMES;

// Default slash commands list (used before Claude SDK returns dynamic list)
export const DEFAULT_SLASH_COMMANDS = Object.keys(BUILTIN_DESCRIPTIONS);

export function mergeSlashCommands(...lists) {
  const merged = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const cmd of list) {
      if (typeof cmd !== 'string' || !cmd) continue;
      if (!merged.includes(cmd)) merged.push(cmd);
    }
  }
  return merged;
}

export function resolveDynamicSlashCommands(store, conversationId, agentId) {
  return mergeSlashCommands(
    conversationId ? store?.slashCommandsMap?.[conversationId] : null,
    agentId ? store?.slashCommandsMap?.[`agent:${agentId}`] : null,
    store?.slashCommandsMap?.__preload__
  );
}

/**
 * Determine the group for a slash command.
 * @param {string} cmd - Command with / prefix, e.g. "/review-code"
 * @param {object} [dynamicDescriptions] - command descriptions keyed by bare name
 * @param {Set<string>} [dynamicCommandNames] - currently visible dynamic command names, without / prefix
 * @returns {'skill' | 'builtin' | 'project'}
 */
export function getCommandGroup(cmd, dynamicDescriptions = {}, dynamicCommandNames = new Set()) {
  if (BUILTIN_NAMES.has(cmd)) return 'builtin';
  // Skill commands include legacy namespaced aliases and Yeaft's visible bare
  // skill commands. Bare skills must be part of the current dynamic command
  // list; descriptions are cumulative across reconnects/workDir switches.
  const bare = cmd.startsWith('/') ? cmd.slice(1) : cmd;
  if (bare.startsWith('skill:') || bare.startsWith('yeaft-skills:')) return 'skill';
  if (dynamicCommandNames.has(bare) && Object.prototype.hasOwnProperty.call(dynamicDescriptions || {}, bare)) return 'skill';
  // Other non-builtin commands (e.g. /update-config, /simplify) — treat as project commands.
  return 'project';
}

/**
 * Get a human-readable description for a command.
 * Priority: dynamic descriptions from store > builtin descriptions > formatted name
 * @param {string} cmd - Command with / prefix
 * @param {object} dynamicDescriptions - { commandName: description } from store
 * @returns {string}
 */
export function getCommandDescription(cmd, dynamicDescriptions = {}) {
  // Check builtin descriptions first (with / prefix)
  if (BUILTIN_DESCRIPTIONS[cmd]) return BUILTIN_DESCRIPTIONS[cmd];
  // Check dynamic descriptions (without / prefix, as CLI uses bare names)
  const bare = cmd.startsWith('/') ? cmd.slice(1) : cmd;
  if (dynamicDescriptions[bare]) return dynamicDescriptions[bare];
  // Format the name for display: "yeaft-skills:sprint" → "Sprint"
  return formatCommandName(bare);
}

/**
 * Format a bare command name into a readable display name.
 * "yeaft-skills:code-review" → "Code review"
 * "update-config" → "Update config"
 * @param {string} bare - Command name without / prefix
 * @returns {string}
 */
export function formatCommandName(bare) {
  // If it has a plugin prefix (e.g. "yeaft-skills:sprint"), use the part after ":"
  const name = bare.includes(':') ? bare.split(':').pop() : bare;
  // Convert kebab-case to title case: "code-review" → "Code review"
  return name.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

/**
 * Group label for each group type.
 */
export const GROUP_LABELS = {
  skill: 'Skills',
  builtin: 'Built-in',
  project: 'Commands'
};

/**
 * Sort order for groups.
 */
const GROUP_ORDER = { skill: 0, project: 1, builtin: 2 };

/**
 * Build grouped commands for the autocomplete dropdown.
 * @param {Array<{cmd: string, desc: string}>} flatItems
 * @param {object} [dynamicDescriptions] - command descriptions keyed by bare name
 * @param {Array<string>} [dynamicCommands] - currently visible dynamic commands
 * @returns {Array<{label: string, items: Array, isLast: boolean}>}
 */
export function buildGroupedCommands(flatItems, dynamicDescriptions = {}, dynamicCommands = []) {
  if (flatItems.length === 0) return [];

  const dynamicCommandNames = new Set(
    dynamicCommands
      .filter(cmd => typeof cmd === 'string')
      .map(cmd => cmd.startsWith('/') ? cmd.slice(1) : cmd)
  );
  const groups = {};
  flatItems.forEach((item, i) => {
    const group = getCommandGroup(item.cmd, item.descriptions || item.dynamicDescriptions || dynamicDescriptions, dynamicCommandNames);
    if (!groups[group]) groups[group] = [];
    groups[group].push({ ...item, flatIndex: i });
  });

  const sortedKeys = Object.keys(groups).sort((a, b) => (GROUP_ORDER[a] ?? 99) - (GROUP_ORDER[b] ?? 99));

  return sortedKeys.map((key, idx) => ({
    label: GROUP_LABELS[key] || key,
    items: groups[key],
    isLast: idx === sortedKeys.length - 1
  }));
}
