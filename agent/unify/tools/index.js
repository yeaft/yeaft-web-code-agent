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
import memorySearch from './memory-search.js';
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

// --- P1 Task tools ---
import {
  taskCreate,
  taskUpdate,
  taskList,
  taskGet,
  taskProgress,
  taskMemory,
  followupTask,
  updatePlan,
} from './task-tools.js';

// --- P2 Auxiliary tools ---
import { jsRepl, jsReplReset } from './js-repl.js';
import notebookEdit from './notebook-edit.js';
import imageGeneration from './image-generation.js';
import viewImage from './view-image.js';
import toolSearch from './tool-search.js';
import requestPermissions from './request-permissions.js';
import writeStdin from './write-stdin.js';

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

  // P1 Task
  taskCreate,
  taskUpdate,
  taskList,
  taskGet,
  taskProgress,
  taskMemory,
  followupTask,
  updatePlan,

  // P2 Auxiliary
  jsRepl,
  jsReplReset,
  notebookEdit,
  imageGeneration,
  viewImage,
  toolSearch,
  requestPermissions,
  writeStdin,
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
