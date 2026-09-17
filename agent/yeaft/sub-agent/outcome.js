import { STATUS, isTerminalAgentStatus } from './status.js';

/** Lifecycle state and task outcome are separate contracts. */
export function describeAgentOutcome(agent) {
  const result = agent?.result;
  const budgetResult = result && typeof result === 'object'
    && result.status === 'budget_exceeded' ? result : null;
  if (budgetResult) {
    return {
      status: 'incomplete',
      complete: false,
      reason: 'budget_exceeded',
      truncated: Boolean(budgetResult.truncated || budgetResult.final_report?.truncated),
    };
  }
  switch (agent?.status) {
    case STATUS.COMPLETED:
      return { status: 'succeeded', complete: true, reason: null, truncated: false };
    case STATUS.FAILED:
      return { status: 'failed', complete: false, reason: 'execution_failed', truncated: false };
    case STATUS.CLOSED:
      return { status: 'cancelled', complete: false, reason: 'closed', truncated: false };
    case STATUS.ABANDONED:
      return { status: 'incomplete', complete: false, reason: 'abandoned', truncated: false };
    default:
      return { status: 'pending', complete: false, reason: null, truncated: false };
  }
}

export function describeAgentLifecycle(agent) {
  return {
    status: agent?.status || null,
    terminal: isTerminalAgentStatus(agent?.status),
  };
}
