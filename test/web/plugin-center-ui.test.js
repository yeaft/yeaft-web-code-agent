// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import PluginCenterPage from '../../web/components/PluginCenterPage.js';
import PluginSaveNotices from '../../web/components/PluginSaveNotices.js';
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

  it('switches Agent state, preserves cached offline rows, distinguishes connection from enabled and retries attributed errors', async () => {
    await render();
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
    expect(chat.loadPluginConfig).not.toHaveBeenCalledWith('c', expect.anything());
  });

  it('creates in captured Agent/project scope, auto-enables explicit selections and guards unsaved forms', async () => {
    await render();
    chat.pluginConfigByAgent.a.draft = { skills: [] };
    wrapper.vm.openSkillForm(); await flushPromises();
    expect(document.activeElement).toBe(document.querySelector('.plugin-center-skill-form input'));
    expect(wrapper.element.closest('body').firstElementChild.inert).toBe(true);
    wrapper.vm.skillScope = 'project';
    wrapper.vm.skillForm = { name: 'new-skill', description: 'description', trigger: '', content: 'instructions' };
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
