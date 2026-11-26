import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';
import { getLlmConfig, updateLlmConfig } from '../../../agent/yeaft/config-api.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real settings UI and Server relay against an isolated Agent config.json.
test('LLM settings round-trip the fast model and a sub-agent scene route', async ({ chatPage: page, mockAgent }) => {
  const dir = await mkdtemp(join(tmpdir(), 'yeaft-llm-scene-settings-'));
  try {
    const main = 'fixture/gpt-5.4';
    const fast = 'fixture/gpt-5.4-mini';
    expect(updateLlmConfig({ primaryModel: main, providers: [{
      name: 'fixture', baseUrl: 'https://provider.invalid', apiKey: 'fixture',
      protocol: 'openai-responses', models: ['gpt-5.4', 'gpt-5.4-mini'],
    }] }, dir).error).toBeUndefined();

    const settings = page.getByRole('dialog', { name: 'Agent settings' });
    const openSettings = async () => {
      await page.locator('.agent-dropdown-trigger').filter({ visible: true }).click();
      await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
      await settings.getByRole('button', { name: 'LLM configuration' }).click();
      const read = await mockAgent.waitForMessage('get_llm_config');
      mockAgent.send({ type: 'llm_config', requestId: read.requestId, ...getLlmConfig(dir) });
    };
    const saveSettings = async () => {
      await settings.getByRole('button', { name: 'Save Changes', exact: true }).click();
      const write = await mockAgent.waitForMessage('update_llm_config');
      const updated = updateLlmConfig(write.config, dir);
      expect(updated.error).toBeUndefined();
      mockAgent.send({ type: 'llm_config_updated', requestId: write.requestId, ...updated });
      await expect(settings.getByText('Configuration saved')).toBeVisible();
    };
    const fastModel = settings.getByRole('combobox', { name: /^Fast Model/ });
    const frontend = settings.getByRole('combobox', { name: /^Frontend/ });
    await openSettings();
    await fastModel.selectOption(fast);
    await frontend.selectOption(main);
    await saveSettings();
    expect(getLlmConfig(dir).agentConfig).toMatchObject({ fastModel: fast, subAgentSceneModels: { frontend: main } });

    await settings.getByRole('button', { name: 'Close' }).click();
    await openSettings();
    await expect(fastModel).toHaveValue(fast);
    await expect(frontend).toHaveValue(main);
    await page.setViewportSize({ width: 320, height: 800 });
    await expect(frontend).toBeVisible();
    expect(await settings.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await frontend.selectOption('');
    await fastModel.selectOption({ label: 'Auto (default routing)' });
    await saveSettings();
    expect(getLlmConfig(dir).agentConfig).toMatchObject({ fastModel: null, subAgentSceneModels: {} });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
