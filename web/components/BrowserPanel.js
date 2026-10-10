import { normalizeBrowserAddress } from '../utils/browser-address.js';

export { normalizeBrowserAddress } from '../utils/browser-address.js';

// Legacy runtime helpers remain exported for existing store consumers/tests.
export function browserPointerPosition(event, element, viewport) {
  const rect = element?.getBoundingClientRect?.();
  const width = Number(viewport?.width) || 1280;
  const height = Number(viewport?.height) || 720;
  if (!rect?.width || !rect?.height) return null;
  const scale = Math.min(rect.width / width, rect.height / height);
  const renderedWidth = width * scale;
  const renderedHeight = height * scale;
  const left = rect.left + (rect.width - renderedWidth) / 2;
  const top = rect.top + (rect.height - renderedHeight) / 2;
  const x = (Number(event.clientX) - left) / scale;
  const y = (Number(event.clientY) - top) / scale;
  if (x < 0 || y < 0 || x > width || y > height) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

export function createBrowserInputController(sendControl) {
  const pressedButtons = new Set();
  const pressedModifiers = new Set();
  let composing = false;
  const send = action => sendControl(action) === true;
  return {
    pointerDown(button, position) {
      if (!position || !send({ type: 'mouse', event: 'down', button, ...position })) return false;
      pressedButtons.add(button);
      return true;
    },
    pointerUp(button, position) {
      if (!pressedButtons.has(button)) return false;
      const sent = send({ type: 'mouse', event: 'up', button, ...(position || {}) });
      if (sent) pressedButtons.delete(button);
      return sent;
    },
    keyDown(event) {
      if (composing || event.isComposing) return false;
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        return send({ type: 'text', text: event.key });
      }
      const modifier = ['Alt', 'Control', 'Meta', 'Shift'].includes(event.key);
      const sent = send({ type: 'key', event: modifier ? 'down' : 'press', key: event.key });
      if (sent && modifier) pressedModifiers.add(event.key);
      return sent;
    },
    keyUp(key) {
      if (!pressedModifiers.has(key)) return false;
      const sent = send({ type: 'key', event: 'up', key });
      if (sent) pressedModifiers.delete(key);
      return sent;
    },
    compositionStart() { composing = true; },
    compositionEnd() { composing = false; },
    inputText(text, isComposing = false) {
      if (isComposing || typeof text !== 'string' || !text) return false;
      composing = false;
      return send({ type: 'text', text });
    },
    reset() {
      if (pressedButtons.size === 0 && pressedModifiers.size === 0) return false;
      const sent = send({ type: 'resetInput' });
      if (sent) {
        pressedButtons.clear();
        pressedModifiers.clear();
      }
      return sent;
    },
    snapshot() {
      return { buttons: [...pressedButtons], modifiers: [...pressedModifiers], composing };
    },
  };
}

export function createBrowserInputSinkHandlers(input) {
  return {
    compositionstart: () => input.compositionStart(),
    compositionend: () => input.compositionEnd(),
    input: event => {
      const target = event.currentTarget;
      const text = target?.value || '';
      if (input.inputText(text, event.isComposing === true) && target) target.value = '';
    },
  };
}

export function browserSessionMatchesSource(snapshot, expected) {
  const actual = snapshot?.sourceRef;
  if (!actual || !expected || actual.kind !== expected.kind) return false;
  if (expected.kind === 'yeaft-session') return actual.sessionId === expected.sessionId;
  if (expected.kind === 'chat-conversation') return actual.conversationId === expected.conversationId;
  return false;
}

// Ephemeral drafts stay inside this component. The Workbench owns URLs across
// capability unmounts; no module-level cache crosses users or workspaces.

const MAX_ROUTES = 100;

function stateForRoute(routeKey, routeStates) {
  let state = routeStates.get(routeKey);
  if (!state) {
    state = Vue.reactive({
      address: '', url: '', error: '', initialUrl: null,
      navigationUrl: null, navigationRevision: null,
    });
  }
  routeStates.delete(routeKey);
  routeStates.set(routeKey, state);
  if (routeStates.size > MAX_ROUTES) routeStates.delete(routeStates.keys().next().value);
  return state;
}

export default {
  name: 'BrowserPanel',
  props: {
    routeKey: { type: String, required: true },
    initialUrl: { type: String, default: '' },
    // Increment revision to explicitly reopen the same URL. The parent owns
    // navigation intent and must provide the intent belonging to routeKey.
    navigation: { type: Object, default: null },
  },
  emits: ['navigate'],
  template: `
    <section class="browser-panel" :aria-label="$t('workbench.browser')">
      <div class="browser-toolbar">
        <form class="browser-location" @submit.prevent="navigate()">
          <input
            v-model="state.address"
            type="text"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            :aria-label="$t('workbench.browserAddressLabel')"
            :placeholder="$t('workbench.browserAddressPlaceholder')"
          >
          <button type="submit" class="btn-ghost browser-go-button" :disabled="!state.address.trim()">
            {{ $t('workbench.browserGo') }}
          </button>
        </form>
        <div class="browser-actions">
          <button type="button" class="btn-ghost" :disabled="!frame" @click="refresh">
            {{ $t('workbench.browserRefresh') }}
          </button>
          <a v-if="frame" class="btn-ghost browser-external" :href="frame.url"
            target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">
            {{ $t('workbench.browserOpenExternal') }}
          </a>
        </div>
      </div>
      <p v-if="state.error" class="browser-error" role="alert">{{ $t(state.error) }}</p>
      <p v-if="loading" class="browser-status" role="status">{{ $t('workbench.browserFrameLoading') }}</p>
      <div class="browser-stage">
        <iframe v-if="frame" :key="frame.key" ref="iframe" class="browser-frame"
          :src="frame.url" :title="$t('workbench.browserFrameLabel')"
          :data-frame-key="frame.key"
          sandbox="allow-scripts allow-forms"
          referrerpolicy="no-referrer"
          @load="onFrameLoad"
        ></iframe>
        <div v-else class="browser-stage-placeholder">
          <p>{{ $t('workbench.browserReadyHint') }}</p>
        </div>
      </div>
    </section>
  `,
  setup(props, { emit }) {
    const routeStates = new Map();
    const state = Vue.shallowRef(null);
    const frame = Vue.shallowRef(null);
    const iframe = Vue.ref(null);
    const loading = Vue.ref(false);
    let activeRoute = null;
    let frameRevision = 0;
    let disposed = false;

    function showFrame(url) {
      // No allow-same-origin: even a redirect to Yeaft cannot access parent
      // credentials or remove the sandbox. Popups and top navigation are denied.
      frame.value = { url, routeKey: activeRoute, key: String(++frameRevision) };
      loading.value = true;
    }

    function navigate(value = state.value.address, notify = true) {
      if (disposed || activeRoute !== props.routeKey) return;
      const url = normalizeBrowserAddress(value);
      if (!url) {
        state.value.error = 'workbench.browserAddressInvalid';
        return;
      }
      state.value.address = url;
      state.value.url = url;
      state.value.error = '';
      showFrame(url);
      if (notify) {
        // Parent remembers the URL without issuing a second navigation.
        state.value.navigationUrl = url;
        state.value.navigationRevision = props.navigation?.revision ?? 0;
        emit('navigate', { routeKey: activeRoute, url });
      }
    }

    function refresh() {
      if (disposed || activeRoute !== props.routeKey || !state.value.url) return;
      showFrame(state.value.url);
    }

    function onFrameLoad(event) {
      // Detached frames may finish after a refresh/route change. A load event
      // (also fired by blocked embeds) is not proof the destination rendered.
      if (disposed || activeRoute !== props.routeKey || !frame.value
        || frame.value.routeKey !== activeRoute || event.currentTarget !== iframe.value
        || event.currentTarget?.dataset.frameKey !== frame.value.key) return;
      loading.value = false;
    }

    Vue.watch(() => [props.routeKey, props.initialUrl, props.navigation?.url, props.navigation?.revision], () => {
      if (activeRoute !== props.routeKey) {
        activeRoute = props.routeKey;
        state.value = stateForRoute(activeRoute, routeStates);
        frame.value = null;
        loading.value = false;
        // Revalidate retained URLs against the current control-plane origin.
        if (state.value.url && normalizeBrowserAddress(state.value.url)) showFrame(state.value.url);
        else state.value.url = '';
      }
      const intent = props.navigation;
      if (intent && typeof intent.url === 'string'
        && (intent.url !== state.value.navigationUrl || intent.revision !== state.value.navigationRevision)) {
        state.value.navigationUrl = intent.url;
        state.value.navigationRevision = intent.revision;
        state.value.address = intent.url;
        navigate(intent.url, false);
      } else if (!intent && props.initialUrl && props.initialUrl !== state.value.initialUrl) {
        state.value.initialUrl = props.initialUrl;
        state.value.address = props.initialUrl;
        navigate(props.initialUrl, false);
      }
    }, { immediate: true });

    Vue.onBeforeUnmount(() => {
      disposed = true;
      frame.value = null;
    });

    return { state, frame, iframe, loading, navigate, refresh, onFrameLoad };
  },
};
