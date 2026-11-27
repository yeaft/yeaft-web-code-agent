/**
 * CosmosGalaxyOverlay — L1 Galaxy HUD, Star Catalog, L2 Orbital Inspector & Omni-Ignite Dock.
 *
 * Strictly uses Pinia `useCreationsStore`, `$t()` i18n keys, and CSS tokens from `creations.css`.
 */
import * as creationsStoreModule from '../../../stores/creations.js';
import { useChatStore } from '../../../stores/chat.js';
import { useSessionsStore } from '../../../stores/sessions.js';
import { t } from '../../../utils/i18n.js';
import { COSMOS_BOOKS_KEY } from '../../../cosmos/constants.js';

const { useCreationsStore } = creationsStoreModule;

function formatAgentDisplayName(ag) {
  if (typeof creationsStoreModule.formatAgentDisplayName === 'function') {
    return creationsStoreModule.formatAgentDisplayName(ag);
  }
  if (!ag) return '';
  if (typeof ag === 'string') {
    return ag.replace(/^user_\d+_[a-z0-9]+:/i, '') || ag;
  }
  const rawName = String(ag.name || '').trim();
  if (rawName && !/^user_\d+_[a-z0-9]+:/i.test(rawName)) return rawName;
  const rawId = String(ag.id || rawName || '').trim();
  return rawId.replace(/^user_\d+_[a-z0-9]+:/i, '') || rawId;
}

function tOr(key, fallback, params) {
  const translated = t(key, params);
  return translated && translated !== key ? translated : fallback;
}

function formatShortDirPath(dirPath) {
  const raw = String(dirPath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!raw) return '';
  const parts = raw.split('/').filter(Boolean);
  if (parts.length <= 2) return raw;
  return `…/${parts.slice(-2).join('/')}`;
}

const LEGACY_BOOKS_DISMISSED_KEY = 'yeaft-cosmos-legacy-books-dismissed-v1';
const LEGACY_BOOKS_IMPORTED_KEY = 'yeaft-cosmos-legacy-books-imported-v1';

function legacyBookmarkImportKey(b) {
  return `legacy-book:${String(b?.id || b?.title || '').slice(0, 96)}`;
}

function readImportedLegacyKeys() {
  try {
    if (typeof localStorage === 'undefined') return new Set();
    const raw = localStorage.getItem(LEGACY_BOOKS_IMPORTED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function persistImportedLegacyKey(importKey) {
  try {
    if (typeof localStorage === 'undefined' || !importKey) return;
    const set = readImportedLegacyKeys();
    set.add(importKey);
    localStorage.setItem(LEGACY_BOOKS_IMPORTED_KEY, JSON.stringify([...set]));
  } catch {
    // ignore storage errors
  }
}

function readLegacyGalaxyBookmarks() {
  try {
    if (typeof localStorage === 'undefined') return [];
    if (localStorage.getItem(LEGACY_BOOKS_DISMISSED_KEY) === '1') return [];
    const raw = localStorage.getItem(COSMOS_BOOKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const imported = readImportedLegacyKeys();
    return parsed.filter((b) => (
      b && typeof b.title === 'string' && b.title.trim() && !imported.has(legacyBookmarkImportKey(b))
    ));
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
                <span>{{ formatAgentDisplayName(ag) }}</span>
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

              <div v-if="projectNameFor(item.projectId)" class="creation-inspector-meta">
                <span class="creation-meta-badge">{{ projectNameFor(item.projectId) }}</span>
              </div>

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
                    @click="openCreationItem(item, 'read')"
                  >
                    {{ $t('creation.inspector.landRead') }}
                  </button>
                  <button
                    type="button"
                    class="creation-glass-btn"
                    @click="openCreationItem(item, 'studio')"
                  >
                    {{ tOr('creation.galaxy.openSession', 'Open Session') }}
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

        <div class="creation-inspector-meta">
          <span v-if="inspectorAgentDisplayName" class="creation-meta-badge">
            <span class="creation-agent-dot" :class="{ 'is-online': selectedAgent?.online }"></span>
            <span>{{ inspectorAgentDisplayName }}</span>
          </span>
          <span v-if="inspectorProjectName" class="creation-meta-badge is-project">
            <span>{{ inspectorProjectName }}</span>
          </span>
          <span v-if="inspectorSessionLabel" class="creation-meta-badge is-session" :title="inspectorSessionLabel">
            <span>{{ inspectorSessionLabel }}</span>
          </span>
          <span
            v-if="inspectedCreation.rootDir"
            class="creation-meta-badge creation-meta-path"
            :title="inspectedCreation.rootDir"
          >
            <span>{{ formatShortDirPath(inspectedCreation.rootDir) }}</span>
          </span>
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
            @click="openCreationItem(inspectedCreation, 'read')"
          >
            {{ $t('creation.inspector.landRead') }}
          </button>
          <button
            type="button"
            class="creation-glass-btn"
            @click="openCreationItem(inspectedCreation, 'studio')"
          >
            {{ tOr('creation.galaxy.openSession', 'Open Session') }}
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

        <!-- Expanded Title & Inline Agent / Project / Session Selectors -->
        <div v-if="isIgniteExpanded" class="creation-ignite-extra">
          <input
            v-model="creationsStore.igniteDraft.title"
            type="text"
            class="creation-ignite-title-input"
            :placeholder="$t('creation.galaxy.igniteTitle')"
            :disabled="!canMutateSelectedAgent || creationsStore.igniteDraft.submitting"
          />

          <div class="creation-ignite-selectors">
            <!-- Agent Selector -->
            <label v-if="agents.length" class="creation-ignite-selector-field">
              <span class="creation-ignite-selector-label">{{ $t('creation.galaxy.agentLabel') }}</span>
              <select
                class="creation-glass-select"
                :value="creationsStore.selectedAgentId"
                :disabled="creationsStore.igniteDraft.submitting"
                @change="selectAgent($event.target.value)"
              >
                <option
                  v-for="ag in agents"
                  :key="ag.id"
                  :value="ag.id"
                >
                  {{ formatAgentDisplayName(ag) }}{{ ag.online ? '' : ' (' + tOr('common.offline', 'Offline') + ')' }}
                </option>
              </select>
            </label>

            <!-- Project Selector -->
            <label class="creation-ignite-selector-field">
              <span class="creation-ignite-selector-label">{{ $t('creation.create.project') }}</span>
              <select
                v-model="igniteProjectSelection"
                class="creation-glass-select"
                :disabled="!canMutateSelectedAgent || creationsStore.igniteDraft.submitting"
              >
                <option value="">{{ $t('creation.create.noProject') }}</option>
                <option
                  v-for="proj in availableProjects"
                  :key="proj.id"
                  :value="proj.id"
                >
                  {{ proj.name || proj.id }}
                </option>
                <option value="__new__">+ {{ $t('creation.create.newProject') }}</option>
              </select>
            </label>

            <input
              v-if="igniteProjectSelection === '__new__'"
              v-model="igniteNewProjectName"
              type="text"
              class="creation-ignite-inline-input"
              :placeholder="$t('creation.create.newProjectPlaceholder')"
              :disabled="!canMutateSelectedAgent || creationsStore.igniteDraft.submitting"
            />

            <!-- Session Mode Selector -->
            <label class="creation-ignite-selector-field">
              <span class="creation-ignite-selector-label">{{ $t('creation.create.session') }}</span>
              <select
                v-model="igniteSessionMode"
                class="creation-glass-select"
                :disabled="!canMutateSelectedAgent || creationsStore.igniteDraft.submitting"
              >
                <option value="new">{{ $t('creation.create.sessionNew') }}</option>
                <option value="existing" :disabled="agentSessions.length === 0">
                  {{ $t('creation.create.sessionExisting') }}
                </option>
              </select>
            </label>

            <select
              v-if="igniteSessionMode === 'existing'"
              v-model="igniteExistingSessionId"
              class="creation-glass-select is-session-picker"
              :disabled="!canMutateSelectedAgent || creationsStore.igniteDraft.submitting || agentSessions.length === 0"
              :aria-label="$t('creation.create.selectSession')"
            >
              <option
                v-for="sess in agentSessions"
                :key="sess.id"
                :value="sess.id"
              >
                {{ sess.title || sess.name || sess.id }}
              </option>
            </select>
          </div>
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
    const chatStore = useChatStore();
    const sessionsStore = useSessionsStore();
    const searchInputRef = Vue.ref(null);
    const igniteInputRef = Vue.ref(null);
    const fileInputRef = Vue.ref(null);
    const isDraggingFiles = Vue.ref(false);
    const legacyBookmarks = Vue.ref(readLegacyGalaxyBookmarks());
    const importingLegacy = Vue.ref(false);
    const igniteProjectSelection = Vue.ref('');
    const igniteNewProjectName = Vue.ref('');
    const igniteSessionMode = Vue.ref('new');
    const igniteExistingSessionId = Vue.ref('');
    const igniteResumeState = Vue.ref({ agentId: '', projectId: '', creationId: '' });
    let dragDepth = 0;
    let igniteReqEpoch = 0;
    let isUnmounted = false;

    function resetIgniteResumeState() {
      igniteResumeState.value = { agentId: '', projectId: '', creationId: '' };
    }

    const selectedAgent = Vue.computed(() => {
      const id = creationsStore.selectedAgentId;
      if (!id) return null;
      return (props.agents || []).find((a) => a && a.id === id) || null;
    });

    const availableProjects = Vue.computed(() => (
      Array.isArray(chatStore.sessionProjects) ? chatStore.sessionProjects.filter((p) => p && p.id) : []
    ));

    function projectNameFor(projectId) {
      if (!projectId) return '';
      const found = availableProjects.value.find((p) => p.id === projectId);
      return found?.name || '';
    }

    const agentSessions = Vue.computed(() => {
      const aid = creationsStore.selectedAgentId;
      if (!aid) return [];
      const fromStore = Array.isArray(sessionsStore?.sessionList)
        ? sessionsStore.sessionList.filter((s) => s && s.id && (s.agentId || aid) === aid)
        : [];
      if (fromStore.length) return fromStore;
      const ag = selectedAgent.value;
      return Array.isArray(ag?.sessions) ? ag.sessions.filter((s) => s && s.id) : [];
    });

    Vue.watch(
      () => [creationsStore.selectedAgentId, agentSessions.value.map((s) => s.id).join(',')],
      () => {
        const list = agentSessions.value;
        if (!list.length) {
          igniteExistingSessionId.value = '';
          if (igniteSessionMode.value === 'existing') igniteSessionMode.value = 'new';
          return;
        }
        if (!list.some((s) => s.id === igniteExistingSessionId.value)) {
          igniteExistingSessionId.value = list[0].id;
        }
      },
      { immediate: true },
    );

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

    const inspectorAgentDisplayName = Vue.computed(() => {
      const target = creationsStore.inspectorTarget;
      const aid = target?.agentId || inspectedCreation.value?.agentId || creationsStore.selectedAgentId;
      if (!aid) return '';
      const ag = (props.agents || []).find((a) => a && a.id === aid) || aid;
      return formatAgentDisplayName(ag);
    });

    const inspectorProjectName = Vue.computed(() => (
      projectNameFor(inspectedCreation.value?.projectId)
    ));

    const inspectorSessionLabel = Vue.computed(() => {
      const item = inspectedCreation.value;
      if (!item || !item.sessionId) return '';
      const aid = creationsStore.inspectorTarget?.agentId || item.agentId || creationsStore.selectedAgentId;
      const sess = sessionsStore?.sessionById?.(item.sessionId, aid)
        || agentSessions.value.find((s) => s.id === item.sessionId)
        || null;
      return sess?.title || sess?.name || tOr('creation.galaxy.linkedSession', 'Session');
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
        const importedKeys = readImportedLegacyKeys();
        const toImport = legacyBookmarks.value.slice();
        for (const bm of toImport) {
          const title = String(bm.title || '').trim();
          if (!title) continue;
          const importKey = legacyBookmarkImportKey(bm);
          if (importedKeys.has(importKey)) {
            legacyBookmarks.value = legacyBookmarks.value.filter((item) => legacyBookmarkImportKey(item) !== importKey);
            continue;
          }
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
            importKey,
            ...(celestial ? { celestial } : {}),
          });
          importedKeys.add(importKey);
          persistImportedLegacyKey(importKey);
          legacyBookmarks.value = legacyBookmarks.value.filter((item) => legacyBookmarkImportKey(item) !== importKey);
          imported += 1;
        }
        if (legacyBookmarks.value.length === 0) {
          dismissLegacyBookmarks();
        }
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

    Vue.watch(
      () => creationsStore.selectedAgentId,
      (next, prev) => {
        if (prev && next !== prev) {
          igniteReqEpoch += 1;
          if (creationsStore.igniteDraft) {
            creationsStore.igniteDraft.submitting = false;
            creationsStore.igniteDraft.error = null;
          }
          resetIgniteResumeState();
        }
      },
    );

    Vue.watch(
      () => [
        props.visible,
        creationsStore.igniteDraft?.open ?? false,
        creationsStore.igniteDraft?.title ?? '',
        igniteProjectSelection.value,
        igniteNewProjectName.value,
      ],
      ([vis, isOpen, title, projectSel, newProjName], prev) => {
        if (!prev) return;
        const closed = (prev[0] && !vis) || (prev[1] && !isOpen);
        const draftChanged = prev[2] !== title || prev[3] !== projectSel || prev[4] !== newProjName;
        if (closed || draftChanged) {
          resetIgniteResumeState();
        }
      },
    );

    async function submitIgnite() {
      if (!canSubmitIgnite.value) return;
      const epoch = ++igniteReqEpoch;
      const submitAgentId = creationsStore.selectedAgentId;
      const startSeq = creationsStore.openActivationSeq;
      const isStillCurrent = () => (
        !isUnmounted
        && epoch === igniteReqEpoch
        && creationsStore.selectedAgentId === submitAgentId
      );
      const liveDraft = creationsStore.igniteDraft;
      const submittedTitle = liveDraft.title;
      const submittedPrompt = liveDraft.prompt;
      const filesToSend = liveDraft.pendingFiles.slice();
      const submittedFileSet = new Set(filesToSend);
      const submittedCelestial = liveDraft.celestial;
      const titleText = submittedTitle.trim();
      const promptText = submittedPrompt.trim();
      const kindVal = liveDraft.kind || 'book';
      const celestialVal = submittedCelestial || undefined;
      const projectIdVal = (igniteProjectSelection.value && igniteProjectSelection.value !== '__new__')
        ? igniteProjectSelection.value
        : undefined;
      const newProjectNameVal = igniteProjectSelection.value === '__new__'
        ? igniteNewProjectName.value.trim() || undefined
        : undefined;
      const sessionModeVal = igniteSessionMode.value || 'new';
      const existingSessionIdVal = sessionModeVal === 'existing'
        ? (igniteExistingSessionId.value || undefined)
        : undefined;
      const resumeState = igniteResumeState.value;
      const canResume = Boolean(resumeState && resumeState.agentId === submitAgentId);
      const resumeProjectIdVal = canResume && resumeState.projectId ? resumeState.projectId : undefined;
      const resumeCreationIdVal = canResume && resumeState.creationId ? resumeState.creationId : undefined;

      liveDraft.submitting = true;
      liveDraft.error = null;

      try {
        const fallbackTitle = promptText
          ? promptText.split(/\r?\n/)[0].trim().slice(0, 48)
          : (filesToSend[0]?.name ? filesToSend[0].name.replace(/\.[^.]+$/, '').slice(0, 48) : '');
        const resolvedTitle = titleText || fallbackTitle || undefined;
        const res = typeof creationsStore.createWorkspaceCreation === 'function'
          ? await creationsStore.createWorkspaceCreation({
              agentId: submitAgentId,
              title: resolvedTitle,
              kind: kindVal,
              projectId: projectIdVal,
              newProjectName: newProjectNameVal,
              sessionMode: sessionModeVal,
              existingSessionId: existingSessionIdVal,
              prompt: promptText || undefined,
              rawFiles: filesToSend,
              celestial: celestialVal,
              ...(resumeProjectIdVal ? { resumeProjectId: resumeProjectIdVal } : {}),
              ...(resumeCreationIdVal ? { resumeCreationId: resumeCreationIdVal } : {}),
            })
          : await creationsStore.createCreation(submitAgentId, {
              title: resolvedTitle,
              kind: kindVal,
              prompt: promptText || undefined,
              rawFiles: filesToSend,
              celestial: celestialVal,
            });
        if (!isStillCurrent()) return;
        const created = res?.creation || res;
        const currentDraft = creationsStore.igniteDraft;
        currentDraft.pendingFiles = currentDraft.pendingFiles.filter((f) => !submittedFileSet.has(f));
        resetIgniteResumeState();

        if (res?.initialTurnError) {
          emit('toast', res.initialTurnError);
        }
        if (res?.projectWarning) {
          emit('toast', res.projectWarning);
        }
        if (currentDraft.title === submittedTitle) {
          currentDraft.title = '';
        }
        if (currentDraft.prompt === submittedPrompt) {
          currentDraft.prompt = '';
        }
        if (currentDraft.celestial === submittedCelestial) {
          currentDraft.celestial = null;
        }
        if (igniteProjectSelection.value === '__new__') {
          igniteProjectSelection.value = '';
          igniteNewProjectName.value = '';
        }
        if (
          !currentDraft.title.trim()
          && !currentDraft.prompt.trim()
          && currentDraft.pendingFiles.length === 0
        ) {
          currentDraft.open = false;
        }
        currentDraft.error = null;

        if (
          created
          && created.id
          && props.visible
          && isStillCurrent()
          && creationsStore.openActivationSeq === startSeq
        ) {
          emit('open-creation', {
            agentId: submitAgentId,
            creationId: created.id,
            sessionId: res?.sessionId || created.sessionId || undefined,
            rootDir: res?.rootDir || created.rootDir || undefined,
            mode: 'studio',
            promptToSend: promptText || '',
          });
        }
      } catch (err) {
        if (!isStillCurrent()) return;
        const nextProjectId = err?.partialProjectId || (canResume ? resumeState.projectId : '') || '';
        const nextCreationId = err?.partialCreation?.id || (canResume ? resumeState.creationId : '') || '';
        if (nextProjectId || nextCreationId) {
          igniteResumeState.value = {
            agentId: submitAgentId,
            projectId: nextProjectId,
            creationId: nextCreationId,
          };
        }
        creationsStore.igniteDraft.error = err?.message || 'Failed to ignite creation';
      } finally {
        if (isStillCurrent()) {
          creationsStore.igniteDraft.submitting = false;
        }
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
      isUnmounted = true;
      igniteReqEpoch += 1;
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
      igniteProjectSelection,
      igniteNewProjectName,
      igniteSessionMode,
      igniteExistingSessionId,
      selectedAgent,
      availableProjects,
      agentSessions,
      agentState,
      filteredCreations,
      isUnsupportedAgent,
      canMutateSelectedAgent,
      inspectedCreation,
      inspectorAgentDisplayName,
      inspectorProjectName,
      inspectorSessionLabel,
      isIgniteExpanded,
      canSubmitIgnite,
      showGalaxyEmptyState,
      formatAgentDisplayName,
      tOr,
      formatShortDirPath,
      projectNameFor,
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
