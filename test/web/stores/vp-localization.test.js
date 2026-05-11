import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

let useVpStore;
let chatLocale = 'en';
let storeInstance = null;

function makeStore(options) {
  const state = options.state ? options.state() : {};
  const store = { ...state };

  for (const [name, getter] of Object.entries(options.getters || {})) {
    Object.defineProperty(store, name, {
      enumerable: true,
      get() {
        return getter.call(store, store);
      },
    });
  }

  for (const [name, action] of Object.entries(options.actions || {})) {
    store[name] = action.bind(store);
  }

  return store;
}

beforeAll(async () => {
  globalThis.window = globalThis;
  globalThis.localStorage = {
    getItem: () => chatLocale,
    setItem: (_key, value) => { chatLocale = value; },
  };
  globalThis.Pinia = {
    defineStore: (_id, options) => {
      return () => {
        if (!storeInstance) storeInstance = makeStore(options);
        return storeInstance;
      };
    },
    useChatStore: () => ({ locale: chatLocale }),
  };

  ({ useVpStore } = await import('../../../web/stores/vp.js'));
});

beforeEach(() => {
  chatLocale = 'en';
  storeInstance = null;
});

describe('VP store localized labels', () => {
  it('uses displayNameZh for zh-CN VP list labels and displayName for en', () => {
    const store = useVpStore();
    store.applySnapshot({
      vps: [{
        vpId: 'linus',
        displayName: 'Linus Torvalds',
        displayNameZh: '林纳斯·托瓦兹',
      }],
    });

    chatLocale = 'zh-CN';
    expect(store.vpLabel('linus')).toBe('林纳斯·托瓦兹');

    chatLocale = 'en';
    expect(store.vpLabel('linus')).toBe('Linus Torvalds');
  });

  it('keeps protocol identifiers untouched while localizing display prose', () => {
    const store = useVpStore();
    store.applySnapshot({
      vps: [{
        vpId: 'martin',
        displayName: 'Martin Fowler',
        displayNameZh: '马丁·福勒',
      }],
    });

    chatLocale = 'zh-CN';
    expect(store.vpList[0].vpId).toBe('martin');
    expect(Object.keys(store.vpList[0])).toEqual(['vpId', 'displayName', 'displayNameZh']);
    expect(store.vpLabel('martin')).toBe('马丁·福勒');
  });
});
