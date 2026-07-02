import { describe, expect, it } from 'vitest';

const { buildTimelineRows, resolveTimelineSession, selectGroupRosterVpList } = await import('../../../web/stores/helpers/vp-timeline.js');

describe('Yeaft VP timeline session lookup', () => {
  it('renders roster rows when sessions are keyed by agent plus session id', () => {
    const sessionId = 'session-ux';
    const agentId = 'agent-2';
    const storeKey = `${agentId}\u001f${sessionId}`;
    const sessionsStore = {
      activeSessionId: sessionId,
      sessions: {
        [storeKey]: { id: sessionId, agentId, roster: ['linus', 'martin'], defaultVpId: 'linus' },
      },
      sessionById(id, requestedAgentId = null) {
        const direct = requestedAgentId ? `${requestedAgentId}\u001f${id}` : id;
        return this.sessions[direct] || Object.values(this.sessions).find(s => s.id === id) || null;
      },
    };
    const vpStore = {
      vpList: [
        { vpId: 'linus', displayName: 'Linus' },
        { vpId: 'martin', displayName: 'Martin' },
      ],
      vpLabel(id) {
        return this.vpList.find(vp => vp.vpId === id)?.displayName || id;
      },
    };
    const chatStore = {
      currentAgent: agentId,
      yeaftConversationId: 'yeaft-conv',
      yeaftActiveSessionFilter: sessionId,
      vpStatuses: {},
      stoppingVpTurnIds: {},
      connectionState: 'connected',
    };

    const filter = chatStore.yeaftActiveSessionFilter || sessionsStore.activeSessionId || null;
    expect(sessionsStore.sessions[sessionId]).toBeUndefined();

    const group = resolveTimelineSession(sessionsStore, filter, chatStore.currentAgent || null);
    const roster = (group && Array.isArray(group.roster)) ? group.roster : [];
    const vpList = selectGroupRosterVpList(roster, vpStore.vpList || []);
    const rows = buildTimelineRows({
      vpList,
      vpStatuses: {},
      stoppingVpTurnIds: chatStore.stoppingVpTurnIds || {},
      connectionState: chatStore.connectionState,
      vpLabelOf: (id) => vpStore.vpLabel(id),
    });

    expect(rows.map(row => row.vpId)).toEqual(['linus', 'martin']);
  });
});
