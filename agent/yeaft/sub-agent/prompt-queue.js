import { snapshotEffortDecision } from '../effort.js';

/**
 * Queue a sub-agent continuation with the Project context that is authoritative
 * for the parent turn which submitted it. Keeping the snapshot on the queue
 * entry preserves ordering when multiple continuations are submitted before
 * the child consumes them. Empty values are an explicit Project-context clear.
 *
 * @param {object} agent
 * @param {string} prompt
 * @param {{ projectSessionIds?: string[], projectLabel?: string, projectInstruction?: string }} projectContext
 */
export function enqueueSubAgentPrompt(agent, prompt, projectContext = {}) {
  // Reserve the original delegation identity, but stop reusing its mutable
  // evidence as soon as follow-up work is accepted (even before it runs).
  agent.delegationSuperseded = true;
  if (!Array.isArray(agent.pendingPrompts)) agent.pendingPrompts = [];
  agent.pendingPrompts.push({
    prompt,
    parentEffortDecision: snapshotEffortDecision(projectContext.parentEffortDecision),
    projectSessionIds: Array.isArray(projectContext.projectSessionIds)
      ? projectContext.projectSessionIds.slice()
      : [],
    projectLabel: typeof projectContext.projectLabel === 'string'
      ? projectContext.projectLabel
      : '',
    projectInstruction: typeof projectContext.projectInstruction === 'string'
      ? projectContext.projectInstruction
      : '',
  });
}
