import { createHash } from 'crypto';

/** Reference to the agent's current reply, not its initial delegation; liveness/status alone do not change it. */
export function getAgentResultRef(agent) {
  const evidence = JSON.stringify({
    result: agent.result ?? null,
    preview: agent.lastResult || '',
    finalReport: agent.finalReport || null,
    error: agent.error || null,
  });
  const hash = createHash('sha256').update(evidence).digest('hex').slice(0, 16);
  return `${agent.id}:${agent.resultRevision || 0}:${hash}`;
}
