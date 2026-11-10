import { webClients } from '../context.js';
import { scheduledTaskReceiptDb } from '../database.js';
import { validScheduledTaskReceiptIdentity } from '../db/scheduled-task-receipt-db.js';
import { sendToWebClient } from '../ws-utils.js';

/** Account-wide read state never depends on currentAgent or an online socket. */
export async function handleClientScheduledTaskReceipts(client, msg) {
  if (msg.type !== 'scheduled_task_notifications_read') return false;
  const requestId = validScheduledTaskReceiptIdentity(msg.requestId) ? msg.requestId : null;
  let receipts;
  try {
    if (!client?.authenticated || !client.userId) {
      throw Object.assign(new Error('Authentication required'), { code: 'authentication_required' });
    }
    if (Object.hasOwn(msg, 'requestId') && !requestId) {
      throw Object.assign(new Error('Invalid requestId'), { code: 'invalid_scheduled_task_receipts' });
    }
    if (Object.hasOwn(msg, 'sessionRead') && typeof msg.sessionRead !== 'boolean') {
      throw Object.assign(new Error('sessionRead must be a boolean'), { code: 'invalid_scheduled_task_receipts' });
    }
    receipts = scheduledTaskReceiptDb.markRead(client.userId, msg.receipts, { sessionRead: msg.sessionRead, sessions: msg.sessions });
  } catch (error) {
    await sendToWebClient(client, {
      type: 'error', code: error.code || 'scheduled_task_receipts_failed',
      message: error.code ? error.message : 'Failed to persist Task notification read receipts',
      ...(requestId ? { requestId } : {}),
    });
    return true;
  }
  const payload = {
    type: 'scheduled_task_notifications_read', receipts,
    ...(requestId ? { requestId } : {}),
  };
  for (const [, target] of webClients) {
    // Intentionally no skipAuth bypass: receipts must never cross accounts.
    if (!target?.authenticated || target.userId !== client.userId) continue;
    try {
      await sendToWebClient(target, payload);
    } catch (error) {
      // A stale tab must not prevent the remaining same-user tabs receiving it.
      console.warn('[Server] Task receipt broadcast failed:', error.message);
    }
  }
  return true;
}
