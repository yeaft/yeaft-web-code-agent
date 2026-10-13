import { expect } from '@playwright/test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '../../fixtures/test-server.js';
import { personInput, personCognition, personToolResults, personToolCall, personStop } from '../../fixtures/person-provider.js';
import { createPersonBridge } from '../../../agent/yeaft/person/bridge.js';
import { createPersonService } from '../../../agent/yeaft/person/service.js';
import { config, finalProposal } from '../../../test/agent/yeaft/person/fixtures.js';

// Real browser/relay/SQLite/native child drivers and shell. Only inference is scripted.
test.use({ serverEnv: { SERVE_DIST: process.env.PERSON_UI_PRODUCTION || 'false' } });
test('Person runs parallel independent threads and collects background shell logs on the next message', async ({ page, serverUrl, mockAgent }, testInfo) => {
  test.setTimeout(90000);
  const dir = await mkdtemp(join(tmpdir(), 'person-async-e2e-'));
  const children = [], childRequests = [], results = [];
  let parentCalls = 0, parallelCalls = 0, backgroundCalls = 0, inspectCalls = 0, pauseCalls = 0, cancelCalls = 0, taskId, release, releaseMain, releaseCancel;
  const mainGate = new Promise(resolve => { releaseMain = resolve; });
  const cancelGate = new Promise(resolve => { releaseCancel = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const adapter = { async *stream(params) {
    let input;
    try { input = personInput(params); } catch {}
    // Native child Engine requests have natural-language input, not Person triggers.
    if (!input?.trigger) {
      childRequests.push(params);
      if (childRequests.length === 2) release();
      await gate;
      yield { type: 'text_delta', text: `Independent result ${childRequests.indexOf(params) + 1}` };
      yield personStop(false);
      return;
    }
    parentCalls++;
    const resultsSoFar = personToolResults(params);
    const use = (id, args, providerId = id) => personToolCall(providerId, id, args);
    const text = input.trigger.text;
    if (text === 'Pause main') pauseCalls++;
    if (text === 'Cancel main') { cancelCalls++; await cancelGate; }
    if (!personCognition(params)) {
      const batch = [];
      if (text === 'Parallel work') {
        parallelCalls++;
        for (const r of resultsSoFar.filter(r => r.id === 'SpawnAgent')) {
          const id = JSON.parse(r.output).agentId;
          if (!children.includes(id)) children.push(id);
        }
        if (!resultsSoFar.length) batch.push(use('SpawnAgent', { name: 'one', mission: 'Independent analysis one', persona: 'explorer' }, 'spawn-one'),
          use('SpawnAgent', { name: 'two', mission: 'Independent analysis two', persona: 'explorer' }, 'spawn-two'));
        else if (resultsSoFar.length === 2) batch.push(use('WaitAgent', { agent_id: children[0], timeout_ms: 5000 }, 'wait-one'), use('WaitAgent', { agent_id: children[1], timeout_ms: 5000 }, 'wait-two'));
        else results.splice(0, results.length, ...resultsSoFar.filter(r => r.id === 'WaitAgent').map(r => JSON.parse(r.output).result));
      } else if (text === 'Background work' || text === 'Long background') {
        backgroundCalls++;
        if (!resultsSoFar.length) batch.push(use('Bash', {
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(text === 'Long background' ? "console.log('long task ready');setInterval(()=>{},1000)" : "setTimeout(()=>console.log('durable shell result'),250)")}`, background: true,
        }));
        else if (text === 'Background work') taskId = resultsSoFar[0].output.match(/Started background task (\S+)\./)[1];
      } else if (text === 'Pause main') {
        if (pauseCalls === 1) { await mainGate; batch.push(use('Recall', { kind: 'messages' })); }
      } else if (text === 'Cancel main') {
        batch.push(use('FileWrite', { file_path: join(dir, 'must-not-write'), content: 'cancelled' }));
      } else {
        inspectCalls++;
        if (!resultsSoFar.length) batch.push(use('WaitTask', { taskId, timeout_ms: 5000 }));
        else if (resultsSoFar.length === 1) batch.push(use('ReadTaskLog', { taskId, offset: 0 }));
      }
      for (const event of batch) yield event;
      if (!batch.length) yield { type: 'text_delta', text: 'Execution complete.' };
      yield personStop(batch.length > 0);
      return;
    }
    const p = finalProposal(input.state.version);
    p.concepts = []; p.state.focusConceptIds = []; p.activity.sourceRefs = [input.trigger.ref];
    if (text === 'Parallel work') p.reply = results.join('; ');
    else if (text === 'Background work') p.reply = 'Started in background.';
    else if (text === 'Long background') p.reply = 'Long task started.';
    else if (text === 'Pause main') p.reply = 'Resumed the same main execution.';
    else p.reply = JSON.parse(resultsSoFar.at(-1).output).text;
    yield { type: 'text_delta', text: JSON.stringify(p) };
    yield personStop(false);
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
    await send('Long background');
    await expect(page.locator('.person-messages')).toContainText('Long task started.', { timeout: 20000 });
    await page.locator('#person-input').fill('Keep this draft');
    let beforeInspection = parentCalls;
    await page.locator('.person-thoughts-button').click();
    await page.locator('.person-inspector-nav').getByRole('button', { name: 'Management', exact: true }).click();
    await expect(page.locator('.person-task-browser')).toContainText('Background tasks');
    await expect(page.locator('.person-task-browser')).toContainText('Child threads');
    await expect(page.locator('.person-task-item')).toHaveCount(4);
    const active = page.locator('.person-task-item').filter({ has: page.getByRole('button', { name: 'Stop', exact: true }) });
    await expect(active).toHaveCount(1);
    // Main and independently owned work share one Management surface. Pause
    // must wait for the in-flight request without replaying it on resume.
    await page.locator('.person-panel-header .header-action-btn').click();
    await send('Pause main');
    await expect.poll(() => pauseCalls).toBe(1);
    await page.locator('.person-thoughts-button').click();
    await page.locator('.person-inspector-nav').getByRole('button', { name: 'Management', exact: true }).click();
    const main = page.locator('.person-main-execution');
    await expect(main).toContainText('Requesting model');
    await expect(main.locator('.person-execution-models')).toContainText('—');
    const episodeId = await main.getAttribute('data-episode-id');
    await main.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(main).toContainText('Pausing at the next safe boundary');
    await expect(main.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
    expect(pauseCalls).toBe(1);
    releaseMain();
    await expect(main.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
    expect(await main.getAttribute('data-episode-id')).toBe(episodeId);
    expect(pauseCalls).toBe(1);
    await expect(page.locator('.person-task-item')).toHaveCount(4);
    await page.screenshot({ path: testInfo.outputPath('person-management-light.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 680 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('person-management-light-mobile.png'), fullPage: true });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('person-management-dark-mobile.png'), fullPage: true });
    await main.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('.person-messages')).toContainText('Resumed the same main execution.');
    await expect(main).toContainText('No live main execution.');
    expect(pauseCalls).toBe(3);
    await page.locator('.person-panel-header .header-action-btn').click();
    await send('Cancel main');
    await expect.poll(() => cancelCalls).toBe(1);
    await page.locator('.person-thoughts-button').click();
    await page.locator('.person-inspector-nav').getByRole('button', { name: 'Management', exact: true }).click();
    await main.locator('[data-execution-control="cancel"]').click();
    await expect(main).toContainText('Cancel this main execution?');
    await main.locator('[data-execution-control="confirm-cancel"]').click();
    releaseCancel();
    await expect(main).toContainText('No live main execution.');
    expect(cancelCalls).toBe(1);
    await expect(access(join(dir, 'must-not-write'))).rejects.toMatchObject({ code: 'ENOENT' });
    beforeInspection = parentCalls;
    await page.locator('.person-panel-header .header-action-btn').click();
    await page.locator('#person-input').fill('Keep this draft');
    await page.locator('.person-thoughts-button').click();
    await page.locator('.person-inspector-nav').getByRole('button', { name: 'Management', exact: true }).click();
    await active.getByRole('button', { name: 'View log', exact: true }).click();
    await expect(page.locator('.person-task-log pre')).toContainText('long task ready');
    await active.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(active).toContainText('Stop this task?');
    await active.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('.person-task-browser').getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    expect(parentCalls).toBe(beforeInspection);
    await expect(page.locator('#person-input')).toHaveValue('Keep this draft');
    await page.setViewportSize({ width: 320, height: 680 });
    await page.locator('.person-task-browser .person-journal-scroll').focus();
    await page.keyboard.press('End');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    mockAgent._messageHandlers.splice(mockAgent._messageHandlers.indexOf(listener), 1);
    release(); releaseMain(); releaseCancel();
    await bridge.close();
    await rm(dir, { recursive: true, force: true });
  }
});
