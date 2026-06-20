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
const llmTabSource = readFileSync(
  new URL('../../../web/components/LlmTab.js', import.meta.url),
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

  it('moves Agent install commands from Security to the LLM tab', () => {
    // Legacy --server / agent-secret install commands are gone from source + i18n.
    expect(settingsPanelSource).not.toMatch(/--server\s/);
    expect(llmTabSource).not.toMatch(/--server\s/);
    expect(settingsPanelSource).not.toContain('agentRunCommand');
    expect(settingsPanelSource).not.toContain('agentServiceCommand');
    expect(settingsPanelSource).not.toContain('agentCmdRun');
    expect(settingsPanelSource).not.toContain('agentCmdService');
    expect(settingsPanelSource).not.toContain('agentCmdNeedsSecret');
    expect(enSource).not.toContain('agentCmdRun');
    expect(enSource).not.toContain('agentCmdService');
    expect(enSource).not.toContain('agentCmdNeedsSecret');
    expect(enSource).not.toContain('--server');
    expect(zhSource).not.toContain('agentCmdRun');
    expect(zhSource).not.toContain('agentCmdService');
    expect(zhSource).not.toContain('agentCmdNeedsSecret');
    expect(zhSource).not.toContain('--server');

    // Security now only owns the secret. Agent install guidance belongs under LLM.
    expect(settingsPanelSource).not.toContain('agentInstallCommand()');
    expect(settingsPanelSource).not.toContain('agentLlmCommand()');
    expect(settingsPanelSource).not.toContain('settings.security.agentCmdInstall');
    expect(settingsPanelSource).not.toContain('settings.security.agentCmdLlm');
    expect(settingsPanelSource).not.toContain('settings.security.agentCmdLlmDesc');
    expect(enSource).not.toContain('settings.security.agentCmdInstall');
    expect(enSource).not.toContain('settings.security.agentCmdLlm');
    expect(enSource).not.toContain('settings.security.agentCmdLlmDesc');
    expect(zhSource).not.toContain('settings.security.agentCmdInstall');
    expect(zhSource).not.toContain('settings.security.agentCmdLlm');
    expect(zhSource).not.toContain('settings.security.agentCmdLlmDesc');

    // LLM renders only copyable script rows: install Agent, then configure Copilot.
    expect(llmTabSource).toContain('class="llm-agent-install"');
    expect(llmTabSource).toContain('agentInstallCommand()');
    expect(llmTabSource).toContain("return 'npm install -g @yeaft/webchat-agent';");
    expect(llmTabSource).toContain('copilotUseCommand()');
    expect(llmTabSource).toContain("return 'yeaft-agent llm use github-copilot --model gpt-5.5';");
    expect(llmTabSource).toContain('copyText(agentInstallCommand)');
    expect(llmTabSource).toContain('copyText(copilotUseCommand)');
    expect(llmTabSource.indexOf('class="llm-agent-install"')).toBeLessThan(llmTabSource.indexOf('v-if="!effectiveAgentId"'));
    expect(llmTabSource.indexOf('class="llm-agent-install"')).toBeLessThan(llmTabSource.indexOf('v-else-if="!agentOnline"'));
    expect(llmTabSource.indexOf('class="llm-agent-install"')).toBeLessThan(llmTabSource.indexOf('v-else-if="loadError"'));
    expect(llmTabSource.indexOf('class="llm-agent-install"')).toBeLessThan(llmTabSource.indexOf('<!-- Config loaded -->'));
    expect(llmTabSource).not.toContain('copilotInstructionsDesc');
    expect(llmTabSource).not.toContain('copilotStepLoginDesc');
    expect(llmTabSource).not.toContain('yeaft-agent llm show');

    // Both locales carry labels for the two copied snippets, not long instructions.
    expect(enSource).toContain("'settings.llm.agentInstallCommands': 'Yeaft Agent install commands'");
    expect(enSource).toContain("'settings.llm.agentInstallCommand': 'Install Agent'");
    expect(enSource).toContain("'settings.llm.copilotUseLabel': 'Use Copilot'");
    expect(enSource).not.toContain('copilotInstructionsDesc');
    expect(enSource).not.toContain('copilotStepVerifyDesc');
    expect(zhSource).toContain("'settings.llm.agentInstallCommands': 'Yeaft Agent 安装命令'");
    expect(zhSource).toContain("'settings.llm.agentInstallCommand': '安装 Agent'");
    expect(zhSource).toContain("'settings.llm.copilotUseLabel': '使用 Copilot'");
    expect(zhSource).not.toContain('copilotInstructionsDesc');
    expect(zhSource).not.toContain('copilotStepVerifyDesc');

    // Removing the --server install hint also retired its helpers and placeholder
    // styling. Guard against either silently sneaking back in via copy/paste.
    expect(settingsPanelSource).not.toContain('agentName()');
    expect(settingsPanelSource).not.toContain('serverWsUrl()');
    expect(settingsCss).not.toContain('.sp-cmd-placeholder');
  });

  it('keeps shared sidebar agent dropdown styles after removing git.css', () => {
    for (const className of [
      'agent-dropdown-trigger',
      'dropdown-chevron',
      'agent-dropdown',
      'agent-dropdown-item',
      'agent-dropdown-name',
      'agent-dropdown-version',
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
