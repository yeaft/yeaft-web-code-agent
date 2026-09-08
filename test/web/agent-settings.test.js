// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as Vue from 'vue';
import AgentSettingsPanel from '../../web/components/AgentSettingsPanel.js';
import SidebarAgentHeader from '../../web/components/SidebarAgentHeader.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const panel = readFileSync(join(root, 'web/components/AgentSettingsPanel.js'), 'utf8');
const llmTab = readFileSync(join(root, 'web/components/LlmTab.js'), 'utf8');
const header = readFileSync(join(root, 'web/components/SidebarAgentHeader.js'), 'utf8');
const chatPage = readFileSync(join(root, 'web/components/ChatPage.js'), 'utf8');
const yeaftPage = readFileSync(join(root, 'web/components/YeaftPage.js'), 'utf8');
const workCenterPage = readFileSync(join(root, 'web/components/WorkCenterPage.js'), 'utf8');
const chatStore = readFileSync(join(root, 'web/stores/chat.js'), 'utf8');
const messageHandler = readFileSync(join(root, 'web/stores/helpers/messageHandler.js'), 'utf8');
const css = readFileSync(join(root, 'web/styles/agent-settings.css'), 'utf8');
const sidebarCss = readFileSync(join(root, 'web/styles/sidebar.css'), 'utf8');
const en = readFileSync(join(root, 'web/i18n/en.js'), 'utf8');
const zh = readFileSync(join(root, 'web/i18n/zh-CN.js'), 'utf8');

describe('Agent settings surface', () => {
  it('keeps the original Agent brand trigger and moves settings to the list footer', () => {
    expect(header).toContain("emits: ['open-agent-settings', 'restart-agent', 'upgrade-agent', 'upgrade-all-agents']");
    expect(header).toContain('class="sidebar-brand agent-dropdown-trigger"');
    expect(header).not.toContain('agent-settings-icon-btn');
    expect(header).toContain('class="agent-dropdown-list"');
    expect(header).toContain('class="agent-dropdown-settings-option"');
    expect(header).toContain("open = false; $emit('open-agent-settings')");
    expect(header).toContain('v-for="agent in onlineAgents"');
    expect(header).toContain('class="agent-dropdown-name"');
    expect(header).toContain('class="agent-dropdown-meta"');
    expect(header).toContain('class="agent-dropdown-actions"');
    expect(header).not.toContain('class="agent-dropdown-identity"');
    expect(header).not.toContain('class="agent-dropdown-trailing"');
    expect(header).toContain(':title="agent.name"');
    expect(header).toContain("$emit('upgrade-agent', agent.id)");
    expect(header).not.toContain('agent-dropdown-settings-hint');
    expect(sidebarCss).toMatch(/\.session-sidebar-shell\s*\{[^}]*overflow:\s*hidden;/s);
    expect(sidebarCss).toMatch(/\.agent-dropdown\s*\{[^}]*left:\s*0;[^}]*width:\s*min\(360px,\s*calc\(var\(--session-sidebar-width\)\s*-\s*12px\),\s*calc\(100vw\s*-\s*12px\)\);[^}]*box-sizing:\s*border-box;/s);
    expect(sidebarCss).not.toMatch(/\.agent-dropdown\s*\{[^}]*left:\s*-\d/s);
    expect(sidebarCss).toMatch(/\.sidebar-brand\s*\{[^}]*font-size:\s*14px;[^}]*font-weight:\s*600;/s);
    expect(sidebarCss).not.toMatch(/\.agent-dropdown-trigger\s*\{[^}]*\bfont\s*:/s);
    expect(sidebarCss).toMatch(/\.agent-dropdown-trigger\s*\{[^}]*font-family:\s*inherit;/s);
    expect(sidebarCss).toMatch(/\.agent-dropdown-item\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*8px minmax\(0, 1fr\) 50px 56px;[^}]*column-gap:\s*8px;/s);
    expect(sidebarCss).toMatch(/\.agent-dropdown-name\s*\{[^}]*min-width:\s*0;[^}]*font-size:\s*14px;[^}]*font-weight:\s*400;/s);
    expect(sidebarCss).toMatch(/\.agent-dropdown-meta\s*\{[^}]*display:\s*block;[^}]*min-width:\s*0;[^}]*text-align:\s*left;/s);
    expect(sidebarCss).toMatch(/\.agent-dropdown-footer\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/s);
    expect(sidebarCss).toMatch(/\.agent-dropdown-settings-option\s*\{[^}]*padding:\s*7px 10px 7px 26px;/s);
    expect(sidebarCss).toMatch(/\.agent-dropdown-actions\s*\{[^}]*justify-self:\s*end;[^}]*gap:\s*0;/s);
    expect(sidebarCss).toMatch(/\.agent-dropdown-action-btn\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*flex-shrink:\s*0;/s);
    expect(sidebarCss).toMatch(/\.agent-dropdown-version\s*\{[^}]*font-size:\s*9px;[^}]*font-family:\s*'SF Mono'/s);
    expect(sidebarCss).toMatch(/\.agent-dropdown-status\s*\{[^}]*font-size:\s*10px;/s);
    expect(sidebarCss).not.toContain('.agent-dropdown-settings-hint');
  });

  it('keeps the upgrade and restart actions clickable from the Agent list', async () => {
    const wrapper = mount(SidebarAgentHeader, {
      props: {
        onlineAgents: [{ id: 'agent-a', name: 'Agent A', online: true, version: '1.0.437' }],
        onlineAgentCount: 1,
        showAgentActions: true,
      },
      global: { mocks: { $t: key => key } },
    });

    await wrapper.get('.agent-dropdown-trigger').trigger('click');
    const upgrade = wrapper.get('.agent-dropdown-upgrade-btn');
    const restart = wrapper.get('.agent-dropdown-restart-btn');
    expect(upgrade.get('svg').attributes()).toMatchObject({ width: '14', height: '14' });
    expect(restart.get('svg').attributes()).toMatchObject({ width: '14', height: '14' });
    expect(upgrade.attributes('disabled')).toBeUndefined();
    expect(restart.attributes('disabled')).toBeUndefined();
    await upgrade.trigger('click');
    await restart.trigger('click');
    expect(wrapper.emitted('upgrade-agent')).toEqual([['agent-a']]);
    expect(wrapper.emitted('restart-agent')).toEqual([['agent-a']]);
    wrapper.unmount();
  });

  it('places a guarded bulk-upgrade action after Agent settings', async () => {
    const wrapper = mount(SidebarAgentHeader, {
      props: {
        onlineAgents: [{ id: 'agent-a', name: 'Agent A', online: true }],
        onlineAgentCount: 1,
        canUpgradeAll: false,
      },
      global: { mocks: { $t: key => key } },
    });

    await wrapper.get('.agent-dropdown-trigger').trigger('click');
    const footer = wrapper.get('.agent-dropdown-footer');
    expect(footer.findAll('button').map(button => button.classes())).toEqual([
      ['agent-dropdown-settings-option'],
      ['agent-dropdown-settings-option', 'agent-dropdown-upgrade-all-option'],
    ]);
    const upgradeAll = footer.get('.agent-dropdown-upgrade-all-option');
    expect(upgradeAll.attributes('disabled')).toBeDefined();
    expect(upgradeAll.text()).toBe('Upgrade all');
    await upgradeAll.trigger('click');
    expect(wrapper.emitted('upgrade-all-agents')).toBeUndefined();

    await wrapper.setProps({ canUpgradeAll: true });
    expect(upgradeAll.attributes('disabled')).toBeUndefined();
    await upgradeAll.trigger('click');
    expect(wrapper.emitted('upgrade-all-agents')).toHaveLength(1);

    await wrapper.setProps({ upgradingAll: true });
    expect(upgradeAll.attributes('disabled')).toBeDefined();
    expect(upgradeAll.text()).toBe('Upgrading all…');
    expect(upgradeAll.find('.agent-dropdown-upgrade-all-spinner').exists()).toBe(true);
    wrapper.unmount();
  });

  it('opens Agent settings from the bottom of the Agent list', async () => {
    const wrapper = mount(SidebarAgentHeader, {
      props: {
        onlineAgents: [{ id: 'agent-a', name: 'Agent A', online: true }],
        onlineAgentCount: 1,
      },
      global: { mocks: { $t: key => key } },
    });

    await wrapper.get('.agent-dropdown-trigger').trigger('click');
    expect(wrapper.find('.agent-dropdown').exists()).toBe(true);
    expect(wrapper.emitted('open-agent-settings')).toBeUndefined();
    expect(wrapper.get('.agent-dropdown-settings-option').text()).toBe('Agent settings');
    expect(wrapper.find('.agent-dropdown-settings-hint').exists()).toBe(false);

    await wrapper.get('.agent-dropdown-settings-option').trigger('click');
    expect(wrapper.emitted('open-agent-settings')).toHaveLength(1);
    expect(wrapper.find('.agent-dropdown').exists()).toBe(false);
    wrapper.unmount();
  });

  it('wires Agent list state and settings navigation from both Session sidebars without a duplicate plugin icon', () => {
    const yeaftSidebar = readFileSync(join(root, 'web/components/YeaftSidebar.js'), 'utf8');
    expect(chatPage).toContain('<AgentSettingsPanel v-if="showAgentSettings"');
    expect(chatPage).toContain(':online-agents="onlineAgents"');
    expect(chatPage).toContain('@open-agent-settings="openAgentSettings(store.currentAgent || null)"');
    expect(chatPage).toContain('@restart-agent="restartAgent"');
    expect(chatPage).toContain('@upgrade-agent="upgradeAgent"');
    expect(chatPage).toContain('@upgrade-all-agents="upgradeAllAgents"');
    expect(chatPage).toContain("window.addEventListener('agent-upgrade-batch-complete'");
    expect(yeaftPage).toContain('<AgentSettingsPanel v-if="showAgentSettings"');
    expect(yeaftSidebar).toContain(':online-agents="onlineAgents"');
    expect(yeaftSidebar).toContain('@open-agent-settings="$emit(\'open-agent-settings\')"');
    expect(yeaftSidebar).toContain('@restart-agent="restartAgent"');
    expect(yeaftSidebar).toContain('@upgrade-agent="upgradeAgent"');
    expect(yeaftSidebar).toContain('@upgrade-all-agents="upgradeAllAgents"');
    expect(yeaftSidebar).toContain("window.addEventListener('agent-upgrade-batch-complete'");
    expect(yeaftSidebar).not.toContain('pluginCenterOpen }"');
    expect(yeaftSidebar).toContain('class="sidebar-nav-item" :disabled="onlineAgents.length === 0" @click="onOpenPlugins"');
  });

  it('keeps per-Agent telemetry requests correlated by request and agent', () => {
    expect(chatStore).toContain("this._telemetryPending[requestId] = { resolve, reject, timer, agentId, operation, requestId }");
    expect(messageHandler).toContain("pending: store._telemetryPending?.[msg.requestId]");
    expect(messageHandler).toContain('A response without request identity has no provenance');
    expect(messageHandler).not.toContain('isUniqueLegacyAgentRequest');
    expect(panel).toContain('this.store.loadTelemetrySettings(agentId)');
    expect(panel).toContain('this.store.updateTelemetrySettings(this.telemetryDraft, agentId)');
  });

  it('treats the pushed Agent version as a hint and keeps manual registry checks available', () => {
    expect(panel).toContain('selectedAgent.upgradeAvailable');
    expect(panel).toContain("$t('agentSettings.runtime.updateUnknown')");
    expect(panel).not.toContain("$t('agentSettings.runtime.upToDate')");
    expect(panel).toContain(':disabled="busy || !selectedAgent.online"');
    expect(en).toContain("'agentSettings.runtime.updateAvailable': 'Update available: v{version}'");
    expect(zh).toContain("'agentSettings.runtime.updateAvailable': '可更新至 v{version}'");
  });

  it('uses the shared rich selector and Settings navigation pattern without a large header', () => {
    expect(panel).toContain("import ModernSelect from './ModernSelect.js'");
    expect(panel).toContain('<ModernSelect');
    expect(panel).toContain(':options="agentOptions"');
    expect(panel).toContain(':menu-min-width="200"');
    expect(panel).not.toContain('sublabel: agent.name');
    expect(panel).not.toContain('<select v-model="selectedAgentId"');
    expect(panel).toContain('class="agent-settings-nav-item"');
    expect(panel).toContain("activeCategory === 'operations'");
    expect(panel).toContain("activeCategory === 'trace'");
    expect(panel).toContain("activeCategory === 'llm'");
    expect(panel).not.toContain('agent-settings-header');
    expect(panel).not.toContain('agent-settings-list');
    expect(en).toContain("'agentSettings.categories.operations': 'Operations'");
    expect(zh).toContain("'agentSettings.categories.llm': 'LLM 配置'");
  });

  it('reuses LlmTab with an explicit selected-Agent target', () => {
    expect(panel).toContain("import LlmTab from './LlmTab.js'");
    expect(panel).toContain('<LlmTab context="yeaft" :agent-id="selectedAgentId"');
    expect(panel).toContain("initialCategory: { type: String, default: 'operations' }");
    expect(llmTab).toContain("agentId: { type: String, default: null }");
    expect(llmTab).toContain('return this.agentId || this.chatStore.currentAgent');
  });

  it('routes existing model configuration entry points into Agent Settings', () => {
    expect(yeaftPage).toContain("openAgentSettings(store.currentAgent || null, 'llm')");
    expect(yeaftPage).not.toContain('yeaft-llm-config-modal');
    expect(workCenterPage).toContain('<AgentSettingsPanel v-if="llmConfigOpen" :initial-agent-id="agentId" initial-category="llm"');
    expect(workCenterPage).not.toContain('<LlmTab context="yeaft"');
  });

  it('propagates a successful LLM save with the exact selected Agent', async () => {
    const store = Vue.reactive({
      agents: [{ id: 'agent-a', name: 'Agent A', online: true }],
      currentAgent: 'agent-a',
      agentOperations: {},
      agentDreamState: {},
      loadTelemetrySettings: vi.fn(() => Promise.resolve({})),
    });
    globalThis.Pinia = { useChatStore: () => store };
    globalThis.Vue = Vue;
    const wrapper = mount(AgentSettingsPanel, {
      props: { initialAgentId: 'agent-a', initialCategory: 'llm' },
      global: {
        mocks: { $t: key => key },
        stubs: { LlmTab: { template: '<button class="save-llm" @click="$emit(\'saved\')">save</button>' } },
      },
    });
    await Vue.nextTick();
    await wrapper.get('.save-llm').trigger('click');
    expect(wrapper.emitted('saved')).toEqual([['agent-a']]);
    wrapper.unmount();
  });

  it('uses content-first rows, scoped buttons, and a mobile layout inside the fixed shell', () => {
    expect(panel).toContain('class="agent-settings-detail-list"');
    expect(panel).toContain("$t('agentSettings.maintenance.description')");
    expect(css).toContain('height: min(760px, 90vh)');
    expect(css).toContain('.agent-settings-content {');
    expect(css).toContain('.agent-settings-agent-picker .modern-select {');
    expect(css).toContain('width: 200px;');
    expect(css).toContain('overflow-y: auto;');
    expect(css).toContain('.agent-settings-dialog .btn-primary');
    expect(css).toContain('var(--accent-fg)');
    expect(css).not.toContain('box-shadow: inset 2px 0 var(--accent)');
    expect(css).toContain('@media (max-height: 680px) and (min-width: 681px)');
    expect(css).toContain('@media (max-width: 680px)');
    expect(css).toContain('.agent-settings-nav nav { flex-direction: row; overflow-x: auto; }');
  });
});
