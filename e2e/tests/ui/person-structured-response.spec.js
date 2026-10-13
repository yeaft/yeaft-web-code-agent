import { expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '../../fixtures/test-server.js';
import { personInput, personCognition, personToolResults, personToolCall, personStop } from '../../fixtures/person-provider.js';
import { createPersonBridge } from '../../../agent/yeaft/person/bridge.js';
import { createPersonService } from '../../../agent/yeaft/person/service.js';
import { config, finalProposal } from '../../../test/agent/yeaft/person/fixtures.js';

// Real production Browser -> owner relay -> Agent -> worker SQLite publication.
// Only model inference is scripted; reopening must not call the model again.
test.use({ serverEnv: { SERVE_DIST: 'true' } });
test('Person publishes shared progress and final structures, persists and replays without duplicate prose', async ({ page, serverUrl, mockAgent }, info) => {
  test.setTimeout(90000);
  const dir = await mkdtemp(join(tmpdir(), 'person-rich-response-'));
  let calls = 0;
  const adapter = { async *stream(params) {
    calls++;
    const input = personInput(params);
    const results = personToolResults(params);
    if (!personCognition(params)) {
      expect(params.tools.some(tool => tool.name === 'PresentResponse')).toBe(true);
      if (!results.length) {
        yield personToolCall('progress-response', 'PresentResponse', {
          summary: 'Partial verified results; checks continue.', phase: 'progress',
          blocks: [{ type: 'metrics', items: [{ label: 'Verified', value: '2' }] }],
        });
        yield personToolCall('final-response', 'PresentResponse', {
          title: 'Shared structured answer', summary: 'The smaller shared implementation is recommended.', phase: 'final',
          blocks: [{ type: 'cards', items: [{ title: 'Reuse', label: 'Recommended', text: 'Keep one shared renderer.',
            image: { url: 'https://example.test/weather-icon.png', alt: 'Supplied weather icon', fit: 'contain' }, url: 'https://example.test/card-source' }] },
            { type: 'map', points: [{ label: 'Beijing', latitude: 39.9075, longitude: 116.39723 }], embed: { provider: 'openstreetmap' } },
            { type: 'chart', style: 'bar', labels: ['A', 'B'], series: [{ label: 'Fixture checks', values: [2, 3] }] },
            { type: 'link', url: 'https://example.test/person-source', text: 'Source report' }],
        });
        yield personStop(true);
      } else {
        expect(results.map(result => result.toolUseId)).toEqual(['progress-response', 'final-response']);
        yield { type: 'text_delta', text: 'Presentation execution complete.' };
        yield personStop(false);
      }
      return;
    }
    const proposal = finalProposal(input.state.version);
    proposal.concepts = []; proposal.state.focusConceptIds = [];
    proposal.activity.sourceRefs = [input.trigger.ref];
    proposal.reply = 'The smaller shared implementation is recommended.';
    yield { type: 'text_delta', text: JSON.stringify(proposal) };
    yield personStop(false);
  } };
  const makeBridge = () => createPersonBridge({ context: { agentId: mockAgent.agentId, CONFIG: { serverUrl, yeaftDir: dir, workDir: dir } },
    send: frame => mockAgent.send(frame), createService: options => createPersonService({ ...options, config, adapter, effortEnabled: true, embedding: { enabled: false } }) });
  let bridge = makeBridge();
  const listener = frame => { if (frame.type === 'person_request') void bridge.request(frame); };
  mockAgent._messageHandlers.push(listener);
  const open = async () => {
    await page.goto(serverUrl);
    await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(a => a.id === id && a.status === 'ready'), mockAgent.agentId);
    mockAgent.send({ type: 'agent_capabilities_updated', capabilities: ['digital_person', 'plaintext-ok'] });
    await page.waitForFunction(id => window.Pinia.useChatStore().agents.some(a => a.id === id && a.capabilities?.includes('digital_person')), mockAgent.agentId);
    await page.evaluate(id => window.Pinia.useChatStore().setDigitalPersonUiEnabled(true, id), mockAgent.agentId);
    await page.locator('.sidebar-person-trigger:visible').click();
    await expect(page.locator('#person-input')).toBeEnabled();
  };
  try {
    await page.context().route('https://example.test/**', route => route.request().url().endsWith('.png')
      ? route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64') })
      : route.fulfill({ contentType: 'text/html', body: '<h1>Person source fixture</h1>' }));
    await page.context().route('https://www.openstreetmap.org/export/embed.html?**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Official map embed fixture</h1>' }));
    await open();
    await page.locator('#person-input').fill('Show the verified results as rich structures.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.person-messages .response-presentation')).toHaveCount(2);
    await expect(page.locator('#person-input')).toBeEnabled();
    expect(calls).toBe(3);
    await expect(page.locator('.person-messages .response-cards')).toContainText('Keep one shared renderer.');
    await expect(page.locator('.person-messages .response-chart svg')).toBeVisible();
    await expect(page.getByAltText('Supplied weather icon')).toBeVisible();
    await expect(page.locator('.response-map iframe')).toHaveAttribute('src', /\/export\/embed\.html\?/);
    await page.getByRole('link', { name: 'View source', exact: true }).click();
    await expect(page.locator('.person-side-panel .browser-frame')).toHaveAttribute('src', 'https://example.test/card-source');
    await page.locator('.person-output-reader-close').click();
    expect(await page.locator('.person-messages').innerText()).toContain('Partial verified results');
    expect((await page.locator('.person-messages').innerText()).match(/The smaller shared implementation is recommended\./g)).toHaveLength(1);
    await page.locator('a.response-link').click();
    await expect(page.locator('.person-side-panel .browser-frame')).toHaveAttribute('src', 'https://example.test/person-source');
    expect(page.context().pages()).toHaveLength(1);
    await page.locator('.person-output-reader-close').click();
    const popupPromise = page.waitForEvent('popup');
    await page.locator('.response-link-row [data-response-external]').click();
    const popup = await popupPromise; await popup.waitForLoadState();
    expect(popup.url()).toBe('https://example.test/person-source'); await popup.close();
    await page.screenshot({ path: info.outputPath('person-rich-live.png'), fullPage: true });
    await bridge.close(); bridge = makeBridge();
    await open();
    await expect(page.locator('.person-messages .response-presentation')).toHaveCount(2);
    await expect(page.locator('.person-messages .response-summary').last()).toHaveText('The smaller shared implementation is recommended.');
    await expect(page.getByAltText('Supplied weather icon')).toBeVisible();
    await expect(page.locator('.response-map iframe')).toHaveAttribute('src', /marker=39\.9075%2C116\.39723/);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('person-rich-replay-mobile.png'), fullPage: true });
    expect(calls).toBe(3); expect(mockAgent.conversations.size).toBe(0);
  } finally {
    mockAgent._messageHandlers.splice(mockAgent._messageHandlers.indexOf(listener), 1);
    await bridge.close(); await rm(dir, { recursive: true, force: true });
  }
});
