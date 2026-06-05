/**
 * Synthetic tool names — single source of truth for Claude Chat's
 * "fake user message" rewrites.
 *
 * Claude CLI injects two classes of system-generated user messages back into
 * the main conversation:
 *
 *   1. <task-notification>...</task-notification> — emitted when a background
 *      Agent/Task tool finishes. Rewritten by `agent/claude.js` into a
 *      synthetic assistant.tool_use block with `name = SUBAGENT_RESULT`.
 *
 *   2. Compact summaries ("This session is being continued from a previous
 *      conversation...") — emitted after context compaction. Rewritten with
 *      `name = COMPACT_SUMMARY`.
 *
 * These names are persisted verbatim into SQLite's `messages.tool_name`
 * column (see `server/handlers/agent-output.js` tool_use branch) and
 * matched verbatim by `web/components/ToolLine.js` to pick the icon and
 * one-line label. They are de-facto schema — renaming requires a DB
 * migration for old rows, so don't rename without one.
 *
 * The `__` prefix is reserved for synthetic / project-internal tool names.
 * Real Claude SDK tools and MCP tools must not use this prefix; if a future
 * tool registry ever needs to enforce this, do it there. Today the
 * convention is documented + relied upon by name collision being absent in
 * practice.
 */

export const SYNTHETIC_TOOL_NAMES = Object.freeze({
  SUBAGENT_RESULT: '__SubagentResult',
  COMPACT_SUMMARY: '__CompactSummary',
});

export const SYNTHETIC_TOOL_PREFIX = '__';

/** True when `name` is one of the project's synthetic tool sentinels. */
export function isSyntheticToolName(name) {
  if (typeof name !== 'string') return false;
  return name === SYNTHETIC_TOOL_NAMES.SUBAGENT_RESULT
      || name === SYNTHETIC_TOOL_NAMES.COMPACT_SUMMARY;
}
