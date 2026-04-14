/**
 * tools/index.js — All built-in tools + createFullRegistry()
 *
 * Central barrel file that imports every built-in tool and exposes a
 * factory function to create a ToolRegistry pre-loaded with all of them.
 *
 * session.js should use createFullRegistry() instead of createEmptyRegistry()
 * to ensure all built-in tools are available to the LLM.
 */

import { ToolRegistry } from './registry.js';
import mcpTools from './mcp-tools.js';
import skillTool from './skill.js';
import enterWorktree from './enter-worktree.js';
import exitWorktree from './exit-worktree.js';

/**
 * All built-in tools, flattened into a single array.
 * mcpTools is already an array; the rest are single ToolDef objects.
 * @type {import('./types.js').ToolDef[]}
 */
export const allTools = [
  ...mcpTools,
  skillTool,
  enterWorktree,
  exitWorktree,
];

/**
 * Create a ToolRegistry pre-loaded with all built-in tools.
 * @returns {ToolRegistry}
 */
export function createFullRegistry() {
  const registry = new ToolRegistry();
  registry.registerAll(allTools);
  return registry;
}
