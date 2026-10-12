import { expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '../../fixtures/test-server.js';
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
    const input = JSON.parse(params.messages[0].content);
    const proposal = finalProposal(input.state.version);
    proposal.concepts = []; proposal.state.focusConceptIds = []; proposal.reply = null;
    proposal.activity.sourceRefs = [input.trigger.ref];
    const next = capability => ({ model: 'test/first', effort: 'low', reason: 'Present verified fixture results.', capability });
    if (calls === 1) proposal.next = next({ id: 'catalog.view', args: { id: 'PresentResponse' } });
    else if (calls === 2) proposal.next = next({ id: 'PresentResponse', args: {
      summary: 'Partial verified results; checks continue.', phase: 'progress',
      blocks: [{ type: 'metrics', items: [{ label: 'Verified', value: '2' }] }],
    } });
    else if (calls === 3) proposal.next = next({ id: 'PresentResponse', args: {
      title: 'Shared structured answer', summary: 'The smaller shared implementation is recommended.', phase: 'final',
      blocks: [{ type: 'cards', items: [{ title: 'Reuse', label: 'Recommended', text: 'Keep one shared renderer.' }] },
        { type: 'chart', style: 'bar', labels: ['A', 'B'], series: [{ label: 'Fixture checks', values: [2, 3] }] }],
    } });
    else proposal.reply = 'The smaller shared implementation is recommended.';
    yield { type: 'text_delta', text: JSON.stringify(proposal) };
    yield { type: 'stop', stopReason: 'end_turn' };
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
    await open();
    await page.locator('#person-input').fill('Show the verified results as rich structures.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.person-messages .response-presentation')).toHaveCount(2);
    await expect(page.locator('#person-input')).toBeEnabled();
    expect(calls).toBe(4);
    await expect(page.locator('.person-messages .response-cards')).toContainText('Keep one shared renderer.');
    await expect(page.locator('.person-messages .response-chart svg')).toBeVisible();
    expect(await page.locator('.person-messages').innerText()).toContain('Partial verified results');
    expect((await page.locator('.person-messages').innerText()).match(/The smaller shared implementation is recommended\./g)).toHaveLength(1);
    await page.screenshot({ path: info.outputPath('person-rich-live.png'), fullPage: true });
    await bridge.close(); bridge = makeBridge();
    await open();
    await expect(page.locator('.person-messages .response-presentation')).toHaveCount(2);
    await expect(page.locator('.person-messages .response-summary').last()).toHaveText('The smaller shared implementation is recommended.');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('person-rich-replay-mobile.png'), fullPage: true });
    expect(calls).toBe(4); expect(mockAgent.conversations.size).toBe(0);
  } finally {
    mockAgent._messageHandlers.splice(mockAgent._messageHandlers.indexOf(listener), 1);
    await bridge.close(); await rm(dir, { recursive: true, force: true });
  }
});
