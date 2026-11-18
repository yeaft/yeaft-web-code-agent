import { expect } from '@playwright/test';
import { resolve } from 'node:path';
import { test } from '../fixtures/test-server.js';
import { geminiAgent, GEMINI_URL, GEMINI_MODELS } from '../fixtures/gemini-agent.js';
import { getThinkingCapability } from '../../agent/yeaft/models.js';

// SERVE_DIST=true runs this exact suite against the production bundle.
test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: process.env.SERVE_DIST || 'false' } });

async function openSettings(page) {
  if (!await page.locator('.agent-dropdown-trigger:visible').isVisible()) {
    await page.locator('.yeaft-topbar-sidebar-toggle:visible, .header-sidebar-toggle:visible').first().click();
  }
  await page.locator('.agent-dropdown-trigger:visible').click();
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
  const dialog = page.locator('.agent-settings-dialog');
  await dialog.locator('.agent-settings-nav-item').nth(2).click();
  return dialog;
}

async function fitsViewport(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 320]) {
    test(`Gemini configuration discovery and Session roundtrip (${theme}, ${width}px)`, async ({ page, serverUrl, mockAgent }) => {
      test.setTimeout(60000);
      const state = geminiAgent(mockAgent);
      const externalRequests = [];
      await page.route('**/*', route => {
        if (new URL(route.request().url()).origin === new URL(serverUrl).origin) return route.continue();
        externalRequests.push(route.request().url());
        return route.abort();
      });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(serverUrl);
      await page.waitForFunction(agentId => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === agentId && agent.online), mockAgent.agentId);
      await page.evaluate(({ agentId, theme }) => {
        document.documentElement.dataset.theme = theme;
        window.Pinia.useChatStore().enterYeaft(agentId);
      }, { agentId: mockAgent.agentId, theme });
      await expect(page.locator('.yeaft-session-input')).toBeVisible();
      const dialog = await openSettings(page);
      const form = dialog.locator('.llm-tab');
      await form.getByRole('button', { name: 'Add Provider', exact: true }).click();
      let card = form.locator('.llm-provider-card').first();
      await card.locator('.sp-custom-select-trigger').click();
      await expect(card.locator('.sp-custom-select-option:visible').filter({ hasText: 'Gemini' })).toHaveCount(1);
      await card.locator('.sp-custom-select-option:visible').filter({ hasText: 'Gemini' }).click();
      await expect(card.locator('input').nth(1)).toHaveValue(GEMINI_URL);
      await expect(card.locator('textarea')).toHaveValue(/gemini-/);
      const discover = () => card.getByRole('button', { name: 'Test connection & refresh models' });
      await expect(discover()).toBeDisabled();
      await card.locator('input').nth(0).fill('google');
      const key = card.locator('input').nth(2);
      await expect(key).toHaveAttribute('type', 'password');
      await key.fill('e2e-fake-gemini-key');
      await card.locator('.llm-eye-btn').click();
      await expect(key).toHaveAttribute('type', 'text');
      await card.locator('.llm-eye-btn').click();
      await fitsViewport(page, discover());
      await discover().focus();
      await expect(discover()).toBeFocused();
      await discover().press('Enter');
      await expect.poll(() => state.discoveries.length).toBe(1);
      expect(state.discoveries[0]).toMatchObject({ providerType: 'gemini', baseUrl: GEMINI_URL, apiKey: 'e2e-fake-gemini-key' });
      await expect(card.getByRole('button', { name: /Refreshing/ })).toBeDisabled();
      state.replyDiscovery('Fixture API key rejected');
      await expect(form.locator('.llm-inline-status')).toContainText('Fixture API key rejected');
      await discover().click();
      await expect.poll(() => state.discoveries.length).toBe(2);
      state.replyDiscovery();
      await expect(form.locator('.llm-inline-status')).toContainText('Connected. Model catalog refreshed (no generation request).');
      await expect(card.locator('textarea')).toHaveValue('gemini-2.5-flash, gemini-4-hydrogen');
      // Editing IDs must not discard discovered token metadata.
      await card.locator('textarea').fill('gemini-2.5-flash,\ngemini-4-hydrogen, ');
      const save = form.locator('.llm-save-row button');
      await expect(save).toBeEnabled();
      expect(state.writes).toHaveLength(0);
      await fitsViewport(page, save);
      await save.click();
      await expect.poll(() => state.writes.length).toBe(1);
      expect(state.config.providers[0]).toMatchObject({ name: 'google', protocol: 'gemini', apiKey: 'e2e-fake-gemini-key', baseUrl: GEMINI_URL, models: GEMINI_MODELS });
      await expect(save).toBeDisabled();
      await dialog.locator('.agent-settings-close').click();
      await openSettings(page);
      await expect(card.locator('.sp-custom-select-trigger')).toContainText('Gemini');
      await expect(key).toHaveValue('e2e-fake-gemini-key');
      await expect(card.locator('textarea')).toHaveValue('gemini-2.5-flash, gemini-4-hydrogen');
      await fitsViewport(page, card);
      const mode = process.env.SERVE_DIST === 'true' ? 'dist' : 'source';
      await dialog.screenshot({ path: resolve(`artifacts/gemini-api/${mode}-settings-${theme}-${width}.png`) });
      // Fetch the preset catalog through the same owner-checked Server relay.
      await form.getByRole('button', { name: 'Add from Catalog', exact: true }).click();
      const picker = page.locator('.llm-preset-modal');
      await expect.poll(() => mockAgent.messages('get_models_dev_registry').length,
        { message: 'Catalog request must reach the Agent through the real Server' }).toBe(1);
      await picker.locator('.llm-preset-providers .llm-preset-row').filter({ hasText: 'Google Gemini' }).click();
      await picker.locator('.llm-preset-model-row').filter({ hasText: 'gemini-2.5-flash' }).locator('input').check();
      const addPreset = picker.getByRole('button', { name: 'Add to providers', exact: true });
      await fitsViewport(page, addPreset);
      await picker.screenshot({ path: resolve(`artifacts/gemini-api/${mode}-catalog-${theme}-${width}.png`) });
      await addPreset.click();
      const preset = form.locator('.llm-provider-card').nth(1);
      await expect(preset.locator('input').nth(0)).toHaveValue('google-2');
      await expect(preset.locator('input').nth(1)).toHaveValue(GEMINI_URL);
      await expect(preset.locator('input').nth(2)).toHaveValue('');
      // Google presets expose the native protocol and its discovery action.
      await expect(preset.locator('.sp-custom-select-trigger')).toContainText('Gemini');
      await expect(preset.getByRole('button', { name: 'Test connection & refresh models' })).toBeDisabled();
      await fitsViewport(page, save);
      await save.click();
      await expect.poll(() => state.writes.length).toBe(2);
      expect(state.config.providers[1]).toMatchObject({ name: 'google-2',
        baseUrl: GEMINI_URL, models: [{ id: 'gemini-2.5-flash', protocol: 'gemini' }] });
      expect(state.config.providers[1].protocol).toBe('gemini');
      await dialog.locator('.agent-settings-close').click();
      await openSettings(page);
      // Google presets expose the native protocol and its discovery action.
      await expect(preset.locator('.sp-custom-select-trigger')).toContainText('Gemini');
      await expect(preset.locator('textarea')).toHaveValue('gemini-2.5-flash');
      await expect(preset.locator('input').nth(1)).toHaveValue(GEMINI_URL);
      await expect(preset.locator('input').nth(2)).toHaveValue('');
      expect(state.config.providers[0].models).toEqual(GEMINI_MODELS);
      await fitsViewport(page, preset);
      await dialog.screenshot({ path: resolve(`artifacts/gemini-api/${mode}-preset-${theme}-${width}.png`) });
      await dialog.locator('.agent-settings-close').click();

      // The Agent catalog and per-Session writes still cross the real relay.
      const catalog = [...GEMINI_MODELS, { id: 'gemini-4-carbon', protocol: 'gemini' }].map(model => {
        const { effortOptions, defaultEffort, thinkingProtocol } = getThinkingCapability(model.id, model);
        return { ...model, ref: `google/${model.id}`, provider: 'google', label: model.id, effortProtocol: thinkingProtocol, effortOptions, defaultEffort };
      });
      mockAgent.send({ type: 'yeaft_output', event: { type: 'yeaft_status', model: catalog[0].ref,
        catalogEpoch: 'gemini-e2e', catalogRevision: 1, catalogRefreshedAt: Date.now(), availableModels: catalog } });
      await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().sidebarSessionCatalog.some(row => row.routeRef.sessionId === 'ordinary-session'))).toBe(true);
      await page.evaluate(agentId => {
        const store = window.Pinia.useChatStore();
        store.openCatalogSession(store.sidebarSessionCatalog.find(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === 'ordinary-session'));
        store.closeSessionSidebar();
      }, mockAgent.agentId);
      await expect.poll(() => page.evaluate(agentId => {
        const store = window.Pinia.useChatStore();
        const status = store.yeaftStatusByAgent[agentId];
        return { epoch: status?.catalogEpoch, revision: status?.catalogRevision, models: store.yeaftAvailableModels };
      }, mockAgent.agentId)).toEqual({ epoch: 'gemini-e2e', revision: 1, models: catalog });
      await expect(page.getByText(`${mockAgent.agentName}: persistent conversation for ordinary-session`, { exact: true })).toBeVisible();
      const modelTrigger = page.locator('.yeaft-composer-model');
      await expect(modelTrigger).toHaveText('gemini-2.5-flash');
      const modelMenu = page.locator('.yeaft-composer-model-dropdown');
      const effort = page.locator('.yeaft-composer-effort');
      const effortMenu = page.locator('.yeaft-composer-effort-dropdown');
      const chooseEffort = async (names, choice, expected) => {
        await fitsViewport(page, effort);
        await effort.press('Enter');
        await expect(effortMenu.locator('.yeaft-model-option-label')).toHaveText(names);
        await effortMenu.getByRole('menuitemradio', { name: choice, exact: true }).click();
        await expect.poll(() => state.inventory.sessions.get('ordinary-session').config?.modelEffort).toBe(expected);
        await expect(effort).toHaveText(choice);
      };
      // Budget-only Gemini 2.5 retains a separate Max tier.
      await chooseEffort(['Medium', 'X-High', 'Max'], 'Max', 'max');
      await modelTrigger.press('Enter');
      await modelMenu.getByRole('menuitemradio', { name: /gemini-4-carbon/ }).click();
      await expect.poll(() => state.inventory.sessions.get('ordinary-session').config?.model).toBe('google/gemini-4-carbon');
      await chooseEffort(['Medium', 'High'], 'High', 'high');
      await modelTrigger.press('Enter');
      await modelMenu.getByRole('menuitemradio', { name: /gemini-4-hydrogen/ }).click();
      await expect.poll(() => state.inventory.sessions.get('ordinary-session').config?.model).toBe('google/gemini-4-hydrogen');
      await expect(effort).toHaveText('X-High');
      await chooseEffort(['Medium', 'X-High'], 'Medium', 'medium');
      await page.screenshot({ path: resolve(`artifacts/gemini-api/${mode}-session-${theme}-${width}.png`) });
      expect(externalRequests).toEqual([]);
    });
  }
}
