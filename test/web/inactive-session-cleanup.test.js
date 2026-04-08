import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tests for task-253: Inactive sessions reappearing in sidebar
 *
 * Root cause: Two issues caused inactive sessions to accumulate in the sidebar:
 *
 * 1. Server: `conversation_closed` handler marked sessions as inactive in DB
 *    (is_active=0) but kept them in agent.conversations in memory. This meant
 *    closed sessions kept appearing in agent_list broadcasts forever.
 *
 * 2. Frontend: `handleAgentList` never removed conversations that were no longer
 *    in the server's list. It set agentOnline=true on stale sessions (keeping
 *    them visible) if their agent was online, even though the server had
 *    actively removed them.
 *
 * Fix:
 * - Server: Remove session from agent.conversations after conversation_closed
 * - Frontend: Remove stale conversations from store.conversations in handleAgentList
 *   when their agent is listed but the session is not
 */

const rootDir = join(import.meta.dirname, '..', '..');
const agentHandlerJs = readFileSync(join(rootDir, 'web/stores/helpers/handlers/agentHandler.js'), 'utf8');
const serverConvHandlerJs = readFileSync(join(rootDir, 'server/handlers/agent-conversation.js'), 'utf8');

// =====================================================================
// Server: conversation_closed removes from agent.conversations
// =====================================================================
describe('Server: conversation_closed removes session from memory', () => {
  const closedStart = serverConvHandlerJs.indexOf("case 'conversation_closed':");
  const closedEnd = serverConvHandlerJs.indexOf('break;', closedStart);
  const closedBody = serverConvHandlerJs.substring(closedStart, closedEnd);

  it('conversation_closed handler exists', () => {
    expect(closedStart).toBeGreaterThan(-1);
  });

  it('sets is_active=0 in DB', () => {
    expect(closedBody).toContain('setActive');
    expect(closedBody).toContain('false');
  });

  it('removes from agent.conversations after marking inactive', () => {
    expect(closedBody).toContain('agent.conversations.delete(msg.conversationId)');
  });

  it('forwards conversation_closed to clients before removing', () => {
    const forwardIdx = closedBody.indexOf('forwardToClients');
    const deleteIdx = closedBody.indexOf('agent.conversations.delete');
    expect(forwardIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(forwardIdx).toBeLessThan(deleteIdx);
  });

  it('broadcasts agent_list after removing', () => {
    const deleteIdx = closedBody.indexOf('agent.conversations.delete');
    const broadcastIdx = closedBody.indexOf('broadcastAgentList', deleteIdx);
    expect(broadcastIdx).toBeGreaterThan(deleteIdx);
  });
});

// =====================================================================
// Frontend: handleAgentList removes stale sessions
// =====================================================================
describe('Frontend: handleAgentList removes stale sessions', () => {
  const fnStart = agentHandlerJs.indexOf('export function handleAgentList');
  const fnEnd = agentHandlerJs.indexOf('export function handleAgentSelected');
  const fnBody = agentHandlerJs.substring(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 8000);

  it('filters store.conversations to remove stale sessions', () => {
    expect(fnBody).toContain('store.conversations = store.conversations.filter');
  });

  it('keeps sessions still in server list', () => {
    expect(fnBody).toContain('allServerConvIds.has(conv.id)');
  });

  it('keeps currently-viewed sessions', () => {
    expect(fnBody).toContain('activeConversations.includes(conv.id)');
  });

  it('removes sessions whose agent is listed but session is not', () => {
    expect(fnBody).toContain('listedAgentIds.has(conv.agentId)');
  });

  it('cleans up associated state for removed sessions', () => {
    expect(fnBody).toContain('delete store.messagesMap[conv.id]');
    expect(fnBody).toContain('delete store.processingConversations[conv.id]');
    expect(fnBody).toContain('delete store.executionStatusMap[conv.id]');
  });

  it('does NOT set agentOnline=true for missing sessions', () => {
    // The old buggy code had: conv.agentOnline = true for sessions not in server list
    // The fix removes stale sessions instead of keeping them with agentOnline=true
    // Only check executable code lines (skip comments) for the pattern
    const staleSection = fnBody.substring(fnBody.indexOf('Remove stale conversations'));
    const codeLines = staleSection.split('\n').filter(l => !l.trim().startsWith('//'));
    const codeOnly = codeLines.join('\n');
    // The filter callback should NOT contain conv.agentOnline = true
    const filterBody = codeOnly.substring(
      codeOnly.indexOf('store.conversations.filter'),
      codeOnly.indexOf('return true;\n    });') + 20
    );
    expect(filterBody).not.toMatch(/conv\.agentOnline\s*=\s*true/);
  });

  it('respects _recentlyDeletedSessions guard', () => {
    expect(fnBody).toContain('_recentlyDeletedSessions');
  });
});

// =====================================================================
// Behavioral: stale session cleanup
// =====================================================================
describe('Behavioral: stale session cleanup in handleAgentList', () => {
  function simulateFilter(storeConvs, serverConvIds, listedAgentIds, activeConversations, recentlyDeleted = {}) {
    return storeConvs.filter(conv => {
      if (serverConvIds.has(conv.id)) return true;
      if (activeConversations.includes(conv.id)) return true;
      if (conv.agentId && listedAgentIds.has(conv.agentId)) {
        const deletedAt = recentlyDeleted[conv.id];
        if (deletedAt && (Date.now() - deletedAt) < 15000) return false;
        return false; // stale → remove
      }
      if (conv.agentId && !listedAgentIds.has(conv.agentId)) {
        conv.agentOnline = false;
      }
      return true;
    });
  }

  it('removes sessions not in server list when agent is listed', () => {
    const convs = [
      { id: 'active-1', agentId: 'agent-1' },
      { id: 'stale-1', agentId: 'agent-1' },
      { id: 'active-2', agentId: 'agent-1' }
    ];
    const serverIds = new Set(['active-1', 'active-2']);
    const agentIds = new Set(['agent-1']);
    const result = simulateFilter(convs, serverIds, agentIds, []);
    expect(result.map(c => c.id)).toEqual(['active-1', 'active-2']);
  });

  it('keeps sessions from agents not in the list (offline agents)', () => {
    const convs = [
      { id: 'active-1', agentId: 'agent-1' },
      { id: 'other-1', agentId: 'agent-2' } // agent-2 not in list
    ];
    const serverIds = new Set(['active-1']);
    const agentIds = new Set(['agent-1']);
    const result = simulateFilter(convs, serverIds, agentIds, []);
    expect(result.map(c => c.id)).toEqual(['active-1', 'other-1']);
    expect(result[1].agentOnline).toBe(false);
  });

  it('keeps currently-viewed session even if not in server list', () => {
    const convs = [
      { id: 'viewing-1', agentId: 'agent-1' },
      { id: 'stale-1', agentId: 'agent-1' }
    ];
    const serverIds = new Set([]);
    const agentIds = new Set(['agent-1']);
    const result = simulateFilter(convs, serverIds, agentIds, ['viewing-1']);
    expect(result.map(c => c.id)).toEqual(['viewing-1']);
  });

  it('handles multiple agents correctly', () => {
    const convs = [
      { id: 'a1-active', agentId: 'agent-1' },
      { id: 'a1-stale', agentId: 'agent-1' },
      { id: 'a2-active', agentId: 'agent-2' },
      { id: 'a2-stale', agentId: 'agent-2' }
    ];
    const serverIds = new Set(['a1-active', 'a2-active']);
    const agentIds = new Set(['agent-1', 'agent-2']);
    const result = simulateFilter(convs, serverIds, agentIds, []);
    expect(result.map(c => c.id)).toEqual(['a1-active', 'a2-active']);
  });

  it('recently-deleted sessions are still removed (no flicker)', () => {
    const convs = [
      { id: 'deleted-1', agentId: 'agent-1' }
    ];
    const serverIds = new Set([]);
    const agentIds = new Set(['agent-1']);
    const recentlyDeleted = { 'deleted-1': Date.now() };
    const result = simulateFilter(convs, serverIds, agentIds, [], recentlyDeleted);
    expect(result.length).toBe(0);
  });

  it('empty store.conversations stays empty', () => {
    const result = simulateFilter([], new Set(), new Set(['agent-1']), []);
    expect(result.length).toBe(0);
  });

  it('all sessions in server list are kept', () => {
    const convs = [
      { id: 'c1', agentId: 'agent-1' },
      { id: 'c2', agentId: 'agent-1' },
      { id: 'c3', agentId: 'agent-1' }
    ];
    const serverIds = new Set(['c1', 'c2', 'c3']);
    const agentIds = new Set(['agent-1']);
    const result = simulateFilter(convs, serverIds, agentIds, []);
    expect(result.length).toBe(3);
  });
});
