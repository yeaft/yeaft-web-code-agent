/**
 * Regression test — YeaftPage.setup() must not hit a temporal dead zone.
 *
 * Bug we're guarding against (introduced sometime before v0.1.747, surfaced
 * when the topbar gear button was added):
 *   the header Dream status computed now resolves via the current group id,
 *   but it still depends on `topbarGroup.value`. `topbarGroup` must be
 *   declared before any eagerly watched Dream computed touches it. Otherwise
 *   setup can dereference `topbarGroup.value` while `topbarGroup` is still in
 *   TDZ — producing
 *     ReferenceError: Cannot access 'Dt' before initialization
 *   and blanking the page when the user enters group mode.
 *
 * Strategy: bundle YeaftPage.js with esbuild into a single IIFE (so all
 * imports are resolved), stub the globals it expects (Vue, Pinia, window,
 * etc.), and run the bundle in a vm sandbox. `Vue.watch` resolves its
 * source eagerly (just like real Vue) so any TDZ in a computed transitively
 * touched by a watch source surfaces immediately. `Vue.computed` itself is
 * **lazy** in the stub (same as real Vue) — its callback only runs on
 * first `.value` read. This deliberately avoids false positives on benign
 * "late-bound" computeds that real Vue would never trip on.
 *
 * This is intentionally a runtime test, not a static analyzer — TDZ in
 * setup() is observable only at execution time, and a static scanner
 * would have to model Vue's reactive evaluation graph to be useful.
 */
import { describe, it, expect } from 'vitest';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Build a minimal Vue stub. `computed` is lazy (matches real Vue); `watch`
 * resolves its source eagerly (also matches real Vue — that's the
 * setup-time read that surfaces TDZ on later-declared consts). Together
 * they catch the bug class without flagging late-bound computeds that
 * never get touched until first render.
 */
function makeVueStub() {
  const ref = (initial) => {
    let v = initial;
    return { get value() { return v; }, set value(x) { v = x; } };
  };
  const reactive = (obj) => obj;
  const computed = (fn) => {
    // Lazy: matches real Vue. The callback only runs when `.value` is
    // read, which is exactly what `Vue.watch` does to its source during
    // setup (see `watch` below), and what the template renderer does on
    // first render. TDZ violations chained through a watch source still
    // surface here because that read happens during setup().
    let cached;
    let ran = false;
    return {
      get value() {
        if (!ran) { cached = fn(); ran = true; }
        return cached;
      },
    };
  };
  /**
   * `watch` resolves its source eagerly during setup to register reactive
   * deps. If `source` is a function we call it; if it's a ref-like we
   * touch `.value`; if it's an array we recurse into each entry. Any of
   * those paths can dereference a not-yet-initialised const and throw —
   * which is the bug. Array support matters because `Vue.watch([refA,
   * refB], cb)` is a valid pattern; without it a future array-source
   * watch would silently no-op here and skip the TDZ check.
   */
  const resolveOne = (s) => {
    if (typeof s === 'function') return s();
    if (s && typeof s === 'object' && 'value' in s) return s.value;
    return undefined;
  };
  const watch = (source) => {
    if (Array.isArray(source)) {
      source.forEach(resolveOne);
    } else {
      resolveOne(source);
    }
  };
  return {
    ref,
    reactive,
    computed,
    watch,
    onMounted: () => {},
    onUnmounted: () => {},
    onBeforeUnmount: () => {},
    getCurrentInstance: () => ({
      appContext: { config: { globalProperties: { t: (k) => k } } },
    }),
  };
}

/**
 * Pinia stub. `defineStore` IS called by the bundle — YeaftPage transitively
 * imports `web/stores/helpers/vp-timeline.js` which pulls in `web/stores/*.js`
 * via the bundler; each store module runs `const { defineStore } = Pinia;
 * defineStore(name, schema)` at load time. We return `() => ({})` for the
 * resulting `useXStore` hook because the test only exercises setup()
 * declaration order, not store behaviour. YeaftPage itself reaches for
 * `window.Pinia.useChatStore()` etc. at runtime, so those three are
 * supplied separately with the fields setup() actually touches.
 *
 * If a future computed reads a store field not listed here it will return
 * undefined — that's intentional. Add fields when setup() needs them.
 */
function makePiniaStub() {
  const triggerGroupDreamCalls = [];
  const projectedDreamEvents = [];
  const sentGroupChats = [];
  const chatStore = {
    yeaftConversationId: null,
    yeaftActiveGroupFilter: null,
    yeaftActiveVpDetailId: null,
    yeaftAvailableModels: [],
    yeaftModel: null,
    activeConversations: [],
    messagesMap: {},
    processingConversations: {},
    vpsTypingInCurrentConv: [],
    activeVpTurns: {},
    hasCapability: () => false,
    setActiveGroupFilter: (groupId) => { chatStore.yeaftActiveGroupFilter = groupId; },
    leaveVpDetailView: () => {},
    leaveYeaft: () => {},
    sendYeaftGroupChat: (payload) => { sentGroupChats.push(payload); },
    cancelYeaft: () => {},
    clearYeaftMessages: () => {},
    switchYeaftModel: () => {},
    enterVpDetailView: () => {},
    cancelVpTurn: () => {},
    handleYeaftOutput: (payload) => {
      if (payload?.event) projectedDreamEvents.push(payload.event);
    },
  };
  const vpStore = {
    dreamStatusFor: () => ({ status: 'idle', lastRunAt: null, lastResult: null }),
    groupDreamStatusFor: () => ({ status: 'idle', lastRunAt: null, lastResult: null }),
    triggerDream: () => {},
    triggerGroupDream: (groupId) => {
      triggerGroupDreamCalls.push(groupId);
      chatStore.handleYeaftOutput({
        event: {
          type: 'dream_progress',
          phase: 'start',
          groupId,
          manual: true,
          trigger: 'manual',
          source: 'header-button',
        },
      });
    },
    vpList: [],
    vpLabel: (id) => id,
  };
  const groupsStore = {
    groups: { grp_default: { id: 'grp_default', name: 'Default', roster: [] } },
    activeGroupId: 'grp_default',
    activeGroup: { id: 'grp_default', name: 'Default', roster: [] },
    activeNeedsInvite: false,
  };
  return {
    defineStore: (_name, _schema) => () => ({}),
    useChatStore: () => chatStore,
    useVpStore: () => vpStore,
    useGroupsStore: () => groupsStore,
    __triggerGroupDreamCalls: triggerGroupDreamCalls,
    __projectedDreamEvents: projectedDreamEvents,
    __sentGroupChats: sentGroupChats,
    __chatStore: chatStore,
    __groupsStore: groupsStore,
  };
}

describe('YeaftPage setup() — temporal dead zone regression', () => {
  it('setup() initialises without ReferenceError, and dependent computeds resolve cleanly', () => {
    // Bundle YeaftPage.js into a single IIFE so imports resolve in-memory.
    const bundle = buildSync({
      entryPoints: [path.join(ROOT, 'web/components/YeaftPage.js')],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: '__YEAFT_PAGE_MOD__',
      platform: 'browser',
      target: 'es2020',
    });
    const code = bundle.outputFiles[0].text;

    const Vue = makeVueStub();
    const Pinia = makePiniaStub();
    const win = {
      Pinia,
      i18n: null,
      innerWidth: 1280,
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { reload: () => {} },
    };

    const sandbox = {
      Vue,
      Pinia,
      window: win,
      document: { addEventListener: () => {}, removeEventListener: () => {} },
      localStorage: { getItem: () => null, setItem: () => {} },
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
      console,
    };
    // Mirror the JS built-ins the bundle reaches for. Hand-curated rather
    // than `Object.assign(sandbox, globalThis)` so unexpected globals
    // (e.g. fetch) surface as `X is not defined` instead of being silently
    // available. Add to this list if setup() ever needs a new built-in.
    for (const key of ['Date', 'Math', 'Set', 'Map', 'WeakMap', 'WeakSet',
                       'Array', 'Object', 'JSON', 'String', 'Number',
                       'Boolean', 'Promise', 'Error', 'TypeError',
                       'ReferenceError', 'SyntaxError', 'URL',
                       'URLSearchParams']) {
      sandbox[key] = globalThis[key];
    }
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'YeaftPage.bundle.js' });

    const mod = sandbox.__YEAFT_PAGE_MOD__;
    expect(mod, 'esbuild IIFE must expose the module').toBeTruthy();
    const Comp = mod.default || mod;
    expect(typeof Comp.setup, 'YeaftPage must have a setup() function').toBe('function');

    // Run setup() — any TDZ violation throws here. `Vue.watch` eagerly
    // resolves its source, which is what surfaces TDZs chained through
    // computeds the watch depends on (the bug we're guarding against).
    let api;
    expect(() => { api = Comp.setup(); }, 'setup() must not throw').not.toThrow();

    // Additionally read every computed setup() exposes. With the lazy
    // `computed` stub above, this catches a second TDZ class: computeds
    // that aren't watched but are referenced from the template (lazy
    // until first render — same end result, blank page). Anything on the
    // returned API that quacks like a ref (`{ value }` getter) gets
    // touched. Refs are fine because their `.value` access is a plain
    // property read; only computeds re-enter `fn()`.
    expect(api, 'setup() must return a public API').toBeTruthy();
    expect(() => {
      for (const k of Object.keys(api)) {
        const v = api[k];
        if (v && typeof v === 'object' && 'value' in v) void v.value;
      }
    }, 'reading every exposed ref/computed must not throw').not.toThrow();

    // Regression for v0.1.800: the real header Dream button must call the
    // group-scoped trigger for the group currently shown by the topbar. A
    // store-only test of triggerGroupDream() is not enough; this pins the
    // actual template handler exposed by YeaftPage.setup().
    expect(typeof api.onDreamTriggerClick).toBe('function');
    api.onDreamTriggerClick();
    expect(Pinia.__triggerGroupDreamCalls).toEqual(['grp_default']);
    expect(Pinia.__projectedDreamEvents).toEqual([
      expect.objectContaining({
        type: 'dream_progress',
        phase: 'start',
        groupId: 'grp_default',
        manual: true,
        trigger: 'manual',
        source: 'header-button',
      }),
    ]);

    // Regression for group isolation: send routing must follow the visible
    // Yeaft filter, not a stale groupsStore.activeGroupId. Quick group
    // switches can briefly leave those pointers divergent; using the stale
    // pointer stamps the new message with the wrong groupId.
    Pinia.__chatStore.yeaftActiveGroupFilter = 'grp-visible';
    Pinia.__groupsStore.activeGroupId = 'grp-stale';
    api.sendMessage('hello visible group', []);
    expect(Pinia.__sentGroupChats.at(-1)).toEqual(expect.objectContaining({
      groupId: 'grp-visible',
      text: 'hello visible group',
    }));
  });
});

