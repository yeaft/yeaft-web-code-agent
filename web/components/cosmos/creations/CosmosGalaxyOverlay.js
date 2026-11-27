/**
 * CosmosGalaxyOverlay — L1 Galaxy HUD, Star Catalog, L2 Orbital Inspector & Omni-Ignite Dock.
 *
 * Strictly uses Pinia `useCreationsStore`, `$t()` i18n keys, and CSS tokens from `creations.css`.
 */
import { useCreationsStore } from '../../../stores/creations.js';
import { t } from '../../../utils/i18n.js';
import { COSMOS_BOOKS_KEY } from '../../../cosmos/constants.js';

const LEGACY_BOOKS_DISMISSED_KEY = 'yeaft-cosmos-legacy-books-dismissed-v1';

function readLegacyGalaxyBookmarks() {
  try {
    if (typeof localStorage === 'undefined') return [];
    if (localStorage.getItem(LEGACY_BOOKS_DISMISSED_KEY) === '1') return [];
    const raw = localStorage.getItem(COSMOS_BOOKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((b) => b && typeof b.title === 'string' && b.title.trim());
  } catch {
    return [];
  }
}

const KIND_FILTERS = [
  { id: 'all', labelKey: 'creation.kind.all', swatch: null },
  { id: 'book', labelKey: 'creation.celestial.book', swatch: 'is-book' },
  { id: 'deck', labelKey: 'creation.celestial.deck', swatch: 'is-deck' },
  { id: 'gallery', labelKey: 'creation.celestial.gallery', swatch: 'is-gallery' },
  { id: 'video', labelKey: 'creation.celestial.video', swatch: 'is-video' },
];

const IGNITE_KINDS = [
  { id: 'book', labelKey: 'creation.kind.book', swatch: 'is-book' },
  { id: 'deck', labelKey: 'creation.kind.deck', swatch: 'is-deck' },
  { id: 'gallery', labelKey: 'creation.kind.gallery', swatch: 'is-gallery' },
  { id: 'video', labelKey: 'creation.kind.video', swatch: 'is-video' },
];

const STARTER_EXAMPLES = [
  { id: 'book', kind: 'book', labelKey: 'creation.galaxy.exampleBook', swatch: 'is-book' },
  { id: 'deck', kind: 'deck', labelKey: 'creation.galaxy.exampleDeck', swatch: 'is-deck' },
  { id: 'video', kind: 'video', labelKey: 'creation.galaxy.exampleVideo', swatch: 'is-video' },
];

export default {
  name: 'CosmosGalaxyOverlay',
  props: {
    agents: {
      type: Array,
      default: () => [],
    },
    visible: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['open-creation', 'toast'],
  template: `
    <div
      v-if="visible"
      class="creation-galaxy-overlay"
      role="region"
      :aria-label="$t('cosmos.scale.galaxy')"
    >
      <!-- Full-Galaxy Drag & Drop Gravity Ring -->
      <div v-if="isDraggingFiles" class="creation-drop-overlay" aria-live="polite">
        <div class="creation-drop-ring" aria-hidden="true">✦</div>
        <div class="creation-drop-label">{{ $t('creation.galaxy.igniteDropHint') }}</div>
      </div>

      <!-- Top Galaxy HUD Bar -->
      <div>
        <div class="creation-galaxy-hud">
          <!-- Agent Selector -->
          <div class="creation-hud-group" :aria-label="$t('creation.galaxy.agentLabel')">
            <div v-if="agents.length" class="creation-hud-agents" role="tablist">
              <button
                v-for="ag in agents"
                :key="ag.id"
                type="button"
                role="tab"
                class="creation-agent-pill"
                :class="{ 'is-active': creationsStore.selectedAgentId === ag.id }"
                :aria-selected="creationsStore.selectedAgentId === ag.id"
                @click="selectAgent(ag.id)"
              >
                <span class="creation-agent-dot" :class="{ 'is-online': ag.online }"></span>
                <span>{{ ag.name || ag.id }}</span>
                <span class="creation-agent-count">{{ creationsStore.creationsForAgent(ag.id).length }}</span>
              </button>
            </div>
            <span v-else class="creation-agent-count">{{ $t('creation.galaxy.noAgents') }}</span>
          </div>

          <span class="creation-hud-divider" aria-hidden="true"></span>

          <!-- Kind Filter Pills -->
          <div class="creation-hud-group">
            <div class="creation-kind-pills" role="group">
              <button
                v-for="k in kindFilters"
                :key="k.id"
                type="button"
                class="creation-kind-pill"
                :class="{ 'is-active': creationsStore.kindFilter === k.id }"
                @click="creationsStore.kindFilter = k.id"
              >
                <span v-if="k.swatch" class="creation-kind-swatch" :class="k.swatch"></span>
                <span>{{ $t(k.labelKey) }}</span>
              </button>
            </div>
          </div>

          <!-- Search + View Mode -->
          <div class="creation-hud-group">
            <label class="creation-hud-search">
              <svg class="creation-hud-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <circle cx="7" cy="7" r="4.8" />
                <path d="M10.8 10.8L14 14" stroke-linecap="round" />
              </svg>
              <input
                ref="searchInputRef"
                v-model="creationsStore.searchQuery"
                type="search"
                class="creation-hud-search-input"
                :placeholder="$t('creation.galaxy.searchPlaceholder')"
                :aria-label="$t('creation.galaxy.searchPlaceholder')"
              />
            </label>

            <div class="creation-view-toggle" role="group">
              <button
                type="button"
                class="creation-view-btn"
                :class="{ 'is-active': creationsStore.viewMode === 'galaxy' }"
                @click="creationsStore.viewMode = 'galaxy'"
              >
                {{ $t('creation.galaxy.viewMap') }}
              </button>
              <button
                type="button"
                class="creation-view-btn"
                :class="{ 'is-active': creationsStore.viewMode === 'catalog' }"
                @click="creationsStore.viewMode = 'catalog'"
              >
                {{ $t('creation.galaxy.viewCatalog') }}
              </button>
            </div>
          </div>
        </div>

        <!-- Status Banners (Offline / Unsupported / Error / Legacy Import) -->
        <div v-if="selectedAgent && !selectedAgent.online" class="creation-galaxy-banner" role="status">
          <span>{{ $t('creation.galaxy.offlineReadonly') }}</span>
        </div>
        <div v-else-if="isUnsupportedAgent" class="creation-galaxy-banner is-error" role="status">
          <span>{{ $t('creation.galaxy.unsupportedAgent') }}</span>
        </div>
        <div v-else-if="agentState.error" class="creation-galaxy-banner is-error" role="alert">
          <span>{{ agentState.error }}</span>
        </div>
        <div
          v-if="legacyBookmarks.length > 0"
          class="creation-galaxy-banner creation-legacy-banner"
          role="status"
        >
          <span>{{ $t('creation.galaxy.legacyFound', { count: legacyBookmarks.length }) }}</span>
          <div class="creation-legacy-banner-actions">
            <button
              type="button"
              class="creation-glass-btn is-primary"
              :disabled="!canMutateSelectedAgent || importingLegacy"
              @click="importLegacyBookmarks"
            >
              {{ $t('creation.galaxy.legacyImport') }}
            </button>
            <button
              type="button"
              class="creation-glass-btn"
              :disabled="importingLegacy"
              @click="dismissLegacyBookmarks"
            >
              {{ $t('creation.galaxy.legacyDismiss') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Middle Area: Catalog Grid OR Empty Onboarding -->
      <div class="creation-galaxy-middle">
        <!-- Star Catalog Grid -->
        <div v-if="creationsStore.viewMode === 'catalog'" class="creation-catalog-panel">
          <div v-if="filteredCreations.length" class="creation-catalog-grid">
            <article
              v-for="item in filteredCreations"
              :key="item.id"
              class="creation-catalog-card"
              tabindex="0"
              @click="openCreationItem(item)"
              @keydown.enter="openCreationItem(item)"
            >
              <div class="creation-card-head">
                <span class="creation-kind-badge">
                  <span class="creation-kind-swatch" :class="'is-' + (item.kind || 'book')"></span>
                  <span>{{ $t('creation.celestial.' + (item.kind || 'book')) }}</span>
                </span>
                <span class="creation-status-pill" :class="'is-' + displayStatusFor(item)">
                  {{ $t('creation.status.' + displayStatusFor(item)) }}
                </span>
              </div>

              <div class="creation-card-title">{{ item.title || $t('creation.kind.' + (item.kind || 'book')) }}</div>
              <div class="creation-card-summary">{{ item.summary || '' }}</div>

              <div class="creation-card-stats">
                <span>{{ $t('creation.inspector.units', { count: item.unitCount || 0 }) }}</span>
                <span>·</span>
                <span>{{ $t('creation.inspector.words', { count: formatCount(item.wordCount || 0) }) }}</span>
                <span>·</span>
                <span>{{ $t('creation.inspector.sources', { count: item.sourceCount || 0 }) }}</span>
              </div>

              <div class="creation-card-actions" @click.stop>
                <div class="creation-card-btn-row">
                  <button
                    type="button"
                    class="creation-glass-btn is-primary"
                    @click="openCreationItem(item, defaultModeFor(item))"
                  >
                    {{ defaultModeFor(item) === 'read' ? $t('creation.inspector.landRead') : $t('creation.inspector.enterStudio') }}
                  </button>
                  <button
                    v-if="defaultModeFor(item) === 'read'"
                    type="button"
                    class="creation-glass-btn"
                    @click="openCreationItem(item, 'studio')"
                  >
                    {{ $t('creation.inspector.enterStudio') }}
                  </button>
                </div>
                <button
                  type="button"
                  class="creation-glass-btn is-danger"
                  :disabled="!canMutateSelectedAgent"
                  @click="confirmAndDelete(item)"
                >
                  {{ $t('creation.inspector.delete') }}
                </button>
              </div>
            </article>
          </div>

          <div v-else-if="!agentState.loading" class="creation-galaxy-empty" style="margin: 0 auto;">
            <div class="creation-galaxy-empty-title">{{ $t('creation.galaxy.emptyTitle') }}</div>
            <div class="creation-galaxy-empty-sub">{{ $t('creation.galaxy.emptySubtitle') }}</div>
            <div class="creation-example-chips">
              <button
                v-for="ex in starterExamples"
                :key="ex.id"
                type="button"
                class="creation-example-chip"
                @click="applyStarterExample(ex)"
              >
                <span class="creation-kind-swatch" :class="ex.swatch"></span>
                <span>{{ $t(ex.labelKey) }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Galaxy Map Empty State (only when loaded & 0 creations & no search filter) -->
        <div
          v-else-if="showGalaxyEmptyState"
          class="creation-galaxy-empty"
        >
          <div class="creation-galaxy-empty-title">{{ $t('creation.galaxy.emptyTitle') }}</div>
          <div class="creation-galaxy-empty-sub">{{ $t('creation.galaxy.emptySubtitle') }}</div>
          <div class="creation-example-chips">
            <button
              v-for="ex in starterExamples"
              :key="ex.id"
              type="button"
              class="creation-example-chip"
              @click="applyStarterExample(ex)"
            >
              <span class="creation-kind-swatch" :class="ex.swatch"></span>
              <span>{{ $t(ex.labelKey) }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- L2 Orbital Inspector Glass Card -->
      <aside
        v-if="inspectedCreation"
        class="creation-inspector-card"
        role="dialog"
        :aria-label="inspectedCreation.title || $t('creation.kind.' + (inspectedCreation.kind || 'book'))"
      >
        <div class="creation-inspector-head">
          <div class="creation-hud-group">
            <span class="creation-kind-badge">
              <span class="creation-kind-swatch" :class="'is-' + (inspectedCreation.kind || 'book')"></span>
              <span>{{ $t('creation.celestial.' + (inspectedCreation.kind || 'book')) }}</span>
            </span>
            <span class="creation-status-pill" :class="'is-' + displayStatusFor(inspectedCreation)">
              {{ $t('creation.status.' + displayStatusFor(inspectedCreation)) }}
            </span>
          </div>
          <button
            type="button"
            class="creation-inspector-close"
            :aria-label="$t('creation.inspector.close')"
            @click="closeInspector"
          >
            ✕
          </button>
        </div>

        <div class="creation-inspector-title">
          {{ inspectedCreation.title || $t('creation.kind.' + (inspectedCreation.kind || 'book')) }}
        </div>
        <div v-if="inspectedCreation.summary" class="creation-inspector-summary">
          {{ inspectedCreation.summary }}
        </div>

        <div class="creation-inspector-metrics">
          <div class="creation-inspector-metric">
            {{ $t('creation.inspector.units', { count: inspectedCreation.unitCount || 0 }) }}
          </div>
          <div class="creation-inspector-metric">
            {{ $t('creation.inspector.words', { count: formatCount(inspectedCreation.wordCount || 0) }) }}
          </div>
          <div class="creation-inspector-metric">
            {{ $t('creation.inspector.sources', { count: inspectedCreation.sourceCount || 0 }) }}
          </div>
          <div class="creation-inspector-metric">
            {{ $t('creation.inspector.proposals', { count: inspectedCreation.pendingProposalCount || 0 }) }}
          </div>
        </div>

        <div
          v-if="inspectedCreation.activeRunStatus === 'running' || inspectedCreation.status === 'generating' || inspectedCreation.activeRunProgress != null"
          class="creation-inspector-progress"
        >
          <div class="creation-card-stats">
            <span>{{ $t('creation.interior.runningBatch') }}</span>
            <span>{{ Math.round((inspectedCreation.activeRunProgress || 0) * 100) }}%</span>
          </div>
          <div class="creation-progress-track">
            <div
              class="creation-progress-fill"
              :style="{ width: Math.max(6, Math.min(100, Math.round((inspectedCreation.activeRunProgress || 0) * 100))) + '%' }"
            ></div>
          </div>
        </div>

        <div class="creation-inspector-actions">
          <button
            type="button"
            class="creation-glass-btn is-primary"
            @click="openCreationItem(inspectedCreation, defaultModeFor(inspectedCreation))"
          >
            {{ defaultModeFor(inspectedCreation) === 'read' ? $t('creation.inspector.landRead') : $t('creation.inspector.enterStudio') }}
          </button>
          <button
            v-if="defaultModeFor(inspectedCreation) === 'read'"
            type="button"
            class="creation-glass-btn"
            @click="openCreationItem(inspectedCreation, 'studio')"
          >
            {{ $t('creation.inspector.enterStudio') }}
          </button>
          <button
            type="button"
            class="creation-glass-btn is-danger"
            :disabled="!canMutateSelectedAgent"
            @click="confirmAndDelete(inspectedCreation)"
          >
            {{ $t('creation.inspector.delete') }}
          </button>
        </div>
      </aside>

      <!-- Bottom Floating Omni-Ignite Dock -->
      <form
        class="creation-ignite-dock"
        :class="{ 'is-expanded': isIgniteExpanded }"
        @submit.prevent="submitIgnite"
      >
        <div class="creation-ignite-row">
          <input
            ref="igniteInputRef"
            v-model="creationsStore.igniteDraft.prompt"
            type="text"
            class="creation-ignite-input"
            :placeholder="$t('creation.galaxy.ignitePlaceholder')"
            :disabled="!canMutateSelectedAgent || creationsStore.igniteDraft.submitting"
            @focus="creationsStore.igniteDraft.open = true"
          />

          <input
            ref="fileInputRef"
            type="file"
            multiple
            style="display: none"
            @change="onFilePicked"
          />
          <button
            type="button"
            class="creation-glass-btn"
            :disabled="!canMutateSelectedAgent || creationsStore.igniteDraft.submitting"
            :title="$t('creation.galaxy.igniteAttach')"
            :aria-label="$t('creation.galaxy.igniteAttach')"
            @click="triggerFilePicker"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d="M13.2 7.4L7.4 13.2a3.3 3.3 0 01-4.7-4.7l6.2-6.2a2.2 2.2 0 013.1 3.1L6 11.4a1.1 1.1 0 01-1.6-1.6l5.4-5.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>

          <button
            type="submit"
            class="creation-glass-btn is-primary"
            :disabled="!canSubmitIgnite"
          >
            {{ creationsStore.igniteDraft.submitting ? $t('common.loading') : $t('creation.galaxy.igniteSubmit') }}
          </button>
        </div>

        <!-- Pending Attached File Chips -->
        <div v-if="creationsStore.igniteDraft.pendingFiles.length" class="creation-ignite-files">
          <span
            v-for="(file, idx) in creationsStore.igniteDraft.pendingFiles"
            :key="(file.name || 'file') + '-' + idx"
            class="creation-file-chip"
          >
            <span class="creation-file-chip-name">{{ file.name }}</span>
            <button
              type="button"
              class="creation-file-chip-remove"
              :aria-label="$t('common.delete')"
              @click="removePendingFile(idx)"
            >
              ✕
            </button>
          </span>
        </div>

        <!-- Expanded Title & Kind Selector Row -->
        <div v-if="isIgniteExpanded" class="creation-ignite-extra">
          <input
            v-model="creationsStore.igniteDraft.title"
            type="text"
            class="creation-ignite-title-input"
            :placeholder="$t('creation.galaxy.igniteTitle')"
            :disabled="!canMutateSelectedAgent || creationsStore.igniteDraft.submitting"
          />
        </div>

        <div class="creation-ignite-footer">
          <div class="creation-ignite-kinds" role="group">
            <button
              v-for="k in igniteKinds"
              :key="k.id"
              type="button"
              class="creation-ignite-kind-btn"
              :class="{ 'is-active': creationsStore.igniteDraft.kind === k.id }"
              @click="creationsStore.igniteDraft.kind = k.id"
            >
              <span class="creation-kind-swatch" :class="k.swatch"></span>
              <span>{{ $t(k.labelKey) }}</span>
            </button>
          </div>

          <span v-if="creationsStore.igniteDraft.error" class="creation-ignite-error" role="alert">
            {{ creationsStore.igniteDraft.error }}
          </span>
          <span v-else-if="selectedAgent" class="creation-agent-count">
            {{ $t('creation.galaxy.totalCount', { count: agentState.list.length }) }}
          </span>
        </div>
      </form>
    </div>
  `,
  setup(props, { emit }) {
    const creationsStore = useCreationsStore();
    const searchInputRef = Vue.ref(null);
    const igniteInputRef = Vue.ref(null);
    const fileInputRef = Vue.ref(null);
    const isDraggingFiles = Vue.ref(false);
    const legacyBookmarks = Vue.ref(readLegacyGalaxyBookmarks());
    const importingLegacy = Vue.ref(false);
    let dragDepth = 0;

    const selectedAgent = Vue.computed(() => {
      const id = creationsStore.selectedAgentId;
      if (!id) return null;
      return (props.agents || []).find((a) => a && a.id === id) || null;
    });

    const agentState = Vue.computed(() => creationsStore.currentAgentState);
    const filteredCreations = Vue.computed(() => creationsStore.currentAgentCreations);

    const isUnsupportedAgent = Vue.computed(() => {
      const ag = selectedAgent.value;
      if (!ag) return false;
      if (ag.online && Array.isArray(ag.capabilities)) {
        return !ag.capabilities.includes('creations');
      }
      if (ag.capabilities && !Array.isArray(ag.capabilities) && ag.capabilities.creations === false) {
        return true;
      }
      const err = String(agentState.value.error || '').toLowerCase();
      return err.includes('unsupported') && err.includes('creation');
    });

    const canMutateSelectedAgent = Vue.computed(() => (
      Boolean(selectedAgent.value && selectedAgent.value.online && !isUnsupportedAgent.value)
    ));

    const inspectedCreation = Vue.computed(() => {
      const target = creationsStore.inspectorTarget;
      if (!target || !target.creationId) return null;
      const list = creationsStore.creationsForAgent(target.agentId);
      return list.find((c) => c && c.id === target.creationId) || null;
    });

    const isIgniteExpanded = Vue.computed(() => {
      const d = creationsStore.igniteDraft;
      return Boolean(d.open || d.title.trim() || d.prompt.trim() || d.pendingFiles.length);
    });

    const canSubmitIgnite = Vue.computed(() => {
      const d = creationsStore.igniteDraft;
      if (!canMutateSelectedAgent.value || d.submitting) return false;
      return Boolean(d.title.trim() || d.prompt.trim() || d.pendingFiles.length);
    });

    const showGalaxyEmptyState = Vue.computed(() => {
      if (creationsStore.viewMode !== 'galaxy') return false;
      if (!selectedAgent.value || agentState.value.loading) return false;
      if (creationsStore.searchQuery.trim()) return false;
      return agentState.value.loaded && agentState.value.list.length === 0;
    });

    function ensureSelectedAgent() {
      const list = props.agents || [];
      if (!list.length) return;
      const currentExists = list.some((a) => a && a.id === creationsStore.selectedAgentId);
      if (currentExists) {
        if (props.visible && !creationsStore.byAgent[creationsStore.selectedAgentId]?.loaded) {
          creationsStore.selectGalaxyAgent(creationsStore.selectedAgentId).catch(() => {});
        }
        return;
      }
      const preferred = list.find((a) => a && a.online) || list[0];
      if (preferred?.id) {
        creationsStore.selectGalaxyAgent(preferred.id).catch(() => {});
      }
    }

    Vue.watch(
      () => [props.visible, (props.agents || []).map((a) => `${a.id}:${a.online}`).join(',')],
      ([vis]) => {
        if (vis) ensureSelectedAgent();
      },
      { immediate: true },
    );

    function displayStatusFor(item) {
      if (!item) return 'active';
      if (item.activeRunStatus === 'running') return 'generating';
      return item.status || 'active';
    }

    function dismissLegacyBookmarks() {
      try {
        localStorage.setItem(LEGACY_BOOKS_DISMISSED_KEY, '1');
      } catch {
        // ignore storage errors
      }
      legacyBookmarks.value = [];
    }

    async function importLegacyBookmarks() {
      if (!canMutateSelectedAgent.value || importingLegacy.value || legacyBookmarks.value.length === 0) return;
      const agentId = creationsStore.selectedAgentId;
      importingLegacy.value = true;
      let imported = 0;
      try {
        const toImport = legacyBookmarks.value.slice();
        for (const bm of toImport) {
          const title = String(bm.title || '').trim();
          if (!title) continue;
          const celestial = (Number.isFinite(bm.arm) || Number.isFinite(bm.r) || Number.isFinite(bm.theta))
            ? {
                ...(Number.isFinite(bm.arm) ? { arm: bm.arm } : {}),
                ...(Number.isFinite(bm.r) ? { r: bm.r } : {}),
                ...(Number.isFinite(bm.theta) ? { theta: bm.theta } : {}),
              }
            : undefined;
          await creationsStore.createCreation(agentId, {
            title,
            kind: 'book',
            autoPlan: false,
            ...(celestial ? { celestial } : {}),
          });
          imported += 1;
        }
        dismissLegacyBookmarks();
        emit('toast', t('creation.galaxy.legacyImported', { count: imported }));
      } catch (err) {
        emit('toast', err?.message || 'Import failed');
      } finally {
        importingLegacy.value = false;
      }
    }

    function selectAgent(agentId) {
      creationsStore.selectGalaxyAgent(agentId).catch(() => {});
    }

    function defaultModeFor(item) {
      if (!item) return 'studio';
      return (item.hasReadableContent || (item.readableUnitCount || 0) > 0) ? 'read' : 'studio';
    }

    function openCreationItem(item, mode) {
      if (!item || !item.id) return;
      const agentId = item.agentId || creationsStore.selectedAgentId;
      emit('open-creation', {
        agentId,
        creationId: item.id,
        mode: mode || defaultModeFor(item),
      });
    }

    function closeInspector() {
      creationsStore.inspectorTarget = null;
    }

    function formatCount(n) {
      const num = Number(n || 0);
      if (num >= 10000) return `${(num / 10000).toFixed(1)}w`;
      if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
      return String(num);
    }

    function applyStarterExample(ex) {
      creationsStore.igniteDraft.kind = ex.kind;
      creationsStore.igniteDraft.open = true;
      Vue.nextTick(() => {
        igniteInputRef.value?.focus?.();
      });
    }

    function triggerFilePicker() {
      fileInputRef.value?.click?.();
    }

    function appendPendingFiles(fileList) {
      const files = Array.from(fileList || []).filter(Boolean);
      if (!files.length) return;
      creationsStore.igniteDraft.pendingFiles = [
        ...creationsStore.igniteDraft.pendingFiles,
        ...files,
      ];
      creationsStore.igniteDraft.open = true;
    }

    function onFilePicked(e) {
      appendPendingFiles(e?.target?.files);
      if (e?.target) e.target.value = '';
    }

    function removePendingFile(idx) {
      const next = creationsStore.igniteDraft.pendingFiles.slice();
      next.splice(idx, 1);
      creationsStore.igniteDraft.pendingFiles = next;
    }

    async function submitIgnite() {
      if (!canSubmitIgnite.value) return;
      const draft = creationsStore.igniteDraft;
      const agentId = creationsStore.selectedAgentId;
      draft.submitting = true;
      draft.error = null;

      try {
        const promptText = draft.prompt.trim();
        const fallbackTitle = promptText
          ? promptText.split(/\r?\n/)[0].trim().slice(0, 48)
          : (draft.pendingFiles[0]?.name ? draft.pendingFiles[0].name.replace(/\.[^.]+$/, '').slice(0, 48) : '');
        const res = await creationsStore.createCreation(agentId, {
          title: draft.title.trim() || fallbackTitle || undefined,
          kind: draft.kind || 'book',
          prompt: promptText || undefined,
          rawFiles: draft.pendingFiles.slice(),
          celestial: draft.celestial || undefined,
        });
        const created = res?.creation || res;
        if (res?.initialTurnError) {
          emit('toast', res.initialTurnError);
        }
        draft.title = '';
        draft.prompt = '';
        draft.pendingFiles = [];
        draft.celestial = null;
        draft.open = false;
        draft.error = null;

        if (created && created.id) {
          emit('open-creation', {
            agentId,
            creationId: created.id,
            mode: 'studio',
          });
        }
      } catch (err) {
        draft.error = err?.message || 'Failed to ignite creation';
      } finally {
        draft.submitting = false;
      }
    }

    async function confirmAndDelete(item) {
      if (!item || !item.id || !canMutateSelectedAgent.value) return;
      const agentId = item.agentId || creationsStore.selectedAgentId;
      const title = item.title || item.id;
      const confirmed = typeof window !== 'undefined'
        ? window.confirm(t('creation.inspector.confirmDelete', { title }))
        : true;
      if (!confirmed) return;

      try {
        await creationsStore.deleteCreation(agentId, item.id);
      } catch (err) {
        emit('toast', err?.message || 'Delete failed');
      }
    }

    // Window keyboard shortcuts (⌘K search, Escape close inspector) & full-galaxy drag/drop
    function hasFiles(e) {
      const types = e?.dataTransfer?.types;
      if (!types) return false;
      return Array.from(types).includes('Files');
    }

    function onWindowDragEnter(e) {
      if (!props.visible || creationsStore.activeCreation || !hasFiles(e)) return;
      e.preventDefault();
      dragDepth += 1;
      isDraggingFiles.value = true;
    }

    function onWindowDragOver(e) {
      if (!props.visible || creationsStore.activeCreation || !hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }

    function onWindowDragLeave(e) {
      if (!props.visible || creationsStore.activeCreation) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) isDraggingFiles.value = false;
    }

    function onWindowDrop(e) {
      if (!props.visible || creationsStore.activeCreation || !hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      isDraggingFiles.value = false;
      if (canMutateSelectedAgent.value) {
        appendPendingFiles(e.dataTransfer?.files);
        Vue.nextTick(() => igniteInputRef.value?.focus?.());
      }
    }

    function focusSearch() {
      searchInputRef.value?.focus?.();
    }

    Vue.onMounted(() => {
      window.addEventListener('dragenter', onWindowDragEnter);
      window.addEventListener('dragover', onWindowDragOver);
      window.addEventListener('dragleave', onWindowDragLeave);
      window.addEventListener('drop', onWindowDrop);
    });

    Vue.onBeforeUnmount(() => {
      window.removeEventListener('dragenter', onWindowDragEnter);
      window.removeEventListener('dragover', onWindowDragOver);
      window.removeEventListener('dragleave', onWindowDragLeave);
      window.removeEventListener('drop', onWindowDrop);
    });

    return {
      creationsStore,
      kindFilters: KIND_FILTERS,
      igniteKinds: IGNITE_KINDS,
      starterExamples: STARTER_EXAMPLES,
      searchInputRef,
      igniteInputRef,
      fileInputRef,
      isDraggingFiles,
      legacyBookmarks,
      importingLegacy,
      selectedAgent,
      agentState,
      filteredCreations,
      isUnsupportedAgent,
      canMutateSelectedAgent,
      inspectedCreation,
      isIgniteExpanded,
      canSubmitIgnite,
      showGalaxyEmptyState,
      displayStatusFor,
      dismissLegacyBookmarks,
      importLegacyBookmarks,
      selectAgent,
      defaultModeFor,
      openCreationItem,
      closeInspector,
      formatCount,
      applyStarterExample,
      triggerFilePicker,
      onFilePicked,
      removePendingFile,
      submitIgnite,
      confirmAndDelete,
      focusSearch,
    };
  },
};
