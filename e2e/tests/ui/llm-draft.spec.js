import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

for (const scenario of [
  { theme: 'light', width: 1440, height: 900 },
  { theme: 'dark', width: 320, height: 720 },
]) {
  test(`LLM draft survives delayed config broadcasts and saves only explicitly (${scenario.theme}, ${scenario.width}px)`, async ({ page, serverUrl, mockAgent }, testInfo) => {
    test.setTimeout(90000);
    let savedConfig = {
      providers: [{ name: 'fixture', baseUrl: 'https://example.test', apiKey: 'fixture-key',
        protocol: 'openai-responses', models: ['model-a'] }],
      primaryModel: 'fixture/model-a', debug: false,
    };
    const reads = [];
    const writes = [];
    const sendConfig = (requestId, changes = {}) => mockAgent.send({
      type: 'llm_config_updated', requestId, agentConfig: savedConfig, ...changes,
    });
    mockAgent._messageHandlers.push(request => {
      if (request.type === 'get_llm_config') {
        reads.push(request);
        sendConfig(request.requestId);
      }
      if (request.type === 'update_llm_config') writes.push(request);
    });
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.goto(serverUrl);
    await page.waitForFunction(agentId => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === agentId && agent.online), mockAgent.agentId);
    await page.evaluate(({ agentId, theme }) => {
      document.documentElement.dataset.theme = theme;
      window.Pinia.useChatStore().currentAgent = agentId;
    }, { agentId: mockAgent.agentId, theme: scenario.theme });
    if (!await page.locator('.agent-dropdown-trigger:visible').isVisible()) {
      await page.locator('.yeaft-topbar-sidebar-toggle:visible, .header-sidebar-toggle:visible').first().click();
    }
    await page.locator('.agent-dropdown-trigger:visible').click();
    await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
    const dialog = page.locator('.agent-settings-dialog');
    await dialog.locator('.agent-settings-nav-item').nth(2).click();
    const form = dialog.locator('.llm-tab');
    const card = form.locator('.llm-provider-card').first();
    const name = card.locator('input').nth(0);
    const url = card.locator('input').nth(1);
    const key = card.locator('input').nth(2);
    const models = card.locator('textarea');
    const save = form.locator('.llm-save-row button');
    await expect(name).toHaveValue('fixture');
    await name.fill('unfinished provider');
    await url.fill('https://draft.example.test/part');
    await key.fill('fixture-half-key');
    await models.fill('model-a,\npartially-written-model, ');
    await models.focus();
    const startReads = reads.length;
    // Deliver the background response after the reported 10+ second window.
    // The real Server relay and message handler update the shared store.
    await page.waitForTimeout(16000);
    sendConfig('delayed-background-read');
    await expect.poll(() => page.evaluate(agentId => window.Pinia.useChatStore().llmConfig[agentId]?.requestId, mockAgent.agentId))
      .toBe('delayed-background-read');
    await expect(name).toHaveValue('unfinished provider');
    await expect(url).toHaveValue('https://draft.example.test/part');
    await expect(key).toHaveValue('fixture-half-key');
    await expect(models).toHaveValue('model-a,\npartially-written-model, ');
    await expect(models).toBeFocused();
    await expect(save).toBeEnabled();
    expect(writes).toHaveLength(0);
    expect(reads.length).toBeGreaterThanOrEqual(startReads);

    sendConfig('background-error', { error: 'background read temporarily unavailable' });
    await expect.poll(() => page.evaluate(agentId => window.Pinia.useChatStore().llmConfig[agentId]?.error, mockAgent.agentId))
      .toBe('background read temporarily unavailable');
    await expect(models).toHaveValue('model-a,\npartially-written-model, ');
    await expect(form.locator('.sp-error-text')).toHaveCount(0);
    await dialog.screenshot({ path: testInfo.outputPath(`llm-draft-${scenario.theme}-${scenario.width}.png`) });

    await save.click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].config.providers[0]).toMatchObject({ name: 'unfinished provider',
      baseUrl: 'https://draft.example.test/part', apiKey: 'fixture-half-key', models: ['model-a', 'partially-written-model'] });
    await name.fill('newer unsaved provider');
    savedConfig = writes[0].config;
    sendConfig(writes[0].requestId);
    await expect(save).toBeEnabled();
    await expect(name).toHaveValue('newer unsaved provider');
    await expect(form.locator('.llm-dirty-hint')).toBeVisible();
    // A reconnect/read (same Agent) must not adopt the older saved snapshot.
    await page.evaluate(agentId => window.Pinia.useChatStore().sendWsMessage({ type: 'get_llm_config', agentId }), mockAgent.agentId);
    await expect.poll(() => reads.length).toBeGreaterThan(startReads);
    await expect(name).toHaveValue('newer unsaved provider');
    expect(writes).toHaveLength(1);

    await save.click();
    await expect.poll(() => writes.length).toBe(2);
    savedConfig = writes[1].config;
    sendConfig(writes[1].requestId);
    await expect(save).toBeDisabled();
    await expect(form.locator('.llm-dirty-hint')).toHaveCount(0);
    await dialog.locator('.agent-settings-close').click();
    if (!await page.locator('.agent-dropdown-trigger:visible').isVisible()) {
      await page.locator('.yeaft-topbar-sidebar-toggle:visible, .header-sidebar-toggle:visible').first().click();
    }
    await page.locator('.agent-dropdown-trigger:visible').click();
    await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
    await dialog.locator('.agent-settings-nav-item').nth(2).click();
    await expect(name).toHaveValue('newer unsaved provider');
    await expect(save).toBeDisabled();
  });
}
