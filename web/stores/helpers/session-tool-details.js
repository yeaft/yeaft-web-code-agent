import { sessionExecutionKey } from './yeaft-session-identity.js';

// Interactive questions, checklists and hand-offs stay in the transcript.
const INLINE_TOOLS = new Set(['AskUser', 'AskUserQuestion', 'TodoWrite', 'RouteForward']);
const MAX_CALLS_PER_EXECUTION = 128;
const MAX_TRACKED_EXECUTIONS = 128;
const scopeKey = ({ agentId, conversationId, sessionId }, executionKey) => JSON.stringify([agentId, conversationId, sessionId, executionKey]);

function liveEntry(store, owner) {
  const key = scopeKey(owner, sessionExecutionKey(owner));
  const cache = store.yeaftLiveToolExecutions ||= {};
  if (!cache[key]) {
    const keys = Object.keys(cache);
    if (keys.length >= MAX_TRACKED_EXECUTIONS) delete cache[keys[0]];
    cache[key] = { ...owner, tools: [], pendingResults: [] };
  }
  return cache[key];
}

// Browser-tab state only: capture events as they arrive, not from transcript
// rows that a recent-history refresh can replace even while a turn is live.
export function recordLiveSessionTool(store, owner, row) {
  if (!row.toolId || !row.toolName || row.isHistory || INLINE_TOOLS.has(row.toolName)) return;
  const entry = liveEntry(store, owner);
  if (entry.tools.some(tool => tool.toolId === row.toolId)) return;
  const { toolId, toolName, toolInput, startTime } = row;
  const tool = { id: toolId, toolId, toolName, toolInput, startTime };
  const pendingIndex = entry.pendingResults.findIndex(item => item.toolId === toolId);
  if (pendingIndex !== -1) {
    const [{ toolId: _id, ...result }] = entry.pendingResults.splice(pendingIndex, 1);
    Object.assign(tool, result);
    Object.assign(row, result);
  }
  // Newest start first, using arrival order only to break ties.
  const index = entry.tools.findIndex(item => item.startTime <= startTime);
  entry.tools.splice(index < 0 ? entry.tools.length : index, 0, tool);
  if (entry.tools.length > MAX_CALLS_PER_EXECUTION) entry.tools.pop();
}

export function applyToolResult(row, result) {
  row.hasResult = true;
  const content = result.content ?? result;
  row.toolResult = result.is_update && row.toolResult ? `${row.toolResult}\n\n${content}` : content;
  if (typeof result.is_error === 'boolean') row.isError = result.is_error;
}

export function recordLiveSessionToolResult(store, owner, toolId, result) {
  if (!toolId) return;
  const entry = liveEntry(store, owner);
  const tool = entry.tools.find(row => row.toolId === toolId);
  if (tool) {
    applyToolResult(tool, result);
    return;
  }
  // On reconnect a result can arrive before its buffered call. Remember it
  // under the exact ID without creating a row or completing a sibling.
  const index = entry.pendingResults.findIndex(item => item.toolId === toolId);
  const pending = index < 0 ? { toolId } : entry.pendingResults.splice(index, 1)[0];
  applyToolResult(pending, result);
  entry.pendingResults.unshift(pending);
  if (entry.pendingResults.length > MAX_CALLS_PER_EXECUTION) entry.pendingResults.pop();
}

export function clearLiveSessionTools(store, { agentId, conversationId, turnIds } = {}) {
  for (const [key, owner] of Object.entries(store.yeaftLiveToolExecutions || {})) {
    if ((!agentId || owner.agentId === agentId) && (!conversationId || owner.conversationId === conversationId)
        && (!turnIds || turnIds.has(owner.turnId))) delete store.yeaftLiveToolExecutions[key];
  }
}

/** A fresh runtime owner is required to display cached calls after reconnect. */
export function liveSessionToolsByExecution(store, scope, liveExecutionKeys) {
  const toolsByExecution = new Map();
  for (const key of liveExecutionKeys) {
    const tools = store.yeaftLiveToolExecutions?.[scopeKey(scope, key)]?.tools;
    if (tools?.length) toolsByExecution.set(key, tools);
  }
  return toolsByExecution;
}
