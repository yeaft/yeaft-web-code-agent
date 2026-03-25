import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Tests for client-conductor.js WebSocket message handler.
 *
 * Replicates the handleClientConductor switch logic to test all
 * client message type branches without importing server dependencies.
 */

// =====================================================================
// Replicate handler logic for isolated testing
// =====================================================================

function createMockClient(overrides = {}) {
  return {
    currentAgent: overrides.currentAgent || null,
    userId: overrides.userId || 'user-1',
    username: overrides.username || 'alice'
  };
}

function createCallTracker() {
  const calls = [];
  return {
    sendToWebClient: async (client, msg) => {
      calls.push({ fn: 'sendToWebClient', client, msg });
    },
    forwardToAgent: async (agentId, msg) => {
      calls.push({ fn: 'forwardToAgent', agentId, msg });
    },
    calls
  };
}

function createMockAgents(entries = {}) {
  return {
    get: (id) => entries[id] || undefined,
    has: (id) => id in entries
  };
}

async function handleClientConductor(clientId, client, msg, checkAgentAccess, agents, tracker) {
  switch (msg.type) {
    case 'create_conductor_session': {
      const agentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(agentId)) break;
      const agent = agents.get(agentId);
      if (!agent) {
        await tracker.sendToWebClient(client, { type: 'error', message: 'Agent not found' });
        break;
      }
      client.currentAgent = agentId;
      await tracker.forwardToAgent(agentId, {
        type: 'create_conductor_session',
        sessionId: msg.sessionId || 'generated-uuid',
        name: msg.name || '',
        workDir: msg.workDir || null,
        scenarioId: msg.scenarioId || null,
        userId: client.userId,
        username: client.username
      });
      break;
    }

    case 'conductor_user_input': {
      const agentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(agentId)) break;
      await tracker.forwardToAgent(agentId, {
        type: 'conductor_user_input',
        sessionId: msg.sessionId,
        content: msg.content
      });
      break;
    }

    case 'conductor_update_workdir': {
      const agentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(agentId)) break;
      await tracker.forwardToAgent(agentId, {
        type: 'conductor_update_workdir',
        sessionId: msg.sessionId,
        workDir: msg.workDir
      });
      break;
    }

    case 'list_conductor_sessions': {
      const agentId = msg.agentId || client.currentAgent;
      if (!agentId) break;
      if (!await checkAgentAccess(agentId)) break;
      await tracker.forwardToAgent(agentId, {
        type: 'list_conductor_sessions',
        requestId: msg.requestId,
        _requestClientId: clientId
      });
      break;
    }

    case 'resume_conductor_session': {
      const agentId = msg.agentId || client.currentAgent;
      if (!await checkAgentAccess(agentId)) break;
      client.currentAgent = agentId;
      await tracker.forwardToAgent(agentId, {
        type: 'resume_conductor_session',
        sessionId: msg.sessionId,
        userId: client.userId,
        username: client.username
      });
      break;
    }

    case 'update_conductor_session': {
      const agentId = msg.agentId || client.currentAgent;
      if (!agentId) break;
      if (!await checkAgentAccess(agentId)) break;
      await tracker.forwardToAgent(agentId, {
        type: 'update_conductor_session',
        sessionId: msg.sessionId,
        name: msg.name,
        workDir: msg.workDir
      });
      break;
    }

    case 'stop_conductor_session': {
      const agentId = msg.agentId || client.currentAgent;
      if (!agentId) break;
      if (!await checkAgentAccess(agentId)) break;
      await tracker.forwardToAgent(agentId, {
        type: 'stop_conductor_session',
        sessionId: msg.sessionId
      });
      break;
    }

    case 'clear_conductor_session': {
      const agentId = msg.agentId || client.currentAgent;
      if (!agentId) break;
      if (!await checkAgentAccess(agentId)) break;
      await tracker.forwardToAgent(agentId, {
        type: 'clear_conductor_session',
        sessionId: msg.sessionId
      });
      break;
    }

    case 'delete_conductor_session': {
      const agentId = msg.agentId || client.currentAgent;
      if (!agentId) break;
      if (!await checkAgentAccess(agentId)) break;
      await tracker.forwardToAgent(agentId, {
        type: 'delete_conductor_session',
        sessionId: msg.sessionId
      });
      break;
    }

    case 'conductor_load_history': {
      const agentId = msg.agentId || client.currentAgent;
      if (!agentId) break;
      if (!await checkAgentAccess(agentId)) break;
      await tracker.forwardToAgent(agentId, {
        type: 'conductor_load_history',
        sessionId: msg.sessionId,
        shardIndex: msg.shardIndex,
        requestId: msg.requestId
      });
      break;
    }

    default:
      return false;
  }
  return true;
}

// =====================================================================
// Tests
// =====================================================================

describe('handleClientConductor', () => {
  let client, tracker, agents;
  const clientId = 'client-test-1';
  const checkAccess = async () => true;
  const denyAccess = async () => false;

  beforeEach(() => {
    client = createMockClient({ currentAgent: 'agent-1' });
    tracker = createCallTracker();
    agents = createMockAgents({ 'agent-1': { name: 'Test Agent' } });
  });

  describe('create_conductor_session', () => {
    it('should forward create request to agent', async () => {
      const msg = {
        type: 'create_conductor_session',
        sessionId: 'cs-new',
        name: 'My Session',
        workDir: '/project',
        scenarioId: 'dev'
      };

      await handleClientConductor(clientId, client, msg, checkAccess, agents, tracker);

      expect(tracker.calls).toHaveLength(1);
      expect(tracker.calls[0].fn).toBe('forwardToAgent');
      expect(tracker.calls[0].agentId).toBe('agent-1');
      expect(tracker.calls[0].msg.type).toBe('create_conductor_session');
      expect(tracker.calls[0].msg.sessionId).toBe('cs-new');
      expect(tracker.calls[0].msg.userId).toBe('user-1');
      expect(tracker.calls[0].msg.username).toBe('alice');
    });

    it('should use msg.agentId if provided', async () => {
      const msg = {
        type: 'create_conductor_session',
        agentId: 'agent-2',
        sessionId: 'cs-a2'
      };
      const agentsWithTwo = createMockAgents({
        'agent-1': { name: 'A1' },
        'agent-2': { name: 'A2' }
      });

      await handleClientConductor(clientId, client, msg, checkAccess, agentsWithTwo, tracker);
      expect(tracker.calls[0].agentId).toBe('agent-2');
      expect(client.currentAgent).toBe('agent-2');
    });

    it('should send error if agent not found', async () => {
      const msg = {
        type: 'create_conductor_session',
        agentId: 'non-existent'
      };
      const emptyAgents = createMockAgents({});

      await handleClientConductor(clientId, client, msg, checkAccess, emptyAgents, tracker);
      expect(tracker.calls[0].fn).toBe('sendToWebClient');
      expect(tracker.calls[0].msg.type).toBe('error');
      expect(tracker.calls[0].msg.message).toBe('Agent not found');
    });

    it('should not forward if access denied', async () => {
      const msg = { type: 'create_conductor_session' };
      await handleClientConductor(clientId, client, msg, denyAccess, agents, tracker);
      expect(tracker.calls).toHaveLength(0);
    });

    it('should generate sessionId if not provided', async () => {
      const msg = { type: 'create_conductor_session' };
      await handleClientConductor(clientId, client, msg, checkAccess, agents, tracker);
      expect(tracker.calls[0].msg.sessionId).toBe('generated-uuid');
    });

    it('should default name, workDir, scenarioId when not provided', async () => {
      const msg = { type: 'create_conductor_session' };
      await handleClientConductor(clientId, client, msg, checkAccess, agents, tracker);
      const forwarded = tracker.calls[0].msg;
      expect(forwarded.name).toBe('');
      expect(forwarded.workDir).toBeNull();
      expect(forwarded.scenarioId).toBeNull();
    });
  });

  describe('conductor_user_input', () => {
    it('should forward user input to agent', async () => {
      const msg = {
        type: 'conductor_user_input',
        sessionId: 'cs-1',
        content: '帮我创建一个搜索功能'
      };

      await handleClientConductor(clientId, client, msg, checkAccess, agents, tracker);
      expect(tracker.calls[0].msg.type).toBe('conductor_user_input');
      expect(tracker.calls[0].msg.content).toBe('帮我创建一个搜索功能');
    });

    it('should not forward if access denied', async () => {
      const msg = { type: 'conductor_user_input', sessionId: 's1', content: 'hi' };
      await handleClientConductor(clientId, client, msg, denyAccess, agents, tracker);
      expect(tracker.calls).toHaveLength(0);
    });
  });

  describe('conductor_update_workdir', () => {
    it('should forward workdir update to agent', async () => {
      const msg = {
        type: 'conductor_update_workdir',
        sessionId: 'cs-1',
        workDir: '/new/path'
      };

      await handleClientConductor(clientId, client, msg, checkAccess, agents, tracker);
      expect(tracker.calls[0].msg.type).toBe('conductor_update_workdir');
      expect(tracker.calls[0].msg.workDir).toBe('/new/path');
    });
  });

  describe('list_conductor_sessions', () => {
    it('should forward list request with requestId and clientId', async () => {
      const msg = {
        type: 'list_conductor_sessions',
        requestId: 'req-123'
      };

      await handleClientConductor(clientId, client, msg, checkAccess, agents, tracker);
      expect(tracker.calls[0].msg.type).toBe('list_conductor_sessions');
      expect(tracker.calls[0].msg.requestId).toBe('req-123');
      expect(tracker.calls[0].msg._requestClientId).toBe('client-test-1');
    });

    it('should not forward if no agentId available', async () => {
      const noAgentClient = createMockClient({ currentAgent: null });
      const msg = { type: 'list_conductor_sessions' };

      await handleClientConductor(clientId, noAgentClient, msg, checkAccess, agents, tracker);
      expect(tracker.calls).toHaveLength(0);
    });
  });

  describe('resume_conductor_session', () => {
    it('should forward resume request with user info', async () => {
      const msg = {
        type: 'resume_conductor_session',
        sessionId: 'cs-resume'
      };

      await handleClientConductor(clientId, client, msg, checkAccess, agents, tracker);
      expect(tracker.calls[0].msg.type).toBe('resume_conductor_session');
      expect(tracker.calls[0].msg.sessionId).toBe('cs-resume');
      expect(tracker.calls[0].msg.userId).toBe('user-1');
      expect(tracker.calls[0].msg.username).toBe('alice');
    });

    it('should update client.currentAgent', async () => {
      const msg = {
        type: 'resume_conductor_session',
        agentId: 'agent-2',
        sessionId: 'cs-r'
      };

      await handleClientConductor(clientId, client, msg, checkAccess, agents, tracker);
      expect(client.currentAgent).toBe('agent-2');
    });
  });

  describe('update_conductor_session', () => {
    it('should forward update with name and workDir', async () => {
      const msg = {
        type: 'update_conductor_session',
        sessionId: 'cs-1',
        name: 'New Name',
        workDir: '/updated'
      };

      await handleClientConductor(clientId, client, msg, checkAccess, agents, tracker);
      const forwarded = tracker.calls[0].msg;
      expect(forwarded.name).toBe('New Name');
      expect(forwarded.workDir).toBe('/updated');
    });

    it('should not forward if no agentId', async () => {
      const noAgentClient = createMockClient({ currentAgent: null });
      const msg = { type: 'update_conductor_session', sessionId: 'cs-1' };

      await handleClientConductor(clientId, noAgentClient, msg, checkAccess, agents, tracker);
      expect(tracker.calls).toHaveLength(0);
    });
  });

  describe('stop_conductor_session', () => {
    it('should forward stop request', async () => {
      const msg = { type: 'stop_conductor_session', sessionId: 'cs-stop' };
      await handleClientConductor(clientId, client, msg, checkAccess, agents, tracker);
      expect(tracker.calls[0].msg.type).toBe('stop_conductor_session');
      expect(tracker.calls[0].msg.sessionId).toBe('cs-stop');
    });

    it('should not forward if no agentId', async () => {
      const noAgentClient = createMockClient({ currentAgent: null });
      const msg = { type: 'stop_conductor_session', sessionId: 'cs-stop' };
      await handleClientConductor(clientId, noAgentClient, msg, checkAccess, agents, tracker);
      expect(tracker.calls).toHaveLength(0);
    });
  });

  describe('clear_conductor_session', () => {
    it('should forward clear request', async () => {
      const msg = { type: 'clear_conductor_session', sessionId: 'cs-clear' };
      await handleClientConductor(clientId, client, msg, checkAccess, agents, tracker);
      expect(tracker.calls[0].msg.type).toBe('clear_conductor_session');
    });
  });

  describe('delete_conductor_session', () => {
    it('should forward delete request', async () => {
      const msg = { type: 'delete_conductor_session', sessionId: 'cs-del' };
      await handleClientConductor(clientId, client, msg, checkAccess, agents, tracker);
      expect(tracker.calls[0].msg.type).toBe('delete_conductor_session');
    });
  });

  describe('conductor_load_history', () => {
    it('should forward history load request with shard info', async () => {
      const msg = {
        type: 'conductor_load_history',
        sessionId: 'cs-hist',
        shardIndex: 2,
        requestId: 'req-hist'
      };

      await handleClientConductor(clientId, client, msg, checkAccess, agents, tracker);
      const forwarded = tracker.calls[0].msg;
      expect(forwarded.type).toBe('conductor_load_history');
      expect(forwarded.shardIndex).toBe(2);
      expect(forwarded.requestId).toBe('req-hist');
    });

    it('should not forward if no agentId', async () => {
      const noAgentClient = createMockClient({ currentAgent: null });
      const msg = { type: 'conductor_load_history', sessionId: 'cs-1' };
      await handleClientConductor(clientId, noAgentClient, msg, checkAccess, agents, tracker);
      expect(tracker.calls).toHaveLength(0);
    });
  });

  describe('unknown message type', () => {
    it('should return false for unhandled type', async () => {
      const msg = { type: 'unknown_client_type' };
      const result = await handleClientConductor(clientId, client, msg, checkAccess, agents, tracker);
      expect(result).toBe(false);
      expect(tracker.calls).toHaveLength(0);
    });
  });

  describe('all client message types are handled', () => {
    const expectedTypes = [
      'create_conductor_session',
      'conductor_user_input',
      'conductor_update_workdir',
      'list_conductor_sessions',
      'resume_conductor_session',
      'update_conductor_session',
      'stop_conductor_session',
      'clear_conductor_session',
      'delete_conductor_session',
      'conductor_load_history'
    ];

    for (const type of expectedTypes) {
      it(`should handle ${type}`, async () => {
        const msg = { type, sessionId: 'test-session', content: 'test' };
        const result = await handleClientConductor(clientId, client, msg, checkAccess, agents, tracker);
        expect(result).toBe(true);
      });
    }
  });

  describe('access control', () => {
    const typesRequiringAccess = [
      'create_conductor_session',
      'conductor_user_input',
      'conductor_update_workdir',
      'resume_conductor_session'
    ];

    for (const type of typesRequiringAccess) {
      it(`should block ${type} when access denied`, async () => {
        const msg = { type, sessionId: 'cs-1', content: 'test' };
        await handleClientConductor(clientId, client, msg, denyAccess, agents, tracker);
        // No forward should happen
        const forwards = tracker.calls.filter(c => c.fn === 'forwardToAgent');
        expect(forwards).toHaveLength(0);
      });
    }
  });
});
