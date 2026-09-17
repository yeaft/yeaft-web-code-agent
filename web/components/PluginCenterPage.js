import { agentSupportsYeaftPlugins } from '../utils/yeaft-plugin-capability.js';
import { agentSupportsYeaftManagedSkills } from '../utils/yeaft-managed-skill-capability.js';

export default {
  name: 'PluginCenterPage',
  emits: ['close'],
  data() {
    return {
      saving: false,
      error: '',
      selection: null,
      savedSelection: null,
      searchQuery: '',
      activeCategory: 'all',
      configLoading: false,
      configLoadError: '',
      configLoadedAgentId: null,
      configLoadGeneration: 0,
      refreshGeneration: 0,
      saveGeneration: 0,
      skillMutationLoading: false,
      skillMutationError: '',
      skillScope: 'user',
      showSkillForm: false,
      skillForm: {
        name: '',
        description: '',
        trigger: '',
        content: '',
      },
    };
  },
  computed: {
    store() {
      try { return window.Pinia?.useChatStore?.() || null; } catch (_) { return null; }
    },
    agents() {
      return (this.store?.agents || []).filter(agent => agent?.online);
    },
    agentId() {
      return this.store?.pluginCenterAgentId || this.store?.currentAgent || null;
    },
    selectedAgent() {
      return this.agents.find(agent => agent.id === this.agentId) || null;
    },
    agentSupportsPlugins() {
      return agentSupportsYeaftPlugins(this.selectedAgent);
    },
    agentSupportsManagedSkills() {
      return agentSupportsYeaftManagedSkills(this.selectedAgent);
    },
    skillManagementUnavailableMessage() {
      return this.selectedAgent?.capabilityMetadataProvided === true
        ? this.$t('yeaft.plugins.skillManagementUpgradeRequired')
        : this.$t('yeaft.plugins.skillManagementVersionUnknown');
    },
    activeSession() {
      return this.store?.activePluginSession?.() || { sessionId: '', agentId: '', workDir: '' };
    },
    projectSkillAvailable() {
      return this.activeSession.agentId === this.agentId && !!this.activeSession.sessionId && !!this.activeSession.workDir;
    },
    configRecord() {
      return this.store?.pluginConfigByAgent?.[this.agentId] || null;
    },
    catalogWorkDir() {
      return this.projectSkillAvailable ? this.activeSession.workDir : '';
    },
    catalogRecord() {
      const key = this.store?.pluginCatalogKey?.(this.agentId, this.catalogWorkDir);
      return key ? this.store?.pluginCatalogByKey?.[key] || null : null;
    },
    catalog() {
      return this.catalogRecord?.catalog || { tools: [], skills: [], skillSources: [], mcpServers: [] };
    },
    managedSkillSources() {
      return Array.isArray(this.catalog.skillSources)
        ? this.catalog.skillSources.filter(item => item?.managed)
        : [];
    },
    loading() {
      return this.agentSupportsPlugins
        && (!this.catalogRecord || !!this.catalogRecord.loading);
    },
    configReady() {
      return !!this.agentId
        && this.agentSupportsPlugins
        && this.configLoadedAgentId === this.agentId
        && !this.configLoading
        && !this.configLoadError;
    },
    hasCatalog() {
      return this.catalog.tools.length + this.catalog.skills.length + this.catalog.mcpServers.length > 0;
    },
    hasExplicitSelection() {
      return !!this.selection && Object.keys(this.selection).length > 0;
    },
    enabledCount() {
      if (!this.hasExplicitSelection) return this.catalog.tools.length + this.catalog.skills.length + this.catalog.mcpServers.length;
      return ['tools', 'skills', 'mcpServers'].reduce((count, field) => (
        count + (Array.isArray(this.selection[field])
          ? this.selection[field].length
          : this.catalog[field].length)
      ), 0);
    },
    totalCount() {
      return this.catalog.tools.length + this.catalog.skills.length + this.catalog.mcpServers.length;
    },
    categoryDefinitions() {
      return [
        { id: 'all', label: this.$t('yeaft.plugins.all'), count: this.totalCount },
        { id: 'tools', label: this.$t('yeaft.plugins.tools'), count: this.catalog.tools.length },
        { id: 'skills', label: this.$t('yeaft.plugins.skills'), count: this.catalog.skills.length },
        { id: 'mcpServers', label: this.$t('yeaft.plugins.mcpServers'), count: this.catalog.mcpServers.length },
      ];
    },
    normalizedSearchQuery() {
      return this.searchQuery.trim().toLocaleLowerCase();
    },
    filteredCatalog() {
      const matches = (item) => {
        if (!this.normalizedSearchQuery) return true;
        const searchable = [item?.id, item?.name, item?.label, item?.description];
        if (Number.isFinite(item?.toolCount)) searchable.push(String(item.toolCount));
        return searchable
          .filter(Boolean)
          .some(value => String(value).toLocaleLowerCase().includes(this.normalizedSearchQuery));
      };
      return {
        tools: this.catalog.tools.filter(matches),
        skills: this.catalog.skills.filter(matches),
        mcpServers: this.catalog.mcpServers.filter(matches),
      };
    },
    visibleCategories() {
      return ['tools', 'skills', 'mcpServers'].filter((field) => (
        (this.activeCategory === 'all' || this.activeCategory === field)
        && this.filteredCatalog[field].length > 0
      ));
    },
    hasSearchResults() {
      return this.visibleCategories.length > 0;
    },
    visibleResultCount() {
      return this.visibleCategories.reduce((total, field) => total + this.filteredCatalog[field].length, 0);
    },
    isDirty() {
      return JSON.stringify(this.normalizedSelection(this.selection))
        !== JSON.stringify(this.normalizedSelection(this.savedSelection));
    },
    statusSummary() {
      if (!this.agentId) return this.$t('yeaft.plugins.noAgent');
      if (!this.agentSupportsPlugins) return this.$t('yeaft.plugins.upgradeRequired');
      if (this.loading || this.configLoading) return this.$t('yeaft.plugins.loading');
      const error = this.catalogRecord?.error || this.configLoadError;
      if (error) return this.$t('yeaft.plugins.loadError', { error });
      if (!this.hasCatalog) return this.$t('yeaft.plugins.empty');
      return this.hasExplicitSelection
        ? this.$t('yeaft.plugins.selectedSummary', { count: this.enabledCount })
        : this.$t('yeaft.plugins.allAvailable');
    },
  },
  watch: {
    catalogWorkDir(next, previous) {
      if (next === previous || !this.agentId || !this.agentSupportsPlugins) return;
      this.store?.loadPluginCatalog?.(this.agentId, next).catch(() => {});
    },
    agentId: {
      immediate: true,
      handler(next) {
        ++this.configLoadGeneration;
        ++this.refreshGeneration;
        ++this.saveGeneration;
        this.saving = false;
        this.error = '';
        if (!next) {
          this.selection = null;
          this.savedSelection = null;
          this.searchQuery = '';
          this.activeCategory = 'all';
          this.configLoading = false;
          this.configLoadError = '';
          this.configLoadedAgentId = null;
          return;
        }
        this.searchQuery = '';
        this.activeCategory = 'all';
        if (!this.agentSupportsPlugins) {
          this.selection = null;
          this.savedSelection = null;
          this.configLoading = false;
          this.configLoadError = this.$t('yeaft.plugins.upgradeRequired');
          this.configLoadedAgentId = null;
          return;
        }
        this.loadConfig(next);
        this.store?.loadPluginCatalog?.(next, this.catalogWorkDir).catch(() => {});
      },
    },
  },
  methods: {
    loadConfig(agentId = this.agentId, generation = ++this.configLoadGeneration) {
      if (!agentId) return;
      ++this.refreshGeneration;
      ++this.saveGeneration;
      this.saving = false;
      this.selection = null;
      this.savedSelection = null;
      this.configLoadedAgentId = null;
      this.configLoading = false;
      this.configLoadError = '';
      if (!this.agentSupportsPlugins) {
        this.configLoadError = this.$t('yeaft.plugins.upgradeRequired');
        return;
      }
      if (this.configRecord?.loaded && !this.configRecord?.error) {
        this.selection = this.copySelection(this.configRecord.plugins);
        this.savedSelection = this.copySelection(this.configRecord.plugins);
        this.configLoadedAgentId = agentId;
        return;
      }
      const request = this.store?.loadPluginConfig?.(agentId);
      this.configLoading = true;
      Promise.resolve(request)
        .then((record) => {
          if (generation !== this.configLoadGeneration || agentId !== this.agentId) return;
          if (record?.error) {
            this.configLoadError = record.error;
            return;
          }
          this.selection = this.copySelection(record?.plugins);
          this.savedSelection = this.copySelection(record?.plugins);
          this.configLoadedAgentId = agentId;
        })
        .catch((err) => {
          if (generation !== this.configLoadGeneration || agentId !== this.agentId) return;
          this.configLoadError = err?.message || String(err);
        })
        .finally(() => {
          if (generation === this.configLoadGeneration && agentId === this.agentId) {
            this.configLoading = false;
          }
        });
    },
    copySelection(plugins = {}) {
      const copy = {};
      for (const field of ['tools', 'skills', 'mcpServers']) {
        if (Array.isArray(plugins?.[field])) copy[field] = [...plugins[field]];
      }
      return copy;
    },
    normalizedSelection(plugins = {}) {
      const normalized = {};
      for (const field of ['tools', 'skills', 'mcpServers']) {
        if (Array.isArray(plugins?.[field])) normalized[field] = [...plugins[field]].sort();
      }
      return normalized;
    },
    pluginName(field, item) {
      return field === 'skills' ? (item?.name || item?.label || item?.id) : item?.id;
    },
    enabled(field, item) {
      const name = this.pluginName(field, item);
      if (!this.selection || !Array.isArray(this.selection[field])) return true;
      return this.selection[field].includes(name);
    },
    toggle(field, item, checked) {
      if (!this.configReady || this.saving) return;
      const name = this.pluginName(field, item);
      if (!name) return;
      const selection = this.selection || {};
      const current = new Set(Array.isArray(selection[field])
        ? selection[field]
        : this.catalog[field].map(entry => this.pluginName(field, entry)));
      if (checked) current.add(name);
      else current.delete(name);
      this.selection = { ...selection, [field]: [...current] };
    },
    useAll() {
      if (!this.configReady || this.saving) return;
      this.selection = {};
      this.error = '';
    },
    async refresh() {
      if (!this.agentId || !this.agentSupportsPlugins) return;
      const targetAgentId = this.agentId;
      const targetLoadGeneration = this.configLoadGeneration;
      const targetRefreshGeneration = ++this.refreshGeneration;
      const isCurrentRefresh = () => (
        targetAgentId === this.agentId
        && targetLoadGeneration === this.configLoadGeneration
        && targetRefreshGeneration === this.refreshGeneration
      );
      this.error = '';
      try {
        const result = await this.store?.loadPluginCatalog?.(targetAgentId, this.catalogWorkDir);
        if (isCurrentRefresh() && result?.error) this.error = result.error;
      } catch (err) {
        if (isCurrentRefresh()) this.error = err?.message || String(err);
      }
    },
    async save() {
      if (this.saving || !this.agentId || !this.agentSupportsPlugins || !this.configReady) return;
      const targetAgentId = this.agentId;
      const targetLoadGeneration = this.configLoadGeneration;
      const targetSaveGeneration = ++this.saveGeneration;
      const submittedSelection = this.copySelection(this.selection || {});
      const isCurrentSave = () => (
        targetAgentId === this.agentId
        && targetLoadGeneration === this.configLoadGeneration
        && targetSaveGeneration === this.saveGeneration
      );
      this.saving = true;
      this.error = '';
      try {
        const result = await this.store?.savePluginConfig?.(submittedSelection, targetAgentId);
        if (!isCurrentSave()) return;
        if (result?.error) this.error = result.error;
        else {
          const savedSelection = this.copySelection(result?.plugins ?? submittedSelection);
          this.selection = savedSelection;
          this.savedSelection = this.copySelection(savedSelection);
        }
      } catch (err) {
        if (isCurrentSave()) this.error = err?.message || String(err);
      } finally {
        if (isCurrentSave()) this.saving = false;
      }
    },
    resetSkillForm() {
      this.skillForm.name = '';
      this.skillForm.description = '';
      this.skillForm.trigger = '';
      this.skillForm.content = '';
      this.skillMutationError = '';
    },
    async refreshCatalogForSkillScope() {
      await this.store?.loadPluginCatalog?.(this.agentId, this.catalogWorkDir);
    },
    async createSkill() {
      if (this.skillMutationLoading || !this.agentSupportsManagedSkills) return;
      if (this.skillScope === 'project' && !this.projectSkillAvailable) {
        this.skillMutationError = this.$t('yeaft.plugins.projectScopeUnavailable');
        return;
      }
      this.skillMutationLoading = true;
      this.skillMutationError = '';
      try {
        const result = await this.store?.mutateManagedSkill?.({
          action: 'create',
          scope: this.skillScope,
          skill: { ...this.skillForm },
          sessionId: this.skillScope === 'project' ? this.activeSession.sessionId : '',
        }, this.agentId);
        if (result?.error) {
          this.skillMutationError = result.error;
          return;
        }
        const createdName = typeof result?.result?.name === 'string'
          ? result.result.name.trim()
          : '';
        if (createdName && Array.isArray(this.selection?.skills)) {
          this.selection = {
            ...this.selection,
            skills: [...new Set([...this.selection.skills, createdName])],
          };
        }
        this.resetSkillForm();
        this.showSkillForm = false;
        await this.refreshCatalogForSkillScope();
      } catch (err) {
        this.skillMutationError = err?.message || String(err);
      } finally {
        this.skillMutationLoading = false;
      }
    },
    async removeSkill(item) {
      if (!item?.managed || this.skillMutationLoading || !this.agentSupportsManagedSkills) return;
      const scope = item.tier === 'project' ? 'project' : 'user';
      if (scope === 'project' && !this.projectSkillAvailable) {
        this.skillMutationError = this.$t('yeaft.plugins.projectScopeUnavailable');
        return;
      }
      if (!confirm(this.$t('yeaft.plugins.confirmRemoveSkill', { name: item.label }))) return;
      this.skillMutationLoading = true;
      this.skillMutationError = '';
      try {
        const result = await this.store?.mutateManagedSkill?.({
          action: 'remove',
          scope,
          name: item.name || item.label,
          sessionId: scope === 'project' ? this.activeSession.sessionId : '',
        }, this.agentId);
        if (result?.error) this.skillMutationError = result.error;
        else await this.refreshCatalogForSkillScope();
      } catch (err) {
        this.skillMutationError = err?.message || String(err);
      } finally {
        this.skillMutationLoading = false;
      }
    },
    selectAgent(agentId) {
      if (!agentId || agentId === this.agentId) return;
      this.store.pluginCenterAgentId = agentId;
    },
  },
  template: `
    <section class="plugin-center-page" :aria-label="$t('yeaft.plugins.title')">
      <header class="plugin-center-header">
        <div class="plugin-center-heading">
          <h1>{{ $t('yeaft.plugins.title') }}</h1>
          <p>{{ $t('yeaft.plugins.subtitle') }}</p>
        </div>
        <div class="plugin-center-header-actions">
          <button type="button" class="plugin-center-icon-button" @click="refresh" :disabled="loading || !agentSupportsPlugins" :title="$t('common.refresh')" :aria-label="$t('common.refresh')">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M20 11a8 8 0 1 0 2 5.3M20 4v7h-7"/></svg>
          </button>
          <button type="button" class="plugin-center-close-button" @click="$emit('close')">{{ $t('common.close') }}</button>
        </div>
      </header>

      <div class="plugin-center-layout">
        <aside class="plugin-center-agent-rail" :aria-label="$t('yeaft.plugins.agentLabel')">
          <div class="plugin-center-rail-heading">
            <span>{{ $t('yeaft.plugins.agentLabel') }}</span>
            <span class="plugin-center-rail-count">{{ agents.length }}</span>
          </div>
          <div class="plugin-center-agent-list">
            <button
              v-for="agent in agents"
              :key="agent.id"
              type="button"
              class="plugin-center-agent"
              :class="{ 'is-active': agent.id === agentId }"
              :aria-pressed="agent.id === agentId"
              @click="selectAgent(agent.id)"
            >
              <span class="plugin-center-agent-mark" aria-hidden="true">{{ (agent.name || agent.id || '?').slice(0, 1).toUpperCase() }}</span>
              <span class="plugin-center-agent-copy">
                <strong>{{ agent.name || agent.id }}</strong>
                <small>{{ agent.id }}</small>
              </span>
            </button>
          </div>
        </aside>

        <main class="plugin-center-content">
          <section class="plugin-center-overview" :aria-label="$t('yeaft.plugins.overviewLabel')">
            <div class="plugin-center-overview-copy">
              <h2>{{ selectedAgent?.name || selectedAgent?.id || $t('yeaft.plugins.noAgent') }}</h2>
              <p>{{ statusSummary }}</p>
            </div>
            <div v-if="configReady && !loading && !catalogRecord?.error && hasCatalog" class="plugin-center-overview-stats">
              <span class="plugin-center-enabled-count"><strong>{{ enabledCount }}</strong> / {{ totalCount }}</span>
              <span>{{ $t('yeaft.plugins.enabledLabel') }}</span>
            </div>
            <button type="button" class="btn-secondary plugin-center-use-all" @click="useAll" :disabled="!configReady || !hasExplicitSelection || saving">
              {{ $t('yeaft.plugins.useAll') }}
            </button>
          </section>

          <div v-if="!agentSupportsPlugins" class="plugin-center-state is-error">
            <span class="plugin-center-state-icon" aria-hidden="true">!</span>
            <p>{{ $t('yeaft.plugins.upgradeRequired') }}</p>
          </div>
          <div v-else-if="loading" class="plugin-center-state">
            <span class="plugin-center-loading-dot" aria-hidden="true"></span>
            <p>{{ $t('yeaft.plugins.loading') }}</p>
          </div>
          <div v-else-if="catalogRecord?.error" class="plugin-center-state is-error">
            <span class="plugin-center-state-icon" aria-hidden="true">!</span>
            <p>{{ $t('yeaft.plugins.loadError', { error: catalogRecord.error }) }}</p>
            <button type="button" class="btn-secondary" @click="refresh">{{ $t('yeaft.plugins.retry') }}</button>
          </div>
          <div v-else-if="configLoadError" class="plugin-center-state is-error">
            <span class="plugin-center-state-icon" aria-hidden="true">!</span>
            <p>{{ $t('yeaft.plugins.loadError', { error: configLoadError }) }}</p>
            <button type="button" class="btn-secondary" @click="loadConfig(agentId)">{{ $t('yeaft.plugins.retry') }}</button>
          </div>
          <template v-else>
            <div class="plugin-center-toolbar">
              <label class="plugin-center-search">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                <input v-model="searchQuery" type="search" :placeholder="$t('yeaft.plugins.searchPlaceholder')" :aria-label="$t('yeaft.plugins.searchPlaceholder')">
              </label>
              <span class="plugin-center-result-count">{{ $t('yeaft.plugins.resultCount', { count: visibleResultCount }) }}</span>
            </div>

            <div class="plugin-center-tabs" role="tablist" :aria-label="$t('yeaft.plugins.categoryLabel')">
              <button
                v-for="category in categoryDefinitions"
                :key="category.id"
                type="button"
                role="tab"
                class="plugin-center-tab"
                :class="{ 'is-active': activeCategory === category.id }"
                :aria-selected="activeCategory === category.id"
                @click="activeCategory = category.id"
              >
                <span>{{ category.label }}</span>
                <span class="plugin-center-tab-count">{{ category.count }}</span>
              </button>
            </div>

            <section class="plugin-center-skill-management" aria-labelledby="plugin-manage-skills-title">
              <div class="plugin-center-section-heading">
                <div>
                  <h2 id="plugin-manage-skills-title">{{ $t('yeaft.plugins.manageSkills') }}</h2>
                  <p class="plugin-center-section-description">{{ $t('yeaft.plugins.manageSkillsDescription') }}</p>
                </div>
                <button type="button" class="btn-secondary plugin-center-skill-create" @click="showSkillForm = !showSkillForm" :disabled="skillMutationLoading || !agentSupportsManagedSkills">
                  {{ showSkillForm ? $t('common.cancel') : $t('yeaft.plugins.createSkill') }}
                </button>
              </div>
              <p v-if="!agentSupportsManagedSkills" class="plugin-center-scope-hint is-error">{{ skillManagementUnavailableMessage }}</p>
              <div v-if="showSkillForm" class="plugin-center-skill-form">
                <div class="plugin-center-scope-control">
                  <span>{{ $t('yeaft.plugins.skillScope') }}</span>
                  <div class="plugin-center-scope-options" role="radiogroup" :aria-label="$t('yeaft.plugins.skillScope')">
                    <label>
                      <input v-model="skillScope" type="radio" value="user" :disabled="skillMutationLoading">
                      <span>{{ $t('yeaft.plugins.userScope') }}</span>
                    </label>
                    <label :class="{ 'is-disabled': !projectSkillAvailable }">
                      <input v-model="skillScope" type="radio" value="project" :disabled="skillMutationLoading || !projectSkillAvailable">
                      <span>{{ $t('yeaft.plugins.projectScope') }}</span>
                    </label>
                  </div>
                </div>
                <p class="plugin-center-scope-hint">
                  {{ skillScope === 'project' ? $t('yeaft.plugins.projectScopeDescription') : $t('yeaft.plugins.userScopeDescription') }}
                </p>
                <label>
                  <span>{{ $t('yeaft.plugins.skillName') }}</span>
                  <input v-model="skillForm.name" type="text" :disabled="skillMutationLoading" autocomplete="off">
                </label>
                <label>
                  <span>{{ $t('yeaft.plugins.skillDescriptionLabel') }}</span>
                  <input v-model="skillForm.description" type="text" :disabled="skillMutationLoading">
                </label>
                <label>
                  <span>{{ $t('yeaft.plugins.skillTrigger') }}</span>
                  <input v-model="skillForm.trigger" type="text" :disabled="skillMutationLoading">
                </label>
                <label>
                  <span>{{ $t('yeaft.plugins.skillInstructions') }}</span>
                  <textarea v-model="skillForm.content" :disabled="skillMutationLoading" rows="5"></textarea>
                </label>
                <p v-if="skillMutationError" class="plugin-center-skill-error" role="alert">{{ skillMutationError }}</p>
                <div class="plugin-center-skill-form-actions">
                  <button type="button" class="btn-primary" @click="createSkill" :disabled="skillMutationLoading || !skillForm.name || !skillForm.description || !skillForm.content || !agentSupportsManagedSkills">
                    {{ skillMutationLoading ? $t('common.saving') : $t('yeaft.plugins.createSkill') }}
                  </button>
                  <button type="button" class="btn-secondary" @click="resetSkillForm" :disabled="skillMutationLoading">{{ $t('yeaft.plugins.resetSkillForm') }}</button>
                </div>
              </div>
              <div v-if="managedSkillSources.length" class="plugin-center-managed-skill-list">
                <div v-for="item in managedSkillSources" :key="item.id" class="plugin-center-managed-skill-row">
                  <span class="plugin-center-card-copy">
                    <strong>{{ item.label }}</strong>
                    <small>{{ $t('yeaft.plugins.skillTier.' + item.tier) }}</small>
                  </span>
                  <button type="button" class="plugin-center-skill-remove" :disabled="skillMutationLoading || !agentSupportsManagedSkills" @click="removeSkill(item)">
                    {{ $t('yeaft.plugins.removeSkill') }}
                  </button>
                </div>
              </div>
            </section>

            <div v-if="!hasSearchResults && hasCatalog" class="plugin-center-empty-search">
              <span class="plugin-center-empty-search-icon" aria-hidden="true">⌕</span>
              <h2>{{ $t('yeaft.plugins.noMatchesTitle') }}</h2>
              <p>{{ $t('yeaft.plugins.noMatchesBody') }}</p>
            </div>

            <div v-else-if="hasCatalog" class="plugin-center-sections">
              <section v-if="visibleCategories.includes('tools')" class="plugin-center-section" aria-labelledby="plugin-tools-title">
                <div class="plugin-center-section-heading">
                  <div>
                    <h2 id="plugin-tools-title">{{ $t('yeaft.plugins.tools') }}</h2>
                  </div>
                  <span>{{ filteredCatalog.tools.length }}</span>
                </div>
                <div class="plugin-center-card-grid">
                  <label v-for="item in filteredCatalog.tools" :key="item.id" class="plugin-center-card" :class="{ 'is-disabled': !configReady || saving || !enabled('tools', item) }">
                    <input type="checkbox" :checked="enabled('tools', item)" :disabled="!configReady || saving" @change="toggle('tools', item, $event.target.checked)">
                    <span class="plugin-center-card-icon" aria-hidden="true">⌘</span>
                    <span class="plugin-center-card-copy">
                      <strong>{{ item.label }}</strong>
                      <small>{{ item.description || $t('yeaft.plugins.toolDescription') }}</small>
                    </span>
                    <span class="plugin-center-toggle" aria-hidden="true"></span>
                  </label>
                </div>
              </section>

              <section v-if="visibleCategories.includes('skills')" class="plugin-center-section" aria-labelledby="plugin-skills-title">
                <div class="plugin-center-section-heading">
                  <div>
                    <h2 id="plugin-skills-title">{{ $t('yeaft.plugins.skills') }}</h2>
                  </div>
                  <span>{{ filteredCatalog.skills.length }}</span>
                </div>
                <div class="plugin-center-card-grid">
                  <label v-for="item in filteredCatalog.skills" :key="item.id" class="plugin-center-card" :class="{ 'is-disabled': !configReady || saving || !enabled('skills', item) }">
                    <input type="checkbox" :checked="enabled('skills', item)" :disabled="!configReady || saving" @change="toggle('skills', item, $event.target.checked)">
                    <span class="plugin-center-card-icon" aria-hidden="true">✦</span>
                    <span class="plugin-center-card-copy">
                      <strong>{{ item.label }}</strong>
                      <small>{{ item.description || $t('yeaft.plugins.skillDescription') }}</small>
                      <small v-if="item.tier" class="plugin-center-skill-tier">{{ $t('yeaft.plugins.skillTier.' + item.tier) }}</small>
                    </span>
                    <span class="plugin-center-toggle" aria-hidden="true"></span>
                  </label>
                </div>
              </section>

              <section v-if="visibleCategories.includes('mcpServers')" class="plugin-center-section" aria-labelledby="plugin-mcp-title">
                <div class="plugin-center-section-heading">
                  <div>
                    <h2 id="plugin-mcp-title">{{ $t('yeaft.plugins.mcpServers') }}</h2>
                  </div>
                  <span>{{ filteredCatalog.mcpServers.length }}</span>
                </div>
                <div class="plugin-center-card-grid">
                  <label v-for="item in filteredCatalog.mcpServers" :key="item.id" class="plugin-center-card" :class="{ 'is-disabled': !configReady || saving || !enabled('mcpServers', item) }">
                    <input type="checkbox" :checked="enabled('mcpServers', item)" :disabled="!configReady || saving" @change="toggle('mcpServers', item, $event.target.checked)">
                    <span class="plugin-center-card-icon" aria-hidden="true">◌</span>
                    <span class="plugin-center-card-copy">
                      <strong>{{ item.label }}</strong>
                      <small>{{ $t('yeaft.plugins.mcpDescription', { count: item.toolCount || 0 }) }}</small>
                    </span>
                    <span class="plugin-center-toggle" aria-hidden="true"></span>
                  </label>
                </div>
              </section>
            </div>
          </template>
        </main>
      </div>

      <footer class="plugin-center-footer">
        <span v-if="error" class="plugin-center-error" role="alert">{{ error }}</span>
        <span v-else-if="isDirty" class="plugin-center-unsaved">{{ $t('yeaft.plugins.unsavedChanges') }}</span>
        <span class="plugin-center-footer-spacer"></span>
        <button type="button" class="btn-secondary plugin-center-cancel" @click="$emit('close')">{{ $t('common.close') }}</button>
        <button type="button" class="btn-primary plugin-center-save" @click="save" :disabled="saving || loading || !configReady || !agentId || !isDirty">
          {{ saving ? $t('common.saving') : $t('common.save') }}
        </button>
      </footer>
    </section>
  `,
};
