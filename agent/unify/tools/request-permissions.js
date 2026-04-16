/**
 * request-permissions.js — Request permission for dangerous operations.
 *
 * When an operation is flagged as destructive, this tool requests
 * explicit user permission before proceeding.
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'RequestPermissions',
  description: `Request permission from the user for a potentially dangerous operation.

Use this before executing destructive operations like:
- Deleting files or directories
- Running commands that modify system state
- Force-pushing to git
- Resetting databases

The user must explicitly approve before you proceed.`,
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        description: 'Description of the operation that needs permission',
      },
      reason: {
        type: 'string',
        description: 'Why this operation is necessary',
      },
      risk_level: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: 'Risk level of the operation',
      },
    },
    required: ['operation'],
  },
  modes: ['chat', 'work'],
  isConcurrencySafe: () => false,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { operation, reason, risk_level = 'medium' } = input;
    if (!operation) return JSON.stringify({ error: 'operation is required' });

    // In a full integration, this would use the ask_user mechanism
    // to get explicit permission. For now, return a structured request.
    return JSON.stringify({
      type: 'permission_request',
      operation,
      reason: reason || 'Operation requires explicit permission',
      riskLevel: risk_level,
      message: `⚠️ Permission required for: ${operation}` +
               (reason ? `\nReason: ${reason}` : '') +
               `\nRisk level: ${risk_level}`,
      hint: 'User must explicitly approve this operation before proceeding.',
    });
  },
});
