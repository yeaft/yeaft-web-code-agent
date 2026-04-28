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
import memoryRead from './memory-read.js';
import memoryWrite from './memory-write.js';
import memorySearch, { memorySearchAlias } from './memory-search.js';
import memoryQuery from './memory-query.js';
import memoryTrace from './memory-trace.js';
import openSourceMessage from './open-source-message.js';
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

// --- P1 Feature tools ---
import {
  featureCreate,
  featureUpdate,
  featureList,
  featureGet,
  featureProgress,
  featureMemory,
  followupFeature,
  updatePlan,
} from './feature-tools.js';

// --- P1 Thread tools (task-299 Phase 1) ---
import {
  spawnThread,
  switchThread,
  listThreads,
  attachThreadToFeature,
  readThreadSummary,
  readThreadRecent,
} from './thread-tools.js';

// --- P2 Auxiliary tools ---
// task-333b L1 delete: ToolSearch and WriteStdin removed — the function-call
// schema already exposes all tools, so ToolSearch was redundant; WriteStdin
// was a stub returning a hint about Bash piping.
import { jsRepl, jsReplReset } from './js-repl.js';
import notebookEdit from './notebook-edit.js';
import imageGeneration from './image-generation.js';
import viewImage from './view-image.js';
import requestPermissions from './request-permissions.js';

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
  memoryRead,
  memoryWrite,
  memorySearch,
  memorySearchAlias,
  memoryQuery,
  memoryTrace,
  openSourceMessage,
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

  // P1 Feature
  featureCreate,
  featureUpdate,
  featureList,
  featureGet,
  featureProgress,
  featureMemory,
  followupFeature,
  updatePlan,

  // P1 Thread (task-299 Phase 1)
  spawnThread,
  switchThread,
  listThreads,
  attachThreadToFeature,
  readThreadSummary,
  readThreadRecent,

  // P2 Auxiliary
  jsRepl,
  jsReplReset,
  notebookEdit,
  imageGeneration,
  viewImage,
  requestPermissions,
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
