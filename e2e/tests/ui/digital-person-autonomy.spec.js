import { expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from '../../fixtures/test-server.js';
import { personInput, personCognition, personToolCall, personStop } from '../../fixtures/person-provider.js';
import { createPersonBridge } from '../../../agent/yeaft/person/bridge.js';
import { createPersonService } from '../../../agent/yeaft/person/service.js';
import { config, finalProposal } from '../../../test/agent/yeaft/person/fixtures.js';

// Real browser, authenticated Server relay, service, SQLite and execution protocol.
// Only inference is scripted. One malformed settings request exercises the real
// service's error contract; the delayed request has not yet granted consent.
test.use({ serverEnv: { SERVE_DIST: process.env.PERSON_UI_PRODUCTION || 'false' } });

for (const scenario of [{ width: 1280, theme: 'light' }, { width: 320, theme: 'dark' }]) {
  test(`Person autonomy requires opt-in and preserves manual use (${scenario.theme}, ${scenario.width}px)`, async ({ page, serverUrl, mockAgent }, testInfo) => {
    test.setTimeout(60000);
    const dir = await mkdtemp(join(tmpdir(), 'person-autonomy-e2e-'));
    const requests = [], calls = [], relays = [];
    let service, ownerId, releaseSettings;
    let rejectFirstSetting = true;
    const settingsGate = new Promise(resolve => { releaseSettings = resolve; });
    const reply = 'Manual answers still work with autonomous follow-up disabled.';
    const adapter = { async *stream(params) {
      await setImmediate();
      calls.push(params);
      const input = personInput(params);
      // This spec exercises goal protocol itself. The shared operation helper
      // intentionally filters goal bookkeeping for other scenario scripts.
      const results = params.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      expect(input.trigger.kind).toBe('send');
      if (personCognition(params)) {
        const proposal = finalProposal(input.state.version);
        proposal.concepts = []; proposal.state.focusConceptIds = [];
        proposal.activity.sourceRefs = [input.trigger.ref]; proposal.reply = reply;
        yield { type: 'text_delta', text: JSON.stringify(proposal) };
        yield personStop(false);
      } else if (!results.length) {
        expect(params.tools.map(tool => tool.name)).toContain('Execution__goal');
        yield personToolCall('manual-answer-goal', 'Execution.goal', {
          objective: 'Answer the direct question about manual use',
          acceptance: 'Explain that manual messages remain available while autonomy is off',
          kind: 'answer', status: 'completed', reason: 'The direct answer is ready; no host action is needed.',
          nextStep: '', sourceRefs: [input.trigger.ref], acceptanceChecks: [], waitFor: [], blocker: null,
        });
        yield personStop(true);
      } else {
        expect(results).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'Execution.goal', ok: true, goal: expect.objectContaining({ kind: 'answer', status: 'completed' }) }),
        ]));
        yield { type: 'text_delta', text: reply };
        yield personStop(false);
      }
    } };
    const bridge = createPersonBridge({
      context: { agentId: mockAgent.agentId, CONFIG: { serverUrl, yeaftDir: dir, workDir: dir } },
      send: message => mockAgent.send(message),
      createService: options => (service = createPersonService({ ...options, config, adapter, embedding: { enabled: false } })),
    });
    const listener = message => {
      if (message.type !== 'person_request') return;
      requests.push(message); ownerId = message.ownerId;
      relays.push((async () => {
        if (message.op === 'settings' && rejectFirstSetting) {
          rejectFirstSetting = false;
          await settingsGate;
          return bridge.request({ ...message, payload: { autonomyEnabled: 'invalid' } });
        }
        return bridge.request(message);
      })());
    };
    mockAgent._messageHandlers.push(listener);
    const snapshot = () => service.request({ ownerId, op: 'snapshot' });
    const settingsRequests = () => requests.filter(request => request.op === 'settings');
    try {
      await page.setViewportSize({ width: scenario.width, height: 800 });
      await page.addInitScript(({ theme }) => {
        localStorage.setItem('locale', 'en'); localStorage.setItem('theme', theme);
      }, scenario);
      await page.goto(serverUrl);
      if (process.env.PERSON_UI_PRODUCTION === 'true') await expect(page.locator('script[src^="app.bundle.js"]')).toHaveCount(1);
      await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === id && agent.status === 'ready'), mockAgent.agentId);
      mockAgent.send({ type: 'agent_capabilities_updated', capabilities: ['digital_person', 'plaintext-ok'] });
      await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === id && agent.capabilities?.includes('digital_person')), mockAgent.agentId);
      await page.evaluate(id => window.Pinia.useChatStore().setDigitalPersonUiEnabled(true, id), mockAgent.agentId);
      if (scenario.width <= 768) await page.locator('.header-sidebar-toggle').click();
      await page.locator('.sidebar-person-trigger:visible').click();
      await expect(page.locator('#person-input')).toBeEnabled();
      await page.locator('#person-input').fill('Keep this draft while managing autonomy');
      await page.locator('.person-thoughts-button').click();
      const managementTab = page.locator('.person-inspector-nav').getByRole('button', { name: 'Management', exact: true });
      await managementTab.focus(); await page.keyboard.press('Enter');
      const management = page.locator('.person-management');
      const checkbox = management.getByRole('checkbox', { name: 'Autonomous follow-up (opt-in)', exact: true });
      const consent = management.locator('.person-main-execution').filter({ has: page.getByRole('checkbox') });
      await expect(checkbox).toBeEnabled(); await expect(checkbox).not.toBeChecked();
      await expect(consent).toContainText('Off by default.');
      await expect(consent).toContainText('This is not new permission for actions.');
      await expect(management).toContainText('No live main execution.');
      await expect(page.locator('html')).toHaveAttribute('data-theme', scenario.theme);
      expect((await snapshot()).person.settings.autonomyEnabled).toBe(false);
      expect(calls).toHaveLength(0);
      expect(settingsRequests()).toHaveLength(0);
      await page.screenshot({ path: testInfo.outputPath('autonomy-off.png'), fullPage: true });

      // Focus, activation and re-entry are keyboard-only, including the 320px modal.
      await checkbox.focus(); await expect(checkbox).toBeFocused();
      expect(await checkbox.evaluate(element => parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThan(0);
      await page.keyboard.press('Space');
      await expect.poll(() => settingsRequests().length).toBe(1);
      await expect(checkbox).toBeDisabled();
      await expect(consent).toHaveAttribute('aria-busy', 'true');
      await expect(consent.getByRole('status')).toHaveText('Updating execution…');
      // Pending UI cannot repeat the command, and reads cannot start inference.
      await management.getByRole('button', { name: 'Refresh', exact: true }).click();
      expect((await snapshot()).person.settings.autonomyEnabled).toBe(false);
      expect(settingsRequests()).toHaveLength(1); expect(calls).toHaveLength(0);
      await page.screenshot({ path: testInfo.outputPath('autonomy-pending.png'), fullPage: true });
      releaseSettings();
      await expect(checkbox).toBeEnabled();
      await expect(page.locator(scenario.width === 320 ? '.person-panel-error' : '.person-error')).toContainText('Invalid digital person settings');
      // Keep rollback failures visible without hiding the independent revoke and
      // manual-execution checks below. Re-entry must use persisted consent.
      await expect.soft(checkbox).not.toBeChecked();
      await expect(consent).toHaveAttribute('aria-busy', 'false');
      expect((await snapshot()).person.settings.autonomyEnabled).toBe(false);
      expect(calls).toHaveLength(0);
      await page.screenshot({ path: testInfo.outputPath('autonomy-error.png'), fullPage: true });
      // Re-enter the surface to verify that an error did not persist consent.
      await page.locator('.person-inspector-nav').getByRole('button', { name: 'Overview', exact: true }).click();
      await managementTab.click();
      await expect(checkbox).not.toBeChecked();

      // Retry valid consent, then revoke it before the real scheduler's first due
      // time. No fake clock, scheduler hook or autonomy admission is involved.
      const consentRequestedAt = Date.now();
      await checkbox.focus(); await page.keyboard.press('Space');
      await expect(checkbox).toBeEnabled(); await expect(checkbox).toBeChecked();
      expect((await snapshot()).person.settings.autonomyEnabled).toBe(true);
      expect(calls).toHaveLength(0);
      await checkbox.focus(); await page.keyboard.press('Space');
      await expect(checkbox).toBeEnabled(); await expect(checkbox).not.toBeChecked();
      // Repository consent schedules first admission at commit time + 5000ms.
      // Measuring from before the request is a conservative proof of revocation
      // before that real deadline, rather than merely observing zero calls.
      expect(Date.now() - consentRequestedAt).toBeLessThan(5000);
      expect(settingsRequests().map(request => request.payload)).toEqual([
        { autonomyEnabled: true }, { autonomyEnabled: true }, { autonomyEnabled: false },
      ]);
      expect((await snapshot()).person.settings.autonomyEnabled).toBe(false);
      expect(calls).toHaveLength(0);
      await management.getByRole('button', { name: 'Refresh', exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await consent.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.locator('.person-panel-header').getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.locator('#person-input')).toHaveValue('Keep this draft while managing autonomy');

      // Disabling background admission does not disable explicit manual execution.
      await page.locator('#person-input').fill('Can I still ask a manual question?');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.locator('.person-messages')).toContainText(reply, { timeout: 20000 });
      await expect.poll(async () => (await snapshot()).busy).toBe(false);
      expect((await snapshot()).latestEpisode.status).toBe('completed');
      expect(calls).toHaveLength(3);
      expect(mockAgent.conversations.size).toBe(0);

      // Persisted consent is authoritative after a complete browser reload;
      // status, snapshots and Management polling remain read-only.
      await page.reload();
      await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === id && agent.status === 'ready'), mockAgent.agentId);
      if (scenario.width <= 768) await page.locator('.header-sidebar-toggle').click();
      await page.locator('.sidebar-person-trigger:visible').click();
      await expect(page.locator('#person-input')).toBeEnabled();
      await page.locator('.person-thoughts-button').click();
      await managementTab.click();
      await expect(checkbox).toBeEnabled(); await expect(checkbox).not.toBeChecked();
      await management.getByRole('button', { name: 'Refresh', exact: true }).click();
      expect((await snapshot()).person.settings.autonomyEnabled).toBe(false);
      expect(calls).toHaveLength(3);
      expect(requests.map(request => request.op)).toEqual(expect.arrayContaining(['status', 'open', 'snapshot', 'tasks', 'executions', 'settings', 'send']));
      await page.screenshot({ path: testInfo.outputPath('autonomy-disabled-persisted.png'), fullPage: true });
    } finally {
      releaseSettings();
      mockAgent._messageHandlers.splice(mockAgent._messageHandlers.indexOf(listener), 1);
      await Promise.allSettled(relays);
      await bridge.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
