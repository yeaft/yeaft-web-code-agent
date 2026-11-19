/**
 * Monochrome tool glyphs for transcript tool lines.
 *
 * Tools are grouped by what they do (read, edit, run, search, web, delegate…)
 * so Claude Code, Copilot and native Yeaft tool names share one small icon
 * vocabulary. Glyphs use the chrome's 24px grid and round 1.8 stroke and take
 * `currentColor`, so they follow the line's muted/running/error colour instead
 * of rendering as platform-dependent colour emoji.
 */
const TOOL_KINDS = {
  read: ['Read', 'FileRead', 'NotebookRead', 'ViewImage', 'ReadTaskLog', 'GitRead', 'Skill'],
  edit: ['Edit', 'MultiEdit', 'FileEdit', 'NotebookEdit', 'ApplyPatch'],
  write: ['Write', 'FileWrite'],
  run: ['Bash', 'PowerShell', 'Shell', 'BashOutput', 'KillShell', 'KillBash'],
  search: ['Glob', 'Grep', 'ListDir', 'LS', 'ToolSearch', 'DiscoverTools', 'MemorySearch'],
  web: ['WebFetch', 'WebSearch'],
  delegate: ['Task', 'Agent', 'SpawnAgent', 'PromptAgent', 'WaitAgent', 'UpdateAgent', 'CloseAgent', 'ListAgents', '__SubagentResult'],
  todo: ['TodoWrite', 'TodoRead'],
  forward: ['RouteForward'],
  summary: ['__CompactSummary'],
  ask: ['AskUser', 'AskUserQuestion'],
};

const KIND_BY_NAME = Object.fromEntries(
  Object.entries(TOOL_KINDS).flatMap(([kind, names]) => names.map(name => [name, kind])),
);

/** @param {string} name tool name as recorded in the transcript */
export function toolGlyphKind(name) {
  if (!name) return 'tool';
  if (KIND_BY_NAME[name]) return KIND_BY_NAME[name];
  if (name.startsWith('mcp__')) return 'plugin';
  return 'tool';
}

export default {
  name: 'ToolGlyph',
  props: {
    name: { type: String, default: '' },
    size: { type: [Number, String], default: 14 },
  },
  computed: {
    kind() { return toolGlyphKind(this.name); },
  },
  template: `
    <svg :width="size" :height="size" viewBox="0 0 24 24" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <template v-if="kind === 'read'"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></template>
      <template v-else-if="kind === 'edit'"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></template>
      <template v-else-if="kind === 'write'"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 12v6M9 15h6"/></template>
      <template v-else-if="kind === 'run'"><path d="m5 7 5 5-5 5"/><path d="M13 17h6"/></template>
      <template v-else-if="kind === 'search'"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></template>
      <template v-else-if="kind === 'web'"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/></template>
      <template v-else-if="kind === 'delegate'"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 13v1M15 13v1"/></template>
      <template v-else-if="kind === 'todo'"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/></template>
      <template v-else-if="kind === 'forward'"><path d="M4 12h12"/><path d="m12 6 6 6-6 6"/><path d="M20 5v14"/></template>
      <template v-else-if="kind === 'summary'"><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></template>
      <template v-else-if="kind === 'ask'"><path d="M20 14a3 3 0 0 1-3 3H9l-5 4V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z"/><path d="M10 8.6a2.2 2.2 0 1 1 3 2.05c-.6.25-1 .75-1 1.35v.3M12 15h.01"/></template>
      <template v-else-if="kind === 'plugin'"><path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v5"/></template>
      <path v-else d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
    </svg>
  `,
};
