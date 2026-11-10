import { stmts, transaction } from './connection.js';

export function validScheduledTaskReceiptIdentity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function reject(code, message) {
  throw Object.assign(new Error(message), { code });
}

const terminalRunStatuses = new Set(['completed', 'succeeded', 'failed', 'interrupted']);

function catalogTerminalRunId(row) {
  try {
    const run = JSON.parse(row?.task_json)?.lastRun;
    return terminalRunStatuses.has(run?.status) && validScheduledTaskReceiptIdentity(run?.id) ? run.id : null;
  } catch { return null; }
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

  /** Called with the authenticated Agent's owner, never a browser-supplied owner. */
  recordNotificationRun(userId, agentId, event) {
    if (event?.type !== 'scheduled_task_notification' || !terminalRunStatuses.has(event.status)
        || ![userId, agentId, event.sessionId, event.runId].every(validScheduledTaskReceiptIdentity)) return;
    stmts.insertScheduledTaskNotificationRun.run(userId, agentId, event.sessionId, event.runId);
  },

  /** Validate the entire batch and persisted ownership before inserting anything. */
  markRead(userId, receipts, { sessionRead = false, sessions = [] } = {}) {
    if (!validScheduledTaskReceiptIdentity(userId)
        || stmts.getUserById.get(userId)?.deletion_state !== 'active') {
      reject('authentication_required', 'An active authenticated user is required');
    }
    if (!Array.isArray(receipts) || !Array.isArray(sessions)
        || receipts.length + sessions.length === 0 || receipts.length + sessions.length > 100
        || (sessions.length > 0 && sessionRead !== true)) {
      reject('invalid_scheduled_task_receipts', 'Expected between 1 and 100 explicit Run or Session identities');
    }
    if (typeof sessionRead !== 'boolean') {
      reject('invalid_scheduled_task_receipts', 'sessionRead must be a boolean');
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
    const sessionScopes = sessions.map(session => {
      if (!session || typeof session !== 'object' || Array.isArray(session)
          || ![session.agentId, session.sessionId].every(validScheduledTaskReceiptIdentity)) {
        reject('invalid_scheduled_task_receipts', 'Each Session read requires explicit Agent and Session identities');
      }
      return { agentId: session.agentId, sessionId: session.sessionId };
    });
    return transaction(() => {
      // Catalog ownership is authoritative even when the Agent is offline. Do
      // not require lastRun equality: an older run may be read after a new run.
      const catalog = new Map();
      for (const { agentId, sessionId } of [...unique.values(), ...sessionScopes]) {
        const key = JSON.stringify([agentId, sessionId]);
        if (catalog.has(key)) continue;
        const row = stmts.getYeaftSessionForAgent.get(sessionId, userId, agentId);
        if (!row) {
          // A deleted Session's existing notice can still be clicked/dismissed.
          // Only Server-stamped exact runs prove ownership, never arbitrary IDs.
          const runs = [...unique.values()].filter(item => item.agentId === agentId && item.sessionId === sessionId);
          const explicitScope = sessionScopes.some(item => item.agentId === agentId && item.sessionId === sessionId);
          if (explicitScope || !runs.length || runs.some(item => !stmts.getScheduledTaskNotificationRun.get(userId, agentId, sessionId, item.runId))) {
            reject('session_access_denied', 'Session not found or access denied');
          }
        }
        catalog.set(key, { agentId, sessionId, row });
      }
      // Expand only to terminal runs already known at this transaction. Never
      // save a Session-wide watermark: future completions remain unread.
      if (sessionRead) {
        for (const { agentId, sessionId, row } of catalog.values()) {
          const runs = stmts.getScheduledTaskNotificationRunsForSession.all(userId, agentId, sessionId);
          const lastRunId = catalogTerminalRunId(row);
          if (lastRunId) runs.push({ run_id: lastRunId });
          for (const { run_id: runId } of runs) {
            unique.set(JSON.stringify([agentId, sessionId, runId]), { agentId, sessionId, runId });
          }
        }
      }
      const batch = [...unique.values()];
      for (const { agentId, sessionId, runId } of batch) {
        stmts.insertScheduledTaskReceipt.run(userId, agentId, sessionId, runId);
      }
      return batch;
    })();
  },
};
