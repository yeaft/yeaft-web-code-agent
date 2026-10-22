import { expect } from '@playwright/test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from '../../fixtures/test-server.js';
import { personInput, personCognition, personToolResults, personToolCall, personStop, personGoal } from '../../fixtures/person-provider.js';
import { createPersonBridge } from '../../../agent/yeaft/person/bridge.js';
import { createPersonService } from '../../../agent/yeaft/person/service.js';
import { config, finalProposal } from '../../../test/agent/yeaft/person/fixtures.js';

// Real browser/relay/SQLite/native child drivers and shell. Only inference is scripted.
test.use({ serverEnv: { SERVE_DIST: process.env.PERSON_UI_PRODUCTION || 'false' } });
test('Person joins parallel work and background results; Management controls pending executions', async ({ page, serverUrl, mockAgent }, testInfo) => {
  test.setTimeout(90000);
  const dir = await mkdtemp(join(tmpdir(), 'person-async-e2e-'));
  const children = [], childRequests = [], results = [];
  const observations = new Map(), readyEpisodes = new Set();
  let service;
  let parentCalls = 0, pauseCalls = 0, cancelCalls = 0, taskId, longTaskId, release, releaseMain, releaseCancel;
  const mainGate = new Promise(resolve => { releaseMain = resolve; });
  const cancelGate = new Promise(resolve => { releaseCancel = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const adapter = { async *stream(params) {
    await setImmediate(); // Model I/O yields to the relay and native workers.
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
    // The bounded transcript may retire older groups after the waiting milestone.
    // Retain only actual operation results already seen by this scripted model,
    // never count goal reports/recovery reads as another shell/spawn operation.
    const key = input.trigger.ref;
    if (!observations.has(key)) observations.set(key, new Map());
    const observed = observations.get(key);
    for (const result of personToolResults(params)) observed.set(result.executionTraceCallId ?? result.toolUseId, result);
    const resultsSoFar = [...observed.values()];
    const use = (id, args, providerId = id) => personToolCall(providerId, id, args);
    const text = input.trigger.text;
    if (text === 'Pause main') pauseCalls++;
    if (text === 'Cancel main') { cancelCalls++; await cancelGate; }
    if (!personCognition(params)) {
      const batch = [];
      const acceptance = text === 'Long background' ? 'Collect the terminal shell status and logs, including an explicit owner stop for the long-running task.'
        : text === 'Parallel work' ? 'Join both independent children and collect their actual reports.'
          : text === 'Pause main' ? 'Resume the same request without replay and read a messages recall page.' : 'Join the shell task and verify its durable log.';
      if (!resultsSoFar.length && ['Parallel work', 'Background work', 'Long background'].includes(text)) {
        const goal = personGoal(params, { objective: text, acceptance, status: 'active' });
        if (goal) { yield goal; yield personStop(true); return; }
      }
      if (text === 'Parallel work') {
        for (const r of resultsSoFar.filter(r => r.id === 'SpawnAgent')) {
          const id = JSON.parse(r.output).agentId;
          if (!children.includes(id)) children.push(id);
        }
        if (!resultsSoFar.length) batch.push(use('SpawnAgent', { name: 'one', mission: 'Independent analysis one', persona: 'explorer' }, 'spawn-one'),
          use('SpawnAgent', { name: 'two', mission: 'Independent analysis two', persona: 'explorer' }, 'spawn-two'));
        else if (resultsSoFar.length === 2) batch.push(use('WaitAgent', { agent_id: children[0], timeout_ms: 5000 }, 'wait-one'), use('WaitAgent', { agent_id: children[1], timeout_ms: 5000 }, 'wait-two'));
        else {
          const collected = resultsSoFar.filter(r => r.id === 'WaitAgent').map(r => JSON.parse(r.output));
          expect(collected.map(result => result.result)).toEqual(['Independent result 1', 'Independent result 2']);
          results.splice(0, results.length, ...collected.map(result => result.result));
        }
      } else if (text === 'Background work' || text === 'Long background') {
        if (!resultsSoFar.length) batch.push(use('Bash', {
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(text === 'Long background' ? "console.log('long task ready');setInterval(()=>{},1000)" : "setTimeout(()=>console.log('durable shell result'),250)")}`, background: true,
        }));
        else {
          const id = resultsSoFar[0].output.match(/Started background task (\S+)\./)[1];
          if (text === 'Long background') longTaskId = id;
          else taskId = id;
          // The host-ready capsule may retire after later groups; this model
          // already observed it and must not re-enter waiting after completion.
          if (params.messages.some(message => message.role === 'user' && message.content.includes('execution-results-ready'))) readyEpisodes.add(key);
          const waiting = readyEpisodes.has(key);
          if (text === 'Long background' && !waiting) {
            batch.push(personGoal(params, {
              objective: text, acceptance,
              status: 'waiting', waitFor: [id],
            }));
          } else if (resultsSoFar.length === 1) batch.push(use('WaitTask', { taskId: id, timeout_ms: 5000 }));
          else if (resultsSoFar.length === 2) {
            expect(JSON.parse(resultsSoFar[1].output)).toMatchObject({ taskId: id, terminal: true, timedOut: false,
              status: text === 'Long background' ? 'cancelled' : 'succeeded' });
            batch.push(use('ReadTaskLog', { taskId: id, offset: 0 }));
          } else {
            expect(JSON.parse(resultsSoFar.at(-1).output).text).toContain(text === 'Long background' ? 'long task ready' : 'durable shell result');
          }
        }
      } else if (text === 'Pause main') {
        if (pauseCalls === 1) { await mainGate; batch.push(use('Recall', { kind: 'messages' })); }
        else {
          expect(resultsSoFar.at(-1)).toMatchObject({ kind: 'messages' });
          expect(Array.isArray(resultsSoFar.at(-1).items)).toBe(true);
        }
      } else if (text === 'Cancel main') {
        batch.push(use('FileWrite', { file_path: join(dir, 'must-not-write'), content: 'cancelled' }));
      } else {
        if (!resultsSoFar.length) batch.push(use('WaitTask', { taskId, timeout_ms: 5000 }));
        else if (resultsSoFar.length === 1) batch.push(use('ReadTaskLog', { taskId, offset: 0 }));
        else expect(JSON.parse(resultsSoFar.at(-1).output).text).toContain('durable shell result');
      }
      if (!batch.length) {
        const expectedOperations = text === 'Parallel work' ? ['SpawnAgent', 'SpawnAgent', 'WaitAgent', 'WaitAgent']
          : text === 'Background work' || text === 'Long background' ? ['Bash', 'WaitTask', 'ReadTaskLog']
            : text === 'Pause main' ? ['Recall'] : ['WaitTask', 'ReadTaskLog'];
        expect(resultsSoFar.map(result => result.kind === 'messages' ? 'Recall' : result.id)).toEqual(expectedOperations);
        const goal = personGoal(params, {
          objective: text,
          acceptance,
          check: text === 'Long background' ? 'WaitTask confirmed owner cancellation; ReadTaskLog returned long task ready.'
            : text === 'Parallel work' ? 'Both WaitAgent results contain the two expected independent reports.'
              : text === 'Pause main' ? 'The resumed execution returned the structured messages Recall page.' : 'The shell task is terminal and its collected log contains durable shell result.',
        });
        if (goal) batch.push(goal);
      }
      for (const event of batch) yield event;
      if (!batch.length) yield { type: 'text_delta', text: 'Execution complete.' };
      yield personStop(batch.length > 0);
      return;
    }
    const p = finalProposal(input.state.version);
    p.concepts = []; p.state.focusConceptIds = []; p.activity.sourceRefs = [input.trigger.ref];
    if (text === 'Parallel work') p.reply = results.join('; ');
    else if (text === 'Background work') p.reply = 'Background finished; durable shell result collected.';
    else if (text === 'Long background') p.reply = 'Long task stopped; ready log collected.';
    else if (text === 'Pause main') p.reply = 'Resumed the same main execution.';
    else p.reply = JSON.parse(resultsSoFar.at(-1).output).text;
    yield { type: 'text_delta', text: JSON.stringify(p) };
    yield personStop(false);
  } };
  const bridge = createPersonBridge({ context: { agentId: mockAgent.agentId, CONFIG: { serverUrl, yeaftDir: dir, workDir: dir } },
    send: msg => mockAgent.send(msg),
    createService: options => (service = createPersonService({ ...options, workDir: dir, config, adapter, embedding: { enabled: false } })),
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
      // These are independent sequential execution scenarios. An enabled inbox
      // no longer implies the previous episode has committed; wait for its real
      // terminal UI state rather than accidentally append to the scripted goal.
      await expect(page.locator('.person-composer').getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      const ownerId = mockAgent.messages('person_request')[0]?.ownerId;
      // A final reply may precede cognition commit. These fixtures intentionally
      // start distinct episodes; use persisted activity, not text visibility.
      await expect.poll(async () => {
        try { return (await service.request({ ownerId, op: 'snapshot' })).busy; }
        catch (error) { if (error.code === 'NOT_OPEN') return null; throw error; }
      }).toBe(false);
      await expect(page.locator('#person-input')).toBeEnabled();
      await page.locator('#person-input').fill(text);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      // Clearing follows the admission ACK. Without this, an assertion matching
      // a previous reply can race ahead before the new Stop target is installed.
      await expect(page.locator('#person-input')).toHaveValue('');
    };
    await send('Parallel work');
    await expect(page.locator('.person-messages')).toContainText('Independent result 1; Independent result 2', { timeout: 20000 });
    expect(childRequests).toHaveLength(2);
    expect(new Set(children).size).toBe(2);
    await send('Background work');
    await expect(page.locator('.person-messages')).toContainText('Background finished; durable shell result collected.', { timeout: 20000 });
    await expect(page.locator('#person-input')).toBeEnabled();
    const callsAfterCommit = parentCalls;
    await page.waitForTimeout(500);
    expect(parentCalls).toBe(callsAfterCommit); // no implicit cognition on completion
    await send('Inspect background');
    await expect(page.locator('.person-messages')).toContainText('durable shell result', { timeout: 20000 });
    expect(mockAgent.conversations.size).toBe(0);
    await expect(page.locator('.person-messages')).not.toContainText('Activity details');
    await send('Long background');
    await expect(page.locator('#person-input')).toBeEnabled();
    await expect.poll(() => longTaskId).toBeTruthy();
    await page.locator('.person-thoughts-button').click();
    await page.locator('.person-inspector-nav').getByRole('button', { name: 'Management', exact: true }).click();
    await expect(page.locator('.person-task-browser')).toContainText('Background tasks');
    await expect(page.locator('.person-task-browser')).toContainText('Child threads');
    await expect(page.locator('.person-task-item')).toHaveCount(4);
    const main = page.getByRole('region', { name: 'Main execution', exact: true });
    const active = page.locator('.person-task-item').filter({ has: page.getByRole('button', { name: 'Stop', exact: true }) });
    await expect(active).toHaveCount(1);
    await expect(main).toContainText('Waiting');
    const waitingEpisode = await main.getAttribute('data-episode-id');
    const waitingCalls = parentCalls;
    await active.getByRole('button', { name: 'View log', exact: true }).click();
    await expect(page.locator('.person-task-log pre')).toContainText('long task ready');
    await page.waitForTimeout(1100);
    expect(parentCalls).toBe(waitingCalls); // Host wait, not model polling or early cognition.
    expect(await main.getAttribute('data-episode-id')).toBe(waitingEpisode);
    await expect(page.locator('.person-messages')).not.toContainText('Long task stopped; ready log collected.');
    await active.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(active).toContainText('Stop this task?');
    await active.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('.person-messages')).toContainText('Long task stopped; ready log collected.', { timeout: 20000 });
    await expect(main).toContainText('No live main execution.');
    await expect(page.locator('.person-task-browser').getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    // Main and independently owned work share one Management surface. Pause
    // must wait for the in-flight request without replaying it on resume.
    await page.locator('.person-panel-header .header-action-btn').click();
    await send('Pause main');
    await expect.poll(() => pauseCalls).toBe(1);
    await page.locator('.person-thoughts-button').click();
    await page.locator('.person-inspector-nav').getByRole('button', { name: 'Management', exact: true }).click();
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
    expect(pauseCalls).toBeGreaterThan(1); // Goal/evidence bookkeeping adds requests, never another Recall.
    const resumed = [...observations.values()].map(items => [...items.values()]).find(items => items.some(result => result.kind === 'messages'));
    expect(resumed).toHaveLength(1);
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
    const beforeInspection = parentCalls;
    await page.locator('.person-panel-header .header-action-btn').click();
    await page.locator('#person-input').fill('Keep this draft');
    await page.locator('.person-thoughts-button').click();
    await page.locator('.person-inspector-nav').getByRole('button', { name: 'Management', exact: true }).click();
    await expect(page.locator('.person-task-item')).toHaveCount(4);
    await page.locator('.person-task-item').filter({ hasText: 'Shell task' }).first().getByRole('button', { name: 'View log', exact: true }).click();
    await expect(page.locator('.person-task-log pre')).toContainText(/long task ready|durable shell result/);
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
