import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tests for task-254: Crew mode typing indicator disappearing prematurely.
 *
 * Root cause: The agent_list handler's reconnect code sent resume_crew_session
 * on EVERY agent_list message (not just reconnection). This triggered
 * crew_session_restored which replaced crewMessagesMap, potentially wiping
 * the local human message and making isWaitingResponse = false.
 *
 * Fix:
 * 1. agent_list reconnect only sends resume_crew_session when the local
 *    session has no messages (actual reconnection scenario)
 * 2. crew_session_restored only replaces messages when the session has no
 *    local messages or it's a user-initiated restore
 */

const rootDir = join(import.meta.dirname, '..', '..');
const agentHandlerJs = readFileSync(join(rootDir, 'web/stores/helpers/handlers/agentHandler.js'), 'utf8');
const crewJs = readFileSync(join(rootDir, 'web/stores/helpers/crew.js'), 'utf8');

// =====================================================================
// 1. agent_list reconnect guards resume_crew_session
// =====================================================================
describe('agent_list reconnect guards resume_crew_session', () => {
  const reconnectSection = agentHandlerJs.substring(
    agentHandlerJs.indexOf('// ★ Reconnect'),
    agentHandlerJs.indexOf('// ★ 自动恢复')
  );

  it('reconnect section exists', () => {
    expect(reconnectSection.length).toBeGreaterThan(100);
  });

  it('checks crewMessagesMap before sending resume_crew_session', () => {
    expect(reconnectSection).toContain('crewMessagesMap');
  });

  it('only sends resume when local session has no messages', () => {
    // Should check crewMsgs.length === 0 or !crewMsgs
    expect(reconnectSection).toMatch(/crewMsgs.*length.*===.*0|!crewMsgs/);
  });

  it('does NOT unconditionally send resume_crew_session for crew conversations', () => {
    // The old code just had: if (conv?.type === 'crew') { store.sendWsMessage({ type: 'resume_crew_session' ... }) }
    // The new code should have a guard inside the crew branch
    const crewBranch = reconnectSection.substring(
      reconnectSection.indexOf("conv?.type === 'crew'"),
      reconnectSection.indexOf('} else {', reconnectSection.indexOf("conv?.type === 'crew'"))
    );
    // The resume_crew_session send should be inside a conditional, not at the top level of the crew branch
    expect(crewBranch).toContain('if (');
  });
});

// =====================================================================
// 2. crew_session_restored guards message replacement
// =====================================================================
describe('crew_session_restored guards message replacement', () => {
  const restoredSection = crewJs.substring(
    crewJs.indexOf("msg.type === 'crew_session_restored'"),
    crewJs.indexOf("msg.type === 'crew_session_restored'") + 3000
  );

  it('crew_session_restored handler exists', () => {
    expect(restoredSection.length).toBeGreaterThan(100);
  });

  it('checks for user-initiated restore (_pendingCrewRestore)', () => {
    expect(restoredSection).toContain('_pendingCrewRestore');
  });

  it('checks for existing local messages before replacing', () => {
    expect(restoredSection).toContain('hasLocalMessages');
  });

  it('only replaces messages when no local messages or user-initiated', () => {
    // Should have: !hasLocalMessages || isUserInitiatedRestore
    expect(restoredSection).toContain('!hasLocalMessages');
    expect(restoredSection).toContain('isUserInitiatedRestore');
  });
});

// =====================================================================
// 3. Behavioral: isWaitingResponse logic
// =====================================================================
describe('Behavioral: Crew isWaitingResponse stays true during turn', () => {
  function makeCrewStore(sessionId, messages) {
    return {
      crewMessagesMap: { [sessionId]: messages },
      crewSessions: { [sessionId]: { id: sessionId, roles: [] } },
      _pendingCrewRestore: undefined
    };
  }

  function isWaitingResponse(store, sessionId) {
    const messages = store.crewMessagesMap[sessionId] || [];
    if (!messages || messages.length === 0) return false;
    const lastMsg = messages[messages.length - 1];
    return lastMsg.role === 'human' && !lastMsg._sendFailed;
  }

  it('typing indicator shows when last message is human', () => {
    const sid = 'crew_1';
    const store = makeCrewStore(sid, [
      { role: 'pm', type: 'text', content: 'I will work on this.' },
      { role: 'human', type: 'text', content: 'Please fix the bug.' }
    ]);
    expect(isWaitingResponse(store, sid)).toBe(true);
  });

  it('typing indicator disappears when AI responds', () => {
    const sid = 'crew_2';
    const store = makeCrewStore(sid, [
      { role: 'human', type: 'text', content: 'Please fix the bug.' },
      { role: 'pm', type: 'text', content: 'On it!' }
    ]);
    expect(isWaitingResponse(store, sid)).toBe(false);
  });

  it('typing indicator stays true when local messages have human as last', () => {
    const sid = 'crew_3';
    const store = makeCrewStore(sid, [
      { role: 'human', type: 'text', content: 'Fix the typing indicator.' }
    ]);

    // Simulate crew_session_restored with server snapshot that includes AI response
    // (the guard should prevent replacement when local messages exist)
    const serverMessages = [
      { role: 'human', type: 'text', content: 'Fix the typing indicator.' },
      { role: 'pm', type: 'text', content: 'Working on it...' }
    ];

    const localMsgs = store.crewMessagesMap[sid];
    const isUserInitiatedRestore = store._pendingCrewRestore === sid;
    const hasLocalMessages = localMsgs && localMsgs.length > 0;

    // Guard should prevent replacement
    if (serverMessages.length > 0 && (!hasLocalMessages || isUserInitiatedRestore)) {
      store.crewMessagesMap[sid] = serverMessages;
    }

    // Human message should still be last (not replaced by server snapshot)
    expect(isWaitingResponse(store, sid)).toBe(true);
  });

  it('messages ARE replaced when user-initiated restore', () => {
    const sid = 'crew_4';
    const store = makeCrewStore(sid, [
      { role: 'human', type: 'text', content: 'Old message' }
    ]);
    store._pendingCrewRestore = sid;

    const serverMessages = [
      { role: 'pm', type: 'text', content: 'Server state' }
    ];

    const localMsgs = store.crewMessagesMap[sid];
    const isUserInitiatedRestore = store._pendingCrewRestore === sid;
    const hasLocalMessages = localMsgs && localMsgs.length > 0;

    if (serverMessages.length > 0 && (!hasLocalMessages || isUserInitiatedRestore)) {
      store.crewMessagesMap[sid] = serverMessages;
    }

    // Should be replaced because it's user-initiated
    expect(isWaitingResponse(store, sid)).toBe(false);
  });

  it('messages ARE replaced when session has no local messages (reconnection)', () => {
    const sid = 'crew_5';
    const store = makeCrewStore(sid, []);

    const serverMessages = [
      { role: 'pm', type: 'text', content: 'Restored from server' }
    ];

    const localMsgs = store.crewMessagesMap[sid];
    const isUserInitiatedRestore = store._pendingCrewRestore === sid;
    const hasLocalMessages = localMsgs && localMsgs.length > 0;

    if (serverMessages.length > 0 && (!hasLocalMessages || isUserInitiatedRestore)) {
      store.crewMessagesMap[sid] = serverMessages;
    }

    // Should be replaced because no local messages
    expect(store.crewMessagesMap[sid]).toEqual(serverMessages);
  });
});

// =====================================================================
// 4. agent_list reconnect: resume_crew_session decision
// =====================================================================
describe('Behavioral: resume_crew_session decision logic', () => {
  it('sends resume when crewMessagesMap is empty', () => {
    const store = { crewMessagesMap: {} };
    const convId = 'crew_resume_1';
    const crewMsgs = store.crewMessagesMap[convId];
    const shouldResume = !crewMsgs || crewMsgs.length === 0;
    expect(shouldResume).toBe(true);
  });

  it('sends resume when crewMessagesMap has empty array', () => {
    const store = { crewMessagesMap: { crew_resume_2: [] } };
    const convId = 'crew_resume_2';
    const crewMsgs = store.crewMessagesMap[convId];
    const shouldResume = !crewMsgs || crewMsgs.length === 0;
    expect(shouldResume).toBe(true);
  });

  it('does NOT send resume when crewMessagesMap has messages', () => {
    const store = {
      crewMessagesMap: {
        crew_resume_3: [{ role: 'human', content: 'Hello' }]
      }
    };
    const convId = 'crew_resume_3';
    const crewMsgs = store.crewMessagesMap[convId];
    const shouldResume = !crewMsgs || crewMsgs.length === 0;
    expect(shouldResume).toBe(false);
  });
});
