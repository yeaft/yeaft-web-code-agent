// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as tasks from '../../web/stores/helpers/scheduled-tasks.js';

const options = {};
globalThis.Pinia = { defineStore: (id, value) => { options[id] = value; return () => ({}); } };
const { useChatStore } = await import('../../web/stores/chat.js');
const { setupVisibilityHandler } = await import('../../web/stores/helpers/websocket.js');
await import('../../web/stores/sessions.js');

function harness() {
  const store = {
    agents: [{ id: 'a', online: true, capabilities: ['scheduled_tasks'] }, { id: 'b', online: true, capabilities: [] }],
    ws: { readyState: 1 }, scheduledTaskProtocolSupported: true, scheduledTaskNotifications: [], scheduledTaskNotificationOwnerId: null,
    sidebarSessionCatalog: [{ catalogKey: 'yeaft:a:same', routeRef: { runtimeProvider: 'yeaft', agentId: 'a', sessionId: 'same' } }],
    sessionCrudRequest: vi.fn(async () => ({ ok: true })),
    markYeaftSessionUnread: vi.fn(), openCatalogSession: vi.fn(() => true),
  };
  tasks.bindScheduledTaskNotificationOwner(store, 'owner');
  return store;
}
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const completed = { sessionId: 'same', runId: 'run', status: 'completed', taskName: 'Daily review' };

describe('Session-backed task store integration', () => {
});
