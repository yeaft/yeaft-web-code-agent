import { stmts, transaction } from './connection.js';

export function validScheduledTaskReceiptIdentity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function reject(code, message) {
  throw Object.assign(new Error(message), { code });
}

/** Server-owned, exact-run receipts; no Agent runtime/configuration is written. */
export const scheduledTaskReceiptDb = {
  getByUser(userId) {
    if (!validScheduledTaskReceiptIdentity(userId)) return [];
    return stmts.getScheduledTaskReceiptsByUser.all(userId).map(row => ({
      agentId: row.agent_id, sessionId: row.session_id, runId: row.run_id,
    }));
  },

  has(userId, agentId, sessionId, runId) {
    if (![userId, agentId, sessionId, runId].every(validScheduledTaskReceiptIdentity)) return false;
    return !!stmts.getScheduledTaskReceipt.get(userId, agentId, sessionId, runId);
  },

  /** Validate the entire batch and persisted ownership before inserting anything. */
  markRead(userId, receipts) {
    if (!validScheduledTaskReceiptIdentity(userId)
        || stmts.getUserById.get(userId)?.deletion_state !== 'active') {
      reject('authentication_required', 'An active authenticated user is required');
    }
    if (!Array.isArray(receipts) || receipts.length === 0 || receipts.length > 100) {
      reject('invalid_scheduled_task_receipts', 'Expected between 1 and 100 receipts');
    }
    const unique = new Map();
    for (const receipt of receipts) {
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
          || ![receipt.agentId, receipt.sessionId, receipt.runId].every(validScheduledTaskReceiptIdentity)) {
        reject('invalid_scheduled_task_receipts', 'Each receipt requires explicit Agent, Session and Run identities');
      }
      const { agentId, sessionId, runId } = receipt;
      const projected = { agentId, sessionId, runId };
      unique.set(JSON.stringify([agentId, sessionId, runId]), projected);
    }
    const batch = [...unique.values()];
    return transaction(() => {
      // Catalog ownership is authoritative even when the Agent is offline. Do
      // not require lastRun equality: an older run may be read after a new run.
      for (const { agentId, sessionId } of batch) {
        if (!stmts.getYeaftSessionForAgent.get(sessionId, userId, agentId)) {
          reject('session_access_denied', 'Session not found or access denied');
        }
      }
      for (const { agentId, sessionId, runId } of batch) {
        stmts.insertScheduledTaskReceipt.run(userId, agentId, sessionId, runId);
      }
      return batch;
    })();
  },
};
