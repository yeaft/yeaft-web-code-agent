import { beforeAll, describe, expect, it } from 'vitest';

let capturedOptions = null;
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => {
  if (options && options.actions && options.actions.switchYeaftModel) {
    capturedOptions = options;
  }
  return () => ({});
};
globalThis.window = globalThis.window || {};
globalThis.window.Pinia = globalThis.Pinia;

let actions;
beforeAll(async () => {
  await import('../../web/stores/chat.js');
  if (!capturedOptions) {
    throw new Error('chat.js defineStore was not captured — Pinia shim mis-wired');
  }
  actions = capturedOptions.actions;
});

function mkStore() {
  const crudRequests = [];
  const wsMessages = [];
  return {
    currentAgent: 'agent-a',
    yeaftModel: null,
    yeaftModelEffort: null,
    crudRequests,
    wsMessages,
    async sessionCrudRequest(op, data) {
      crudRequests.push({ op, data });
      return { ok: true };
    },
    sendWsMessage(msg) {
      wsMessages.push(msg);
    },
  };
}

describe('Yeaft model effort save flow', () => {
  it('saves explicit effort for session-scoped model selection', async () => {
    const store = mkStore();

    const res = await actions.switchYeaftModel.call(
      store,
      'github-copilot/claude-opus-4.8',
      'session-a',
      'max'
    );

    expect(res).toEqual({ ok: true });
    expect(store.crudRequests).toEqual([{
      op: 'update_config',
      data: {
        sessionId: 'session-a',
        config: { model: 'github-copilot/claude-opus-4.8', modelEffort: 'max' },
      },
    }]);
    expect(store.yeaftModel).toBe(null);
    expect(store.yeaftModelEffort).toBe(null);
  });

  it('sends minimal effort on the legacy non-session model switch path', async () => {
    const store = mkStore();

    await actions.switchYeaftModel.call(store, 'github-copilot/gpt-5.5', null, 'minimal');

    expect(store.wsMessages).toEqual([{
      type: 'yeaft_model_switch',
      model: 'github-copilot/gpt-5.5',
      modelEffort: 'minimal',
      agentId: 'agent-a',
    }]);
  });
});
