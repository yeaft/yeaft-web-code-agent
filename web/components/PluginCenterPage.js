import NavigationIcon from './NavigationIcon.js';
import { pluginCenterAgents } from '../stores/helpers/plugin-config.js';
import { confirmDialog, useDialogState } from '../utils/dialog.js';
import { agentSupportsYeaftPlugins } from '../utils/yeaft-plugin-capability.js';
import { agentSupportsYeaftManagedSkills } from '../utils/yeaft-managed-skill-capability.js';

const FIELDS = ['skills', 'mcpServers', 'tools'];

export default {
  name: 'PluginCenterPage',
  components: { NavigationIcon },
  emits: ['close', 'toggle-sidebar'],
  data() {
    return {
      disposed: false,
      skillDetail: null, skillDetailLoading: false, skillDetailError: '', skillDetailUnsupported: false, skillDetailSequence: 0,
      searchQuery: '', activeCategory: 'all', enabledOnly: false,
      searchOpen: false, menu: null, detailKey: null, listScrollTop: 0, formBackground: [], formOpener: null,
      showSkillForm: false, skillScope: 'user', skillMutationLoading: false, skillMutationError: '',
      skillForm: { name: '', description: '', trigger: '', content: '' },
    };
  },
  computed: {
    store() {
      try { return window.Pinia?.useChatStore?.() || null; } catch { return null; }
    },
    agents() { return pluginCenterAgents(this.store); },
    agentId() { return this.store?.pluginCenterAgentId || this.store?.currentAgent || null; },
    selectedAgent() { return this.agents.find(agent => agent.id === this.agentId) || null; },
    online() { return !!this.selectedAgent?.online && (!this.store?.connectionState || this.store.connectionState === 'connected'); },
    agentSupportsPlugins() { return !!this.selectedAgent && agentSupportsYeaftPlugins(this.selectedAgent); },
    agentSupportsManagedSkills() { return !!this.selectedAgent && agentSupportsYeaftManagedSkills(this.selectedAgent); },
    activeSession() { return this.store?.activePluginSession?.() || {}; },
    projectSkillAvailable() {
      return this.activeSession.agentId === this.agentId && !!this.activeSession.sessionId && !!this.activeSession.workDir;
    },
    catalogWorkDir() { return this.projectSkillAvailable ? this.activeSession.workDir : ''; },
    configRecord() { return this.store?.pluginConfigByAgent?.[this.agentId] || {}; },
    selection() { return this.configRecord.draft ?? this.configRecord.plugins ?? {}; },
    configReady() { return this.online && this.agentSupportsPlugins && this.configRecord.loaded && !this.configRecord.loading && !(this.configRecord.error && this.configRecord.errorOperation === 'load'); },
    catalogRecord() {
      const key = this.store?.pluginCatalogKey?.(this.agentId, this.catalogWorkDir);
      return this.store?.pluginCatalogByKey?.[key] || {};
    },
    catalog() { return { tools: [], skills: [], skillSources: [], mcpServers: [], ...this.catalogRecord.catalog }; },
    loading() { return this.online && this.agentSupportsPlugins && ((!this.catalogRecord.loaded && !this.catalogRecord.error) || this.catalogRecord.loading || this.configRecord.loading); },
    loadError() { return this.catalogRecord.error || (this.configRecord.errorOperation === 'load' ? this.configRecord.error : '') || ''; },
    categories() {
      return ['all', ...FIELDS].map(id => ({ id, label: this.$t('yeaft.plugins.' + id) }));
    },
    entries() {
      return FIELDS.flatMap(field => this.catalog[field].map(item => ({
        ...item, field, key: `${field}:${item.id}`, label: item.label || item.name || item.id,
      })));
    },
    visibleEntries() {
      const query = this.searchQuery.trim().toLocaleLowerCase();
      return this.entries.filter(item => (this.activeCategory === 'all' || this.activeCategory === item.field)
        && (!this.enabledOnly || this.enabled(item))
        && (!query || [item.id, item.label, item.description].some(value => String(value || '').toLocaleLowerCase().includes(query))));
    },
    detail() { return this.entries.find(item => item.key === this.detailKey) || null; },
    skillCommand() { return this.detail ? `/skill:${this.pluginName(this.detail)} ${this.$t('yeaft.plugins.skillExampleTask')}` : ''; },
    detailDescription() {
      if (!this.detail) return '';
      if (this.detail.field !== 'skills') return this.itemDescription(this.detail);
      const description = String(this.skillDetail?.description || this.detail.description || '').trim();
      return ['|', '>'].includes(description) ? '' : description;
    },
    detailSources() {
      return this.detail?.field === 'skills'
        ? this.catalog.skillSources.filter(item => (item.name || item.label) === this.pluginName(this.detail)) : [];
    },
    skillFormDirty() { return Object.values(this.skillForm).some(value => value.trim()); },
    saveErrors() { return Object.entries(this.store?.pluginConfigByAgent || {}).filter(([, record]) => (record.errorOperation === 'save' && record.error)); },
  },
  watch: {
    agentId: { immediate: true, handler() { this.detailKey = null; this.menu = null; this.load(); } },
    catalogWorkDir() { this.detailKey = null; this.load(); },
    online(next, previous) {
      if (next && !previous) { this.load(true); this.loadSkillDetail(); }
      if (!next) { this.skillDetailSequence++; this.skillDetail = null; this.skillDetailLoading = false; this.skillDetailError = ''; this.skillDetailUnsupported = false; }
    },
    detailKey() { this.loadSkillDetail(); },
    showSkillForm(open) {
      if (open) {
        this.formOpener = document.activeElement;
        this.$nextTick(() => {
          if (this.disposed || !this.showSkillForm) return;
          this.formBackground = [...document.body.children].filter(element => !element.classList.contains('plugin-center-form-overlay'));
          this.formBackground.forEach(element => { element.inert = true; });
        });
      } else {
        this.restoreFormBackground();
        this.$nextTick(() => this.formOpener?.isConnected && this.formOpener.focus());
      }
    },
    activeCategory() { this.detailKey = null; },
    searchQuery() { this.detailKey = null; },
  },
  mounted() {
    document.addEventListener('pointerdown', this.closePopups);
    document.addEventListener('keydown', this.onKeydown);
    window.addEventListener('beforeunload', this.beforeUnload);
  },
  beforeUnmount() {
    this.disposed = true;
    this.restoreFormBackground();
    document.removeEventListener('pointerdown', this.closePopups);
    document.removeEventListener('keydown', this.onKeydown);
    window.removeEventListener('beforeunload', this.beforeUnload);
  },
  methods: {
    operationFence() {
      return { store: this.store, generation: Number(this.store?.pluginStateGeneration || 0), agentId: this.agentId, workDir: this.catalogWorkDir };
    },
    operationCurrent(fence) {
      return !this.disposed && this.store?.pluginCenterOpen && fence.store === this.store
        && fence.generation === Number(this.store?.pluginStateGeneration || 0)
        && fence.agentId === this.agentId && fence.workDir === this.catalogWorkDir;
    },
    restoreFormBackground() {
      this.formBackground.forEach(element => { element.inert = false; });
      this.formBackground = [];
    },
    async load(force = false) {
      if (this.disposed || !this.store?.pluginCenterOpen || !this.agentId || !this.online || !this.agentSupportsPlugins) return;
      const agentId = this.agentId, workDir = this.catalogWorkDir;
      await Promise.all([
        this.store.loadPluginConfig(agentId),
        (force || !this.catalogRecord.loaded) ? this.store.loadPluginCatalog(agentId, workDir) : Promise.resolve(),
      ]);
      if (!this.disposed && agentId === this.agentId && workDir === this.catalogWorkDir) this.loadSkillDetail();
    },
    async loadSkillDetail() {
      const sequence = ++this.skillDetailSequence;
      this.skillDetail = null; this.skillDetailError = ''; this.skillDetailUnsupported = false; this.skillDetailLoading = false;
      if (this.detail?.field !== 'skills' || !this.online) return;
      const fence = this.operationFence(), key = this.detailKey, name = this.pluginName(this.detail);
      this.skillDetailLoading = true;
      try {
        const result = await this.store.loadPluginSkillDetail(name, this.agentId, this.catalogWorkDir);
        if (sequence !== this.skillDetailSequence || key !== this.detailKey || !this.operationCurrent(fence) || !this.online) return;
        if (result?.stale) return;
        this.skillDetail = result?.skillDetail || null;
        this.skillDetailError = result?.error || '';
        this.skillDetailUnsupported = result?.unsupported === true;
      } catch (error) {
        if (sequence === this.skillDetailSequence && this.operationCurrent(fence)) this.skillDetailError = error?.message || String(error);
      } finally { if (sequence === this.skillDetailSequence) this.skillDetailLoading = false; }
    },
    pluginName(item) { return item.field === 'skills' ? (item.name || item.label || item.id) : item.id; },
    enabled(item) { return !Array.isArray(this.selection[item.field]) || this.selection[item.field].includes(this.pluginName(item)); },
    toggle(item) {
      if (!this.configReady) return;
      this.store.setPluginEnabled(item.field, this.pluginName(item), !this.enabled(item), this.catalog[item.field].map(entry => this.pluginName({ ...entry, field: item.field })), this.agentId);
    },
    itemSaving(item) {
      const confirmed = this.configRecord.plugins?.[item.field];
      const wasEnabled = !Array.isArray(confirmed) || confirmed.includes(this.pluginName(item));
      return this.configRecord.saving && wasEnabled !== this.enabled(item);
    },
    itemDescription(item) {
      if (item.field === 'mcpServers') return this.$t('yeaft.plugins.mcpDescription', { count: item.toolCount || 0 });
      return item.description || this.$t(item.field === 'skills' ? 'yeaft.plugins.skillDescription' : 'yeaft.plugins.toolDescription');
    },
    itemSource(item) {
      if (item.field === 'mcpServers') return this.$t(item.ready === true ? 'yeaft.plugins.connected' : item.ready === false ? 'yeaft.plugins.notConnected' : 'yeaft.plugins.connectionUnknown');
      if (item.field === 'tools') return this.$t('yeaft.plugins.bundled');
      return item.tier ? this.$t('yeaft.plugins.skillTier.' + item.tier) : this.$t('yeaft.plugins.agentLabel');
    },
    itemIcon(item) { return item.field === 'skills' ? 'activity' : item.field === 'mcpServers' ? 'globe' : 'file'; },
    agentName(id) { const agent = this.agents.find(entry => entry.id === id); return agent?.name || id; },
    async selectAgent(id) {
      if (id === this.agentId) { this.menu = null; return; }
      const fence = this.operationFence();
      if (!await this.closeSkillForm() || !this.operationCurrent(fence)) return;
      this.store.pluginCenterAgentId = id;
    },
    toggleMenu(name) {
      this.menu = this.menu === name ? null : name;
      if (this.menu) this.$nextTick(() => this.$refs[name + 'Menu']?.querySelector('button')?.focus());
    },
    closePopups(event) { if (!event.target.closest('.plugin-center-menu-host')) this.menu = null; },
    onKeydown(event) {
      if (event.key !== 'Escape' || event.defaultPrevented || useDialogState().open) return;
      if (this.menu) { const menu = this.menu; this.menu = null; this.$refs[menu + 'Trigger']?.focus(); }
      else if (this.searchOpen) this.closeSearch();
      else if (this.showSkillForm) this.closeSkillForm();
    },
    menuKeydown(event) {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
      const current = buttons.indexOf(document.activeElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[index]?.focus();
    },
    openSearch() { this.searchOpen = true; this.menu = null; this.$nextTick(() => this.$refs.mobileSearch?.focus()); },
    closeSearch() { this.searchOpen = false; this.$nextTick(() => this.$refs.searchTrigger?.focus()); },
    openDetail(item) {
      this.listScrollTop = this.$refs.content?.scrollTop || 0;
      this.detailKey = item.key; this.menu = null;
      this.$nextTick(() => { if (!this.disposed && this.$refs.content) { this.$refs.content.scrollTop = 0; this.$refs.detailTitle?.focus(); } });
    },
    backToList() {
      const key = this.detailKey; this.detailKey = null;
      this.$nextTick(() => {
        if (this.disposed || !this.$refs.content) return;
        this.$refs.content.scrollTop = this.listScrollTop;
        [...this.$el.querySelectorAll('.plugin-center-row-main')].find(button => button.dataset.entry === key)?.focus({ preventScroll: true });
      });
    },
    resetFilters() { this.searchQuery = ''; this.activeCategory = 'all'; this.enabledOnly = false; },
    openSkillForm() {
      this.menu = null; this.showSkillForm = true; this.skillMutationError = '';
      this.$nextTick(() => this.$refs.skillName?.focus());
    },
    async closeSkillForm() {
      if (!this.showSkillForm) return true;
      if (this.skillMutationLoading) return false;
      if (this.skillFormDirty) {
        const fence = this.operationFence();
        const discard = await confirmDialog(this.$t('yeaft.plugins.discardSkill'));
        if (!this.operationCurrent(fence)) return false;
        if (!discard) {
          this.formBackground.forEach(element => { element.inert = true; });
          return false;
        }
      }
      this.showSkillForm = false; this.skillMutationError = '';
      this.skillForm = { name: '', description: '', trigger: '', content: '' };
      return true;
    },
    beforeUnload(event) { if (this.showSkillForm && this.skillFormDirty) { event.preventDefault(); event.returnValue = ''; } },
    formKeydown(event) {
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    },
    async createSkill() {
      if (this.disposed || !this.store?.pluginCenterOpen || this.skillMutationLoading || !this.configReady || !this.agentSupportsManagedSkills) return;
      const fence = this.operationFence();
      const agentId = this.agentId, workDir = this.catalogWorkDir, scope = this.skillScope;
      if (scope === 'project' && !this.projectSkillAvailable) return;
      this.skillMutationLoading = true; this.skillMutationError = '';
      try {
        const result = await this.store.mutateManagedSkill({ action: 'create', scope, skill: { ...this.skillForm }, sessionId: scope === 'project' ? this.activeSession.sessionId : '' }, agentId);
        if (!this.operationCurrent(fence)) return;
        if (result?.error || result?.stale) { this.skillMutationError = result.error || ''; return; }
        if (result?.result?.name && Array.isArray(this.selection.skills)) {
          this.store.setPluginEnabled('skills', result.result.name, true, [], agentId);
        }
        this.skillForm = { name: '', description: '', trigger: '', content: '' }; this.showSkillForm = false;
        await this.store.loadPluginCatalog(agentId, workDir);
      } catch (error) { this.skillMutationError = error?.message || String(error); }
      finally { this.skillMutationLoading = false; }
    },
    async removeSkill(item) {
      if (this.disposed || !this.store?.pluginCenterOpen || !item.managed || this.skillMutationLoading || !this.online || !this.agentSupportsManagedSkills) return;
      const fence = this.operationFence();
      const agentId = this.agentId, workDir = this.catalogWorkDir, sessionId = this.activeSession.sessionId;
      const scope = item.tier === 'project' ? 'project' : 'user';
      if (scope === 'project' && !this.projectSkillAvailable) return;
      if (!await confirmDialog(this.$t('yeaft.plugins.confirmRemoveSkill', { name: item.label }), { destructive: true })) return;
      if (!this.operationCurrent(fence) || !this.online) return;
      this.skillMutationLoading = true; this.skillMutationError = '';
      try {
        const result = await this.store.mutateManagedSkill({ action: 'remove', scope, name: item.name || item.label, sessionId: scope === 'project' ? sessionId : '' }, agentId);
        if (!this.operationCurrent(fence)) return;
        if (result?.error || result?.stale) this.skillMutationError = result.error || '';
        else {
          await this.store.loadPluginCatalog(agentId, workDir);
          if (this.operationCurrent(fence)) await this.loadSkillDetail();
        }
      } catch (error) { this.skillMutationError = error?.message || String(error); }
      finally { this.skillMutationLoading = false; }
    },
  },
  template: `
    <section class="plugin-center-page" :aria-label="$t('yeaft.plugins.title')">
      <div class="plugin-center-workspace" :inert="showSkillForm || null">
        <header class="plugin-center-header" :aria-label="$t('yeaft.plugins.toolbar')">
          <button type="button" class="btn-ghost plugin-center-icon-button plugin-center-sidebar-toggle" :aria-label="$t('chat.sidebar.expand')" @click="$emit('toggle-sidebar')"><NavigationIcon name="menu" :size="18" /></button>
          <template v-if="!searchOpen">
            <div class="plugin-center-menu-host plugin-center-agent-host">
              <button ref="agentsTrigger" type="button" class="btn-ghost plugin-center-agent-trigger" aria-haspopup="true" :aria-expanded="menu === 'agents'" :aria-label="$t('yeaft.plugins.selectAgent')" @click="toggleMenu('agents')">
                <span class="plugin-center-agent-caption">Agent</span><span class="plugin-center-agent-name">{{ selectedAgent?.name || agentId || $t('yeaft.plugins.noAgent') }}</span><NavigationIcon name="chevron" :size="12" />
              </button>
              <div v-if="menu === 'agents'" ref="agentsMenu" class="plugin-center-menu plugin-center-agent-menu" :aria-label="$t('yeaft.plugins.selectAgent')" @keydown="menuKeydown">
                <button v-for="agent in agents" :key="agent.id" type="button" :aria-pressed="agentId === agent.id" :disabled="skillMutationLoading" @click="selectAgent(agent.id)"><span class="plugin-center-agent-option-name" :title="agent.name || agent.id">{{ agent.name || agent.id }}</span><small v-if="!agent.online">{{ $t('yeaft.plugins.offlineLabel') }}</small></button>
              </div>
            </div>
            <nav class="plugin-center-tabs" :aria-label="$t('yeaft.plugins.categoryLabel')"><button v-for="category in categories" :key="category.id" type="button" class="btn-ghost" :class="{ 'is-active': activeCategory === category.id }" :aria-pressed="activeCategory === category.id" @click="activeCategory = category.id">{{ category.label }}</button></nav>
            <select class="plugin-center-category-select" v-model="activeCategory" :aria-label="$t('yeaft.plugins.categoryLabel')"><option v-for="category in categories" :key="category.id" :value="category.id">{{ category.label }}</option></select>
            <label class="plugin-center-search"><NavigationIcon name="search" :size="15" /><input v-model="searchQuery" type="search" :placeholder="$t('yeaft.plugins.searchShort')" :aria-label="$t('yeaft.plugins.searchPlaceholder')"></label>
            <button ref="searchTrigger" type="button" class="btn-ghost plugin-center-icon-button plugin-center-compact-search" :aria-label="$t('yeaft.plugins.searchPlaceholder')" @click="openSearch"><NavigationIcon name="search" :size="18" /></button>
            <button type="button" class="btn-secondary plugin-center-create" :disabled="!configReady || !agentSupportsManagedSkills || skillMutationLoading" @click="openSkillForm"><NavigationIcon name="add" :size="14" /><span>{{ $t('yeaft.plugins.createSkill') }}</span></button>
            <div class="plugin-center-menu-host">
              <button ref="moreTrigger" type="button" class="btn-ghost plugin-center-icon-button" aria-haspopup="true" :aria-expanded="menu === 'more'" :aria-label="$t('yeaft.plugins.more')" @click="toggleMenu('more')"><NavigationIcon name="more" :size="18" /></button>
              <div v-if="menu === 'more'" ref="moreMenu" class="plugin-center-menu plugin-center-more-menu" :aria-label="$t('yeaft.plugins.more')" @keydown="menuKeydown">
                <button type="button" class="plugin-center-mobile-create" :disabled="!configReady || !agentSupportsManagedSkills || skillMutationLoading" @click="openSkillForm">{{ $t('yeaft.plugins.createSkill') }}</button>
                <button type="button" :aria-pressed="enabledOnly" @click="enabledOnly = !enabledOnly; menu = null">{{ $t('yeaft.plugins.enabledOnly') }}<span v-if="enabledOnly" class="plugin-center-menu-check" aria-hidden="true">✓</span></button>
                <button type="button" :disabled="!online || loading" @click="load(true); menu = null">{{ $t('common.refresh') }}</button>
                <button type="button" @click="$emit('close')">{{ $t('yeaft.plugins.backToChat') }}</button>
              </div>
            </div>
          </template>
          <template v-else><label class="plugin-center-expanded-search"><NavigationIcon name="search" :size="18" /><input ref="mobileSearch" v-model="searchQuery" type="search" :placeholder="$t('yeaft.plugins.searchShort')" :aria-label="$t('yeaft.plugins.searchPlaceholder')"></label><button type="button" class="btn-ghost plugin-center-icon-button" :aria-label="$t('yeaft.plugins.closeSearch')" @click="closeSearch"><NavigationIcon name="close" :size="18" /></button></template>
        </header>
        <div v-if="!online" class="plugin-center-notice" role="status">{{ $t('yeaft.plugins.offline') }}</div>
        <div v-for="[id, record] in saveErrors" :key="id" class="plugin-center-notice is-error" role="alert"><span>{{ $t('yeaft.plugins.saveFailed', { agent: agentName(id), error: record.error }) }}</span><button type="button" class="btn-ghost" :disabled="!agents.find(a => a.id === id)?.online || record.saving" @click="store.retryPluginConfig(id)">{{ $t('yeaft.plugins.retry') }}</button></div>
        <div ref="content" class="plugin-center-content" :aria-busy="loading ? 'true' : 'false'">
          <div v-if="!selectedAgent" class="plugin-center-state">{{ $t('yeaft.plugins.noAgent') }}</div>
          <div v-else-if="!agentSupportsPlugins" class="plugin-center-state is-error">{{ $t('yeaft.plugins.upgradeRequired') }}</div>
          <div v-else-if="loading && !catalogRecord.loaded" class="plugin-center-state" role="status">{{ $t('yeaft.plugins.loading') }}</div>
          <div v-else-if="loadError" class="plugin-center-state is-error" role="alert"><p>{{ $t('yeaft.plugins.loadError', { error: loadError }) }}</p><button type="button" class="btn-secondary" :disabled="!online" @click="load(true)">{{ $t('yeaft.plugins.retry') }}</button></div>
          <section v-else-if="detail" class="plugin-center-detail">
            <button type="button" class="btn-ghost plugin-center-back" @click="backToList"><NavigationIcon name="back" :size="15" />{{ $t('yeaft.plugins.allPlugins') }}</button>
            <div class="plugin-center-detail-title"><span class="plugin-center-entry-icon"><NavigationIcon :name="itemIcon(detail)" :size="23" /></span><div><h1 ref="detailTitle" tabindex="-1">{{ detail.label }}</h1><p>{{ $t('yeaft.plugins.' + detail.field) }} · {{ itemSource(detail) }}</p></div><span class="plugin-center-save-indicator" :class="{ 'is-visible': itemSaving(detail) }" role="status" :aria-label="itemSaving(detail) ? $t('common.saving') : ''"></span><button type="button" class="plugin-center-switch" role="switch" :aria-checked="enabled(detail)" :aria-label="$t('yeaft.plugins.toggleLabel', { name: detail.label })" :disabled="!configReady" @click="toggle(detail)"><span></span></button></div>
            <p v-if="detailDescription" class="plugin-center-detail-description">{{ detailDescription }}</p>
            <template v-if="detail.field === 'skills'">
              <section class="plugin-center-skill-usage" :aria-label="$t('yeaft.plugins.skillUsage')">
                <h2>{{ $t('yeaft.plugins.skillUsage') }}</h2>
                <p>{{ $t('yeaft.plugins.skillUsageHelp') }}</p>
                <pre class="plugin-center-skill-command"><code>{{ skillCommand }}</code></pre>
                <p v-if="skillDetail?.trigger"><strong>{{ $t('yeaft.plugins.skillTriggerLabel') }}</strong> {{ skillDetail.trigger }}</p>
                <p v-if="skillDetail?.keywords?.length"><strong>{{ $t('yeaft.plugins.skillKeywords') }}</strong> {{ skillDetail.keywords.join(', ') }}</p>
              </section>
              <section class="plugin-center-skill-prompt" :aria-label="$t('yeaft.plugins.skillPrompt')" :aria-busy="skillDetailLoading ? 'true' : 'false'">
                <h2>{{ $t('yeaft.plugins.skillPrompt') }}</h2>
                <p v-if="skillDetailLoading" class="plugin-center-detail-note" role="status">{{ $t('yeaft.plugins.skillDetailLoading') }}</p>
                <div v-else-if="skillDetailError" class="plugin-center-error" role="alert"><p>{{ $t('yeaft.plugins.skillDetailError', { error: skillDetailError }) }}</p><button type="button" class="btn-secondary" :disabled="!online" @click="loadSkillDetail">{{ $t('yeaft.plugins.retry') }}</button></div>
                <p v-else-if="skillDetailUnsupported" class="plugin-center-detail-note" role="status">{{ $t('yeaft.plugins.skillDetailUnsupported') }}</p>
                <template v-else-if="skillDetail">
                  <p class="plugin-center-detail-note plugin-center-skill-effective">{{ $t('yeaft.plugins.skillEffectiveSource', { source: $t('yeaft.plugins.skillTier.' + skillDetail.tier) }) }}</p>
                  <p v-if="skillDetail.contentTruncated" class="plugin-center-notice" role="status">{{ $t('yeaft.plugins.skillPromptTruncated') }}</p>
                  <pre v-if="skillDetail.content" class="plugin-center-skill-content" tabindex="0">{{ skillDetail.content }}</pre>
                  <p v-else class="plugin-center-detail-note">{{ $t('yeaft.plugins.skillPromptEmpty') }}</p>
                  <div v-if="skillDetail.references?.length || skillDetail.templates?.length" class="plugin-center-skill-files"><h3>{{ $t('yeaft.plugins.skillFiles') }}</h3><ul><li v-for="file in skillDetail.references" :key="'references/' + file">references/{{ file }}</li><li v-for="file in skillDetail.templates" :key="'templates/' + file">templates/{{ file }}</li></ul></div>
                </template>
                <p v-else-if="!online" class="plugin-center-detail-note">{{ $t('yeaft.plugins.skillDetailOffline') }}</p>
              </section>
            </template>
            <dl class="plugin-center-properties"><dt>{{ $t('yeaft.plugins.identifier') }}</dt><dd>{{ detail.id }}</dd><dt>{{ $t('yeaft.plugins.agentLabel') }}</dt><dd>{{ selectedAgent.name || agentId }}</dd><dt>{{ $t('yeaft.plugins.source') }}</dt><dd>{{ itemSource(detail) }}</dd><template v-if="detail.field === 'mcpServers'"><dt>{{ $t('yeaft.plugins.connection') }}</dt><dd>{{ itemSource(detail) }}</dd></template></dl>
            <template v-if="detailSources.length"><h2>{{ $t('yeaft.plugins.skillSources') }}</h2><div v-for="source in detailSources" :key="source.id" class="plugin-center-source-row"><div><strong>{{ source.label }}</strong><small>{{ $t('yeaft.plugins.skillTier.' + source.tier) }}</small></div><button v-if="source.managed" type="button" class="btn-ghost plugin-center-remove" :disabled="!online || !agentSupportsManagedSkills || skillMutationLoading || (source.tier === 'project' && !projectSkillAvailable)" @click="removeSkill(source)">{{ $t('yeaft.plugins.removeSkill') }}</button></div></template>
            <p class="plugin-center-detail-note">{{ $t('yeaft.plugins.applyBoundary') }}</p>
            <p v-if="skillMutationError" class="plugin-center-error" role="alert">{{ skillMutationError }}</p>
          </section>
          <div v-else class="plugin-center-catalog">
            <button v-if="enabledOnly" type="button" class="btn-ghost plugin-center-filter" @click="enabledOnly = false">{{ $t('yeaft.plugins.enabledOnly') }}<NavigationIcon name="close" :size="12" /></button>
            <article v-for="item in visibleEntries" :key="item.key" class="plugin-center-row" :data-entry="item.key">
              <button type="button" class="plugin-center-row-main" :data-entry="item.key" :aria-label="$t('yeaft.plugins.viewDetails', { name: item.label })" @click="openDetail(item)"><span class="plugin-center-entry-icon"><NavigationIcon :name="itemIcon(item)" :size="21" /></span><span class="plugin-center-row-copy"><strong>{{ item.label }}</strong><small>{{ itemDescription(item) }}</small></span></button>
              <span class="plugin-center-row-meta"><span>{{ $t('yeaft.plugins.' + item.field) }}</span><span class="plugin-center-origin" :class="{ 'is-connected': item.field === 'mcpServers' && item.ready === true }">{{ itemSource(item) }}</span></span>
              <span class="plugin-center-save-indicator" :class="{ 'is-visible': itemSaving(item) }" role="status" :aria-label="itemSaving(item) ? $t('common.saving') : ''"></span>
              <button type="button" class="plugin-center-switch" role="switch" :aria-checked="enabled(item)" :aria-label="$t('yeaft.plugins.toggleLabel', { name: item.label })" :disabled="!configReady" @click="toggle(item)"><span></span></button>
            </article>
            <div v-if="!visibleEntries.length" class="plugin-center-state"><NavigationIcon name="search" :size="24" /><p>{{ searchQuery || enabledOnly ? $t('yeaft.plugins.noMatchesTitle') : $t('yeaft.plugins.empty') }}</p><button v-if="searchQuery || enabledOnly" type="button" class="btn-secondary" @click="resetFilters">{{ $t('yeaft.plugins.clearFilters') }}</button></div>
          </div>
        </div>
      </div>
      <Teleport to="body"><div v-if="showSkillForm" class="modal-overlay plugin-center-form-overlay" @click.self="closeSkillForm">
        <form class="modal plugin-center-skill-form" role="dialog" aria-modal="true" aria-labelledby="plugin-skill-form-title" @submit.prevent="createSkill" @keydown="formKeydown">
          <header><h2 id="plugin-skill-form-title">{{ $t('yeaft.plugins.createSkill') }}</h2><button type="button" class="btn-ghost plugin-center-icon-button" :disabled="skillMutationLoading" :aria-label="$t('common.close')" @click="closeSkillForm"><NavigationIcon name="close" :size="18" /></button></header>
          <div class="plugin-center-form-body">
            <label><span>{{ $t('yeaft.plugins.skillScope') }}</span><select v-model="skillScope" :disabled="skillMutationLoading"><option value="user">{{ $t('yeaft.plugins.userScope') }}</option><option value="project" :disabled="!projectSkillAvailable">{{ $t('yeaft.plugins.projectScope') }}</option></select></label>
            <p class="plugin-center-detail-note">{{ $t(skillScope === 'project' ? 'yeaft.plugins.projectScopeDescription' : 'yeaft.plugins.userScopeDescription') }}</p>
            <label><span>{{ $t('yeaft.plugins.skillName') }}</span><input ref="skillName" v-model="skillForm.name" required autocomplete="off" :disabled="skillMutationLoading"></label>
            <label><span>{{ $t('yeaft.plugins.skillDescriptionLabel') }}</span><input v-model="skillForm.description" required :disabled="skillMutationLoading"></label>
            <label><span>{{ $t('yeaft.plugins.skillTrigger') }}</span><input v-model="skillForm.trigger" :disabled="skillMutationLoading"></label>
            <label><span>{{ $t('yeaft.plugins.skillInstructions') }}</span><textarea v-model="skillForm.content" rows="8" required :disabled="skillMutationLoading"></textarea></label>
            <p v-if="skillMutationError" class="plugin-center-error" role="alert">{{ skillMutationError }}</p>
          </div>
          <footer><button type="button" class="btn-secondary" :disabled="skillMutationLoading" @click="closeSkillForm">{{ $t('common.cancel') }}</button><button type="submit" class="btn-primary" :disabled="skillMutationLoading || !configReady || !skillForm.name.trim() || !skillForm.description.trim() || !skillForm.content.trim()">{{ skillMutationLoading ? $t('common.saving') : $t('yeaft.plugins.createSkill') }}</button></footer>
        </form>
      </div></Teleport>
    </section>
  `,
};
