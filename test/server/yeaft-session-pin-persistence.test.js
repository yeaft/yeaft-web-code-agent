import { beforeEach, describe, expect, it, vi } from 'vitest';

function dbRow(overrides = {}) {
  return {
    id: 'session_default',
    user_id: 'user-1',
    agent_id: 'agent-1',
    name: 'Default',
    roster_json: '[]',
    default_vp_id: null,
    work_dir: '',
    config_json: '{}',
    announcement: '',
    created_at: 1,
    updated_at: 2,
    is_archived: 0,
    is_pinned: 0,
    ...overrides,
  };
}

async function loadYeaftSessionDb(existingRow) {
  vi.resetModules();
  const stmts = {
    getYeaftSession: { get: vi.fn(() => existingRow) },
    getYeaftSessionForAgent: { get: vi.fn((_id, _userId, agentId) => Array.isArray(existingRow) ? existingRow.find(row => row.agent_id === agentId) : (existingRow?.agent_id === agentId ? existingRow : null)) },
    getYeaftSessionsByAgent: { all: vi.fn(() => existingRow ? (Array.isArray(existingRow) ? existingRow : [existingRow]) : []) },
    getYeaftSessionsByUser: { all: vi.fn(() => existingRow ? (Array.isArray(existingRow) ? existingRow : [existingRow]) : []) },
    upsertYeaftSession: { run: vi.fn() },
    deleteYeaftSession: { run: vi.fn() },
    deleteYeaftSessionForAgent: { run: vi.fn() },
    setYeaftSessionArchivedForAgent: { run: vi.fn() },
    setYeaftSessionPinned: { run: vi.fn() },
    setYeaftSessionPinnedForAgent: { run: vi.fn() },
    setYeaftSessionSortOrder: { run: vi.fn() },
  };
  vi.doMock('../../server/db/connection.js', () => ({ stmts }));
  const { yeaftSessionDb } = await import('../../server/db/yeaft-session-db.js');
  return { yeaftSessionDb, stmts };
}

async function loadDecorator(pinnedRows) {
  vi.resetModules();
  const yeaftSessionDb = {
    getByAgent: vi.fn(() => pinnedRows),
  };
  vi.doMock('../../server/database.js', () => ({
    messageDb: {},
    yeaftSessionDb,
  }));
  vi.doMock('../../server/ws-utils.js', () => ({
    broadcastAgentList: vi.fn(),
    forwardToClients: vi.fn(),
    sendToWebClient: vi.fn(),
  }));
  vi.doMock('../../server/context.js', () => ({
    trackMessage: vi.fn(),
    webClients: new Map(),
    previewFiles: vi.fn(),
  }));
  vi.doMock('../../server/config.js', () => ({
    CONFIG: { skipAuth: true },
  }));
  const mod = await import('../../server/handlers/agent-output.js');
  return { decorateYeaftSessionsWithPinned: mod.decorateYeaftSessionsWithPinned, yeaftSessionDb };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('yeaftSessionDb.setPinnedForAgent', () => {
  it('creates an agent-scoped pin row instead of mutating another agent with the same session id', async () => {
    const { yeaftSessionDb, stmts } = await loadYeaftSessionDb(dbRow({ agent_id: 'agent-2', is_pinned: 0 }));

    const ok = yeaftSessionDb.setPinnedForAgent('user-1', 'agent-1', { id: 'session_default' }, true);

    expect(ok).toBe(true);
    expect(stmts.upsertYeaftSession.run).toHaveBeenCalledWith(
      'session_default',
      'user-1',
      'agent-1',
      'session_default',
      '[]',
      null,
      '',
      '{}',
      '',
      expect.any(Number),
      expect.any(Number),
      0,
    );
    expect(stmts.setYeaftSessionPinnedForAgent.run).toHaveBeenCalledWith(1, expect.any(Number), 'session_default', 'user-1', 'agent-1');
    expect(stmts.setYeaftSessionPinned.run).not.toHaveBeenCalled();
  });

  it('updates an existing row owned by the same user and agent', async () => {
    const { yeaftSessionDb, stmts } = await loadYeaftSessionDb(dbRow({ agent_id: 'agent-1', is_pinned: 0 }));

    const ok = yeaftSessionDb.setPinnedForAgent('user-1', 'agent-1', { id: 'session_default' }, true);

    expect(ok).toBe(true);
    expect(stmts.setYeaftSessionPinnedForAgent.run).toHaveBeenCalledWith(1, expect.any(Number), 'session_default', 'user-1', 'agent-1');
    expect(stmts.upsertYeaftSession.run).not.toHaveBeenCalled();
  });

  it('creates a stub row before pinning when no server shadow row exists yet', async () => {
    const { yeaftSessionDb, stmts } = await loadYeaftSessionDb(null);

    const ok = yeaftSessionDb.setPinnedForAgent('user-1', 'agent-1', {
      id: 'session-1',
      name: 'Scratch',
      workDir: '/tmp/project',
    }, true);

    expect(ok).toBe(true);
    expect(stmts.upsertYeaftSession.run).toHaveBeenCalledWith(
      'session-1',
      'user-1',
      'agent-1',
      'Scratch',
      '[]',
      null,
      '/tmp/project',
      '{}',
      '',
      expect.any(Number),
      expect.any(Number),
      0,
    );
    expect(stmts.setYeaftSessionPinnedForAgent.run).toHaveBeenCalledWith(1, expect.any(Number), 'session-1', 'user-1', 'agent-1');
  });

  it('persists manual order only for sessions owned by the same user and agent', async () => {
    const { yeaftSessionDb, stmts } = await loadYeaftSessionDb(dbRow({ id: 'session-a', user_id: 'user-1', agent_id: 'agent-1' }));
    stmts.getYeaftSessionsByAgent.all.mockReturnValue([
      dbRow({ id: 'session-a', user_id: 'user-1', agent_id: 'agent-1' }),
      dbRow({ id: 'session-b', user_id: 'user-1', agent_id: 'agent-1' }),
      dbRow({ id: 'session-foreign', user_id: 'user-2', agent_id: 'agent-1' }),
    ]);

    const ok = yeaftSessionDb.setOrderForAgent('user-1', 'agent-1', ['session-b', 'session-foreign', 'session-a']);

    expect(ok).toBe(true);
    expect(stmts.setYeaftSessionSortOrder.run).toHaveBeenCalledTimes(2);
    expect(stmts.setYeaftSessionSortOrder.run).toHaveBeenNthCalledWith(1, 0, expect.any(Number), 'session-b', 'user-1', 'agent-1');
    expect(stmts.setYeaftSessionSortOrder.run).toHaveBeenNthCalledWith(2, 1, expect.any(Number), 'session-a', 'user-1', 'agent-1');
  });

  it('persists manual order across agents for the same user', async () => {
    const { yeaftSessionDb, stmts } = await loadYeaftSessionDb(null);
    stmts.getYeaftSessionsByUser.all.mockReturnValue([
      dbRow({ id: 'session-a', user_id: 'user-1', agent_id: 'agent-a' }),
      dbRow({ id: 'session-b', user_id: 'user-1', agent_id: 'agent-b' }),
      dbRow({ id: 'session-c', user_id: 'user-1', agent_id: 'agent-a' }),
      dbRow({ id: 'session-foreign', user_id: 'user-2', agent_id: 'agent-b' }),
    ]);

    const ok = yeaftSessionDb.setOrderForUser('user-1', [
      { agentId: 'agent-b', sessionId: 'session-b' },
      { agentId: 'agent-b', sessionId: 'session-foreign' },
      { agentId: 'agent-a', sessionId: 'session-c' },
      { agentId: 'agent-a', sessionId: 'session-a' },
    ]);

    expect(ok).toBe(true);
    expect(stmts.setYeaftSessionSortOrder.run).toHaveBeenCalledTimes(3);
    expect(stmts.setYeaftSessionSortOrder.run).toHaveBeenNthCalledWith(1, 0, expect.any(Number), 'session-b', 'user-1', 'agent-b');
    expect(stmts.setYeaftSessionSortOrder.run).toHaveBeenNthCalledWith(2, 1, expect.any(Number), 'session-c', 'user-1', 'agent-a');
    expect(stmts.setYeaftSessionSortOrder.run).toHaveBeenNthCalledWith(3, 2, expect.any(Number), 'session-a', 'user-1', 'agent-a');
  });

  it('reconciles opened-session snapshots without clearing persisted pin state', async () => {
    const { yeaftSessionDb, stmts } = await loadYeaftSessionDb(dbRow({ is_pinned: 1 }));

    yeaftSessionDb.reconcileFromSnapshot('user-1', 'agent-1', [
      { id: 'session_default', name: 'Default from agent', workDir: '/repo' },
    ]);

    expect(stmts.upsertYeaftSession.run).toHaveBeenCalled();
    expect(stmts.setYeaftSessionPinned.run).not.toHaveBeenCalled();
    expect(stmts.deleteYeaftSessionForAgent.run).not.toHaveBeenCalled();
  });
});

describe('decorateYeaftSessionsWithPinned', () => {
  it('decorates agent list snapshots with persisted pinned state and manual order', async () => {
    const { decorateYeaftSessionsWithPinned, yeaftSessionDb } = await loadDecorator([
      { id: 'session-1', isPinned: true, sortOrder: 1 },
      { id: 'session-2', isPinned: false, sortOrder: 0 },
    ]);

    const out = decorateYeaftSessionsWithPinned('agent-1', [
      { id: 'session-1', name: 'One' },
      { id: 'session-2', name: 'Two' },
    ]);

    expect(yeaftSessionDb.getByAgent).toHaveBeenCalledWith('agent-1');
    expect(out).toEqual([
      { id: 'session-1', name: 'One', pinned: true, isPinned: true, sortOrder: 1 },
      { id: 'session-2', name: 'Two', pinned: false, isPinned: false, sortOrder: 0 },
    ]);
  });
});
