import { describe, expect, it, vi } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = globalThis.Pinia.defineStore || ((_id, options) => () => options);
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = globalThis.localStorage || {
  _m: {},
  getItem(k) { return this._m[k] ?? null; },
  setItem(k, v) { this._m[k] = String(v); },
  removeItem(k) { delete this._m[k]; },
};

const { default: YeaftSidebar } = await import('../../web/components/YeaftSidebar.js');

function makeCtx({ agent = { id: 'agent-1', online: true, version: '0.1.2' }, upgrading, restarting } = {}) {
  const store = { agents: agent ? [agent] : [] };
  return {
    chatStore: store,
    store,
    upgradingAgents: upgrading || {},
    restartingAgents: restarting || {},
  };
}

describe('YeaftSidebar agent transient statuses', () => {
  it('clears upgrading state when the upgraded agent returns online with a new version', () => {
    const ctx = makeCtx({
      agent: { id: 'agent-1', online: true, version: '0.1.3' },
      upgrading: { 'agent-1': { since: Date.now(), oldVersion: '0.1.2' } },
    });

    YeaftSidebar.methods.clearRecoveredAgentStatuses.call(ctx);

    expect(ctx.upgradingAgents).toEqual({});
  });

  it('clears upgrading state when the agent disappears during upgrade', () => {
    const ctx = makeCtx({
      agent: null,
      upgrading: { 'agent-1': { since: Date.now(), oldVersion: '0.1.2' } },
    });

    YeaftSidebar.methods.clearRecoveredAgentStatuses.call(ctx);

    expect(ctx.upgradingAgents).toEqual({});
  });

  it('delays clearing an online upgrading agent until the minimum display window when version is unchanged', () => {
    vi.useFakeTimers();
    try {
      const ctx = makeCtx({
        agent: { id: 'agent-1', online: true, version: '0.1.2' },
        upgrading: { 'agent-1': { since: Date.now(), oldVersion: '0.1.2' } },
      });

      YeaftSidebar.methods.clearRecoveredAgentStatuses.call(ctx);
      expect(ctx.upgradingAgents['agent-1']).toBeTruthy();

      vi.advanceTimersByTime(3000);
      expect(ctx.upgradingAgents).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears restarting state when the agent returns online', () => {
    const ctx = makeCtx({
      agent: { id: 'agent-1', online: true, version: '0.1.2' },
      restarting: { 'agent-1': true },
    });

    YeaftSidebar.methods.clearRecoveredAgentStatuses.call(ctx);

    expect(ctx.restartingAgents).toEqual({});
  });
});
