/**
 * CreationCreateModal — Shared modal for creating a folder-level Creation Workspace.
 *
 * Uses Yeaft's native `.modal-overlay` + `.modal` shell with fixed header/footer
 * and scrollable body. Allows choosing Agent, Project (existing or inline new),
 * Session mode (new recommended or link existing), Title, Kind, optional Folder
 * Path, optional Initial Prompt, and optional Source Files.
 */
import { useChatStore } from '../../stores/chat.js';
import { useSessionsStore } from '../../stores/sessions.js';
import { creationSessionsForAgent, newCreationAttemptKey, useCreationsStore } from '../../stores/creations.js';
import {
  CREATION_CATEGORIES,
  defaultKindForCategory,
  inferCategoryFromKind,
} from '../../utils/creation-categories.js';
import NavigationIcon from '../NavigationIcon.js';

export const CREATION_KINDS = Object.freeze([
  { id: 'book', labelKey: 'creation.kind.book', fallback: 'Book', swatchClass: 'is-book' },
  { id: 'deck', labelKey: 'creation.kind.deck', fallback: 'Deck', swatchClass: 'is-deck' },
  { id: 'gallery', labelKey: 'creation.kind.gallery', fallback: 'Gallery', swatchClass: 'is-gallery' },
  { id: 'video', labelKey: 'creation.kind.video', fallback: 'Video', swatchClass: 'is-video' },
]);

/**
 * Strip `user_<digits>_<rand>:` prefixes when falling back to raw Agent IDs.
 * @param {string} id
 * @returns {string}
 */
export function shortAgentLabel(id) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  return raw.replace(/^user_[^:]+:/, '') || raw;
}

function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default {
  name: 'CreationCreateModal',
  components: { NavigationIcon },
  props: {
    visible: { type: Boolean, default: true },
    initialAgentId: { type: String, default: '' },
    initialProjectId: { type: String, default: '' },
    initialSessionId: { type: String, default: '' },
    initialSessionMode: { type: String, default: 'new' },
    initialKind: { type: String, default: 'book' },
    initialCategory: { type: String, default: '' },
    initialTitle: { type: String, default: '' },
    initialRootDir: { type: String, default: '' },
    initialPrompt: { type: String, default: '' },
    initialFiles: { type: Array, default: () => [] },
    celestial: { type: Object, default: null },
  },
  emits: ['close', 'created'],
  template: `
    <Teleport to="body">
      <div
        v-if="visible"
        class="modal-overlay creation-create-overlay"
        role="dialog"
        aria-modal="true"
        :aria-label="tr('creation.create.modalTitle', 'New Creation')"
        @click.self="onBackdropClick"
      >
        <div class="modal creation-create-modal" ref="modalEl">
          <header class="creation-create-header">
            <div class="creation-create-heading">
              <h2>{{ tr('creation.create.modalTitle', 'New Creation') }}</h2>
              <p class="creation-create-subtitle">{{ tr('creation.create.modalDesc', 'Create a folder-backed workspace for documents, images, and videos.') }}</p>
            </div>
            <button
              type="button"
              class="btn-ghost creation-create-close"
              :disabled="submitting"
              :aria-label="tr('common.close', 'Close')"
              @click="requestClose"
            >
              <NavigationIcon name="close" :size="18" />
            </button>
          </header>

          <form class="creation-create-form" @submit.prevent="handleSubmit">
            <div class="creation-create-body">
              <div v-if="errorMessage || projectNameError" class="creation-create-error" role="alert">
                {{ errorMessage || projectNameError }}
              </div>

              <!-- Title -->
              <div class="creation-create-field">
                <label class="creation-create-label" for="creation-create-title">
                  {{ tr('creation.create.titleLabel', 'Title') }}
                  <span class="creation-create-required" aria-hidden="true">*</span>
                </label>
                <input
                  id="creation-create-title"
                  ref="titleInputRef"
                  v-model.trim="form.title"
                  type="text"
                  class="creation-create-input"
                  maxlength="120"
                  autocomplete="off"
                  :disabled="submitting"
                  :placeholder="tr('creation.create.titlePlaceholder', 'e.g. Q4 Product Launch Deck')"
                />
              </div>

              <!-- Category (6-category registry) -->
              <div class="creation-create-field">
                <span class="creation-create-label">{{ tr('creation.create.categoryLabel', 'Category') }}</span>
                <div class="creation-create-category-grid" role="radiogroup" :aria-label="tr('creation.create.categoryLabel', 'Category')">
                  <button
                    v-for="cat in categories"
                    :key="cat.id"
                    type="button"
                    role="radio"
                    class="creation-create-category-card"
                    :class="{ active: form.category === cat.id }"
                    :aria-checked="form.category === cat.id"
                    :disabled="submitting"
                    @click="selectCategory(cat.id)"
                  >
                    <span class="creation-create-category-head">
                      <span class="creation-kind-swatch" :class="cat.swatchClass" aria-hidden="true"></span>
                      <span class="creation-create-category-title">{{ tr(cat.labelKey, cat.id) }}</span>
                    </span>
                    <span class="creation-create-category-desc">{{ tr(cat.descKey, '') }}</span>
                  </button>
                </div>
              </div>

              <!-- Optional Initial Prompt & Source Files -->
              <div class="creation-create-field">
                <label class="creation-create-label" for="creation-create-prompt">
                  {{ tr('creation.create.promptLabel', 'Initial Prompt (optional)') }}
                </label>
                <textarea
                  id="creation-create-prompt"
                  v-model="form.prompt"
                  class="creation-create-textarea creation-create-textarea-compact"
                  rows="2"
                  :disabled="submitting"
                  :placeholder="tr('creation.create.promptPlaceholder', 'Describe what to draft, illustrate, or assemble...')"
                ></textarea>

                <div
                  class="creation-dropzone creation-dropzone-compact"
                  :class="{ 'is-dragover': dragOver }"
                  @dragover.prevent="dragOver = true"
                  @dragleave="dragOver = false"
                  @drop.prevent="onFileDrop"
                  @click="triggerFilePicker"
                >
                  <input
                    ref="fileInputRef"
                    type="file"
                    multiple
                    class="creation-hidden-file-input"
                    :disabled="submitting"
                    @change="onFileInputChange"
                  />
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                    <path fill="currentColor" d="M19.35 10.04A7.49 7.49 0 0012 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 000 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z" />
                  </svg>
                  <span>{{ tr('creation.create.dropFilesHint', 'Drop files here or click to browse') }}</span>
                </div>

                <ul v-if="form.files.length > 0" class="creation-file-list">
                  <li v-for="(file, idx) in form.files" :key="file.name + '-' + idx" class="creation-file-item">
                    <span class="creation-file-name" :title="file.name">{{ file.name }}</span>
                    <span class="creation-file-size">{{ formatFileSize(file.size) }}</span>
                    <button
                      type="button"
                      class="creation-file-remove"
                      :disabled="submitting"
                      :aria-label="tr('common.remove', 'Remove')"
                      @click="removeFile(idx)"
                    >
                      <NavigationIcon name="close" :size="14" />
                    </button>
                  </li>
                </ul>
              </div>

              <!-- Compact Collapsible Settings Bar -->
              <div class="creation-create-settings-bar" :class="{ 'is-expanded': settingsExpanded }">
                <div class="creation-create-settings-summary">
                  <span class="creation-create-settings-text" :title="settingsSummaryText">
                    {{ settingsSummaryText }}
                  </span>
                  <button
                    type="button"
                    class="creation-create-settings-toggle"
                    :aria-expanded="settingsExpanded"
                    @click="settingsExpanded = !settingsExpanded"
                  >
                    <span>{{ settingsExpanded ? tr('creation.create.hideSettings', 'Hide settings') : tr('creation.create.adjustSettings', 'Adjust') }}</span>
                    <svg class="creation-collapse-caret" :class="{ open: settingsExpanded }" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                      <path fill="currentColor" d="M5.5 3.5L10 8l-4.5 4.5z" />
                    </svg>
                  </button>
                </div>

                <div v-show="settingsExpanded" class="creation-create-settings-panel">
                  <!-- Agent & Project Row -->
                  <div class="creation-create-row-2">
                    <div class="creation-create-field">
                      <label class="creation-create-label" for="creation-create-agent">
                        {{ tr('creation.create.agent', 'Agent') }}
                      </label>
                      <select
                        id="creation-create-agent"
                        v-model="form.agentId"
                        class="creation-create-select"
                        :disabled="submitting || agentOptions.length === 0"
                      >
                        <option v-if="agentOptions.length === 0" value="">
                          {{ tr('creation.create.noAgents', 'No agents available') }}
                        </option>
                        <option
                          v-for="ag in agentOptions"
                          :key="ag.id"
                          :value="ag.id"
                          :disabled="!ag.eligible"
                        >
                          {{ ag.label }}{{ !ag.online ? ' (' + tr('common.offline', 'offline') + ')' : (!ag.hasCreationCap ? ' (' + tr('creation.create.noCreationsCap', 'unsupported') + ')' : '') }}
                        </option>
                      </select>
                      <p v-if="!hasEligibleAgent" class="creation-create-hint is-warning" role="status">
                        {{ tr('creation.create.noEligibleAgent', 'No online Agent with Creations support is available.') }}
                      </p>
                    </div>

                    <div class="creation-create-field">
                      <div class="creation-create-label-row">
                        <label class="creation-create-label" for="creation-create-project">
                          {{ tr('creation.create.project', 'Project') }}
                        </label>
                        <button
                          type="button"
                          class="creation-create-inline-toggle"
                          :disabled="submitting"
                          @click="toggleNewProject"
                        >
                          {{ form.creatingProject ? tr('creation.create.selectExistingProject', 'Choose existing') : '+ ' + tr('creation.create.newProject', 'New Project') }}
                        </button>
                      </div>
                      <input
                        v-if="form.creatingProject"
                        id="creation-create-project"
                        ref="newProjectInputRef"
                        v-model.trim="form.newProjectName"
                        type="text"
                        class="creation-create-input"
                        maxlength="80"
                        autocomplete="off"
                        :disabled="submitting"
                        :placeholder="tr('creation.create.newProjectPlaceholder', 'New project name')"
                      />
                      <select
                        v-else
                        id="creation-create-project"
                        v-model="form.projectId"
                        class="creation-create-select"
                        :disabled="submitting"
                      >
                        <option value="">{{ tr('creation.create.noProject', 'No Project') }}</option>
                        <option
                          v-for="proj in projectOptions"
                          :key="proj.id"
                          :value="proj.id"
                        >
                          {{ proj.name }}
                        </option>
                      </select>
                    </div>
                  </div>

                  <!-- Session Mode -->
                  <div class="creation-create-field">
                    <span class="creation-create-label">{{ tr('creation.create.session', 'Session') }}</span>
                    <div class="creation-session-mode-toggle" role="radiogroup" :aria-label="tr('creation.create.session', 'Session')">
                      <button
                        type="button"
                        role="radio"
                        class="creation-mode-btn"
                        :class="{ active: form.sessionMode === 'new' }"
                        :aria-checked="form.sessionMode === 'new'"
                        :disabled="submitting"
                        @click="form.sessionMode = 'new'"
                      >
                        {{ tr('creation.create.newSessionRecommended', 'Create new Session (recommended)') }}
                      </button>
                      <button
                        type="button"
                        role="radio"
                        class="creation-mode-btn"
                        :class="{ active: form.sessionMode === 'existing' }"
                        :aria-checked="form.sessionMode === 'existing'"
                        :disabled="submitting"
                        @click="form.sessionMode = 'existing'"
                      >
                        {{ tr('creation.create.linkExistingSession', 'Link existing Session') }}
                      </button>
                    </div>

                    <p v-if="form.sessionMode === 'new'" class="creation-create-hint">
                      {{ tr('creation.create.newSessionOnlineHint', 'Creating a new Yeaft Session requires an online Agent connection.') }}
                    </p>

                    <div v-if="form.sessionMode === 'existing'" class="creation-existing-session-wrap">
                      <select
                        v-model="form.existingSessionId"
                        class="creation-create-select"
                        :aria-label="tr('creation.create.selectSession', 'Select existing Session')"
                        :disabled="submitting || existingSessionOptions.length === 0"
                      >
                        <option v-if="existingSessionOptions.length === 0" value="">
                          {{ tr('creation.create.noExistingSessions', 'No sessions on this Agent') }}
                        </option>
                        <option
                          v-for="sess in existingSessionOptions"
                          :key="sess.id"
                          :value="sess.id"
                        >
                          {{ sess.label }}
                        </option>
                      </select>
                    </div>
                  </div>

                  <!-- Folder Path -->
                  <div class="creation-create-field">
                    <label class="creation-create-label" for="creation-create-folder">
                      {{ tr('creation.create.folderLabel', 'Folder Path (optional)') }}
                    </label>
                    <input
                      id="creation-create-folder"
                      v-model.trim="form.rootDir"
                      type="text"
                      class="creation-create-input creation-create-mono"
                      autocomplete="off"
                      :disabled="submitting"
                      :placeholder="tr('creation.create.folderPlaceholder', 'Leave blank to auto-create inside Agent workspace')"
                    />
                  </div>
                </div>
              </div>
            </div>

            <footer class="creation-create-footer">
              <button
                type="button"
                class="btn-secondary"
                :disabled="submitting"
                @click="requestClose"
              >
                {{ tr('common.cancel', 'Cancel') }}
              </button>
              <button
                v-if="unassignedResult"
                type="button"
                class="btn-secondary"
                :disabled="submitting"
                @click="continueWithoutProject"
              >
                {{ tr('common.open', 'Open') }} — {{ tr('creation.create.noProject', 'No Project') }}
              </button>
              <button
                type="submit"
                class="btn-primary"
                :disabled="!canSubmit"
              >
                <span v-if="submitting">{{ tr('creation.create.creating', 'Creating…') }}</span>
                <span v-else>{{ tr('creation.create.submit', 'Create Creation') }}</span>
              </button>
            </footer>
          </form>
        </div>
      </div>
    </Teleport>
  `,
  setup(props, { emit }) {
    const chatStore = useChatStore();
    const sessionsStore = useSessionsStore();
    const creationsStore = useCreationsStore();
    const instance = Vue.getCurrentInstance();

    const tr = (key, fallback, params) => {
      const translated = instance?.proxy?.$t?.(key, params);
      if (translated && translated !== key) return translated;
      return fallback || key;
    };

    const modalEl = Vue.ref(null);
    const titleInputRef = Vue.ref(null);
    const newProjectInputRef = Vue.ref(null);
    const fileInputRef = Vue.ref(null);

    const submitting = Vue.ref(false);
    const errorMessage = Vue.ref('');
    const dragOver = Vue.ref(false);
    const folderExpanded = Vue.ref(Boolean(props.initialRootDir));
    const settingsExpanded = Vue.ref(false);
    const resumeState = Vue.ref(null);
    const unassignedResult = Vue.ref(null);
    const resetResumeState = () => {
      resumeState.value = null;
      unassignedResult.value = null;
    };

    const resolveInitialCategory = () => {
      const cat = String(props.initialCategory || '').trim();
      if (cat && CREATION_CATEGORIES.some((c) => c.id === cat)) return cat;
      return inferCategoryFromKind(props.initialKind);
    };

    const initialCat = resolveInitialCategory();

    const form = Vue.reactive({
      agentId: props.initialAgentId || '',
      projectId: props.initialProjectId || '',
      creatingProject: false,
      newProjectName: '',
      sessionMode: props.initialSessionMode === 'existing' ? 'existing' : 'new',
      existingSessionId: props.initialSessionId || '',
      title: props.initialTitle || '',
      category: initialCat,
      kind: CREATION_KINDS.some(k => k.id === props.initialKind) ? props.initialKind : defaultKindForCategory(initialCat),
      rootDir: props.initialRootDir || '',
      prompt: props.initialPrompt || '',
      files: Array.isArray(props.initialFiles) ? [...props.initialFiles] : [],
    });

    const selectCategory = (categoryId) => {
      form.category = categoryId;
      form.kind = defaultKindForCategory(categoryId);
    };

    const agentOptions = Vue.computed(() => {
      const rawAgents = Array.isArray(chatStore.agents) ? chatStore.agents : [];
      const mapped = rawAgents.map(ag => {
        const caps = Array.isArray(ag.capabilities) ? ag.capabilities : [];
        const hasCreationCap = caps.includes('creations');
        const online = Boolean(ag.online);
        return {
          id: ag.id,
          label: (ag.name && String(ag.name).trim()) || shortAgentLabel(ag.id),
          online,
          hasCreationCap,
          eligible: online && hasCreationCap,
        };
      });
      // Online Creation-capable first, then other online, then offline
      mapped.sort((a, b) => {
        if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
        if (a.online !== b.online) return a.online ? -1 : 1;
        if (a.hasCreationCap !== b.hasCreationCap) return a.hasCreationCap ? -1 : 1;
        return a.label.localeCompare(b.label);
      });
      return mapped;
    });

    const hasEligibleAgent = Vue.computed(() => (
      agentOptions.value.some(a => a.eligible)
    ));

    const pickDefaultAgentId = () => {
      const list = agentOptions.value;
      if (list.length === 0) return '';
      if (props.initialAgentId && list.some(a => a.id === props.initialAgentId && a.eligible)) {
        return props.initialAgentId;
      }
      if (chatStore.currentAgent && list.some(a => a.id === chatStore.currentAgent && a.eligible)) {
        return chatStore.currentAgent;
      }
      const firstEligible = list.find(a => a.eligible);
      return firstEligible ? firstEligible.id : '';
    };

    const projectOptions = Vue.computed(() => {
      const list = Array.isArray(chatStore.sessionProjects) ? chatStore.sessionProjects : [];
      return list
        .filter(p => p && p.id)
        .map(p => ({ id: p.id, name: p.name || p.title || p.id }));
    });

    const existingSessionOptions = Vue.computed(() => (
      creationSessionsForAgent(sessionsStore, form.agentId)
        .map(s => ({ id: s.id, label: s.name || s.title || s.id }))
    ));

    const projectSelection = Vue.computed(() => form.creatingProject ? '__new__' : form.projectId);
    const newProjectName = Vue.computed(() => form.creatingProject ? form.newProjectName.trim() : '');
    const projectNameError = Vue.computed(() => (
      form.creatingProject && !newProjectName.value
        ? tr('creation.create.newProjectPlaceholder', 'Enter a name for the new Project.')
        : ''
    ));

    const selectedAgentEligible = Vue.computed(() => (
      agentOptions.value.some(a => a.id === form.agentId && a.eligible)
    ));

    const settingsSummaryText = Vue.computed(() => {
      const ag = agentOptions.value.find((a) => a.id === form.agentId);
      const agentLabel = ag ? ag.label : tr('creation.create.noAgents', 'No agents available');
      const projectLabel = form.creatingProject
        ? (form.newProjectName.trim() || tr('creation.create.newProject', 'New Project'))
        : (projectOptions.value.find((p) => p.id === form.projectId)?.name || tr('creation.create.noProject', 'No Project'));
      const sessionLabel = form.sessionMode === 'existing'
        ? tr('creation.create.existingSessionShort', 'Existing Session')
        : tr('creation.create.newSessionShort', 'New Session');
      return `${agentLabel} · ${projectLabel} · ${sessionLabel}`;
    });

    const shouldAutoExpandSettings = () => (
      !hasEligibleAgent.value
      || Boolean(props.initialRootDir)
      || Boolean(props.initialProjectId)
      || props.initialSessionMode === 'existing'
    );

    const canSubmit = Vue.computed(() => {
      if (submitting.value) return false;
      if (!form.title.trim()) return false;
      if (!form.agentId || !selectedAgentEligible.value) return false;
      if (projectNameError.value) return false;
      if (form.sessionMode === 'existing' && !existingSessionOptions.value.some(s => s.id === form.existingSessionId)) return false;
      return true;
    });

    const syncInitialState = () => {
      const nextCat = resolveInitialCategory();
      form.agentId = pickDefaultAgentId();
      form.projectId = props.initialProjectId || '';
      form.creatingProject = false;
      form.newProjectName = '';
      form.sessionMode = props.initialSessionMode === 'existing' ? 'existing' : 'new';
      form.existingSessionId = props.initialSessionId || '';
      form.title = props.initialTitle || '';
      form.category = nextCat;
      form.kind = props.initialCategory
        ? defaultKindForCategory(nextCat)
        : (CREATION_KINDS.some(k => k.id === props.initialKind) ? props.initialKind : defaultKindForCategory(nextCat));
      form.rootDir = props.initialRootDir || '';
      form.prompt = props.initialPrompt || '';
      form.files = Array.isArray(props.initialFiles) ? [...props.initialFiles] : [];
      folderExpanded.value = Boolean(props.initialRootDir);
      settingsExpanded.value = shouldAutoExpandSettings();
      errorMessage.value = '';
      submitting.value = false;
      resetResumeState();
    };

    Vue.watch(() => props.visible, (isVisible) => {
      if (isVisible) {
        syncInitialState();
        Vue.nextTick(() => titleInputRef.value?.focus());
      } else {
        resetResumeState();
      }
    }, { immediate: true });

    Vue.watch([projectSelection, newProjectName], ([selection, name]) => {
      const state = resumeState.value;
      if (!state || (state.projectSelectionSnapshot === selection && state.newProjectNameSnapshot === name)) return;
      Object.assign(state, { projectId: '', projectAttempted: false, baselineProjectIds: [],
        projectSelectionSnapshot: selection, newProjectNameSnapshot: name });
    }, { flush: 'sync' });

    Vue.watch([() => form.sessionMode, () => form.existingSessionId], () => {
      if (resumeState.value) {
        Object.assign(resumeState.value, { sessionId: '', sessionAttempted: false, baselineSessionIds: [] });
      }
      unassignedResult.value = null;
    }, { flush: 'sync' });

    Vue.watch(() => form.agentId, () => {
      submitting.value = false;
      resetResumeState();
      errorMessage.value = '';
      if (form.sessionMode === 'existing') {
        const opts = existingSessionOptions.value;
        if (!opts.some(s => s.id === form.existingSessionId)) {
          form.existingSessionId = opts[0]?.id || '';
        }
      }
    }, { flush: 'sync' });

    Vue.watch(() => form.sessionMode, (mode) => {
      if (mode === 'existing' && !form.existingSessionId) {
        form.existingSessionId = existingSessionOptions.value[0]?.id || '';
      }
    });

    const toggleNewProject = () => {
      form.creatingProject = !form.creatingProject;
      if (form.creatingProject) {
        form.projectId = '';
        Vue.nextTick(() => newProjectInputRef.value?.focus());
      } else {
        form.newProjectName = '';
      }
    };

    const triggerFilePicker = () => {
      if (submitting.value) return;
      fileInputRef.value?.click();
    };

    const addFiles = (fileList) => {
      if (!fileList || !fileList.length) return;
      for (const file of fileList) {
        if (!file) continue;
        const duplicate = form.files.some(
          existing => existing.name === file.name && existing.size === file.size,
        );
        if (!duplicate) form.files.push(file);
      }
    };

    const onFileInputChange = (event) => {
      addFiles(event.target?.files);
      if (event.target) event.target.value = '';
    };

    const onFileDrop = (event) => {
      dragOver.value = false;
      if (submitting.value) return;
      addFiles(event.dataTransfer?.files);
    };

    const removeFile = (index) => {
      form.files.splice(index, 1);
    };

    const requestClose = () => {
      if (submitting.value) return;
      resetResumeState();
      emit('close');
    };

    const onBackdropClick = () => {
      requestClose();
    };

    const handleKeydown = (event) => {
      if (!props.visible || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
      }
    };

    Vue.onMounted(() => {
      document.addEventListener('keydown', handleKeydown);
    });

    Vue.onUnmounted(() => {
      resetResumeState();
      document.removeEventListener('keydown', handleKeydown);
    });

    const completeCreation = result => {
      submitting.value = false;
      resetResumeState();
      const creation = result?.creation || result || null;
      emit('created', {
        agentId: result?.agentId || form.agentId,
        creation,
        category: creation?.category || form.category,
        sessionId: result?.sessionId || creation?.sessionId || (form.sessionMode === 'existing' ? form.existingSessionId : ''),
        projectId: result?.projectId ?? creation?.projectId ?? null,
        rootDir: result?.rootDir || creation?.rootDir || form.rootDir.trim(),
        prompt: form.prompt.trim(),
      });
      emit('close');
    };

    const continueWithoutProject = () => {
      if (!submitting.value && unassignedResult.value) completeCreation(unassignedResult.value);
    };

    const maybeExpandSettingsForError = (msg) => {
      if (/agent|project|session|folder|dir/i.test(String(msg || ''))) {
        settingsExpanded.value = true;
      }
    };

    const handleSubmit = async () => {
      if (!canSubmit.value) return;
      if (!resumeState.value) {
        resumeState.value = {
          agentId: form.agentId,
          attemptKey: newCreationAttemptKey(),
          projectId: '',
          projectSelectionSnapshot: projectSelection.value,
          newProjectNameSnapshot: newProjectName.value,
          creationId: '',
          sessionId: '',
          projectAttempted: false,
          sessionAttempted: false,
          baselineProjectIds: [],
          baselineSessionIds: [],
        };
      }
      const state = resumeState.value;
      submitting.value = true;
      errorMessage.value = '';
      try {
        const result = await creationsStore.createWorkspaceCreation({
          agentId: state.agentId,
          title: form.title.trim(),
          kind: form.kind,
          category: form.category,
          projectId: form.creatingProject ? '' : form.projectId,
          newProjectName: newProjectName.value,
          sessionMode: form.sessionMode,
          existingSessionId: form.sessionMode === 'existing' ? form.existingSessionId : '',
          rootDir: form.rootDir.trim(),
          prompt: form.prompt.trim(),
          rawFiles: form.files.slice(),
          celestial: props.celestial || null,
          attemptKey: state.attemptKey,
          resumeProjectId: state.projectId || undefined,
          resumeCreationId: state.creationId || undefined,
          resumeSessionId: state.sessionId || undefined,
          projectAttempted: state.projectAttempted,
          sessionAttempted: state.sessionAttempted,
          baselineProjectIds: state.baselineProjectIds,
          baselineSessionIds: state.baselineSessionIds,
        });
        if (resumeState.value !== state) return;
        const warning = result?.projectAssignError || result?.projectWarning;
        if (warning) {
          state.projectId = result.requestedProjectId || result.partialProjectId || result.projectId || state.projectId || form.projectId;
          state.creationId = result.creation?.id || state.creationId;
          state.sessionId = result.sessionId || result.creation?.sessionId || state.sessionId;
          unassignedResult.value = result;
          errorMessage.value = warning.message || warning;
          settingsExpanded.value = true;
          return;
        }
        completeCreation(result);
      } catch (err) {
        if (resumeState.value !== state) return;
        state.projectId = err?.partialProjectId || state.projectId;
        state.creationId = err?.partialCreation?.id || err?.partialCreationId || state.creationId;
        state.sessionId = err?.partialSessionId || state.sessionId;
        state.projectAttempted = err?.projectAttempted ?? state.projectAttempted;
        state.sessionAttempted = err?.sessionAttempted ?? state.sessionAttempted;
        state.baselineProjectIds = err?.baselineProjectIds ?? state.baselineProjectIds;
        state.baselineSessionIds = err?.baselineSessionIds ?? state.baselineSessionIds;
        errorMessage.value = err?.message || tr('creation.create.failed', 'Failed to create Creation');
        maybeExpandSettingsForError(errorMessage.value);
      } finally {
        if (resumeState.value === state) submitting.value = false;
      }
    };

    return {
      kinds: CREATION_KINDS,
      categories: CREATION_CATEGORIES,
      modalEl,
      titleInputRef,
      newProjectInputRef,
      fileInputRef,
      form,
      submitting,
      errorMessage,
      projectNameError,
      unassignedResult,
      continueWithoutProject,
      dragOver,
      folderExpanded,
      settingsExpanded,
      settingsSummaryText,
      agentOptions,
      hasEligibleAgent,
      projectOptions,
      existingSessionOptions,
      canSubmit,
      tr,
      formatFileSize,
      selectCategory,
      toggleNewProject,
      triggerFilePicker,
      onFileInputChange,
      onFileDrop,
      removeFile,
      requestClose,
      onBackdropClick,
      handleSubmit,
    };
  },
};
