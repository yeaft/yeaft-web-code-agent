import { describe, expect, it } from 'vitest';
import { hasUsableYeaftAgent, resolveActiveSessionIdForSettings } from '../../web/utils/yeaftSessionSettings.js';

function openAnnouncementFromStatusPane(state) {
  const sessionId = resolveActiveSessionIdForSettings(state);
  if (!sessionId) return null;
  return { sessionId, section: 'session' };
}

function openVpEditFromStatusPane(state, vpId) {
  if (!vpId) return null;
  const sessionId = resolveActiveSessionIdForSettings(state);
  if (!sessionId) return null;
  return { sessionId, section: 'members', editVpId: vpId };
}

describe('Yeaft session settings entrypoints', () => {
  it('opens announcement settings from the active session before topbarGroup hydrates', () => {
    const payload = openAnnouncementFromStatusPane({
      activeSessionFilter: null,
      sessionsStore: { activeSessionId: 'session_a' },
      topbarGroup: null,
    });

    expect(payload).toEqual({ sessionId: 'session_a', section: 'session' });
  });

  it('opens VP editing from the active session before topbarGroup hydrates', () => {
    const payload = openVpEditFromStatusPane({
      activeSessionFilter: 'session_filter',
      sessionsStore: { activeSessionId: 'session_a' },
      topbarGroup: null,
    }, 'vp_x');

    expect(payload).toEqual({
      sessionId: 'session_filter',
      section: 'members',
      editVpId: 'vp_x',
    });
  });

  it('falls back to the hydrated topbar group when no active session id exists', () => {
    expect(resolveActiveSessionIdForSettings({
      activeSessionFilter: null,
      sessionsStore: { activeSessionId: null },
      topbarGroup: { id: 'session_topbar' },
    })).toBe('session_topbar');
  });

  it('uses connected Agent state, not stale selected ids, for onboarding detection', () => {
    expect(hasUsableYeaftAgent({ currentAgent: 'agent_a', currentAgentInfo: { id: 'agent_a', online: true }, agents: [] })).toBe(true);
    expect(hasUsableYeaftAgent({ currentAgent: null, agents: [{ id: 'agent_b', online: true }] })).toBe(true);
    expect(hasUsableYeaftAgent({ currentAgent: 'agent_a', currentAgentInfo: { id: 'agent_a', online: false }, agents: [] })).toBe(false);
    expect(hasUsableYeaftAgent({ currentAgent: 'stale-agent-id', agents: [] })).toBe(false);
    expect(hasUsableYeaftAgent({ yeaftAgentId: 'legacy-only', currentAgent: null, agents: [] })).toBe(false);
  });
});
