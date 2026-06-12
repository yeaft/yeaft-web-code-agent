import { describe, expect, it } from 'vitest';
import en from '../../web/i18n/en.js';
import zhCN from '../../web/i18n/zh-CN.js';

globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => {
  const state = options.state ? options.state() : {};
  return { ...state };
};
globalThis.Pinia.useChatStore = () => ({ locale: 'en' });

globalThis.window = globalThis.window || { localStorage: globalThis.localStorage };

const { default: SettingsPanel } = await import('../../web/components/SettingsPanel.js');

describe('SettingsPanel agent commands', () => {
  const template = SettingsPanel.template;
  const computed = SettingsPanel.computed;

  it('always renders the install command and only gates the secret-bearing service command', () => {
    expect(template).toContain('class="sp-cmd-group"');
    expect(template).not.toContain('class="sp-cmd-group" v-if="agentSecret"');
    expect(template).toContain('{{ agentInstallCommand }}');
    expect(template).toContain('copyText(agentInstallCommand)');
    expect(template).toContain('<template v-if="agentSecret">');
    expect(template).toContain('{{ agentServiceCommand }}');
    expect(template).toContain('settings.security.agentCmdNeedsSecret');
  });

  it('builds the install and service commands from host, secret, and stable agent name', () => {
    const ctx = {
      agentSecret: 'secret-123',
      serverWsUrl: 'wss://example.test',
      agentName: 'alice-abcdef'
    };

    expect(computed.agentInstallCommand.call(ctx)).toBe('npm install -g @yeaft/webchat-agent');
    expect(computed.agentServiceCommand.call(ctx)).toBe(
      'yeaft-agent install --server wss://example.test --secret secret-123 --name alice-abcdef'
    );
  });

  it('keeps service command empty until an agent secret exists', () => {
    const ctx = {
      agentSecret: null,
      serverWsUrl: 'wss://example.test',
      agentName: 'alice-abcdef'
    };

    expect(computed.agentServiceCommand.call(ctx)).toBe('');
  });

  it('has i18n for the missing-secret hint in both locales', () => {
    expect(en['settings.security.agentCmdNeedsSecret']).toContain('--secret');
    expect(zhCN['settings.security.agentCmdNeedsSecret']).toContain('--secret');
  });
});
