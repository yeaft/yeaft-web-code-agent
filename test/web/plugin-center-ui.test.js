// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import PluginCenterPage from '../../web/components/PluginCenterPage.js';
import PluginSaveNotices from '../../web/components/PluginSaveNotices.js';
import { clearPluginState } from '../../web/stores/helpers/plugin-config.js';
import { confirmDialog } from '../../web/utils/dialog.js';
import en from '../../web/i18n/en.js';
import zh from '../../web/i18n/zh-CN.js';

vi.mock('../../web/utils/dialog.js', () => ({ confirmDialog: vi.fn(async () => true), useDialogState: () => ({ open: false }) }));
let wrapper, chat;
const catalog = {
  skills: [{ id: 'review', label: 'review', description: '<script>Review code</script>', tier: 'user' }],
  tools: [{ id: 'FileRead', label: 'FileRead' }],
  mcpServers: [{ id: 'github', label: 'GitHub', toolCount: 2, ready: false }],
  skillSources: [{ id: 'user:review', name: 'review', label: 'review', managed: true, tier: 'user' }],
};
beforeEach(() => {
  chat = Vue.reactive({
    currentAgent: 'a', pluginCenterAgentId: 'a', pluginCenterOpen: true, connectionState: 'connected',
    agents: [{ id: 'a', name: 'Alpha', online: true, capabilityMetadataProvided: true, capabilities: ['yeaft_plugins', 'yeaft_managed_skills'] }, { id: 'b', name: 'Beta', online: true }, { id: 'c', online: false }],
    pluginConfigByAgent: { a: { plugins: {}, draft: {}, loaded: true }, b: { plugins: { skills: [] }, draft: { skills: [] }, loaded: true } },
    pluginCatalogByKey: { a: { catalog, loaded: true }, b: { catalog, loaded: true }, c: { catalog, loaded: true } },
    pluginCatalogKey: id => id, activePluginSession: () => ({ agentId: 'a', sessionId: 'session', workDir: '/repo' }),
    loadPluginConfig: vi.fn(async () => ({})), loadPluginCatalog: vi.fn(async () => ({})),
    loadPluginSkillDetail: vi.fn(async name => ({ skillDetail: { name, description: 'Review code', content: '# Workflow\n\n<script>alert(1)</script>', trigger: 'review', keywords: ['code'], tier: 'user', references: ['checklist.md'], templates: [] } })),
    setPluginEnabled: vi.fn(), retryPluginConfig: vi.fn(), mutateManagedSkill: vi.fn(async () => ({ result: { name: 'new-skill' } })),
  });
  vi.stubGlobal('Vue', Vue);
  vi.stubGlobal('Pinia', { useChatStore: () => chat });
});
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
async function render(messages = en, component = PluginCenterPage) {
  wrapper = mount(component, { attachTo: document.body, global: { config: { globalProperties: { $t: (key, params = {}) => (messages[key] || key).replace(/\{(\w+)\}/g, (all, name) => String(params[name] ?? all)) } } } });
  await flushPromises();
}

describe('Plugin Center workspace', () => {
  it.each([en, zh])('uses one toolbar, unified rows and independent accessible toggles/details', async messages => {
    await render(messages);
    expect(wrapper.findAll('.plugin-center-header')).toHaveLength(1);
    expect(wrapper.find('.plugin-center-agent-rail').exists()).toBe(false);
    expect(wrapper.find('.plugin-center-footer').exists()).toBe(false);
    expect(wrapper.findAll('.plugin-center-row').map(row => row.attributes('data-entry'))).toEqual(['skills:review', 'mcpServers:github', 'tools:FileRead']);
    expect(wrapper.find('script').exists()).toBe(false);
    expect(wrapper.text()).toContain('<script>Review code</script>');
    const toggle = wrapper.get('[data-entry="skills:review"] .plugin-center-switch');
    await toggle.trigger('click');
    expect(chat.setPluginEnabled).toHaveBeenCalledWith('skills', 'review', false, ['review'], 'a');
    expect(wrapper.find('.plugin-center-detail').exists()).toBe(false);
    await wrapper.get('[data-entry="skills:review"] .plugin-center-row-main').trigger('click');
    expect(wrapper.get('.plugin-center-detail').text()).toContain(messages['yeaft.plugins.skillSources']);
    expect(document.activeElement).toBe(wrapper.get('h1').element);
    await wrapper.get('.plugin-center-back').trigger('click');
    expect(document.activeElement).toBe(wrapper.get('[data-entry="skills:review"] .plugin-center-row-main').element);
    await wrapper.get('.plugin-center-search input').setValue('nothing');
    expect(wrapper.findAll('.plugin-center-row')).toHaveLength(0);
    await wrapper.get('.plugin-center-state button').trigger('click');
    expect(wrapper.findAll('.plugin-center-row')).toHaveLength(3);
    await wrapper.get('.plugin-center-agent-trigger').trigger('click');
    await wrapper.get('.plugin-center-agent-menu').trigger('keydown', { key: 'End' });
    expect(document.activeElement.textContent).toContain('c');
    await wrapper.get('.plugin-center-agent-menu').trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('.plugin-center-agent-menu').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('.plugin-center-agent-trigger').element);
  });

  it('keeps Agent names in identical rows without status dots or checkmarks', async () => {
    await render();
    await wrapper.get('.plugin-center-agent-trigger').trigger('click');
    const buttons = wrapper.findAll('.plugin-center-agent-menu button');
    expect(buttons.map(button => button.get('.plugin-center-agent-option-name').text())).toEqual(['Alpha', 'Beta', 'c']);
    expect(buttons.map(button => button.attributes('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(wrapper.find('.plugin-center-dot').exists()).toBe(false);
    expect(wrapper.get('.plugin-center-agent-menu').text()).not.toContain('✓');
    await buttons[1].trigger('click'); await flushPromises();
    expect(wrapper.vm.agentId).toBe('b');
    await wrapper.get('.plugin-center-agent-trigger').trigger('click');
    expect(wrapper.findAll('.plugin-center-agent-menu button').map(button => button.attributes('aria-pressed'))).toEqual(['false', 'true', 'false']);
  });

  it('loads the effective Prompt on demand, shows usage and fences navigation, offline, errors and unsupported Agents', async () => {
    await render(zh);
    expect(chat.loadPluginSkillDetail).not.toHaveBeenCalled();
    await wrapper.get('[data-entry="skills:review"] .plugin-center-row-main').trigger('click'); await flushPromises();
    expect(chat.loadPluginSkillDetail).toHaveBeenCalledWith('review', 'a', '/repo');
    expect(wrapper.get('.plugin-center-skill-content').text()).toBe('# Workflow\n\n<script>alert(1)</script>');
    expect(wrapper.find('script').exists()).toBe(false);
    expect(wrapper.get('.plugin-center-skill-command').text()).toBe('/skill:review 在这里描述你的任务');
    expect(wrapper.get('.plugin-center-skill-usage').text()).toContain('review');
    expect(wrapper.get('.plugin-center-skill-files').text()).toContain('references/checklist.md');
    expect(wrapper.get('.plugin-center-skill-effective').text()).toContain('用户级');
    await wrapper.get('.plugin-center-back').trigger('click');
    let complete;
    chat.loadPluginSkillDetail.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await wrapper.get('[data-entry="skills:review"] .plugin-center-row-main').trigger('click');
    expect(wrapper.get('.plugin-center-skill-prompt').attributes('aria-busy')).toBe('true');
    await wrapper.vm.selectAgent('b'); await flushPromises();
    complete({ skillDetail: { name: 'review', content: 'Alpha private Prompt' } }); await flushPromises();
    expect(wrapper.text()).not.toContain('Alpha private Prompt');
    chat.loadPluginSkillDetail.mockResolvedValueOnce({ error: 'read denied' });
    await wrapper.get('[data-entry="skills:review"] .plugin-center-row-main').trigger('click'); await flushPromises();
    expect(wrapper.get('.plugin-center-skill-prompt [role="alert"]').text()).toContain('read denied');
    chat.loadPluginSkillDetail.mockResolvedValueOnce({ unsupported: true });
    await wrapper.get('.plugin-center-skill-prompt button').trigger('click'); await flushPromises();
    expect(wrapper.get('.plugin-center-skill-prompt').text()).toContain(zh['yeaft.plugins.skillDetailUnsupported']);
    chat.agents[1].online = false; await Vue.nextTick();
    await wrapper.get('.plugin-center-back').trigger('click');
    const requests = chat.loadPluginSkillDetail.mock.calls.length;
    await wrapper.get('[data-entry="skills:review"] .plugin-center-row-main').trigger('click');
    expect(chat.loadPluginSkillDetail).toHaveBeenCalledTimes(requests);
    expect(wrapper.get('.plugin-center-skill-prompt').text()).toContain(zh['yeaft.plugins.skillDetailOffline']);
  });

  it('switches Agent state, preserves cached offline rows, distinguishes connection from enabled and retries attributed errors', async () => {
    await render();
    chat.pluginConfigByAgent.a.loading = true;
    await Vue.nextTick();
    const cachedToggle = wrapper.get('[data-entry="skills:review"] .plugin-center-switch');
    expect(cachedToggle.attributes('disabled')).toBeDefined();
    await cachedToggle.trigger('click');
    expect(chat.setPluginEnabled).not.toHaveBeenCalled();
    // Authoritative refresh can change a different field while rows stay cached.
    chat.pluginConfigByAgent.a = { ...chat.pluginConfigByAgent.a, loading: false, plugins: { tools: [] }, draft: { tools: [] } };
    await Vue.nextTick();
    expect(wrapper.get('[data-entry="tools:FileRead"] .plugin-center-switch').attributes('aria-checked')).toBe('false');
    expect(cachedToggle.attributes('disabled')).toBeUndefined();
    await wrapper.vm.selectAgent('b'); await flushPromises();
    expect(wrapper.get('[data-entry="skills:review"] .plugin-center-switch').attributes('aria-checked')).toBe('false');
    expect(wrapper.get('[data-entry="mcpServers:github"] .plugin-center-switch').attributes('aria-checked')).toBe('true');
    expect(wrapper.get('[data-entry="mcpServers:github"] .plugin-center-origin').text()).toBe(en['yeaft.plugins.notConnected']);
    chat.pluginConfigByAgent.a = { ...chat.pluginConfigByAgent.a, errorOperation: 'save', error: 'failed' };
    await Vue.nextTick();
    expect(wrapper.get('[role="alert"]').text()).toContain('Alpha');
    await wrapper.get('[role="alert"] button').trigger('click');
    expect(chat.retryPluginConfig).toHaveBeenCalledWith('a');
    await wrapper.vm.selectAgent('c'); await flushPromises();
    expect(wrapper.findAll('.plugin-center-row')).toHaveLength(3);
    for (const toggle of wrapper.findAll('.plugin-center-switch')) expect(toggle.attributes('disabled')).toBeDefined();
    expect(chat.loadPluginConfig).not.toHaveBeenCalledWith('c');
    await wrapper.vm.selectAgent('b'); await flushPromises();
    chat.pluginCatalogByKey.b = { loading: false, error: 'timeout' };
    await Vue.nextTick();
    expect(wrapper.get('.plugin-center-state').text()).toContain('timeout');
    expect(wrapper.get('.plugin-center-state button').attributes('disabled')).toBeUndefined();
    chat.pluginConfigByAgent.b.agent = { ...chat.agents.find(agent => agent.id === 'b') };
    chat.pluginCatalogByKey.b = { catalog, loaded: true };
    chat.agents = [];
    await Vue.nextTick();
    expect(wrapper.findAll('.plugin-center-row')).toHaveLength(3);
    expect(wrapper.get('.plugin-center-agent-name').text()).toBe('Beta');
    for (const toggle of wrapper.findAll('.plugin-center-switch')) expect(toggle.attributes('disabled')).toBeDefined();
  });

  it('creates in captured Agent/project scope, auto-enables explicit selections and guards unsaved forms', async () => {
    await render();
    chat.pluginConfigByAgent.a.draft = { skills: [] };
    wrapper.vm.openSkillForm(); await flushPromises();
    expect(document.activeElement).toBe(document.querySelector('.plugin-center-skill-form input'));
    expect(wrapper.element.closest('body').firstElementChild.inert).toBe(true);
    wrapper.vm.skillScope = 'project';
    wrapper.vm.skillForm = { name: 'new-skill', description: 'description', trigger: '', content: 'instructions' };
    chat.pluginConfigByAgent.a.loading = true;
    await Vue.nextTick();
    expect(document.querySelector('.plugin-center-skill-form button[type="submit"]').disabled).toBe(true);
    await wrapper.vm.createSkill();
    expect(chat.mutateManagedSkill).not.toHaveBeenCalled();
    chat.pluginConfigByAgent.a.loading = false;
    await Vue.nextTick();
    await wrapper.vm.createSkill(); await flushPromises();
    expect(chat.mutateManagedSkill).toHaveBeenCalledWith({ action: 'create', scope: 'project', sessionId: 'session', skill: { name: 'new-skill', description: 'description', trigger: '', content: 'instructions' } }, 'a');
    expect(chat.setPluginEnabled).toHaveBeenCalledWith('skills', 'new-skill', true, [], 'a');
    expect(document.querySelector('.plugin-center-skill-form')).toBeNull();
    wrapper.vm.openSkillForm(); await flushPromises();
    wrapper.vm.skillForm.name = 'unsaved';
    const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await wrapper.vm.selectAgent('b'); await flushPromises();
    expect(wrapper.vm.showSkillForm).toBe(false);
    expect(wrapper.vm.agentId).toBe('b');
    await wrapper.vm.selectAgent('a'); await flushPromises();
    let confirm;
    confirmDialog.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    const removing = wrapper.vm.removeSkill(catalog.skillSources[0]);
    clearPluginState(chat);
    confirm(true);
    await removing;
    expect(chat.mutateManagedSkill).toHaveBeenCalledTimes(1);
    // Reopen in the new auth epoch, then retire a successful create reply.
    chat.pluginCenterOpen = true; chat.pluginCenterAgentId = 'a';
    chat.pluginConfigByAgent = { a: { loaded: true, plugins: {}, draft: {} } };
    let complete;
    chat.mutateManagedSkill.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await Vue.nextTick();
    const creating = wrapper.vm.createSkill();
    clearPluginState(chat);
    const catalogLoads = chat.loadPluginCatalog.mock.calls.length;
    complete({ result: { name: 'private-skill' } });
    await creating; await flushPromises();
    expect(chat.loadPluginCatalog).toHaveBeenCalledTimes(catalogLoads);
    expect(chat.setPluginEnabled).toHaveBeenCalledTimes(1);
    // Leaving the page also invalidates a still-open deletion confirmation.
    chat.pluginCenterOpen = true; chat.pluginCenterAgentId = 'a';
    await Vue.nextTick();
    confirmDialog.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    const leftPage = wrapper.vm.removeSkill(catalog.skillSources[0]);
    wrapper.unmount(); wrapper = null;
    confirm(true); await leftPage;
    expect(chat.mutateManagedSkill).toHaveBeenCalledTimes(2);
  });

  it('keeps failed saves visible outside the plugin page without inventing success', async () => {
    chat.pluginCenterOpen = false;
    chat.pluginConfigByAgent.a = { plugins: {}, errorOperation: 'save', error: 'timeout', uncertain: true };
    await render(en, PluginSaveNotices);
    expect(wrapper.get('[role="alert"]').text()).toContain('Alpha');
    await wrapper.get('button').trigger('click');
    expect(chat.retryPluginConfig).toHaveBeenCalledWith('a');
    chat.pluginCenterOpen = true; await Vue.nextTick();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });
});
