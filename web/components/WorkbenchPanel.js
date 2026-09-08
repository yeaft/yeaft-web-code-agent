import WorkbenchCapabilityHost from './WorkbenchCapabilityHost.js';
import BrowserPanel from './BrowserPanel.js';
import {
  workbenchConversationId,
  workbenchRouteKey,
  workbenchWorkspaceGeneration,
} from '../utils/workbench-route.js';

export default {
  name: 'WorkbenchPanel',
  components: { WorkbenchCapabilityHost, BrowserPanel },
  template: `
    <div ref="panelRoot" class="workbench-panel" :class="{ expanded: store.workbenchExpanded, maximized: store.workbenchMaximized }" :style="panelStyle">
      <div class="workbench-content" v-show="store.workbenchExpanded">
        <header class="workbench-header">
          <div class="workbench-tab-rail" ref="tabRail">
            <div class="workbench-tabs" role="tablist" ref="tabList" :aria-label="$t('workbench.openItems')">
            <div
              v-for="item in visibleWorkbenchItems"
              :key="item.id"
              class="workbench-item-tab"
              :class="{ active: item.id === activeWorkbenchItemId }"
              :data-workbench-item-id="item.id"
              @contextmenu.prevent="showTabContextMenu($event, item)"
            >
              <button
                type="button"
                class="workbench-item-select"
                role="tab"
                :aria-selected="item.id === activeWorkbenchItemId"
                :aria-controls="'workbench-item-panel'"
                :tabindex="item.id === activeWorkbenchItemId ? 0 : -1"
                :title="item.title || item.label"
                @click="selectWorkbenchItem(item)"
                @keydown="handleWorkbenchTabKeydown($event, item)"
              >
                <span v-if="item.dirty" class="workbench-item-dirty" aria-hidden="true">●</span>
                <span class="workbench-item-label">{{ item.label }}</span>
              </button>
              <button
                type="button"
                class="workbench-item-close"
                :aria-label="$t('workbench.closeItem', { name: item.label })"
                @click="closeWorkbenchItem(item)"
              >×</button>
            </div>
            <div ref="launcherRoot" class="workbench-add-wrap">
              <button
                type="button"
                class="workbench-header-action workbench-add-btn"
                :aria-label="$t('workbench.addItem')"
                :title="$t('workbench.addItem')"
                ref="launcherTrigger"
                :aria-expanded="launcherOpen"
                aria-haspopup="menu"
                @click.stop="toggleLauncher"
                @keydown="handleLauncherButtonKeydown"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              </button>
              <div v-if="launcherOpen" ref="launcherMenu" class="ctx-menu workbench-add-menu" role="menu">
                <button
                  v-for="capability in capabilityCards"
                  :key="capability.id"
                  type="button"
                  role="menuitem"
                  class="ctx-menu-item workbench-add-menu-item"
                  :data-workbench-capability="capability.id"
                  @click="openCapability(capability.id)"
                  @keydown="handleLauncherMenuKeydown"
                >
                  <span>{{ $t(capability.titleKey) }}</span>
                  <small>{{ $t(capability.statusKey) }}</small>
                </button>
              </div>
            </div>
          </div>
          </div>
          <button
            v-if="hiddenWorkbenchItems.length"
            ref="openItemsTrigger"
            type="button"
            class="workbench-header-action workbench-open-items-btn"
            :title="$t('files.showOpenTabs')"
            :aria-label="$t('files.showOpenTabs')"
            :aria-expanded="openItemsMenu.visible"
            aria-haspopup="menu"
            @click.stop="toggleOpenItemsMenu"
            @keydown="handleOpenItemsButtonKeydown"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 6l4 4 4-4z"/></svg>
          </button>
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

        <div id="workbench-item-panel" class="workbench-view-content workbench-tab-content" role="tabpanel">
          <section
            v-if="!activeCapability"
            class="workbench-launcher"
            aria-labelledby="workbench-launcher-title"
          >
            <div class="workbench-launcher-intro">
              <h2 id="workbench-launcher-title">{{ $t('workbench.chooseCapability') }}</h2>
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
                <span class="workbench-capability-status" :class="{ available: capability.ready }">{{ $t(capability.statusKey) }}</span>
              </button>
            </div>
          </section>

          <KeepAlive :max="8">
            <WorkbenchCapabilityHost
              v-if="activeRouteKey"
              :key="workbenchContextKey"
              :active-capability="activeToolCapability"
              :retained-capabilities="routeHostState.openCapabilities"
              :route-props="routeHostState.routeProps"
            />
          </KeepAlive>

          <section
            v-if="activeCapability && activeCapability !== 'browser' && activeCapabilityUnavailable"
            class="workbench-capability-empty"
          >
            <h2>{{ $t(activeCapabilityTitleKey) }}</h2>
            <p>{{ $t('workbench.capabilityUnavailable') }}</p>
            <button type="button" class="btn-secondary" @click="closeCapability">{{ $t('workbench.backToCapabilities') }}</button>
          </section>

          <BrowserPanel
            v-if="activeCapability === 'browser' && canOpenBrowser"
            :key="'browser:' + workbenchContextKey"
            v-bind="routeProps"
            :runtime-ready="hasBrowser"
          />

          <section v-else-if="activeCapability === 'browser'" class="workbench-capability-empty workbench-browser-view">
            <span class="workbench-capability-icon workbench-capability-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 14H4V9h16v9zM4 7V6h16v1H4zm2-1h2v1H6V6z"/></svg>
            </span>
            <h2>{{ $t('workbench.browser') }}</h2>
            <p>{{ $t('workbench.browserUnavailable') }}</p>
            <button type="button" class="btn-secondary" @click="closeCapability">{{ $t('workbench.backToCapabilities') }}</button>
          </section>
        </div>

        <div
          v-if="openItemsMenu.visible"
          ref="openItemsMenuElement"
          class="ctx-menu workbench-open-items-menu"
          :style="{ left: openItemsMenu.x + 'px', top: openItemsMenu.y + 'px' }"
          role="menu"
          @click.stop
        >
          <button
            v-for="item in hiddenWorkbenchItems"
            :key="item.id"
            type="button"
            class="ctx-menu-item workbench-menu-item"
            role="menuitem"
            @click="selectItemFromMenu(item)"
            @keydown="handleOpenItemsMenuKeydown"
          >
            <span class="workbench-menu-item-label"><span v-if="item.dirty" aria-hidden="true">● </span>{{ item.label }}</span>
            <span class="workbench-menu-item-path">{{ item.title || '' }}</span>
          </button>
        </div>

        <div
          v-if="tabContextMenu.visible"
          ref="tabContextMenuElement"
          class="ctx-menu workbench-tab-context-menu"
          :style="{ left: tabContextMenu.x + 'px', top: tabContextMenu.y + 'px' }"
          role="menu"
          @click.stop
        >
          <button type="button" class="ctx-menu-item" role="menuitem" @click="runTabContextAction('current')">{{ $t('files.closeTabAction') }}</button>
          <button type="button" class="ctx-menu-item" role="menuitem" :disabled="workbenchItems.length < 2" @click="runTabContextAction('others')">{{ $t('files.closeOtherTabs') }}</button>
          <div class="ctx-menu-separator"></div>
          <button type="button" class="ctx-menu-item" role="menuitem" :disabled="tabContextMenu.index <= 0" @click="runTabContextAction('left')">{{ $t('files.closeTabsToLeft') }}</button>
          <button type="button" class="ctx-menu-item" role="menuitem" :disabled="tabContextMenu.index >= workbenchItems.length - 1" @click="runTabContextAction('right')">{{ $t('files.closeTabsToRight') }}</button>
          <div class="ctx-menu-separator"></div>
          <button type="button" class="ctx-menu-item" role="menuitem" @click="runTabContextAction('all')">{{ $t('files.closeAllTabs') }}</button>
        </div>
      </div>

      <div class="resize-handle" @mousedown="startResize" @touchstart.prevent="startResize" v-if="store.workbenchExpanded"></div>
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const panelRoot = Vue.ref(null);
    const tabRail = Vue.ref(null);
    const tabList = Vue.ref(null);
    const launcherRoot = Vue.ref(null);
    const launcherOpen = Vue.ref(false);
    const launcherTrigger = Vue.ref(null);
    const launcherMenu = Vue.ref(null);
    const openItemsTrigger = Vue.ref(null);
    const openItemsMenuElement = Vue.ref(null);
    const tabContextMenuElement = Vue.ref(null);
    const openItemsMenu = Vue.reactive({ visible: false, x: 0, y: 0 });
    const tabContextMenu = Vue.reactive({ visible: false, x: 0, y: 0, itemId: '', index: -1 });
    const hiddenWorkbenchItemIds = Vue.ref([]);
    const measuredTabWidths = new Map();
    let tabOverflowUpdatePending = false;
    const instance = Vue.getCurrentInstance();
    const t = (key, params) => instance?.proxy?.$t?.(key, params) || key;

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
    const canSetupBrowser = Vue.computed(() => (
      store.browserRuntimeServerEnabled === true
      && store.browserRuntimeProtocolSupported === true
      && store.browserRuntimeSetupProtocolSupported === true
      && store.hasCapability('browser_runtime_setup')
    ));
    const hasBrowser = Vue.computed(() => (
      store.browserRuntimeServerEnabled === true
      && store.browserRuntimeProtocolSupported === true
      && store.hasCapability('browser_runtime')
      && store.hasCapability('browser_webrtc')
      && (store.hasCapability('browser_capture_tab') || store.hasCapability('browser_capture_cdp'))
    ));
    const canOpenBrowser = Vue.computed(() => hasBrowser.value || canSetupBrowser.value);

    const capabilityCard = (id, titleKey, descriptionKey, available, ready = available) => ({
      id,
      titleKey,
      descriptionKey,
      available,
      ready,
      statusKey: !available ? 'workbench.unavailable'
        : ready ? 'workbench.available'
          : 'workbench.enableRequired',
    });
    const capabilityCards = Vue.computed(() => [
      capabilityCard('terminal', 'workbench.terminal', 'workbench.terminalDescription', hasTerminal.value),
      capabilityCard('git', 'workbench.git', 'workbench.gitDescription', hasExplorer.value),
      capabilityCard('files', 'workbench.files', 'workbench.filesDescription', hasExplorer.value),
      capabilityCard(
        'browser',
        'workbench.browser',
        'workbench.browserDescription',
        canOpenBrowser.value,
        hasBrowser.value,
      ),
    ]);

    const activeCapability = Vue.ref(null);
    const activatedCapabilities = Vue.reactive(new Set());
    const openCapabilities = Vue.reactive([]);
    const openFileItems = Vue.ref([]);
    const activeFilePath = Vue.ref('');
    const capabilityState = new Map();
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
    const routeHostState = Vue.computed(() => ({
      openCapabilities: openCapabilities.filter(capabilityId => {
        const definition = capabilityCards.value.find(capability => capability.id === capabilityId);
        return definition?.available && ['terminal', 'git', 'files'].includes(capabilityId);
      }),
      routeProps: { ...routeProps.value },
    }));

    const capabilityActivationKey = capabilityId => `${workbenchContextKey.value}\u0000${capabilityId}`;
    const isCapabilityActivated = capabilityId => activatedCapabilities.has(capabilityActivationKey(capabilityId));
    const ensureOpenCapability = capabilityId => {
      if (!openCapabilities.includes(capabilityId)) openCapabilities.push(capabilityId);
    };
    const capabilityLabel = capabilityId => {
      const definition = capabilityCards.value.find(capability => capability.id === capabilityId);
      return definition ? t(definition.titleKey) : capabilityId;
    };
    const fileItemId = path => `file:${path}`;
    const workbenchItems = Vue.computed(() => {
      const items = [];
      for (const capabilityId of openCapabilities) {
        if (capabilityId === 'files') {
          for (const file of openFileItems.value) {
            items.push({
              id: fileItemId(file.path),
              capabilityId: 'files',
              path: file.path,
              label: file.name,
              title: file.path,
              dirty: file.isDirty,
            });
          }
          if (openFileItems.value.length === 0) {
            items.push({ id: 'files', capabilityId: 'files', label: capabilityLabel('files') });
          }
          continue;
        }
        items.push({ id: capabilityId, capabilityId, label: capabilityLabel(capabilityId) });
      }
      return items;
    });
    const activeWorkbenchItemId = Vue.computed(() => (
      activeCapability.value === 'files' && activeFilePath.value
        ? fileItemId(activeFilePath.value)
        : activeCapability.value
    ));
    const hiddenWorkbenchItemIdSet = Vue.computed(() => new Set(hiddenWorkbenchItemIds.value));
    const visibleWorkbenchItems = Vue.computed(() => (
      workbenchItems.value.filter(item => (
        item.id === activeWorkbenchItemId.value || !hiddenWorkbenchItemIdSet.value.has(item.id)
      ))
    ));
    const hiddenWorkbenchItems = Vue.computed(() => (
      workbenchItems.value.filter(item => (
        item.id !== activeWorkbenchItemId.value && hiddenWorkbenchItemIdSet.value.has(item.id)
      ))
    ));
    const rememberCapability = () => {
      if (!workbenchContextKey.value) return;
      capabilityState.set(workbenchContextKey.value, {
        activeCapability: activeCapability.value,
        openCapabilities: [...openCapabilities],
      });
    };
    const restoreCapability = () => {
      const saved = capabilityState.get(workbenchContextKey.value);
      openCapabilities.splice(0, openCapabilities.length, ...(saved?.openCapabilities || []));
      const next = saved?.activeCapability || openCapabilities[0] || null;
      if (!next || !capabilityCards.value.some(capability => capability.id === next)) {
        activeCapability.value = null;
        return;
      }
      activatedCapabilities.add(capabilityActivationKey(next));
      activeCapability.value = next;
    };

    const launcherItems = () => (
      [...(launcherMenu.value?.querySelectorAll('.workbench-add-menu-item') || [])]
    );
    const focusLauncherItem = (index = 0) => Vue.nextTick(() => {
      const items = launcherItems();
      items[Math.max(0, Math.min(index, items.length - 1))]?.focus();
    });
    const updateLauncherMenuPosition = async () => {
      await Vue.nextTick();
      const triggerRect = launcherTrigger.value?.getBoundingClientRect();
      const menu = launcherMenu.value;
      if (!triggerRect || !menu) return;
      const margin = 8;
      const menuWidth = Math.min(menu.getBoundingClientRect().width, window.innerWidth - margin * 2);
      const viewportLeft = Math.max(margin, Math.min(triggerRect.left, window.innerWidth - menuWidth - margin));
      menu.style.left = `${viewportLeft}px`;
      menu.style.top = `${triggerRect.bottom + 4}px`;
    };
    const openLauncher = (focusIndex = 0) => {
      launcherOpen.value = true;
      updateLauncherMenuPosition();
      focusLauncherItem(focusIndex);
    };
    const closeLauncher = (restoreFocus = false) => {
      launcherOpen.value = false;
      if (restoreFocus) Vue.nextTick(() => launcherTrigger.value?.focus());
    };
    const toggleLauncher = () => {
      if (launcherOpen.value) closeLauncher();
      else openLauncher();
    };
    const handleLauncherButtonKeydown = event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        openLauncher(0);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        openLauncher(capabilityCards.value.length - 1);
      } else if (event.key === 'Escape' && launcherOpen.value) {
        event.preventDefault();
        closeLauncher(true);
      }
    };
    const handleLauncherMenuKeydown = event => {
      const items = launcherItems();
      const currentIndex = items.indexOf(document.activeElement);
      let nextIndex = currentIndex;
      if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
      else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = items.length - 1;
      else if (event.key === 'Escape') {
        event.preventDefault();
        closeLauncher(true);
        return;
      } else if (event.key === 'Tab') {
        closeLauncher();
        return;
      } else return;
      event.preventDefault();
      items[nextIndex]?.focus();
    };

    const openCapability = capabilityId => {
      if (!capabilityCards.value.some(capability => capability.id === capabilityId)) return false;
      if (['terminal', 'git', 'files'].includes(capabilityId) && !activeRouteKey.value) return false;
      ensureOpenCapability(capabilityId);
      activatedCapabilities.add(capabilityActivationKey(capabilityId));
      activeCapability.value = capabilityId;
      closeLauncher();
      rememberCapability();
      return true;
    };

    const confirmFilesCapabilityClose = ({ routeKey, workspaceGeneration }) => new Promise(resolve => {
      window.dispatchEvent(new CustomEvent('workbench-close-files-capability', {
        detail: { routeKey, workspaceGeneration, resolve },
      }));
    });
    const removeCapability = capabilityId => {
      const index = openCapabilities.indexOf(capabilityId);
      if (index < 0) return false;
      if (activeCapability.value === capabilityId) {
        activeCapability.value = openCapabilities[index + 1] || openCapabilities[index - 1] || null;
      }
      openCapabilities.splice(index, 1);
      activatedCapabilities.delete(capabilityActivationKey(capabilityId));
      if (capabilityId === 'files') {
        openFileItems.value = [];
        activeFilePath.value = '';
      }
      rememberCapability();
      return true;
    };
    const closeCapability = async capabilityId => {
      const target = capabilityId || activeCapability.value;
      const initiatingContextKey = workbenchContextKey.value;
      if (!openCapabilities.includes(target)) return false;
      if (target === 'files' && hasExplorer.value && isCapabilityActivated(target)) {
        const confirmed = await confirmFilesCapabilityClose({
          routeKey: activeRouteKey.value,
          workspaceGeneration: activeWorkspaceGeneration.value,
        });
        if (!confirmed || workbenchContextKey.value !== initiatingContextKey) return false;
      }
      return removeCapability(target);
    };

    const selectWorkbenchItem = item => {
      openCapability(item.capabilityId);
      if (item.path) {
        window.dispatchEvent(new CustomEvent('workbench-select-file-item', {
          detail: {
            routeKey: activeRouteKey.value,
            workspaceGeneration: activeWorkspaceGeneration.value,
            path: item.path,
          },
        }));
      }
    };

    const closeWorkbenchItem = item => {
      if (item.path) {
        window.dispatchEvent(new CustomEvent('workbench-close-file-item', {
          detail: {
            routeKey: activeRouteKey.value,
            workspaceGeneration: activeWorkspaceGeneration.value,
            path: item.path,
          },
        }));
        return;
      }
      closeCapability(item.capabilityId);
    };
    const positionFixedMenu = (target, triggerRect) => {
      const margin = 8;
      const width = target?.offsetWidth || 220;
      const height = target?.offsetHeight || 200;
      return {
        x: Math.max(margin, Math.min(triggerRect.left, window.innerWidth - width - margin)),
        y: Math.max(margin, Math.min(triggerRect.bottom + 4, window.innerHeight - height - margin)),
      };
    };
    const closeWorkbenchMenus = () => {
      openItemsMenu.visible = false;
      tabContextMenu.visible = false;
    };
    const openItemsMenuItems = () => (
      [...(openItemsMenuElement.value?.querySelectorAll('.ctx-menu-item:not(:disabled)') || [])]
    );
    const focusOpenItemsMenuItem = (index = 0) => Vue.nextTick(() => {
      const items = openItemsMenuItems();
      if (!items.length) return;
      const boundedIndex = Math.max(0, Math.min(index, items.length - 1));
      items[boundedIndex]?.focus();
    });
    const openOpenItemsMenu = async (focusIndex = 0) => {
      tabContextMenu.visible = false;
      openItemsMenu.visible = true;
      await Vue.nextTick();
      const rect = openItemsTrigger.value?.getBoundingClientRect();
      if (rect) Object.assign(openItemsMenu, positionFixedMenu(openItemsMenuElement.value, rect));
      focusOpenItemsMenuItem(focusIndex);
    };
    const closeOpenItemsMenu = (restoreFocus = false) => {
      openItemsMenu.visible = false;
      if (restoreFocus) Vue.nextTick(() => openItemsTrigger.value?.focus());
    };
    const toggleOpenItemsMenu = () => {
      if (openItemsMenu.visible) closeOpenItemsMenu();
      else openOpenItemsMenu();
    };
    const handleOpenItemsButtonKeydown = event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        openOpenItemsMenu(0);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        openOpenItemsMenu(hiddenWorkbenchItems.value.length - 1);
      } else if (event.key === 'Escape' && openItemsMenu.visible) {
        event.preventDefault();
        closeOpenItemsMenu(true);
      }
    };
    const handleOpenItemsMenuKeydown = event => {
      const items = openItemsMenuItems();
      const currentIndex = items.indexOf(document.activeElement);
      let nextIndex = currentIndex;
      if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
      else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = items.length - 1;
      else if (event.key === 'Escape') {
        event.preventDefault();
        closeOpenItemsMenu(true);
        return;
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const nextTarget = event.shiftKey
          ? openItemsTrigger.value
          : panelRoot.value?.querySelector('.workbench-maximize-btn:not(:disabled)');
        closeOpenItemsMenu();
        Vue.nextTick(() => nextTarget?.focus());
        return;
      } else return;
      event.preventDefault();
      items[nextIndex]?.focus();
    };
    const selectItemFromMenu = item => {
      selectWorkbenchItem(item);
      closeWorkbenchMenus();
    };
    const showTabContextMenu = async (event, item) => {
      closeLauncher();
      openItemsMenu.visible = false;
      const index = workbenchItems.value.findIndex(candidate => candidate.id === item.id);
      Object.assign(tabContextMenu, {
        visible: true,
        x: event.clientX,
        y: event.clientY,
        itemId: item.id,
        index,
      });
      await Vue.nextTick();
      const width = tabContextMenuElement.value?.offsetWidth || 180;
      const height = tabContextMenuElement.value?.offsetHeight || 220;
      tabContextMenu.x = Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8));
      tabContextMenu.y = Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8));
    };
    const closeFileItems = paths => new Promise(resolve => {
      window.dispatchEvent(new CustomEvent('workbench-close-file-items', {
        detail: {
          routeKey: activeRouteKey.value,
          workspaceGeneration: activeWorkspaceGeneration.value,
          paths,
          resolve,
        },
      }));
    });
    const runTabContextAction = async action => {
      const snapshot = [...workbenchItems.value];
      const targetIndex = snapshot.findIndex(item => item.id === tabContextMenu.itemId);
      if (targetIndex < 0) {
        closeWorkbenchMenus();
        return;
      }
      let targets = [];
      if (action === 'current') targets = [snapshot[targetIndex]];
      else if (action === 'others') targets = snapshot.filter((_, index) => index !== targetIndex);
      else if (action === 'left') targets = snapshot.slice(0, targetIndex);
      else if (action === 'right') targets = snapshot.slice(targetIndex + 1);
      else if (action === 'all') targets = snapshot;
      closeWorkbenchMenus();
      const filePaths = targets.filter(item => item.path).map(item => item.path);
      const closesAllFiles = filePaths.length > 0
        && filePaths.length === openFileItems.value.length
        && openFileItems.value.every(file => filePaths.includes(file.path));
      if (filePaths.length && !await closeFileItems(filePaths)) return;
      if (closesAllFiles) removeCapability('files');
      for (const item of targets.filter(item => !item.path)) {
        if (!await closeCapability(item.capabilityId)) break;
      }
    };
    const focusWorkbenchItem = itemId => Vue.nextTick(() => {
      const tab = [...(tabList.value?.querySelectorAll('.workbench-item-tab') || [])]
        .find(candidate => candidate.dataset.workbenchItemId === itemId);
      tab?.querySelector('.workbench-item-select')?.focus();
    });
    const handleWorkbenchTabKeydown = (event, item) => {
      const items = workbenchItems.value;
      const currentIndex = items.findIndex(candidate => candidate.id === item.id);
      let nextIndex = currentIndex;
      if (event.key === 'ArrowLeft') nextIndex = Math.max(0, currentIndex - 1);
      else if (event.key === 'ArrowRight') nextIndex = Math.min(items.length - 1, currentIndex + 1);
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = items.length - 1;
      else return;
      event.preventDefault();
      const nextItem = items[nextIndex];
      if (!nextItem) return;
      selectWorkbenchItem(nextItem);
      focusWorkbenchItem(nextItem.id);
    };

    const panelWidth = Vue.ref(0);
    const isResizing = Vue.ref(false);
    const hasCustomWidth = Vue.ref(false);
    let panelResizeObserver = null;
    let activeResize = null;

    const cancelActiveResize = () => {
      activeResize?.cleanup();
    };

    Vue.watch(
      workbenchContextKey,
      (contextKey, previousContextKey) => {
        if (contextKey === previousContextKey) return;
        cancelActiveResize();
        if (previousContextKey) {
          capabilityState.set(previousContextKey, {
            activeCapability: activeCapability.value,
            openCapabilities: [...openCapabilities],
          });
          store.rememberWorkbenchPanelState(
            previousContextKey.split('\u0000', 1)[0],
            hasCustomWidth.value ? panelWidth.value : undefined,
          );
        }
        store.restoreWorkbenchPanelState(activeRoute.value);
        const savedWidth = store.workbenchPanelWidthForRoute(activeRoute.value);
        hasCustomWidth.value = savedWidth !== null;
        panelWidth.value = savedWidth || 0;
        openFileItems.value = [];
        activeFilePath.value = '';
        restoreCapability();
      },
      { flush: 'sync', immediate: true },
    );

    // The rendered width can be an animation frame or constrained by flex/mobile
    // layout. Never feed it back into the user's route-scoped width preference.
    const renderedPanelWidth = () => Math.round(
      panelRoot.value?.getBoundingClientRect?.().width || 0,
    );

    const updateTabOverflow = () => {
      const railWidth = Math.floor(
        tabRail.value?.clientWidth || tabRail.value?.getBoundingClientRect?.().width || 0,
      );
      if (railWidth <= 0) return;

      const currentIds = new Set(workbenchItems.value.map(item => item.id));
      for (const itemId of measuredTabWidths.keys()) {
        if (!currentIds.has(itemId)) measuredTabWidths.delete(itemId);
      }
      for (const tab of tabList.value?.querySelectorAll('.workbench-item-tab') || []) {
        const width = Math.ceil(tab.getBoundingClientRect?.().width || tab.offsetWidth || 0);
        if (tab.dataset.workbenchItemId && width > 0) {
          measuredTabWidths.set(tab.dataset.workbenchItemId, width);
        }
      }

      const launcherWidth = Math.ceil(
        launcherRoot.value?.getBoundingClientRect?.().width || launcherRoot.value?.offsetWidth || 32,
      );
      const itemWidth = item => measuredTabWidths.get(item.id) || 96;
      const overflowTriggerExtent = Math.ceil(
        openItemsTrigger.value?.getBoundingClientRect?.().width
          || openItemsTrigger.value?.offsetWidth
          || 32,
      ) + 6;
      const expandedRailWidth = railWidth + (openItemsTrigger.value ? overflowTriggerExtent : 0);
      const allTabsWidth = workbenchItems.value.reduce((total, item) => total + itemWidth(item), 0);
      if (allTabsWidth + launcherWidth <= expandedRailWidth) {
        hiddenWorkbenchItemIds.value = [];
        openItemsMenu.visible = false;
        return;
      }

      const availableWidth = Math.max(
        0,
        expandedRailWidth - launcherWidth - overflowTriggerExtent,
      );
      const activeId = activeWorkbenchItemId.value;
      const visibleIds = new Set();
      let remainingWidth = availableWidth;
      const activeItem = workbenchItems.value.find(item => item.id === activeId);
      if (activeItem) {
        visibleIds.add(activeItem.id);
        remainingWidth -= itemWidth(activeItem);
      }
      for (const item of workbenchItems.value) {
        if (visibleIds.has(item.id)) continue;
        const width = itemWidth(item);
        if (width <= remainingWidth) {
          visibleIds.add(item.id);
          remainingWidth -= width;
        }
      }

      const nextHiddenIds = workbenchItems.value
        .filter(item => !visibleIds.has(item.id))
        .map(item => item.id);
      if (nextHiddenIds.length === hiddenWorkbenchItemIds.value.length
        && nextHiddenIds.every((itemId, index) => itemId === hiddenWorkbenchItemIds.value[index])) return;
      hiddenWorkbenchItemIds.value = nextHiddenIds;
      if (nextHiddenIds.length === 0) openItemsMenu.visible = false;
      Vue.nextTick(scheduleTabOverflowUpdate);
    };

    const scheduleTabOverflowUpdate = () => {
      if (tabOverflowUpdatePending) return;
      tabOverflowUpdatePending = true;
      Vue.nextTick(() => {
        tabOverflowUpdatePending = false;
        updateTabOverflow();
      });
    };

    const notifyWorkbenchResize = () => {
      window.dispatchEvent(new CustomEvent('workbench-panel-resize', {
        detail: { width: renderedPanelWidth() },
      }));
    };

    const keepActiveItemVisible = () => {
      hiddenWorkbenchItemIds.value = hiddenWorkbenchItemIds.value
        .filter(itemId => itemId !== activeWorkbenchItemId.value);
      scheduleTabOverflowUpdate();
    };

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
      cancelActiveResize();
      const isTouch = e.type === 'touchstart';
      const startX = isTouch ? e.touches[0].clientX : e.clientX;
      const resizeContextKey = workbenchContextKey.value;
      const resizeRoute = { ...activeRoute.value };
      isResizing.value = true;
      const startWidth = renderedPanelWidth() || panelWidth.value;
      panelWidth.value = startWidth;
      hasCustomWidth.value = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      let resize = null;

      const cleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        document.removeEventListener('touchcancel', onEnd);
        if (activeResize !== resize) return;
        activeResize = null;
        isResizing.value = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      const isCurrentResize = () => activeResize === resize
        && workbenchContextKey.value === resizeContextKey;

      const onMove = (moveEvent) => {
        if (!isCurrentResize()) return;
        const clientX = isTouch ? moveEvent.touches[0]?.clientX : moveEvent.clientX;
        if (!Number.isFinite(clientX)) return;
        const delta = startX - clientX;
        const maxWidth = Math.max(900, window.innerWidth - 100);
        panelWidth.value = Math.max(280, Math.min(maxWidth, startWidth + delta));
        notifyWorkbenchResize();
      };

      const onEnd = () => {
        if (!isCurrentResize()) {
          cleanup();
          return;
        }
        store.rememberWorkbenchPanelState(resizeRoute, panelWidth.value);
        notifyWorkbenchResize();
        cleanup();
      };

      resize = { cleanup };
      activeResize = resize;
      document.addEventListener(isTouch ? 'touchmove' : 'mousemove', onMove);
      document.addEventListener(isTouch ? 'touchend' : 'mouseup', onEnd);
      if (isTouch) document.addEventListener('touchcancel', onEnd);
    };

    const handleOpenFile = (event) => {
      if (!hasExplorer.value || !activeRouteKey.value) return;
      const eventDetail = { ...(event.detail || {}) };
      const eventRouteKey = eventDetail.workbenchRouteKey
        || (eventDetail.workbenchRoute ? workbenchRouteKey(eventDetail.workbenchRoute) : '');
      const eventWorkspaceGeneration = eventDetail.workspaceGeneration || '';
      if (!eventRouteKey || !eventWorkspaceGeneration
        || eventRouteKey !== activeRouteKey.value
        || eventWorkspaceGeneration !== activeWorkspaceGeneration.value) return;
      const initiatingContextKey = workbenchContextKey.value;
      const targetRouteProps = { ...routeProps.value };
      if (!openCapability('files')) return;
      Vue.nextTick(() => {
        if (workbenchContextKey.value !== initiatingContextKey) return;
        window.dispatchEvent(new CustomEvent('workbench-open-file-in-active-view', {
          detail: {
            ...eventDetail,
            agentId: targetRouteProps.agentId,
            conversationId: targetRouteProps.conversationId,
            workDir: targetRouteProps.workDir,
            workbenchRouteKey: targetRouteProps.routeKey,
            workspaceGeneration: targetRouteProps.workspaceGeneration,
          },
        }));
      });
    };

    const handleFileItemsChanged = event => {
      if (event.detail?.routeKey !== activeRouteKey.value
        || event.detail?.workspaceGeneration !== activeWorkspaceGeneration.value) return;
      openFileItems.value = Array.isArray(event.detail.files) ? event.detail.files : [];
      activeFilePath.value = event.detail.activePath || '';
      if (openFileItems.value.length > 0) ensureOpenCapability('files');
    };
    const handleDocumentClick = event => {
      if (launcherOpen.value
        && !launcherRoot.value?.contains(event.target)
        && !launcherMenu.value?.contains(event.target)) closeLauncher();
      if (openItemsMenu.visible
        && !openItemsTrigger.value?.contains(event.target)
        && !openItemsMenuElement.value?.contains(event.target)) openItemsMenu.visible = false;
      if (tabContextMenu.visible && !tabContextMenuElement.value?.contains(event.target)) {
        tabContextMenu.visible = false;
      }
    };

    Vue.onMounted(() => {
      window.addEventListener('open-file-in-explorer', handleOpenFile);
      window.addEventListener('workbench-file-items-changed', handleFileItemsChanged);
      document.addEventListener('click', handleDocumentClick);
      if (typeof ResizeObserver !== 'undefined' && panelRoot.value) {
        panelResizeObserver = new ResizeObserver(() => {
          scheduleTabOverflowUpdate();
          notifyWorkbenchResize();
        });
        panelResizeObserver.observe(panelRoot.value);
      }
      window.addEventListener('resize', scheduleTabOverflowUpdate);
      scheduleTabOverflowUpdate();
    });

    Vue.watch(
      [activeWorkbenchItemId, workbenchItems],
      () => Vue.nextTick(keepActiveItemVisible),
      { flush: 'post' },
    );

    Vue.onUnmounted(() => {
      cancelActiveResize();
      window.removeEventListener('open-file-in-explorer', handleOpenFile);
      window.removeEventListener('workbench-file-items-changed', handleFileItemsChanged);
      document.removeEventListener('click', handleDocumentClick);
      window.removeEventListener('resize', scheduleTabOverflowUpdate);
      panelResizeObserver?.disconnect();
      panelResizeObserver = null;
    });

    return {
      store,
      panelRoot,
      tabRail,
      tabList,
      launcherRoot,
      launcherTrigger,
      launcherMenu,
      launcherOpen,
      openItemsTrigger,
      openItemsMenuElement,
      openItemsMenu,
      tabContextMenuElement,
      tabContextMenu,
      activeCapability,
      activeCapabilityTitleKey,
      activeCapabilityUnavailable,
      activeToolCapability,
      routeHostState,
      openCapabilities,
      activeWorkbenchItemId,
      workbenchItems,
      visibleWorkbenchItems,
      hiddenWorkbenchItems,
      capabilityCards,
      routeProps,
      activeRouteKey,
      workbenchContextKey,
      openCapability,
      closeCapability,
      toggleLauncher,
      handleLauncherButtonKeydown,
      handleLauncherMenuKeydown,
      closeWorkbenchItem,
      selectWorkbenchItem,
      selectItemFromMenu,
      toggleOpenItemsMenu,
      handleOpenItemsButtonKeydown,
      handleOpenItemsMenuKeydown,
      showTabContextMenu,
      runTabContextAction,
      handleWorkbenchTabKeydown,
      isCapabilityActivated,
      hasTerminal,
      hasExplorer,
      canOpenBrowser,
      hasBrowser,
      panelStyle,
      startResize,
    };
  }
};
