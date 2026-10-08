import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { test } from '../../fixtures/test-server.js';
import { createPersonBridge } from '../../../agent/yeaft/person/bridge.js';
import { createPersonService } from '../../../agent/yeaft/person/service.js';
import { config, finalProposal } from '../../../test/agent/yeaft/person/fixtures.js';

// Real browser -> isolated Server -> Agent bridge -> local SQLite / optional MongoDB. Only inference is scripted.
// No live Agent, native config or paid provider is used; all storage is isolated.
const uri = process.env.PERSON_TEST_MONGO_URI;
for (const storage of ['sqlite', 'mongodb']) test(`Person ${storage} three capability layers persist through relay and restart`, async ({ page, serverUrl, mockAgent }) => {
  test.setTimeout(90000);
  test.skip(storage === 'mongodb' && !uri, 'Requires an explicitly supplied isolated MongoDB replica set');
  const dbName = `person_e2e_${randomUUID().replaceAll('-', '')}`;
  const yeaftDir = await mkdtemp(join(tmpdir(), 'person-e2e-'));
  const env = storage === 'mongodb' ? { YEAFT_PERSON_MONGODB_URI: uri, YEAFT_PERSON_MONGODB_DB: dbName } : {};
  const reply = `Remembered in ${storage}.`;
  let calls = 0;
  const requests = [];
  const requestedModels = [];
  const adapter = { async *stream(params) {
    calls++;
    const input = JSON.parse(params.messages[0].content);
    requests.push(input);
    requestedModels.push(params.model);
    const proposal = finalProposal(input.state.version);
    proposal.concepts[0].expectedRevision = input.concepts.find(c => c.id === 'curiosity')?.revision || 0;
    proposal.activity.sourceRefs = input.sourceRefs;
    proposal.concepts[0].sourceRefs = input.sourceRefs;
    proposal.reply = input.trigger.kind === 'send' ? reply : null;
    const use = (id, args = {}) => { proposal.next = { model: params.model, effort: null, reason: 'Choose a prepared cognitive ability.', capability: { id, args } }; };
    if (input.trigger.text === 'Learn a reusable sum script.') {
      if (!input.capabilityResult) use('Capability.create', { id: 'Script.sum', expectedVersion: 0,
        description: 'Sum numeric arrays', useWhen: 'Need a sum', avoidWhen: 'Not arbitrary precision', inputDescription: 'Number array', outputDescription: 'Total',
        code: 'return input.reduce((a,b)=>a+b,0);', tests: [{ input: [1, 2], expected: 3 }, { input: [], expected: 0 }] });
      else if (input.capabilityResult.published) use('Script.sum', { input: [5, 7] });
      else { expect(input.capabilityResult.output).toBe(12); proposal.reply = 'Learned a reusable sum; result 12.'; }
    } else if (input.trigger.text === 'Reuse the sum script.') {
      if (!input.capabilityResult) {
        expect(input.capabilities.active.find(c => c.id === 'Script.sum').availability.layer).toBe('familiar');
        use('Script.sum', { input: [8, 9] });
      } else { expect(input.capabilityResult.output).toBe(17); proposal.reply = 'Reused the saved sum; result 17.'; }
    } else if (!input.capabilityResult) {
      if (input.trigger.kind === 'send') use('Recall', { kind: 'messages' });
      if (input.trigger.kind === 'think') use('catalog.search', { query: '重新审视' });
      if (input.trigger.kind === 'dream') use('Skill.reconsider');
    } else if (input.capabilityResult.contracts) use('Skill.reconsider');
    yield { type: 'text_delta', text: JSON.stringify(proposal) };
    yield { type: 'stop', stopReason: 'end_turn' };
  } };
  const context = { agentId: mockAgent.agentId, CONFIG: { serverUrl, yeaftDir } };
  const makeBridge = () => createPersonBridge({ context, env, send: msg => mockAgent.send(msg),
    createService: options => createPersonService({ ...options, config, adapter, embedding: { enabled: false } }) });
  let bridge = makeBridge();
  const listener = msg => { if (msg.type === 'person_request') void bridge.request(msg); };
  mockAgent._messageHandlers.push(listener);
  try {
    await page.goto(serverUrl);
    // Finish registration/catalog initialization before updating capabilities;
    // otherwise the initial agent snapshot can overwrite the test's early update.
    await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(a => a.id === id && a.status === 'ready'), mockAgent.agentId);
    mockAgent.send({ type: 'agent_capabilities_updated', capabilities: ['digital_person', 'plaintext-ok'] });
    await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(a => a.id === id && a.capabilities?.includes('digital_person')), mockAgent.agentId);
    await page.locator('.sidebar-person-trigger:visible').click();
    await expect(page.locator('#person-input')).toBeEnabled();
    await page.locator('#person-input').fill('Recall our discussion about a curious digital person.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.person-messages')).toContainText(reply);
    await expect(page.locator('#person-input')).toBeEnabled();
    await page.getByRole('button', { name: 'Think', exact: true }).click();
    await expect.poll(() => calls).toBe(5);
    await expect(page.locator('#person-input')).toBeEnabled();
    await page.getByRole('button', { name: 'Thought journal', exact: true }).click();
    await expect(page.locator('#person-thoughts')).toContainText('Reconsider the available experience.');
    await expect(page.locator('#person-thoughts')).toContainText('A hypothesis is not a fact.');
    await expect(page.locator('#person-thoughts pre')).toHaveCount(0);
    expect(mockAgent.conversations.size).toBe(0);
    await bridge.close(); bridge = makeBridge();
    await page.reload();
    await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
    await page.locator('.sidebar-person-trigger:visible').click();
    await expect(page.locator('.person-messages')).toContainText(reply);
    await expect(page.locator('.person-status')).toContainText('Waiting for you');
    expect(calls).toBe(5);
    expect(requests[0].capabilities.active.find(c => c.id === 'Recall').availability.layer).toBe('foundation');
    expect(requests[3].capabilities.active.find(c => c.id === 'Skill.reconsider').availability.layer).toBe('discovered');
    await page.getByRole('button', { name: 'Dream', exact: true }).click();
    await expect.poll(() => calls).toBe(7);
    await expect(page.locator('#person-input')).toBeEnabled();
    expect(requests[5].capabilities.active.find(c => c.id === 'Skill.reconsider').availability.layer).toBe('familiar');
    await expect(page.locator('.session-sidebar-shell')).toHaveCount(0);
    await page.locator('#person-input').fill('Learn a reusable sum script.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    // Creation runs multiple fresh WASM workers plus cognition and snapshot polling.
    // Wait for the terminal reply, not the shorter single-UI-operation timeout.
    await expect(page.locator('.person-messages')).toContainText('Learned a reusable sum; result 12.', { timeout: 15000 });
    await expect(page.locator('#person-input')).toBeEnabled();
    expect(calls).toBe(10);
    await page.getByRole('button', { name: 'Thought journal', exact: true }).click();
    await expect(page.locator('#person-thoughts')).toContainText('Script.sum');
    await bridge.close(); bridge = makeBridge();
    await page.reload();
    await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
    await page.locator('.sidebar-person-trigger:visible').click();
    await expect(page.locator('#person-input')).toBeEnabled();
    expect(calls).toBe(10);
    await page.locator('#person-input').fill('Reuse the sum script.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.person-messages')).toContainText('Reused the saved sum; result 17.');
    await expect(page.locator('#person-input')).toBeEnabled();
    expect(calls).toBe(12);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Follow Agent model defaults').uncheck();
    await dialog.getByLabel('test/second', { exact: true }).check();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(calls).toBe(12); // Reading/saving candidates never starts cognition.
    await page.locator('input[type="file"]').setInputFiles({ name: 'reference.txt', mimeType: 'text/plain', buffer: Buffer.from('Private uploaded context marker.') });
    await expect(page.locator('.person-attachment-list')).toContainText('reference.txt');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => calls).toBe(14);
    await expect(page.locator('#person-input')).toBeEnabled();
    const attachmentCalls = requests.slice(-2);
    expect(requestedModels.slice(-2)).toEqual(['test/second', 'test/second']);
    for (const input of attachmentCalls) {
      expect(input.trigger.attachments[0]).toMatchObject({ name: 'reference.txt', content: 'Private uploaded context marker.', trust: 'untrusted-user-content' });
    }
    await expect(page.locator('.person-sent-files')).toContainText('reference.txt');
    await bridge.close(); bridge = makeBridge();
    await page.reload();
    await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
    await page.locator('.sidebar-person-trigger:visible').click();
    await expect(page.locator('#person-input')).toBeEnabled();
    await expect(page.locator('.person-sent-files')).toContainText('reference.txt');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('test/second', { exact: true })).toBeChecked();
    expect(calls).toBe(14);
  } finally {
    mockAgent._messageHandlers = mockAgent._messageHandlers.filter(h => h !== listener);
    await bridge.close();
    if (storage === 'mongodb') {
      const client = new MongoClient(uri);
      try { await client.connect(); await client.db(dbName).dropDatabase(); } finally { await client.close(); }
    }
    await rm(yeaftDir, { recursive: true, force: true });
  }
});
