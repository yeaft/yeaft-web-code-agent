import { describe, it, expect } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => options;
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { useChatStore } = await import('../../../web/stores/chat.js');

function makeStore() {
  const schema = useChatStore();
  const state = schema.state();
  const store = { ...state, sessionCrudCalls: [] };
  for (const [name, fn] of Object.entries(schema.actions)) {
    store[name] = fn.bind(store);
  }
  store.sessionCrudRequest = async function sessionCrudRequest(op, data) {
    this.sessionCrudCalls.push({ op, data });
    return { ok: true, op, group: data };
  };
  return store;
}

describe('createYeaftSession', () => {
  it('includes workDir in the create payload when provided', async () => {
    const store = makeStore();

    const res = await store.createYeaftSession({
      displayName: '  Kernel work  ',
      vpIds: ['linus', 'martin'],
      workDir: '  /home/user/projects/linux  ',
    });

    expect(res.ok).toBe(true);
    expect(store.sessionCrudCalls).toEqual([
      {
        op: 'create',
        data: {
          roster: ['linus', 'martin'],
          defaultVpId: 'linus',
          name: 'Kernel work',
          workDir: '/home/user/projects/linux',
        },
      },
    ]);
  });

  it('omits workDir when blank to preserve the existing default create behavior', async () => {
    const store = makeStore();

    await store.createYeaftSession({
      displayName: '',
      vpIds: ['omni'],
      workDir: '   ',
    });

    expect(store.sessionCrudCalls).toEqual([
      {
        op: 'create',
        data: {
          roster: ['omni'],
          defaultVpId: 'omni',
        },
      },
    ]);
  });
});
