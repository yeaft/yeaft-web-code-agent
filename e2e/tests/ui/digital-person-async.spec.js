import { expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '../../fixtures/test-server.js';
import { createPersonBridge } from '../../../agent/yeaft/person/bridge.js';
import { createPersonService } from '../../../agent/yeaft/person/service.js';
import { config, finalProposal } from '../../../test/agent/yeaft/person/fixtures.js';

// Real browser/relay/SQLite/native child drivers and shell. Only inference is scripted.
test.use({ serverEnv: { SERVE_DIST: process.env.PERSON_UI_PRODUCTION || 'false' } });
test('Person runs parallel independent threads and collects background shell logs on the next message', async ({ page, serverUrl, mockAgent }) => {
  test.setTimeout(90000);
  const dir = await mkdtemp(join(tmpdir(), 'person-async-e2e-'));
  const children = [], childRequests = [], results = [];
  let parentCalls = 0, parallelCalls = 0, backgroundCalls = 0, inspectCalls = 0, taskId, release;
  const gate = new Promise(resolve => { release = resolve; });
  const adapter = { async *stream(params) {
    if (params.tools?.length) {
      childRequests.push(params);
      if (childRequests.length === 2) release();
      await gate;
      yield { type: 'text_delta', text: `Independent result ${childRequests.indexOf(params) + 1}` };
      yield { type: 'stop', stopReason: 'end_turn' };
      return;
    }
    parentCalls++;
    const input = JSON.parse(params.messages[0].content);
    const p = finalProposal(input.state.version);
    p.concepts = []; p.state.focusConceptIds = [];
    p.activity.sourceRefs = [input.trigger.ref];
    const use = (id, args) => { p.next = { model: params.model, effort: null, reason: 'Execute scoped task.', capability: { id, args } }; };
    if (input.trigger.text === 'Parallel work') {
      parallelCalls++;
      if (input.capabilityResult?.id === 'SpawnAgent' && typeof input.capabilityResult.output === 'string') children.push(JSON.parse(input.capabilityResult.output).agentId);
      if (input.capabilityResult?.id === 'WaitAgent' && typeof input.capabilityResult.output === 'string') results.push(JSON.parse(input.capabilityResult.output).result);
      switch (parallelCalls) {
        case 1: use('catalog.view', { id: 'SpawnAgent' }); break;
        case 2: use('SpawnAgent', { name: 'one', mission: 'Independent analysis one', persona: 'explorer' }); break;
        case 3: use('SpawnAgent', { name: 'two', mission: 'Independent analysis two', persona: 'explorer' }); break;
        case 4: use('catalog.view', { id: 'WaitAgent' }); break;
        case 5: use('WaitAgent', { agent_id: children[0], timeout_ms: 5000 }); break;
        case 6: use('WaitAgent', { agent_id: children[1], timeout_ms: 5000 }); break;
        default: p.reply = results.join('; ');
      }
    } else if (input.trigger.text === 'Background work') {
      backgroundCalls++;
      if (backgroundCalls === 1) use('catalog.view', { id: 'Bash' });
      else if (backgroundCalls === 2) use('Bash', {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(()=>console.log('durable shell result'),250)")}`, background: true,
      });
      else { taskId = input.capabilityResult.output.match(/Started background task (\S+)\./)[1]; p.reply = 'Started in background.'; }
    } else {
      inspectCalls++;
      switch (inspectCalls) {
        case 1: use('catalog.view', { id: 'WaitTask' }); break;
        case 2: use('WaitTask', { taskId, timeout_ms: 5000 }); break;
        case 3: use('catalog.view', { id: 'ReadTaskLog' }); break;
        case 4: use('ReadTaskLog', { taskId, offset: 0 }); break;
        default: p.reply = JSON.parse(input.capabilityResult.output).text;
      }
    }
    yield { type: 'text_delta', text: JSON.stringify(p) };
    yield { type: 'stop', stopReason: 'end_turn' };
  } };
  const bridge = createPersonBridge({ context: { agentId: mockAgent.agentId, CONFIG: { serverUrl, yeaftDir: dir, workDir: dir } },
    send: msg => mockAgent.send(msg),
    createService: options => createPersonService({ ...options, workDir: dir, config, adapter, embedding: { enabled: false } }),
  });
  const listener = msg => { if (msg.type === 'person_request') void bridge.request(msg); };
  mockAgent._messageHandlers.push(listener);
  try {
    await page.goto(serverUrl);
    await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(a => a.id === id && a.status === 'ready'), mockAgent.agentId);
    mockAgent.send({ type: 'agent_capabilities_updated', capabilities: ['digital_person', 'plaintext-ok'] });
    await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(a => a.id === id && a.capabilities?.includes('digital_person')), mockAgent.agentId);
    await page.evaluate(id => window.Pinia.useChatStore().setDigitalPersonUiEnabled(true, id), mockAgent.agentId);
    await page.locator('.sidebar-person-trigger:visible').click();
    const send = async text => {
      await expect(page.locator('#person-input')).toBeEnabled();
      await page.locator('#person-input').fill(text);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
    };
    await send('Parallel work');
    await expect(page.locator('.person-messages')).toContainText('Independent result 1; Independent result 2', { timeout: 20000 });
    expect(childRequests).toHaveLength(2);
    expect(new Set(children).size).toBe(2);
    await send('Background work');
    await expect(page.locator('.person-messages')).toContainText('Started in background.', { timeout: 20000 });
    await expect(page.locator('#person-input')).toBeEnabled();
    const callsAfterCommit = parentCalls;
    await page.waitForTimeout(500);
    expect(parentCalls).toBe(callsAfterCommit); // no implicit cognition on completion
    await send('Inspect background');
    await expect(page.locator('.person-messages')).toContainText('durable shell result', { timeout: 20000 });
    expect(mockAgent.conversations.size).toBe(0);
    await expect(page.locator('.person-messages')).not.toContainText('Activity details');
  } finally {
    mockAgent._messageHandlers.splice(mockAgent._messageHandlers.indexOf(listener), 1);
    release();
    await bridge.close();
    await rm(dir, { recursive: true, force: true });
  }
});
