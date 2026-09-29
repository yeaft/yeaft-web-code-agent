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
for (const storage of ['sqlite', 'mongodb']) test(`Person ${storage} conversation and Think persist through relay and restart`, async ({ page, serverUrl, mockAgent }) => {
  test.skip(storage === 'mongodb' && !uri, 'Requires an explicitly supplied isolated MongoDB replica set');
  const dbName = `person_e2e_${randomUUID().replaceAll('-', '')}`;
  const yeaftDir = await mkdtemp(join(tmpdir(), 'person-e2e-'));
  const env = storage === 'mongodb' ? { YEAFT_PERSON_MONGODB_URI: uri, YEAFT_PERSON_MONGODB_DB: dbName } : {};
  const reply = `Remembered in ${storage}.`;
  let calls = 0;
  const adapter = { async *stream(params) {
    calls++;
    const input = JSON.parse(params.messages[0].content);
    const proposal = finalProposal(input.state.version);
    proposal.concepts[0].expectedRevision = input.concepts.find(c => c.id === 'curiosity')?.revision || 0;
    proposal.activity.sourceRefs = input.sourceRefs;
    proposal.concepts[0].sourceRefs = input.sourceRefs;
    proposal.reply = input.trigger.kind === 'send' ? reply : null;
    yield { type: 'text_delta', text: JSON.stringify(proposal) };
    yield { type: 'stop', stopReason: 'end_turn' };
  } };
  const context = { agentId: mockAgent.agentId, CONFIG: { serverUrl, yeaftDir } };
  const makeBridge = () => createPersonBridge({ context, env, send: msg => mockAgent.send(msg),
    createService: options => createPersonService({ ...options, config, adapter }) });
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
    await expect.poll(() => calls).toBe(2);
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
    expect(calls).toBe(2);
    await expect(page.locator('.session-sidebar-shell')).toHaveCount(0);
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
