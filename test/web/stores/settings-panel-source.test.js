import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const settingsPanelSource = readFileSync(
  new URL('../../../web/components/SettingsPanel.js', import.meta.url),
  'utf8',
);
const settingsCss = readFileSync(
  new URL('../../../web/styles/settings.css', import.meta.url),
  'utf8',
);
const sidebarAgentHeaderSource = readFileSync(
  new URL('../../../web/components/SidebarAgentHeader.js', import.meta.url),
  'utf8',
);
const sidebarCss = readFileSync(
  new URL('../../../web/styles/sidebar.css', import.meta.url),
  'utf8',
);
const stylesIndexSource = readFileSync(
  new URL('../../../web/styles/index.css', import.meta.url),
  'utf8',
);
const enSource = readFileSync(new URL('../../../web/i18n/en.js', import.meta.url), 'utf8');
const zhSource = readFileSync(new URL('../../../web/i18n/zh-CN.js', import.meta.url), 'utf8');

const agentDropdownCss = sidebarCss.slice(
  sidebarCss.indexOf('/* Shared agent dropdown used by Chat and Yeaft sidebars */'),
  sidebarCss.indexOf('.sidebar-header-actions {'),
);

describe('Settings panel source', () => {
  it('does not expose the removed port proxy settings page', () => {
    expect(settingsPanelSource).not.toContain("import ProxyTab");
    expect(settingsPanelSource).not.toContain('<ProxyTab');
    expect(settingsPanelSource).not.toContain("activeTab === 'proxy'");
    expect(settingsPanelSource).not.toContain("settings.tabs.proxy");
    expect(settingsPanelSource).not.toContain("key: 'proxy'");
    expect(enSource).not.toContain("settings.tabs.proxy");
    expect(zhSource).not.toContain("settings.tabs.proxy");
    expect(enSource).not.toContain("chat.sidebar.portProxy");
    expect(zhSource).not.toContain("chat.sidebar.portProxy");
    expect(stylesIndexSource).not.toContain("git.css");
    expect(settingsCss).not.toContain('proxy-select-wrapper');
    expect(settingsCss).not.toContain('proxy-select');
    expect(settingsCss).not.toContain('proxy-modal');
  });

  it('does not expose the removed global Tools settings tab', () => {
    expect(settingsPanelSource).not.toContain("activeTab === 'tools'");
    expect(settingsPanelSource).not.toContain("key: 'tools'");
    expect(settingsPanelSource).not.toContain('mcpServersList');
    expect(settingsPanelSource).not.toContain('toggleMcpServer');
    expect(enSource).not.toContain('settings.tabs.tools');
    expect(zhSource).not.toContain('settings.tabs.tools');
    expect(enSource).not.toContain('settings.tools.');
    expect(zhSource).not.toContain('settings.tools.');
    expect(settingsCss).not.toContain('sp-mcp-item');
    expect(settingsCss).not.toContain('sp-tools-hint');

    // Yeaft-owned MCP configuration remains in the Yeaft settings section.
    expect(settingsPanelSource).toContain("{ key: 'mcp', label: this.$t('settings.yeaft.tabs.mcp') }");
    expect(settingsPanelSource).toContain('<McpTab @message="onLlmMessage" />');
  });

  it('keeps Agent commands usable only when a secret is available', () => {
    expect(settingsPanelSource).toContain('agentRunCommand()');
    expect(settingsPanelSource).toContain('agentServiceCommand()');
    expect(settingsPanelSource).toContain('yeaft-agent --server ${this.serverWsUrl} --secret ${this.agentSecret} --name ${this.agentName}');
    expect(settingsPanelSource).toContain('yeaft-agent install --server ${this.serverWsUrl} --secret ${this.agentSecret} --name ${this.agentName}');
    expect(settingsPanelSource).toContain("this.agentSecret && !this.resetConfirm");
    expect(settingsPanelSource).toContain("settings.security.generateKey");
    expect(enSource).toContain("'settings.security.agentCmdRun': 'Run Agent'");
    expect(zhSource).toContain("'settings.security.agentCmdRun': '运行 Agent'");
    expect(enSource).toContain('--server, --secret, and --name');
    expect(zhSource).toContain('--server、--secret 和 --name');
  });

  it('keeps shared sidebar agent dropdown styles after removing git.css', () => {
    for (const className of [
      'agent-dropdown-trigger',
      'dropdown-chevron',
      'agent-dropdown',
      'agent-dropdown-item',
      'agent-dropdown-name',
      'agent-dropdown-version',
      'agent-dropdown-latency',
      'agent-dropdown-status',
      'agent-dropdown-restart-btn',
      'agent-dropdown-upgrade-btn',
      'agent-dropdown-empty',
    ]) {
      expect(sidebarAgentHeaderSource).toContain(className);
      expect(agentDropdownCss).toContain(`.${className}`);
    }

    expect(settingsCss).not.toContain('agent-dropdown');
    expect(agentDropdownCss).toContain('background: var(--bg-main);');
    expect(agentDropdownCss).toContain('border: 1px solid var(--border-color);');
    expect(agentDropdownCss).toContain('color: var(--accent-blue);');
    expect(agentDropdownCss).not.toContain('var(--accent-color');
    expect(agentDropdownCss).not.toContain('var(--bg-hover');
  });

  it('styles Yeaft settings subtabs as a segmented control', () => {
    expect(settingsPanelSource).toContain('class="sp-subtab-bar"');
    expect(settingsPanelSource).toContain('class="sp-subtab"');
    expect(settingsPanelSource).toContain("settings.yeaft.tabs.vp");
    expect(settingsPanelSource).toContain("settings.yeaft.tabs.search");
    expect(settingsPanelSource).toContain("settings.yeaft.tabs.mcp");

    expect(settingsCss).toContain('.sp-subtab-bar');
    expect(settingsCss).toContain('display: inline-flex;');
    expect(settingsCss).toContain('background: var(--bg-sidebar);');
    expect(settingsCss).toContain('border: 1px solid var(--border-light);');
    expect(settingsCss).toContain('.sp-subtab.active');
    expect(settingsCss).toContain('outline: 2px solid var(--accent-blue);');
  });
});
