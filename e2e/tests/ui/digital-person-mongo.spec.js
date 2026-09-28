import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { test } from '../../fixtures/test-server.js';
import { createPersonBridge } from '../../../agent/yeaft/person/bridge.js';
import { createPersonService } from '../../../agent/yeaft/person/service.js';
import { config, finalProposal } from '../../../test/agent/yeaft/person/fixtures.js';

// Real browser -> isolated Server -> Agent bridge -> MongoDB. Only inference is scripted.
// No live Agent, native config or paid provider is used; all data lives in a random test DB.
const uri = process.env.PERSON_TEST_MONGO_URI;
test('Person conversation and Think persist through the actual relay and a service restart', async ({ page, serverUrl, mockAgent }) => {
  test.skip(!uri, 'Requires an explicitly supplied isolated MongoDB replica set');
  const dbName = `person_e2e_${randomUUID().replaceAll('-', '')}`;
  const env = { YEAFT_PERSON_MONGODB_URI: uri, YEAFT_PERSON_MONGODB_DB: dbName };
  let calls = 0;
  const adapter = { async *stream(params) {
    calls++;
    const input = JSON.parse(params.messages[0].content);
    const proposal = finalProposal(input.state.version);
    proposal.concepts[0].expectedRevision = input.concepts.find(c => c.id === 'curiosity')?.revision || 0;
    proposal.activity.sourceRefs = input.sourceRefs;
    proposal.concepts[0].sourceRefs = input.sourceRefs;
    proposal.reply = input.trigger.kind === 'send' ? 'Remembered in MongoDB.' : null;
    yield { type: 'text_delta', text: JSON.stringify(proposal) };
    yield { type: 'stop', stopReason: 'end_turn' };
  } };
  const context = { agentId: mockAgent.agentId, CONFIG: { serverUrl, yeaftDir: '/unused-test-instance' } };
  const makeBridge = () => createPersonBridge({ context, env, send: msg => mockAgent.send(msg),
    createService: options => createPersonService({ ...options, config, adapter }) });
  let bridge = makeBridge();
  const listener = msg => { if (msg.type === 'person_request') void bridge.request(msg); };
  mockAgent._messageHandlers.push(listener);
  mockAgent.send({ type: 'agent_capabilities_updated', capabilities: ['digital_person', 'plaintext-ok'] });
  try {
    await page.goto(serverUrl);
    await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(a => a.id === id && a.capabilities?.includes('digital_person')), mockAgent.agentId);
    await page.locator('.sidebar-person-trigger:visible').click();
    await expect(page.locator('#person-input')).toBeEnabled();
    await page.locator('#person-input').fill('Recall our discussion about a curious digital person.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.person-messages')).toContainText('Remembered in MongoDB.');
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
    await expect(page.locator('.person-messages')).toContainText('Remembered in MongoDB.');
    await expect(page.locator('.person-status')).toContainText('Ready');
    expect(calls).toBe(2);
    await expect(page.locator('.session-sidebar-shell')).toHaveCount(0);
  } finally {
    mockAgent._messageHandlers = mockAgent._messageHandlers.filter(h => h !== listener);
    await bridge.close();
    const client = new MongoClient(uri);
    try { await client.connect(); await client.db(dbName).dropDatabase(); } finally { await client.close(); }
  }
});
