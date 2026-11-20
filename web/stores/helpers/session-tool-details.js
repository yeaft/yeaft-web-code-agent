import { userTurnExcerpt } from '../../utils/concurrent-user-turns.js';
import { sessionExecutionKey } from './session-activity.js';

// These are user-facing content rather than internal calls: keep the
// interactive question, checklist and hand-off in the transcript.
const INLINE_TOOLS = new Set(['AskUser', 'AskUserQuestion', 'TodoWrite', 'RouteForward']);

/** Group the same authorized tool rows the transcript already receives. Do not
 * fetch raw logs or infer legacy ownership from the nearest prompt: concurrent
 * or paginated history can put an unrelated prompt immediately before a call. */
export function sessionToolGroups(messages, { agentId, sessionId }) {
  const prompts = new Map();
  const promptByExecution = new Map();
  const groups = new Map();
  for (const row of messages) {
    if (!row || (row.sessionId ?? row.groupId) !== sessionId || (row.agentId && row.agentId !== agentId)) continue;
    if (row.type === 'user' && row.turnRelation !== 'supplement') {
      const label = userTurnExcerpt(row);
      if (label) {
        for (const id of [row.userTurnId, row.id, row.messageId, row.clientMessageId]) {
          if (id && !prompts.has(id)) prompts.set(id, label);
        }
        if (row.turnId && row.turnId !== row.id) promptByExecution.set(row.turnId, label);
      }
    }
    if (row.type !== 'tool-use' || !row.toolName || INLINE_TOOLS.has(row.toolName)) continue;
    const knownExecution = row.turnId && (!row.isHistory || row._hasPersistedTurnId === true);
    const executionKey = knownExecution ? sessionExecutionKey(row) : '';
    const key = row.userTurnId ? `user:${row.userTurnId}`
      : executionKey ? `engine:${executionKey}` : 'legacy';
    if (!groups.has(key)) groups.set(key, { key, userTurnId: row.userTurnId, turnId: knownExecution ? row.turnId : null, tools: [] });
    groups.get(key).tools.push({ row, executionKey });
  }
  return [...groups.values()].map(group => ({ ...group, label: prompts.get(group.userTurnId) || promptByExecution.get(group.turnId) || '' })).reverse();
}
