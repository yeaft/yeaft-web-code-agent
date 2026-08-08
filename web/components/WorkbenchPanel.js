import WorkbenchCapabilityHost from './WorkbenchCapabilityHost.js';
import {
  workbenchConversationId,
  workbenchRouteKey,
  workbenchWorkspaceGeneration,
} from '../utils/workbench-route.js';

export default {
  name: 'WorkbenchPanel',
  components: { WorkbenchCapabilityHost },
  template: `
    <div ref="panelRoot" class="workbench-panel" :class="{ expanded: store.workbenchExpanded, maximized: store.workbenchMaximized }" :style="panelStyle">
      <div class="workbench-content" v-if="store.workbenchExpanded">
        <header class="workbench-header">
          <button
            v-if="activeCapability"
            ref="capabilityCloseButton"
            type="button"
            class="workbench-header-action workbench-view-close"
            @click="closeCapability"
            :title="$t('workbench.closeCapability')"
            :aria-label="$t('workbench.closeCapability')"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.42-1.41L7.83 13H20v-2z"/></svg>
          </button>
          <div class="workbench-header-copy">
            <span class="workbench-header-title">{{ $t(activeCapabilityTitleKey) }}</span>
          </div>
          <div class="workbench-header-spacer"></div>
          <button
            type="button"
            class="workbench-header-action workbench-maximize-btn"
            @click="store.toggleWorkbenchMaximized()"
            :title="store.workbenchMaximized ? $t('workbench.restore') : $t('workbench.maximize')"
            :aria-label="store.workbenchMaximized ? $t('workbench.restore') : $t('workbench.maximize')"
          >
            <svg v-if="!store.workbenchMaximized" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zM5 10h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
            <svg v-else viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
          </button>
          <button
            type="button"
            class="workbench-header-action workbench-panel-close"
            @click="store.toggleWorkbench()"
            :title="$t('workbench.collapse')"
            :aria-label="$t('workbench.collapse')"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </header>

        <div class="workbench-view-content workbench-tab-content">
          <section
            v-if="!activeCapability"
            class="workbench-launcher"
            aria-labelledby="workbench-launcher-title"
          >
            <div class="workbench-launcher-intro">
              <h2 ref="launcherTitle" id="workbench-launcher-title" tabindex="-1">{{ $t('workbench.chooseCapability') }}</h2>
              <p>{{ $t('workbench.chooseCapabilityHint') }}</p>
            </div>
            <div class="workbench-capability-grid">
              <button
                v-for="capability in capabilityCards"
                :key="capability.id"
                type="button"
                class="workbench-capability-card"
                :class="{ unavailable: !capability.available }"
                :data-workbench-capability="capability.id"
                @click="openCapability(capability.id)"
              >
                <span class="workbench-capability-icon" aria-hidden="true">
                  <svg v-if="capability.id === 'terminal'" viewBox="0 0 24 24"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10zM7 16l4-4-4-4 1.4-1.4L13.8 12l-5.4 5.4L7 16zm6 0h5v-2h-5v2z"/></svg>
                  <svg v-else-if="capability.id === 'git'" viewBox="0 0 24 24"><path fill="currentColor" d="M21.62 11.11l-8.73-8.73a1.32 1.32 0 00-1.87 0L8.89 4.51l2.35 2.35a1.57 1.57 0 012 2l2.27 2.27a1.57 1.57 0 11-.94.88l-2.12-2.12v5.57a1.57 1.57 0 11-1.29 0V9.72a1.57 1.57 0 01-.85-2.06L8 5.34 2.38 11a1.32 1.32 0 000 1.87l8.73 8.73a1.32 1.32 0 001.87 0l8.64-8.64a1.32 1.32 0 000-1.85z"/></svg>
                  <svg v-else-if="capability.id === 'files'" viewBox="0 0 24 24"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                  <svg v-else viewBox="0 0 24 24"><path fill="currentColor" d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 14H4V9h16v9zM4 7V6h16v1H4zm2-1h2v1H6V6z"/></svg>
                </span>
                <span class="workbench-capability-copy">
                  <span class="workbench-capability-name">{{ $t(capability.titleKey) }}</span>
                  <span class="workbench-capability-description">{{ $t(capability.descriptionKey) }}</span>
                </span>
                <span
                  class="workbench-capability-status"
                  :class="{ available: capability.available }"
                >{{ $t(capability.available ? 'workbench.available' : 'workbench.unavailable') }}</span>
              </button>
            </div>
          </section>

          <WorkbenchCapabilityHost
            :key="workbenchContextKey"
            :active-capability="activeToolCapability"
            :route-props="routeProps"
          />

          <section
            v-if="activeCapability && activeCapability !== 'browser' && activeCapabilityUnavailable"
            class="workbench-capability-empty"
          >
            <h2>{{ $t(activeCapabilityTitleKey) }}</h2>
            <p>{{ $t('workbench.capabilityUnavailable') }}</p>
            <button type="button" class="btn-secondary" @click="closeCapability">{{ $t('workbench.backToCapabilities') }}</button>
          </section>

          <section v-if="activeCapability === 'browser'" class="workbench-capability-empty workbench-browser-view">
            <span class="workbench-capability-icon workbench-capability-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 14H4V9h16v9zM4 7V6h16v1H4zm2-1h2v1H6V6z"/></svg>
            </span>
            <h2>{{ $t('workbench.browser') }}</h2>
            <p>{{ $t(hasBrowser ? 'workbench.browserViewerPending' : 'workbench.browserUnavailable') }}</p>
            <button type="button" class="btn-secondary" @click="closeCapability">{{ $t('workbench.backToCapabilities') }}</button>
          </section>
        </div>
      </div>

      <div class="resize-handle" @mousedown="startResize" @touchstart.prevent="startResize" v-if="store.workbenchExpanded"></div>
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const panelRoot = Vue.ref(null);
    const launcherTitle = Vue.ref(null);
    const capabilityCloseButton = Vue.ref(null);

    const activeRoute = Vue.computed(() => store.activeSessionRoute || null);
    const activeRouteKey = Vue.computed(() => workbenchRouteKey(activeRoute.value));
    const activeWorkDir = Vue.computed(() => store.effectiveWorkDir || '');
    const activeWorkspaceGeneration = Vue.computed(() => (
      workbenchWorkspaceGeneration(activeRouteKey.value, activeWorkDir.value)
    ));
    const workbenchContextKey = Vue.computed(() => `${activeRouteKey.value}\u0000${activeWorkspaceGeneration.value}`);
    const routeProps = Vue.computed(() => ({
      routeKey: activeRouteKey.value,
      runtimeProvider: activeRoute.value?.runtimeProvider || '',
      agentId: activeRoute.value?.agentId || '',
      sessionId: activeRoute.value?.sessionId || '',
      conversationId: workbenchConversationId(activeRouteKey.value),
      workDir: activeWorkDir.value,
      workspaceGeneration: activeWorkspaceGeneration.value,
    }));

    const hasSessionRoutes = Vue.computed(() => (
      store.workbenchRouteProtocolSupported === true
      && store.hasCapability('workbench_session_routes')
    ));
    const hasTerminal = Vue.computed(() => hasSessionRoutes.value && store.hasCapability('terminal'));
    const hasExplorer = Vue.computed(() => hasSessionRoutes.value && store.hasCapability('file_editor'));
    const hasBrowser = Vue.computed(() => (
      store.hasCapability('browser_runtime')
      && store.hasCapability('browser_webrtc')
      && (store.hasCapability('browser_capture_tab') || store.hasCapability('browser_capture_cdp'))
    ));

    const capabilityCards = Vue.computed(() => [
      { id: 'terminal', titleKey: 'workbench.terminal', descriptionKey: 'workbench.terminalDescription', available: hasTerminal.value },
      { id: 'git', titleKey: 'workbench.git', descriptionKey: 'workbench.gitDescription', available: hasExplorer.value },
      { id: 'files', titleKey: 'workbench.files', descriptionKey: 'workbench.filesDescription', available: hasExplorer.value },
      { id: 'browser', titleKey: 'workbench.browser', descriptionKey: 'workbench.browserDescription', available: hasBrowser.value },
    ]);

    const activeCapability = Vue.ref(null);
    const activatedCapabilities = Vue.reactive(new Set());
    const lastCapabilityTrigger = Vue.ref(null);
    const activeCapabilityDefinition = Vue.computed(() => (
      capabilityCards.value.find(capability => capability.id === activeCapability.value) || null
    ));
    const activeCapabilityTitleKey = Vue.computed(() => (
      activeCapabilityDefinition.value?.titleKey || 'workbench.title'
    ));
    const activeCapabilityUnavailable = Vue.computed(() => (
      activeCapabilityDefinition.value?.available === false
    ));
    const activeToolCapability = Vue.computed(() => {
      if (!activeCapabilityDefinition.value?.available) return null;
      return ['terminal', 'git', 'files'].includes(activeCapability.value)
        && isCapabilityActivated(activeCapability.value)
        ? activeCapability.value
        : null;
    });

    const capabilityActivationKey = capabilityId => `${activeRouteKey.value}\u0000${capabilityId}`;
    const isCapabilityActivated = capabilityId => activatedCapabilities.has(capabilityActivationKey(capabilityId));

    const focusCapabilityClose = () => {
      Vue.nextTick(() => capabilityCloseButton.value?.focus());
    };

    const openCapability = (capabilityId, options = {}) => {
      const focus = typeof options === 'boolean'
        ? options
        : options?.focus !== false;
      if (!capabilityCards.value.some(capability => capability.id === capabilityId)) return false;
      if (['terminal', 'git', 'files'].includes(capabilityId) && !activeRouteKey.value) return false;
      lastCapabilityTrigger.value = capabilityId;
      activatedCapabilities.add(capabilityActivationKey(capabilityId));
      activeCapability.value = capabilityId;
      if (focus) focusCapabilityClose();
      return true;
    };

    const closeCapability = (options = {}) => {
      const restoreFocus = typeof options === 'boolean'
        ? options
        : options?.restoreFocus !== false;
      const capabilityId = activeCapability.value || lastCapabilityTrigger.value;
      activeCapability.value = null;
      if (!restoreFocus || !capabilityId) return;
      Vue.nextTick(() => {
        panelRoot.value
          ?.querySelector(`[data-workbench-capability="${capabilityId}"]`)
          ?.focus();
      });
    };

    Vue.watch(
      () => store.workbenchExpanded,
      (expanded, wasExpanded) => {
        if (expanded && !wasExpanded) closeCapability({ restoreFocus: false });
      },
      { flush: 'sync' },
    );

    Vue.watch(
      workbenchContextKey,
      (contextKey, previousContextKey) => {
        if (contextKey === previousContextKey) return;
        const focusWasInsideWorkbench = !!panelRoot.value?.contains(document.activeElement);
        closeCapability({ restoreFocus: false });
        activatedCapabilities.clear();
        lastCapabilityTrigger.value = null;
        if (focusWasInsideWorkbench) Vue.nextTick(() => launcherTitle.value?.focus());
      },
      { flush: 'sync' },
    );

    const panelWidth = Vue.ref(0);
    const isResizing = Vue.ref(false);
    const hasCustomWidth = Vue.ref(false);

    const panelStyle = Vue.computed(() => {
      if (!store.workbenchExpanded) return {};
      if (store.workbenchMaximized) return {};
      if (window.innerWidth <= 768) return {};
      if (!hasCustomWidth.value) {
        if (isResizing.value) return { transition: 'none' };
        return {};
      }
      const style = { width: panelWidth.value + 'px' };
      if (isResizing.value) style.transition = 'none';
      return style;
    });

    const startResize = (e) => {
      e.preventDefault();
      const isTouch = e.type === 'touchstart';
      const startX = isTouch ? e.touches[0].clientX : e.clientX;
      isResizing.value = true;
      if (!hasCustomWidth.value) {
        const el = e.target.closest('.workbench-panel');
        if (el) panelWidth.value = el.offsetWidth;
        hasCustomWidth.value = true;
      }
      const startWidth = panelWidth.value;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (moveEvent) => {
        const clientX = isTouch ? moveEvent.touches[0].clientX : moveEvent.clientX;
        const delta = startX - clientX;
        const maxWidth = Math.max(900, window.innerWidth - 100);
        panelWidth.value = Math.max(280, Math.min(maxWidth, startWidth + delta));
      };

      const onEnd = () => {
        isResizing.value = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
      };

      document.addEventListener(isTouch ? 'touchmove' : 'mousemove', onMove);
      document.addEventListener(isTouch ? 'touchend' : 'mouseup', onEnd);
    };

    const handleOpenFile = (event) => {
      if (!hasExplorer.value || !activeRouteKey.value) return;
      const eventRouteKey = event.detail?.workbenchRoute
        ? workbenchRouteKey(event.detail.workbenchRoute)
        : activeRouteKey.value;
      if (eventRouteKey !== activeRouteKey.value) return;
      if (!openCapability('files')) return;
      Vue.nextTick(() => {
        window.dispatchEvent(new CustomEvent('workbench-open-file-in-active-view', {
          detail: {
            ...(event.detail || {}),
            agentId: routeProps.value.agentId,
            conversationId: routeProps.value.conversationId,
            workDir: routeProps.value.workDir,
            workbenchRouteKey: activeRouteKey.value,
          },
        }));
      });
    };

    Vue.onMounted(() => {
      window.addEventListener('open-file-in-explorer', handleOpenFile);
    });

    Vue.onUnmounted(() => {
      window.removeEventListener('open-file-in-explorer', handleOpenFile);
    });

    return {
      store,
      panelRoot,
      launcherTitle,
      capabilityCloseButton,
      activeCapability,
      activeCapabilityTitleKey,
      activeCapabilityUnavailable,
      activeToolCapability,
      capabilityCards,
      routeProps,
      workbenchContextKey,
      openCapability,
      closeCapability,
      isCapabilityActivated,
      hasTerminal,
      hasExplorer,
      hasBrowser,
      panelStyle,
      startResize,
    };
  }
};
