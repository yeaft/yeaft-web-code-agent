import { createHash } from 'crypto';

/** Stable evidence reference; liveness/status changes alone do not create new evidence. */
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
