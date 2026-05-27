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

// --- Existing tools ---
import mcpTools from './mcp-tools.js';
import skillTool from './skill.js';
import enterWorktree from './enter-worktree.js';
import exitWorktree from './exit-worktree.js';

// --- P0 Core tools ---
import askUser from './ask-user.js';
import webSearch from './web-search.js';
import webFetch from './web-fetch.js';
import historySearch from './history-search.js';

// --- P0 File tools ---
import bash from './bash.js';
import fileRead from './file-read.js';
import fileWrite from './file-write.js';
import fileEdit from './file-edit.js';
import globTool from './glob.js';
import grepTool from './grep.js';
import listDir from './list-dir.js';
import applyPatch from './apply-patch.js';

// --- P1 Agent tools ---
import agentTool from './agent.js';
import sendMessage from './send-message.js';
import waitAgent from './wait-agent.js';
import closeAgent from './close-agent.js';
import listAgents from './list-agents.js';

// --- P1 Routing tools (task-334d) ---
import routeForward from './route-forward.js';

// --- P1 Progress tracking ---
import todoWrite from './todo-write.js';
import startPlan from './start-plan.js';

// H2.f.4: user-facing thread tools (spawnThread/switchThread/listThreads/...)
// were deleted. PR #797 reintroduces runtime-owned VP thread routing below the
// tool layer; LLMs still do not manage threads via tools.
//
// Feature tools (FeatureCreate/Update/List/Get/Progress/Memory + Followup
// + UpdatePlan + feature_summary_post) and the FeatureArc auto-creation
// system were removed in 2026-05-13 — they were defined but never used in
// production, contributing ~2900 lines of dead code. The TodoWrite tool
// above replaces them as the actual progress-tracking surface the LLM
// uses for multi-step tasks.

// --- P2 Auxiliary tools ---
// task-333b L1 delete: ToolSearch and WriteStdin removed — the function-call
// schema already exposes all tools, so ToolSearch was redundant; WriteStdin
// was a stub returning a hint about Bash piping.
import { jsRepl, jsReplReset } from './js-repl.js';
import notebookEdit from './notebook-edit.js';
import imageGeneration from './image-generation.js';
import viewImage from './view-image.js';

/**
 * All built-in tools, flattened into a single array.
 * mcpTools is already an array; the rest are single ToolDef objects.
 * @type {import('./types.js').ToolDef[]}
 */
export const allTools = [
  // Existing tools
  ...mcpTools,
  skillTool,
  enterWorktree,
  exitWorktree,

  // P0 Core
  askUser,
  webSearch,
  webFetch,
  historySearch,

  // P0 File
  bash,
  fileRead,
  fileWrite,
  fileEdit,
  globTool,
  grepTool,
  listDir,
  applyPatch,

  // P1 Agent
  agentTool,
  sendMessage,
  waitAgent,
  closeAgent,
  listAgents,

  // P1 Routing (task-334d)
  routeForward,

  // P1 Progress tracking
  todoWrite,
  startPlan,

  // P2 Auxiliary
  jsRepl,
  jsReplReset,
  notebookEdit,
  imageGeneration,
  viewImage,
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
