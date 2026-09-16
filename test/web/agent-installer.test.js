// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AgentInstaller from '../../web/components/AgentInstaller.js';

const mountInstaller = props => mount(AgentInstaller, {
  props,
  global: { mocks: { $t: key => key } },
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AgentInstaller', () => {
  it('renders an explicit platform choice and copies each platform command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const wrapper = mountInstaller({ agentSecret: "sec'ret" });

    expect(wrapper.findAll('.agent-installer-tab')).toHaveLength(2);
    expect(wrapper.get('details').element.open).toBe(false);
    expect(wrapper.get('.agent-installer-tab').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('.agent-installer-copy').text()).toBe('installer.copyCommand');
    expect(wrapper.get('code').text()).toContain('/installers/install.sh');
    await wrapper.get('.agent-installer-copy').trigger('click');
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("--secret 'sec'\"'\"'ret'"));

    await wrapper.findAll('.agent-installer-tab')[1].trigger('click');
    expect(wrapper.get('code').text()).toContain('/installers/install.ps1');
    expect(wrapper.get('code').text()).toContain("-Secret 'sec''ret'");
    wrapper.unmount();
  });

  it('does not expose a runnable command without a secret', async () => {
    const wrapper = mountInstaller({ agentSecret: '' });
    expect(wrapper.get('.agent-installer-copy').attributes('disabled')).toBeDefined();
    expect(wrapper.get('code').text()).toBe('installer.commandUnavailable');
    expect(wrapper.text()).toContain('installer.secretRequired');
    await wrapper.get('.agent-installer-settings').trigger('click');
    expect(wrapper.emitted('open-settings')).toHaveLength(1);
    wrapper.unmount();
  });

  it('reports clipboard failures and disables copying while loading', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const wrapper = mountInstaller({ agentSecret: 'secret', loading: true });
    expect(wrapper.get('.agent-installer-copy').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('installer.secretLoading');

    await wrapper.setProps({ loading: false });
    await wrapper.get('.agent-installer-copy').trigger('click');
    expect(wrapper.get('details').element.open).toBe(true);
    expect(wrapper.text()).toContain('installer.copyError');
    expect(wrapper.get('.agent-installer-copy').text()).toBe('installer.copyFailed');
    wrapper.unmount();
  });
});
