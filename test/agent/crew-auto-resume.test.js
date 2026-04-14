import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tests for task-256: Crew messages silently discarded in paused/stopped state.
 *
 * Fix: auto-resume session to 'running' when user sends a message,
 * instead of silently discarding. Only 'initializing' remains as a
 * blocking state (roles not ready yet).
 */

const rootDir = join(import.meta.dirname, '..', '..');
const humanInteractionJs = readFileSync(join(rootDir, 'agent/crew/human-interaction.js'), 'utf8');
const routingJs = readFileSync(join(rootDir, 'agent/crew/routing.js'), 'utf8');
const crewChatViewJs = readFileSync(join(rootDir, 'web/components/CrewChatView.js'), 'utf8');
const messageHandlerJs = readFileSync(join(rootDir, 'web/stores/helpers/messageHandler.js'), 'utf8');

// =====================================================================
// 1. human-interaction.js: auto-resume on user input
// =====================================================================
describe('human-interaction.js: auto-resume on user input', () => {
  it('auto-resumes session from paused/stopped/completed to running', () => {
    // The auto-resume block should check all 3 stale states
    expect(humanInteractionJs).toContain("session.status === 'paused'");
    expect(humanInteractionJs).toContain("session.status === 'stopped'");
    expect(humanInteractionJs).toContain("session.status === 'completed'");
    expect(humanInteractionJs).toContain("session.status = 'running'");
    expect(humanInteractionJs).toContain('sendStatusUpdate(session)');
    expect(humanInteractionJs).toContain('debouncedSaveSessionMeta(session)');
  });

  it('has auto-resume block before message processing (after session lookup)', () => {
    // Auto-resume should happen BEFORE the waiting_human check and @role parsing
    const autoResumeIdx = humanInteractionJs.indexOf("Auto-resuming session from");
    const waitingHumanIdx = humanInteractionJs.indexOf("session.status === 'waiting_human'");
    expect(autoResumeIdx).toBeGreaterThan(-1);
    expect(waitingHumanIdx).toBeGreaterThan(-1);
    expect(autoResumeIdx).toBeLessThan(waitingHumanIdx);
  });

  it('does NOT have silent guard for skill commands', () => {
    // The old silent guard "skipping skill dispatch" should be removed
    expect(humanInteractionJs).not.toContain('skipping skill dispatch');
  });

  it('still supports skill command dispatch to roles', () => {
    // Skill command detection still works
    expect(humanInteractionJs).toContain('/[a-zA-Z0-9_-]+');
    expect(humanInteractionJs).toContain('Skill command dispatched');
  });
});

// =====================================================================
// 2. routing.js dispatchToRole(): auto-resume, only block initializing
// =====================================================================
describe('routing.js dispatchToRole(): auto-resume', () => {
  it('only blocks initializing state (not paused/stopped)', () => {
    // Extract dispatchToRole function body
    const fnMatch = routingJs.match(/export async function dispatchToRole\b[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[0];

    // Should block initializing
    expect(fnBody).toContain("session.status === 'initializing'");
    expect(fnBody).toContain('skipping dispatch');
  });

  it('auto-resumes from paused/stopped to running in dispatchToRole', () => {
    const fnMatch = routingJs.match(/export async function dispatchToRole\b[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[0];

    // Should auto-resume paused/stopped
    expect(fnBody).toContain("session.status = 'running'");
    expect(fnBody).toContain('Auto-resuming session');
  });

  it('does NOT silently skip paused/stopped in dispatchToRole', () => {
    const fnMatch = routingJs.match(/export async function dispatchToRole\b[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[0];

    // The old guard that returned early for paused/stopped should be gone
    // It should NOT have "skipping dispatch" for paused/stopped
    const skipBlock = fnBody.match(/skipping dispatch/g);
    // Only one "skipping dispatch" should exist — for initializing
    expect(skipBlock).not.toBeNull();
    expect(skipBlock.length).toBe(1);
  });
});

// =====================================================================
// 3. routing.js executeRoute(): auto-resume instead of pendingRoutes
// =====================================================================
describe('routing.js executeRoute(): auto-resume', () => {
  it('does NOT store routes as pendingRoutes when paused/stopped', () => {
    const fnMatch = routingJs.match(/export async function executeRoute\b[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[0];

    // Old behavior: session.pendingRoutes.push should be removed
    expect(fnBody).not.toContain('pendingRoutes.push');
    expect(fnBody).not.toContain('route saved as pending');
  });

  it('auto-resumes from paused/stopped in executeRoute', () => {
    const fnMatch = routingJs.match(/export async function executeRoute\b[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[0];

    expect(fnBody).toContain("session.status = 'running'");
    expect(fnBody).toContain('Auto-resuming session');
    expect(fnBody).toContain('sendStatusUpdate(session)');
  });
});

// =====================================================================
// 4. CrewChatView.js: isWaitingResponse safety net
// =====================================================================
describe('CrewChatView.js: isWaitingResponse safety net', () => {
  it('returns false when session status is completed', () => {
    // Extract isWaitingResponse computed body
    const fnMatch = crewChatViewJs.match(/isWaitingResponse\(\)\s*\{[\s\S]*?\n\s{4}\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[0];

    expect(fnBody).toContain("paneCrewStatus?.status === 'completed'");
    expect(fnBody).toContain('return false');
  });

  it('does NOT block typing indicator for paused/stopped (only completed)', () => {
    const fnMatch = crewChatViewJs.match(/isWaitingResponse\(\)\s*\{[\s\S]*?\n\s{4}\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[0];

    // Should NOT check for paused/stopped — the auto-resume on agent side handles that
    expect(fnBody).not.toContain("'paused'");
    expect(fnBody).not.toContain("'stopped'");
  });
});

// =====================================================================
// 5. messageHandler.js: crew_routing case added
// =====================================================================
describe('messageHandler.js: crew_routing dispatch', () => {
  it('has crew_routing in the crew message dispatch block', () => {
    expect(messageHandlerJs).toContain("case 'crew_routing':");
  });

  it('crew_routing goes to handleCrewOutput', () => {
    // The crew_routing case should be in the same block as crew_output/crew_status
    // that calls store.handleCrewOutput(msg)
    const crewBlock = messageHandlerJs.match(/case 'crew_output':[\s\S]*?handleCrewOutput/);
    expect(crewBlock).not.toBeNull();
    expect(crewBlock[0]).toContain("'crew_routing'");
  });
});

// =====================================================================
// 6. Behavioral test: auto-resume logic simulation
// =====================================================================
describe('Auto-resume logic simulation', () => {
  function simulateAutoResume(session) {
    if (session.status === 'paused' || session.status === 'stopped' || session.status === 'completed') {
      session.status = 'running';
      session.statusUpdated = true;
      return true;
    }
    return false;
  }

  it('resumes from paused', () => {
    const session = { status: 'paused' };
    expect(simulateAutoResume(session)).toBe(true);
    expect(session.status).toBe('running');
  });

  it('resumes from stopped', () => {
    const session = { status: 'stopped' };
    expect(simulateAutoResume(session)).toBe(true);
    expect(session.status).toBe('running');
  });

  it('resumes from completed', () => {
    const session = { status: 'completed' };
    expect(simulateAutoResume(session)).toBe(true);
    expect(session.status).toBe('running');
  });

  it('does NOT change already running session', () => {
    const session = { status: 'running' };
    expect(simulateAutoResume(session)).toBe(false);
    expect(session.status).toBe('running');
  });

  it('does NOT change initializing session', () => {
    const session = { status: 'initializing' };
    expect(simulateAutoResume(session)).toBe(false);
    expect(session.status).toBe('initializing');
  });

  it('does NOT change waiting_human session', () => {
    const session = { status: 'waiting_human' };
    expect(simulateAutoResume(session)).toBe(false);
    expect(session.status).toBe('waiting_human');
  });
});

// =====================================================================
// 7. Behavioral test: dispatchToRole guard logic
// =====================================================================
describe('dispatchToRole guard logic simulation', () => {
  function shouldBlock(status) {
    // Only initializing blocks — paused/stopped auto-resume
    return status === 'initializing';
  }

  function shouldAutoResume(status) {
    return status === 'paused' || status === 'stopped';
  }

  it('blocks initializing', () => {
    expect(shouldBlock('initializing')).toBe(true);
  });

  it('does NOT block running', () => {
    expect(shouldBlock('running')).toBe(false);
  });

  it('does NOT block paused (auto-resumes instead)', () => {
    expect(shouldBlock('paused')).toBe(false);
    expect(shouldAutoResume('paused')).toBe(true);
  });

  it('does NOT block stopped (auto-resumes instead)', () => {
    expect(shouldBlock('stopped')).toBe(false);
    expect(shouldAutoResume('stopped')).toBe(true);
  });

  it('does NOT auto-resume running', () => {
    expect(shouldAutoResume('running')).toBe(false);
  });
});

// =====================================================================
// 8. isWaitingResponse safety net simulation
// =====================================================================
describe('isWaitingResponse safety net simulation', () => {
  function isWaitingResponse(crewStatus, messages) {
    if (crewStatus?.status === 'completed') return false;
    if (!messages || messages.length === 0) return false;
    const lastMsg = messages[messages.length - 1];
    return lastMsg.role === 'human' && !lastMsg._sendFailed;
  }

  it('returns true when last message is human and session is running', () => {
    expect(isWaitingResponse({ status: 'running' }, [{ role: 'human' }])).toBe(true);
  });

  it('returns true when last message is human and session is paused', () => {
    // Paused doesn't block — the agent will auto-resume
    expect(isWaitingResponse({ status: 'paused' }, [{ role: 'human' }])).toBe(true);
  });

  it('returns false when session is completed', () => {
    expect(isWaitingResponse({ status: 'completed' }, [{ role: 'human' }])).toBe(false);
  });

  it('returns false when no messages', () => {
    expect(isWaitingResponse({ status: 'running' }, [])).toBe(false);
  });

  it('returns false when last message is not human', () => {
    expect(isWaitingResponse({ status: 'running' }, [{ role: 'assistant' }])).toBe(false);
  });

  it('returns false when send failed', () => {
    expect(isWaitingResponse({ status: 'running' }, [{ role: 'human', _sendFailed: true }])).toBe(false);
  });
});
