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

/**
 * Determine the group for a slash command.
 * @param {string} cmd - Command with / prefix, e.g. "/yeaft-skills:sprint"
 * @returns {'skill' | 'builtin' | 'project'}
 */
export function getCommandGroup(cmd) {
  if (BUILTIN_NAMES.has(cmd)) return 'builtin';
  // Skill commands include both plugin-style names and Yeaft-native skill:<name>.
  const bare = cmd.startsWith('/') ? cmd.slice(1) : cmd;
  if (bare.startsWith('skill:') || bare.includes(':')) return 'skill';
  // Other non-builtin commands (e.g. /update-config, /simplify) — treat as project skills
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
 * @returns {Array<{label: string, items: Array, isLast: boolean}>}
 */
export function buildGroupedCommands(flatItems) {
  if (flatItems.length === 0) return [];

  const groups = {};
  flatItems.forEach((item, i) => {
    const group = getCommandGroup(item.cmd);
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
