/**
 * Regression test — UnifyPage.setup() must not hit a temporal dead zone.
 *
 * Bug we're guarding against (introduced sometime before v0.1.747, surfaced
 * when the topbar gear button was added):
 *   `dreamButtonVpId` was declared as a Vue.computed early in setup() and
 *   read `topbarGroup.value`. `topbarGroup` itself was declared 240+ lines
 *   later. The dream-status `Vue.watch` source evaluates eagerly during
 *   setup, which transitively dereferences `topbarGroup.value` while
 *   `topbarGroup` is still in TDZ — producing
 *     ReferenceError: Cannot access 'Dt' before initialization
 *   and blanking the page when the user enters group mode.
 *
 * Strategy: bundle UnifyPage.js with esbuild into a single IIFE (so all
 * imports are resolved), stub the globals it expects (Vue, Pinia, window,
 * etc.), and run the bundle in a vm sandbox. Computed/watch are stubbed
 * to evaluate eagerly during setup so TDZ violations surface immediately.
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
 * Build a minimal Vue stub whose computed/watch eagerly evaluate their
 * callbacks so that any TDZ violation in setup() surfaces immediately.
 */
function makeVueStub() {
  const ref = (initial) => {
    let v = initial;
    return { get value() { return v; }, set value(x) { v = x; } };
  };
  const reactive = (obj) => obj;
  const computed = (fn) => {
    // Eagerly invoke once — this models watch-source resolution + first
    // template render. TDZ violations on let/const declared later in the
    // enclosing setup() throw here.
    const cached = fn();
    return { get value() { return cached; } };
  };
  const watch = (source) => {
    // Vue resolves the source to a getter and invokes it once during
    // setup to register reactive deps. If `source` is a function we call
    // it; if it's a ref-like we touch .value. Either path can dereference
    // a not-yet-initialised const and throw — which is the bug.
    if (typeof source === 'function') {
      source();
    } else if (source && typeof source === 'object' && 'value' in source) {
      void source.value;
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

function makePiniaStub() {
  const chatStore = {
    unifyConversationId: null,
    unifyActiveGroupFilter: null,
    unifyActiveVpDetailId: null,
    unifyAvailableModels: [],
    unifyModel: null,
    activeConversations: [],
    messagesMap: {},
    processingConversations: {},
    vpsTypingInCurrentConv: [],
    activeVpTurns: {},
    hasCapability: () => false,
    setActiveGroupFilter: () => {},
    leaveVpDetailView: () => {},
    leaveUnify: () => {},
    sendUnifyGroupChat: () => {},
    cancelUnify: () => {},
    clearUnifyMessages: () => {},
    switchUnifyModel: () => {},
    enterVpDetailView: () => {},
    cancelVpTurn: () => {},
  };
  const vpStore = {
    dreamStatusFor: () => ({ status: 'idle', lastRunAt: null, lastResult: null }),
    triggerDream: () => {},
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
    // Pinia.defineStore is called at module-load time by each store file
    // (web/stores/*.js). The factory it returns is the `useXStore` hook —
    // for this test we ignore the schema and return a flat stub.
    defineStore: (_name, _schema) => () => ({}),
    useChatStore: () => chatStore,
    useVpStore: () => vpStore,
    useGroupsStore: () => groupsStore,
  };
}

describe('UnifyPage setup() — temporal dead zone regression', () => {
  it('setup() initialises without ReferenceError when every computed evaluates eagerly', () => {
    // Bundle UnifyPage.js into a single IIFE so imports resolve in-memory.
    const bundle = buildSync({
      entryPoints: [path.join(ROOT, 'web/components/UnifyPage.js')],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: '__UNIFY_PAGE_MOD__',
      platform: 'browser',
      target: 'es2020',
      // The component reads window.Pinia at runtime; we provide that via
      // the vm sandbox. Imports are bundled inline.
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
    // Mirror everything from globalThis we need (Date, Math, Array, etc.)
    for (const key of ['Date', 'Math', 'Set', 'Map', 'Array', 'Object', 'JSON',
                       'String', 'Number', 'Boolean', 'Promise', 'Error',
                       'TypeError', 'ReferenceError', 'SyntaxError']) {
      sandbox[key] = globalThis[key];
    }
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'UnifyPage.bundle.js' });

    const mod = sandbox.__UNIFY_PAGE_MOD__;
    expect(mod, 'esbuild IIFE must expose the module').toBeTruthy();
    const Comp = mod.default || mod;
    expect(typeof Comp.setup, 'UnifyPage must have a setup() function').toBe('function');

    // Run setup() — any TDZ violation throws here. The whole point of
    // the eager-computed stub above is that this call mirrors what the
    // production bundle does on first render.
    expect(() => Comp.setup()).not.toThrow();
  });
});
