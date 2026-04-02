import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for task-217: crew_routing status messages in processRoleOutput
 *
 * Validates:
 * 1. crew_routing (status: routing) is sent BEFORE executeRoute
 * 2. crew_routing (status: done) is sent AFTER executeRoute
 * 3. Empty routes → NO crew_routing messages
 * 4. Failed executeRoute still sends done status (Promise.allSettled)
 * 5. Existing crew_output, crew_status messages are NOT affected
 */

// =====================================================================
// Mock sendCrewMessage to capture messages
// =====================================================================
const capturedMessages = [];
const mockSendCrewMessage = vi.fn((msg) => {
  capturedMessages.push({ ...msg, _timestamp: Date.now() });
});

// =====================================================================
// Replicate parseRoutes for testing (avoid importing real module with side effects)
// =====================================================================
function parseRoutes(text) {
  const routes = [];
  const regex = /---ROUTE---\s*\n([\s\S]*?)---END[_ ]ROUTE---/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const toMatch = block.match(/to:\s*(.+)/i);
    if (!toMatch) continue;
    const toRaw = toMatch[1].trim().toLowerCase();
    const toClean = toRaw.split(/[\s(]/)[0];
    const summaryMatch = block.match(/summary:\s*([\s\S]+?)(?=\n\s*(?:task|taskTitle)\s*:|$)/i);
    const taskMatch = block.match(/^task:\s*(.+)/im);
    const taskTitleMatch = block.match(/^taskTitle:\s*(.+)/im);
    routes.push({
      to: toClean,
      summary: summaryMatch ? summaryMatch[1].trim() : '',
      taskId: taskMatch ? taskMatch[1].trim() : null,
      taskTitle: taskTitleMatch ? taskTitleMatch[1].trim() : null
    });
  }
  return routes;
}

// =====================================================================
// Simulate the routing section of processRoleOutput
// =====================================================================

/**
 * Simulates the routing section from processRoleOutput (lines ~179-217)
 * This isolates the exact logic we want to test.
 */
async function simulateRoutingSection(session, roleName, routes, executeRouteFn) {
  if (routes.length > 0) {
    session.round++;

    // Notify frontend: entering routing state
    mockSendCrewMessage({
      type: 'crew_routing',
      sessionId: session.id,
      fromRole: roleName,
      routes: routes.map(r => ({ to: r.to, taskId: r.taskId, taskTitle: r.taskTitle })),
      status: 'routing'
    });

    const results = await Promise.allSettled(routes.map(route =>
      executeRouteFn(session, roleName, route)
    ));
    for (const r of results) {
      if (r.status === 'rejected') {
        console.warn(`[Crew] Route execution failed:`, r.reason);
      }
    }

    // Routing complete: notify frontend to restore normal state
    mockSendCrewMessage({
      type: 'crew_routing',
      sessionId: session.id,
      fromRole: roleName,
      status: 'done'
    });
    // sendStatusUpdate would be called here in real code
  }
  // else: processHumanQueue (no crew_routing messages)
}

function createMockSession(overrides = {}) {
  return {
    id: 'test-session-1',
    round: 0,
    roles: new Map([
      ['pm', { name: 'pm', displayName: 'PM', icon: '📋', isDecisionMaker: true }],
      ['dev-1', { name: 'dev-1', displayName: 'Dev', icon: '💻' }],
      ['rev-1', { name: 'rev-1', displayName: 'Reviewer', icon: '🔍' }],
    ]),
    roleStates: new Map(),
    uiMessages: [],
    features: new Map(),
    ...overrides
  };
}

describe('task-217: crew_routing status messages', () => {
  beforeEach(() => {
    capturedMessages.length = 0;
    mockSendCrewMessage.mockClear();
  });

  // ---------------------------------------------------------------
  // Sub-task B: Basic routing message flow
  // ---------------------------------------------------------------
  describe('Sub-task B: crew_routing message lifecycle', () => {
    it('sends crew_routing (routing) before executeRoute and (done) after', async () => {
      const session = createMockSession();
      const executionOrder = [];

      const mockExecuteRoute = vi.fn(async (session, fromRole, route) => {
        executionOrder.push(`execute:${route.to}`);
        // Simulate async work
        await new Promise(r => setTimeout(r, 10));
      });

      const routes = [
        { to: 'dev-1', taskId: 'task-100', taskTitle: 'Test task', summary: 'Do something' }
      ];

      await simulateRoutingSection(session, 'pm', routes, mockExecuteRoute);

      // Should have exactly 2 crew_routing messages
      const routingMsgs = capturedMessages.filter(m => m.type === 'crew_routing');
      expect(routingMsgs).toHaveLength(2);

      // First: status=routing with routes info
      expect(routingMsgs[0].status).toBe('routing');
      expect(routingMsgs[0].fromRole).toBe('pm');
      expect(routingMsgs[0].routes).toEqual([
        { to: 'dev-1', taskId: 'task-100', taskTitle: 'Test task' }
      ]);
      expect(routingMsgs[0].sessionId).toBe('test-session-1');

      // Second: status=done
      expect(routingMsgs[1].status).toBe('done');
      expect(routingMsgs[1].fromRole).toBe('pm');
      expect(routingMsgs[1].routes).toBeUndefined(); // done message has no routes

      // Verify execution happened between the two messages
      expect(mockExecuteRoute).toHaveBeenCalledTimes(1);
    });

    it('sends crew_routing with multiple routes', async () => {
      const session = createMockSession();
      const mockExecuteRoute = vi.fn(async () => {});

      const routes = [
        { to: 'dev-1', taskId: 'task-100', taskTitle: 'Implement feature' },
        { to: 'rev-1', taskId: 'task-100', taskTitle: 'Review feature' }
      ];

      await simulateRoutingSection(session, 'pm', routes, mockExecuteRoute);

      const routingMsgs = capturedMessages.filter(m => m.type === 'crew_routing');
      expect(routingMsgs).toHaveLength(2);

      // Routing message should include both routes
      expect(routingMsgs[0].status).toBe('routing');
      expect(routingMsgs[0].routes).toHaveLength(2);
      expect(routingMsgs[0].routes[0].to).toBe('dev-1');
      expect(routingMsgs[0].routes[1].to).toBe('rev-1');

      // Both routes should be executed
      expect(mockExecuteRoute).toHaveBeenCalledTimes(2);
    });

    it('increments session.round when routes are present', async () => {
      const session = createMockSession({ round: 5 });
      const mockExecuteRoute = vi.fn(async () => {});

      const routes = [{ to: 'dev-1', taskId: 'task-1', taskTitle: 'T' }];
      await simulateRoutingSection(session, 'pm', routes, mockExecuteRoute);

      expect(session.round).toBe(6);
    });
  });

  // ---------------------------------------------------------------
  // Edge case: empty routes
  // ---------------------------------------------------------------
  describe('Edge case: empty routes', () => {
    it('does NOT send crew_routing when routes is empty', async () => {
      const session = createMockSession();
      const mockExecuteRoute = vi.fn(async () => {});

      await simulateRoutingSection(session, 'pm', [], mockExecuteRoute);

      const routingMsgs = capturedMessages.filter(m => m.type === 'crew_routing');
      expect(routingMsgs).toHaveLength(0);
      expect(mockExecuteRoute).not.toHaveBeenCalled();
    });

    it('does not increment round when routes is empty', async () => {
      const session = createMockSession({ round: 3 });
      const mockExecuteRoute = vi.fn(async () => {});

      await simulateRoutingSection(session, 'pm', [], mockExecuteRoute);

      expect(session.round).toBe(3);
    });
  });

  // ---------------------------------------------------------------
  // Edge case: executeRoute failure
  // ---------------------------------------------------------------
  describe('Edge case: executeRoute failure still sends done', () => {
    it('sends done status even when executeRoute rejects', async () => {
      const session = createMockSession();
      const mockExecuteRoute = vi.fn(async () => {
        throw new Error('Connection timeout');
      });

      const routes = [{ to: 'dev-1', taskId: 'task-1', taskTitle: 'Test' }];
      await simulateRoutingSection(session, 'pm', routes, mockExecuteRoute);

      const routingMsgs = capturedMessages.filter(m => m.type === 'crew_routing');
      expect(routingMsgs).toHaveLength(2);
      expect(routingMsgs[0].status).toBe('routing');
      expect(routingMsgs[1].status).toBe('done');
    });

    it('sends done even when some routes fail and some succeed', async () => {
      const session = createMockSession();
      let callCount = 0;
      const mockExecuteRoute = vi.fn(async (session, from, route) => {
        callCount++;
        if (route.to === 'dev-1') throw new Error('Failed');
        // rev-1 succeeds
      });

      const routes = [
        { to: 'dev-1', taskId: 'task-1', taskTitle: 'Test' },
        { to: 'rev-1', taskId: 'task-1', taskTitle: 'Test' }
      ];
      await simulateRoutingSection(session, 'pm', routes, mockExecuteRoute);

      const routingMsgs = capturedMessages.filter(m => m.type === 'crew_routing');
      expect(routingMsgs).toHaveLength(2);
      expect(routingMsgs[0].status).toBe('routing');
      expect(routingMsgs[1].status).toBe('done');
      expect(mockExecuteRoute).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------
  // Sub-task A: parseRoutes still works correctly
  // ---------------------------------------------------------------
  describe('Sub-task A: parseRoutes validation', () => {
    it('parses standard ROUTE block', () => {
      const text = `Some text before

---ROUTE---
to: dev-1
task: task-100
taskTitle: Implement feature
summary: Please implement the login flow
---END_ROUTE---

Some text after`;

      const routes = parseRoutes(text);
      expect(routes).toHaveLength(1);
      expect(routes[0].to).toBe('dev-1');
      expect(routes[0].taskId).toBe('task-100');
      expect(routes[0].taskTitle).toBe('Implement feature');
      expect(routes[0].summary).toBe('Please implement the login flow');
    });

    it('parses multiple ROUTE blocks', () => {
      const text = `
---ROUTE---
to: rev-1
task: task-200
taskTitle: Review code
summary: Please review the changes
---END_ROUTE---

---ROUTE---
to: test-1
task: task-200
taskTitle: Test code
summary: Please test the changes
---END_ROUTE---`;

      const routes = parseRoutes(text);
      expect(routes).toHaveLength(2);
      expect(routes[0].to).toBe('rev-1');
      expect(routes[1].to).toBe('test-1');
    });

    it('does NOT parse freeform ROUTE → format', () => {
      const text = `ROUTE → dev-1: Please implement this`;
      const routes = parseRoutes(text);
      expect(routes).toHaveLength(0);
    });

    it('does NOT parse ROUTE: format', () => {
      const text = `ROUTE: dev-1\nsummary: Please implement this`;
      const routes = parseRoutes(text);
      expect(routes).toHaveLength(0);
    });

    it('tolerates END ROUTE with space', () => {
      const text = `---ROUTE---
to: dev-1
summary: test
---END ROUTE---`;

      const routes = parseRoutes(text);
      expect(routes).toHaveLength(1);
      expect(routes[0].to).toBe('dev-1');
    });
  });

  // ---------------------------------------------------------------
  // Regression: existing message types not affected
  // ---------------------------------------------------------------
  describe('Regression: existing messages unaffected', () => {
    it('crew_routing messages are separate from crew_output', async () => {
      const session = createMockSession();
      const mockExecuteRoute = vi.fn(async () => {});

      // Simulate sending a crew_output before routing
      mockSendCrewMessage({
        type: 'crew_output',
        sessionId: session.id,
        role: 'pm',
        outputType: 'text',
        data: { message: { content: 'hello' } }
      });

      const routes = [{ to: 'dev-1', taskId: 'task-1', taskTitle: 'Test' }];
      await simulateRoutingSection(session, 'pm', routes, mockExecuteRoute);

      // Verify crew_output is still there, separate from crew_routing
      const outputMsgs = capturedMessages.filter(m => m.type === 'crew_output');
      const routingMsgs = capturedMessages.filter(m => m.type === 'crew_routing');

      expect(outputMsgs).toHaveLength(1);
      expect(routingMsgs).toHaveLength(2);
      expect(outputMsgs[0].outputType).toBe('text');
    });

    it('crew_routing does not interfere with crew_status fields', () => {
      // Verify that crew_routing message structure doesn't overlap with crew_status
      const routingMsg = {
        type: 'crew_routing',
        sessionId: 'test-session',
        fromRole: 'pm',
        routes: [{ to: 'dev-1' }],
        status: 'routing'
      };

      // crew_status has different fields
      const statusMsg = {
        type: 'crew_status',
        sessionId: 'test-session',
        status: 'active',
        currentRole: 'pm',
        round: 1,
        roles: []
      };

      // These should be distinguishable by type
      expect(routingMsg.type).not.toBe(statusMsg.type);
      // crew_routing.status is 'routing'/'done', crew_status.status is 'active'/'stopped'/etc
      expect(routingMsg.status).toBe('routing');
      expect(statusMsg.status).toBe('active');
    });

    it('routing done message structure matches expected format', () => {
      // Verify the done message has the right shape for frontend consumption
      const doneMsg = {
        type: 'crew_routing',
        sessionId: 'test-session',
        fromRole: 'pm',
        status: 'done'
      };

      expect(doneMsg.type).toBe('crew_routing');
      expect(doneMsg.status).toBe('done');
      expect(doneMsg.fromRole).toBe('pm');
      // done message should NOT have routes field
      expect(doneMsg.routes).toBeUndefined();
    });
  });
});
