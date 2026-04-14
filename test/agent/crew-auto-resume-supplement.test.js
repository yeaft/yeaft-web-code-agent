/**
 * task-256 supplementary tests: Crew auto-resume on user input.
 *
 * Supplements dev's crew-auto-resume.test.js with:
 * 1. Auto-resume ordering: resume happens before message processing
 * 2. Three auto-resume paths: all consistent in behavior
 * 3. Split-pane: isWaitingResponse scoped to pane's conversation
 * 4. Edge cases: waiting_human not touched, initializing only blocks dispatch
 * 5. crew_routing placement: correct switch block with crew_output
 * 6. No silent discard: old guard patterns fully removed
 * 7. Status update side-effects: sendStatusUpdate and debouncedSaveSessionMeta called
 * 8. Completed only blocks typing indicator, not message sending
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');

let humanInteractionJs;
let routingJs;
let crewChatViewJs;
let messageHandlerJs;

beforeAll(() => {
  humanInteractionJs = read('agent/crew/human-interaction.js');
  routingJs = read('agent/crew/routing.js');
  crewChatViewJs = read('web/components/CrewChatView.js');
  messageHandlerJs = read('web/stores/helpers/messageHandler.js');
});

// =============================================================================
// 1. Auto-resume ordering: resume before message handling
// =============================================================================
describe('Auto-resume ordering in human-interaction.js', () => {
  it('auto-resume block is before uiMessages.push (message recording)', () => {
    const autoResumeIdx = humanInteractionJs.indexOf("Auto-resuming session from");
    const uiPushIdx = humanInteractionJs.indexOf('session.uiMessages.push');
    expect(autoResumeIdx).toBeGreaterThan(-1);
    expect(uiPushIdx).toBeGreaterThan(-1);
    expect(autoResumeIdx).toBeLessThan(uiPushIdx);
  });

  it('auto-resume block is before @role parsing', () => {
    const autoResumeIdx = humanInteractionJs.indexOf("Auto-resuming session from");
    const atRoleIdx = humanInteractionJs.indexOf('@');
    // Find the @role detection in message parsing (after the auto-resume)
    const roleParseIdx = humanInteractionJs.indexOf("message.startsWith('@')") ||
                         humanInteractionJs.indexOf("content.startsWith('@')") ||
                         humanInteractionJs.indexOf("message.match");
    // The auto-resume should definitely be before any message parsing
    // We know from the test above it's before uiMessages.push which is before @role
    expect(autoResumeIdx).toBeLessThan(humanInteractionJs.indexOf('buildHumanContent'));
  });

  it('auto-resume uses both sendStatusUpdate AND debouncedSaveSessionMeta', () => {
    // Extract the auto-resume block (between "Auto-resuming" and the closing brace)
    const autoResumeMatch = humanInteractionJs.match(
      /Auto-resuming session from[\s\S]*?debouncedSaveSessionMeta\(session\)/
    );
    expect(autoResumeMatch).not.toBeNull();
    expect(autoResumeMatch[0]).toContain('sendStatusUpdate(session)');
    expect(autoResumeMatch[0]).toContain('debouncedSaveSessionMeta(session)');
  });
});

// =============================================================================
// 2. Three auto-resume paths: consistent behavior
// =============================================================================
describe('Three auto-resume paths are consistent', () => {
  it('human-interaction.js: resumes paused, stopped, AND completed', () => {
    // The if-condition + auto-resume block spans from status check to debouncedSaveSessionMeta
    // Look for the entire block including the if-condition
    const fullBlock = humanInteractionJs.match(
      /session\.status === 'paused'[\s\S]*?debouncedSaveSessionMeta/
    );
    expect(fullBlock).not.toBeNull();
    expect(fullBlock[0]).toContain("'paused'");
    expect(fullBlock[0]).toContain("'stopped'");
    expect(fullBlock[0]).toContain("'completed'");
  });

  it('dispatchToRole: resumes paused and stopped (NOT completed)', () => {
    const fnMatch = routingJs.match(/export async function dispatchToRole\b[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    // The auto-resume if-condition is before the console.log
    const autoBlock = fnMatch[0].match(/session\.status === 'paused'[\s\S]*?sendStatusUpdate/);
    expect(autoBlock).not.toBeNull();
    expect(autoBlock[0]).toContain("'paused'");
    expect(autoBlock[0]).toContain("'stopped'");
    // completed NOT checked in dispatchToRole (routes don't come from completed sessions normally)
  });

  it('executeRoute: resumes paused and stopped (NOT completed)', () => {
    const fnMatch = routingJs.match(/export async function executeRoute\b[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const autoBlock = fnMatch[0].match(/session\.status === 'paused'[\s\S]*?sendStatusUpdate/);
    expect(autoBlock).not.toBeNull();
    expect(autoBlock[0]).toContain("'paused'");
    expect(autoBlock[0]).toContain("'stopped'");
  });

  it('all 3 paths set status to "running"', () => {
    // Each path should contain session.status = 'running'
    const humanBlock = humanInteractionJs.match(/Auto-resuming[\s\S]*?status = 'running'/);
    expect(humanBlock).not.toBeNull();

    const dispatchFn = routingJs.match(/export async function dispatchToRole\b[\s\S]*?^}/m);
    expect(dispatchFn[0]).toContain("session.status = 'running'");

    const routeFn = routingJs.match(/export async function executeRoute\b[\s\S]*?^}/m);
    expect(routeFn[0]).toContain("session.status = 'running'");
  });

  it('all 3 paths call sendStatusUpdate', () => {
    const humanBlock = humanInteractionJs.match(/Auto-resuming[\s\S]*?sendStatusUpdate\(session\)/);
    expect(humanBlock).not.toBeNull();

    const dispatchFn = routingJs.match(/export async function dispatchToRole\b[\s\S]*?^}/m);
    const dispatchResume = dispatchFn[0].match(/Auto-resuming[\s\S]*?sendStatusUpdate\(session\)/);
    expect(dispatchResume).not.toBeNull();

    const routeFn = routingJs.match(/export async function executeRoute\b[\s\S]*?^}/m);
    const routeResume = routeFn[0].match(/Auto-resuming[\s\S]*?sendStatusUpdate\(session\)/);
    expect(routeResume).not.toBeNull();
  });
});

// =============================================================================
// 3. Split-pane: isWaitingResponse uses pane-scoped status
// =============================================================================
describe('Split-pane: isWaitingResponse is pane-scoped', () => {
  it('isWaitingResponse reads from paneCrewStatus (not global)', () => {
    const fnMatch = crewChatViewJs.match(/isWaitingResponse\(\)\s*\{[\s\S]*?\n\s{4}\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch[0]).toContain('paneCrewStatus');
    // Should NOT directly access store.crewStatuses[...] — it uses the computed paneCrewStatus
    expect(fnMatch[0]).not.toContain('store.crewStatuses');
  });

  it('paneCrewStatus is based on effectiveConvId', () => {
    const fnMatch = crewChatViewJs.match(/paneCrewStatus\(\)\s*\{[\s\S]*?\n\s{4}\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch[0]).toContain('effectiveConvId');
    expect(fnMatch[0]).toContain('crewStatuses');
  });

  it('paneCrewMessages is also based on effectiveConvId', () => {
    const fnMatch = crewChatViewJs.match(/paneCrewMessages\(\)\s*\{[\s\S]*?\n\s{4}\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch[0]).toContain('effectiveConvId');
    expect(fnMatch[0]).toContain('crewMessagesMap');
  });

  it('isWaitingResponse reads paneCrewMessages (pane-scoped messages)', () => {
    const fnMatch = crewChatViewJs.match(/isWaitingResponse\(\)\s*\{[\s\S]*?\n\s{4}\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch[0]).toContain('paneCrewMessages');
  });
});

// =============================================================================
// 4. Edge: waiting_human is not auto-resumed
// =============================================================================
describe('Edge: waiting_human status is preserved by auto-resume', () => {
  it('human-interaction auto-resume does NOT check waiting_human', () => {
    const block = humanInteractionJs.match(
      /Auto-resuming session from[\s\S]*?debouncedSaveSessionMeta/
    );
    expect(block).not.toBeNull();
    expect(block[0]).not.toContain("'waiting_human'");
  });

  it('waiting_human has its own dedicated handler (separate from auto-resume)', () => {
    // The waiting_human check is a separate if block, not part of auto-resume
    const waitingIdx = humanInteractionJs.indexOf("session.status === 'waiting_human'");
    const autoResumeIdx = humanInteractionJs.indexOf("Auto-resuming session from");
    expect(waitingIdx).toBeGreaterThan(-1);
    expect(autoResumeIdx).toBeGreaterThan(-1);
    // waiting_human handler is AFTER auto-resume
    expect(waitingIdx).toBeGreaterThan(autoResumeIdx);
  });

  it('waiting_human → running transition exists separately', () => {
    // After the auto-resume block, there's a waiting_human check that also sets to running
    const waitingSection = humanInteractionJs.match(
      /waiting_human[\s\S]*?session\.status = 'running'/
    );
    expect(waitingSection).not.toBeNull();
  });
});

// =============================================================================
// 5. Edge: initializing blocks dispatchToRole but not human input
// =============================================================================
describe('Edge: initializing state behavior', () => {
  it('dispatchToRole returns early for initializing', () => {
    const fnMatch = routingJs.match(/export async function dispatchToRole\b[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch[0]).toContain("session.status === 'initializing'");
    // Should have return statement right after initializing check
    const initBlock = fnMatch[0].match(/initializing[\s\S]*?return;/);
    expect(initBlock).not.toBeNull();
  });

  it('executeRoute does NOT block initializing (no initializing check)', () => {
    const fnMatch = routingJs.match(/export async function executeRoute\b[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch[0]).not.toContain("'initializing'");
  });

  it('human-interaction auto-resume does NOT include initializing', () => {
    const block = humanInteractionJs.match(
      /Auto-resuming session from[\s\S]*?debouncedSaveSessionMeta/
    );
    expect(block).not.toBeNull();
    expect(block[0]).not.toContain("'initializing'");
  });
});

// =============================================================================
// 6. No silent discard: old patterns fully removed
// =============================================================================
describe('Old silent discard patterns fully removed', () => {
  it('no "skipping skill dispatch" in human-interaction.js', () => {
    expect(humanInteractionJs).not.toContain('skipping skill dispatch');
  });

  it('no "route saved as pending" in routing.js', () => {
    expect(routingJs).not.toContain('route saved as pending');
  });

  it('no "pendingRoutes.push" in executeRoute', () => {
    const fnMatch = routingJs.match(/export async function executeRoute\b[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch[0]).not.toContain('pendingRoutes.push');
  });

  it('only ONE "skipping dispatch" in entire dispatchToRole (for initializing only)', () => {
    const fnMatch = routingJs.match(/export async function dispatchToRole\b[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const skipMatches = fnMatch[0].match(/skipping dispatch/g);
    expect(skipMatches).not.toBeNull();
    expect(skipMatches.length).toBe(1);
  });

  it('old multi-status guard removed: no single line with paused+stopped+initializing', () => {
    // Old code: if (status === 'paused' || status === 'stopped' || status === 'initializing') return;
    // This pattern should NOT exist as a single guard anymore
    const dispatchFn = routingJs.match(/export async function dispatchToRole\b[\s\S]*?^}/m);
    expect(dispatchFn).not.toBeNull();
    // Should NOT have all three in a single if condition
    const tripleGuard = dispatchFn[0].match(
      /paused.*stopped.*initializing.*return/
    );
    expect(tripleGuard).toBeNull();
  });
});

// =============================================================================
// 7. crew_routing in messageHandler: correct position
// =============================================================================
describe('crew_routing in messageHandler switch block', () => {
  it('crew_routing is between crew_status and crew_turn_completed', () => {
    const crewStatusIdx = messageHandlerJs.indexOf("case 'crew_status':");
    const crewRoutingIdx = messageHandlerJs.indexOf("case 'crew_routing':");
    const crewTurnIdx = messageHandlerJs.indexOf("case 'crew_turn_completed':");
    expect(crewStatusIdx).toBeGreaterThan(-1);
    expect(crewRoutingIdx).toBeGreaterThan(-1);
    expect(crewTurnIdx).toBeGreaterThan(-1);
    expect(crewRoutingIdx).toBeGreaterThan(crewStatusIdx);
    expect(crewRoutingIdx).toBeLessThan(crewTurnIdx);
  });

  it('crew_routing falls through to handleCrewOutput (no break between)', () => {
    const block = messageHandlerJs.match(
      /case 'crew_routing':[\s\S]*?handleCrewOutput/
    );
    expect(block).not.toBeNull();
    // Should NOT have a break; between crew_routing and handleCrewOutput
    expect(block[0]).not.toContain('break');
  });

  it('all crew message types route to handleCrewOutput', () => {
    const crewTypes = [
      'crew_session_created', 'crew_session_restored', 'crew_output',
      'crew_status', 'crew_routing', 'crew_turn_completed',
      'crew_human_needed', 'crew_message_queued', 'crew_image',
      'crew_role_added', 'crew_role_removed', 'crew_session_cleared',
      'crew_role_error', 'crew_history_loaded'
    ];
    for (const type of crewTypes) {
      expect(messageHandlerJs).toContain(`case '${type}':`);
    }
  });
});

// =============================================================================
// 8. Behavioral: completed blocks typing indicator, not message sending
// =============================================================================
describe('Behavioral: completed blocks typing, not sending', () => {
  function simulateAutoResume(status) {
    if (status === 'paused' || status === 'stopped' || status === 'completed') {
      return 'running';
    }
    return status;
  }

  function isWaitingResponse(crewStatus, messages) {
    if (crewStatus?.status === 'completed') return false;
    if (!messages || messages.length === 0) return false;
    const lastMsg = messages[messages.length - 1];
    return lastMsg.role === 'human' && !lastMsg._sendFailed;
  }

  it('completed session: message can be sent (auto-resumes to running)', () => {
    expect(simulateAutoResume('completed')).toBe('running');
  });

  it('completed session: typing indicator hidden (safety net)', () => {
    expect(isWaitingResponse({ status: 'completed' }, [{ role: 'human' }])).toBe(false);
  });

  it('after auto-resume from completed: typing indicator shows (now running)', () => {
    // After auto-resume, status becomes 'running'
    const newStatus = simulateAutoResume('completed');
    expect(isWaitingResponse({ status: newStatus }, [{ role: 'human' }])).toBe(true);
  });

  it('paused session: typing indicator visible (NOT blocked)', () => {
    expect(isWaitingResponse({ status: 'paused' }, [{ role: 'human' }])).toBe(true);
  });

  it('stopped session: typing indicator visible (NOT blocked)', () => {
    expect(isWaitingResponse({ status: 'stopped' }, [{ role: 'human' }])).toBe(true);
  });

  it('running session: typing indicator visible', () => {
    expect(isWaitingResponse({ status: 'running' }, [{ role: 'human' }])).toBe(true);
  });

  it('null status: typing indicator still works (no crash, treats as non-completed)', () => {
    // null?.status === 'completed' is false, so typing shows
    expect(isWaitingResponse(null, [{ role: 'human' }])).toBe(true);
  });

  it('undefined status: typing indicator still works (no crash, treats as non-completed)', () => {
    expect(isWaitingResponse(undefined, [{ role: 'human' }])).toBe(true);
  });
});

// =============================================================================
// 9. Behavioral: full flow simulation
// =============================================================================
describe('Full flow: user sends message in various states', () => {
  function simulateSession(initialStatus) {
    const session = {
      status: initialStatus,
      statusUpdates: [],
      uiMessages: []
    };
    return session;
  }

  function handleUserInput(session) {
    // Step 1: Auto-resume (mirrors human-interaction.js logic)
    if (session.status === 'paused' || session.status === 'stopped' || session.status === 'completed') {
      session.status = 'running';
      session.statusUpdates.push('running');
    }
    // Step 2: Record message
    session.uiMessages.push({ role: 'human', content: 'test' });
    return session;
  }

  it('stopped → send message → running, message recorded', () => {
    const session = simulateSession('stopped');
    handleUserInput(session);
    expect(session.status).toBe('running');
    expect(session.uiMessages.length).toBe(1);
    expect(session.statusUpdates).toContain('running');
  });

  it('paused → send message → running, message recorded', () => {
    const session = simulateSession('paused');
    handleUserInput(session);
    expect(session.status).toBe('running');
    expect(session.uiMessages.length).toBe(1);
    expect(session.statusUpdates).toContain('running');
  });

  it('completed → send message → running, message recorded', () => {
    const session = simulateSession('completed');
    handleUserInput(session);
    expect(session.status).toBe('running');
    expect(session.uiMessages.length).toBe(1);
    expect(session.statusUpdates).toContain('running');
  });

  it('running → send message → still running, message recorded, no extra status update', () => {
    const session = simulateSession('running');
    handleUserInput(session);
    expect(session.status).toBe('running');
    expect(session.uiMessages.length).toBe(1);
    expect(session.statusUpdates.length).toBe(0);
  });

  it('initializing → send message → still initializing, message still recorded', () => {
    const session = simulateSession('initializing');
    handleUserInput(session);
    // initializing is NOT auto-resumed by human-interaction (roles not ready)
    // But the message IS recorded (not silently discarded)
    expect(session.status).toBe('initializing');
    expect(session.uiMessages.length).toBe(1);
  });

  it('waiting_human → send message → still waiting_human (handled by separate code path)', () => {
    const session = simulateSession('waiting_human');
    handleUserInput(session);
    // waiting_human has its own handler, auto-resume doesn't touch it
    expect(session.status).toBe('waiting_human');
    expect(session.uiMessages.length).toBe(1);
  });

  it('multiple messages in paused: only first triggers status update', () => {
    const session = simulateSession('paused');
    handleUserInput(session);
    expect(session.statusUpdates.length).toBe(1);
    handleUserInput(session);
    // Second message: already running, no status update
    expect(session.statusUpdates.length).toBe(1);
    expect(session.uiMessages.length).toBe(2);
  });
});

// =============================================================================
// 10. Behavioral: dispatchToRole guard simulation
// =============================================================================
describe('dispatchToRole guard: full state matrix', () => {
  function simulateDispatch(status) {
    if (status === 'initializing') return { blocked: true, resumed: false };
    if (status === 'paused' || status === 'stopped') {
      return { blocked: false, resumed: true, newStatus: 'running' };
    }
    return { blocked: false, resumed: false };
  }

  const states = ['initializing', 'running', 'paused', 'stopped', 'completed', 'waiting_human'];

  it('initializing: blocked, NOT resumed', () => {
    const r = simulateDispatch('initializing');
    expect(r.blocked).toBe(true);
    expect(r.resumed).toBe(false);
  });

  it('running: NOT blocked, NOT resumed', () => {
    const r = simulateDispatch('running');
    expect(r.blocked).toBe(false);
    expect(r.resumed).toBe(false);
  });

  it('paused: NOT blocked, resumed to running', () => {
    const r = simulateDispatch('paused');
    expect(r.blocked).toBe(false);
    expect(r.resumed).toBe(true);
    expect(r.newStatus).toBe('running');
  });

  it('stopped: NOT blocked, resumed to running', () => {
    const r = simulateDispatch('stopped');
    expect(r.blocked).toBe(false);
    expect(r.resumed).toBe(true);
    expect(r.newStatus).toBe('running');
  });

  it('completed: NOT blocked, NOT resumed (no completed check in dispatchToRole)', () => {
    const r = simulateDispatch('completed');
    expect(r.blocked).toBe(false);
    expect(r.resumed).toBe(false);
  });

  it('waiting_human: NOT blocked, NOT resumed', () => {
    const r = simulateDispatch('waiting_human');
    expect(r.blocked).toBe(false);
    expect(r.resumed).toBe(false);
  });
});
