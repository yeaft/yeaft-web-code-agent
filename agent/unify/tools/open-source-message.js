/**
 * open-source-message.js — task-334f R6 §Δ24.4.
 *
 * Low-level random access: given a (groupId, msgId), fetch the raw message
 * from the group's jsonl log. Used when a VP has an exact pointer but does
 * not want to run the memory_trace wrapper (5% case: audit / debug).
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'open_source_message',
  description: `Open a single source message by (groupId, msgId).

This is the low-level random-access primitive. Prefer memory_trace if you are
starting from a memory entry. Returns JSON: { message } or { error }.`,
  parameters: {
    type: 'object',
    properties: {
      groupId: { type: 'string', description: 'Group id' },
      msgId:   { type: 'string', description: 'Message id' },
    },
    required: ['groupId', 'msgId'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { groupId, msgId } = input || {};
    if (!groupId || !msgId) {
      return JSON.stringify({ error: 'groupId and msgId required' });
    }
    const coordinator = ctx?.coordinator;
    if (!coordinator || typeof coordinator.openGroup !== 'function') {
      return JSON.stringify({ error: 'group coordinator not available' });
    }
    const group = coordinator.openGroup(groupId);
    if (!group) return JSON.stringify({ error: `group not found: ${groupId}` });

    const iter = typeof group.readMessageRange === 'function'
      ? group.readMessageRange(msgId, msgId)
      : group.streamMessages();
    for (const msg of iter) {
      if (msg.id === msgId) {
        return JSON.stringify({ message: msg });
      }
    }
    return JSON.stringify({ error: `message not found: ${msgId} in ${groupId}` });
  },
});
