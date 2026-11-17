import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test as base, useMockAgent } from '../../fixtures/test-server.js';
import { MockAgent } from '../../fixtures/mock-agent.js';
import { personInput, personCognition, personToolCall, personStop } from '../../fixtures/person-provider.js';
import { clickPersonAction } from '../../helpers/person-actions.js';
import { createPersonBridge } from '../../../agent/yeaft/person/bridge.js';
import { createPersonService } from '../../../agent/yeaft/person/service.js';
import { config, finalProposal, goalInput } from '../../../test/agent/yeaft/person/fixtures.js';

// Real owner authentication, Server relay, Person runtime and SQLite. Only model
// inference is scripted. No conversation/store arrays or protocol replies are injected.
const test = base.extend({
  owner: async ({ serverUrl }, use) => {
    const username = `parallel_${randomUUID().slice(0, 8)}`, password = randomUUID();
    const post = async (path, body) => (await fetch(`${serverUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json();
    expect(await post('/api/auth/register', { username, password })).toMatchObject({ success: true });
    const login = await post('/api/auth/login', { username, password });
    expect(login).toMatchObject({ success: true, needTotpCode: false, needTotpSetup: false, needEmailCode: false });
    const secret = await (await fetch(`${serverUrl}/api/user/agent-secret`, { headers: { Authorization: `Bearer ${login.token}` } })).json();
    expect(secret, JSON.stringify(secret)).toHaveProperty('agentSecret');
    await use({ ...login, secret: secret.agentSecret });
  },
  mockAgent: async ({ serverUrl, owner }, use) => {
    const agent = new MockAgent(serverUrl);
    const send = agent.send.bind(agent);
    agent.send = message => send(message.type === 'auth' ? { ...message, secret: owner.secret, capabilities: [...message.capabilities, 'digital_person'] } : message);
    await useMockAgent(agent, use);
  },
});
test.use({ serverEnv: { SKIP_AUTH: 'false', TOTP_ENABLED: 'false', JWT_SECRET: 'isolated-person-parallel-browser-test-secret', SERVE_DIST: process.env.PERSON_UI_PRODUCTION || 'false' } });

for (const scenario of [{ width: 1600, theme: 'light', panel: 'inside' }, { width: 1600, theme: 'dark', panel: 'outputs' }, { width: 320, theme: 'dark', panel: 'outputs' }]) {
  test(`Person parallel turns survive reload, independently stop and collapse only on split (${scenario.theme}, ${scenario.width}px)`, async ({ page, serverUrl, mockAgent, owner, testServer }, testInfo) => {
    test.setTimeout(90000);
    const browserLog = [], serverLog = [];
    page.on('console', message => browserLog.push(message.text()));
    page.on('pageerror', error => browserLog.push(error.stack));
    testServer.process.stdout.on('data', data => serverLog.push(data.toString()));
    testServer.process.stderr.on('data', data => serverLog.push(data.toString()));
    const dir = await mkdtemp(join(tmpdir(), 'person-parallel-browser-'));
    const requests = [], responses = [], calls = [], routes = [], gates = new Map(), started = new Set();
    const texts = Array.from({ length: 5 }, (_, i) => `Independent question ${i + 1}: describe public result ${i + 1}.`);
    const supplement = 'Supplement the first question with a concise answer.';
    const privateMarker = 'PRIVATE_PROVIDER_REASONING_MUST_NOT_LEAK';
    let service;
    const hold = key => {
      if (!gates.has(key)) {
        let release;
        const promise = new Promise(resolve => { release = resolve; });
        gates.set(key, { promise, release });
      }
      return gates.get(key).promise;
    };
    let first;
    const adapter = { async *stream(params) {
      if (params.maxTokens === 256) {
        const route = JSON.parse(params.messages[0].content);
        routes.push(route);
        expect(params.tools).toEqual([]);
        expect(JSON.stringify(route)).not.toContain(privateMarker);
        const related = route.newQuery === supplement;
        yield { type: 'text_delta', text: JSON.stringify({ decision: related ? 'related' : 'unrelated', targetThreadId: related ? first.episodeId : null, title: 'Independent public question' }) };
        yield personStop(false); return;
      }
      calls.push(params);
      const input = personInput(params), key = input.trigger.text;
      expect(texts).toContain(key);
      if (personCognition(params)) {
        const rebase = params.messages.map(message => { try { return JSON.parse(message.content); } catch { return {}; } }).findLast(value => value.phase === 'cognition-rebase');
        const proposal = finalProposal(rebase?.baseStateVersion ?? input.state.version);
        proposal.concepts = []; proposal.state.focusConceptIds = []; proposal.reply = null;
        yield { type: 'text_delta', text: JSON.stringify(proposal) }; yield personStop(false); return;
      }
      if (!started.has(key)) {
        started.add(key);
        yield { type: 'thinking_delta', text: privateMarker };
        await hold(key);
      }
      const results = params.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      if (!results.some(result => result.id === 'Execution.goal' && result.ok)) {
        yield personToolCall('answer-goal', 'Execution.goal', goalInput([input.trigger.ref], { objective: key, acceptance: 'Return the requested public answer.' }));
        yield personStop(true);
      } else {
        yield { type: 'text_delta', text: `Public answer ${texts.indexOf(key) + 1}.` }; yield personStop(false);
      }
    } };
    const bridge = createPersonBridge({
      context: { agentId: mockAgent.agentId, CONFIG: { serverUrl, yeaftDir: dir, workDir: dir } },
      send: message => { responses.push(message); return mockAgent.send(message); },
      createService: options => (service = createPersonService({ ...options, workDir: dir, config, adapter, embedding: { enabled: false } })),
    });
    const listener = message => { if (message.type === 'person_request') { requests.push(message); void bridge.request(message); } };
    mockAgent._messageHandlers.push(listener);
    const snapshot = () => service.request({ ownerId: owner.userId, op: 'snapshot' });
    const records = table => {
      const db = new DatabaseSync(join(dir, 'person', 'person.db'), { readOnly: true });
      try { return db.prepare(`SELECT record FROM ${table}`).all().map(row => JSON.parse(row.record)); } finally { db.close(); }
    };
    const screenshot = async name => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const path = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(name, { path, contentType: 'image/png' });
    };
    const pane = id => page.locator(`.parallel-turn-pane[data-user-turn-id="${id}"]`);
    const panel = page.locator('#person-side-panel');
    const send = async text => {
      const count = requests.filter(request => request.op === 'send').length;
      await page.locator('#person-input').fill(text);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => {
        const request = requests.filter(request => request.op === 'send')[count];
        return responses.find(response => response.requestId === request?.requestId)?.ok;
      }).toBe(true);
      const request = requests.filter(request => request.op === 'send')[count];
      expect(request.ownerId).toBe(owner.userId);
      return responses.find(response => response.requestId === request.requestId).data;
    };
    try {
      await page.setViewportSize({ width: scenario.width, height: 900 });
      await page.addInitScript(({ theme, token }) => {
        localStorage.setItem('locale', 'en'); localStorage.setItem('theme', theme); localStorage.setItem('authToken', token);
      }, { ...scenario, token: owner.token });
      await page.goto(serverUrl);
      await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === id && agent.status === 'ready'), mockAgent.agentId);
      await page.waitForFunction(id => window.Pinia.useChatStore().agents.some(agent => agent.id === id && agent.capabilities?.includes('digital_person')), mockAgent.agentId);
      await page.evaluate(id => window.Pinia.useChatStore().setDigitalPersonUiEnabled(true, id), mockAgent.agentId);
      if (scenario.width <= 768) await page.locator('.header-sidebar-toggle').click();
      await page.locator('.sidebar-person-trigger:visible').click();
      first = await send(texts[0]);
      await expect.poll(() => started.has(texts[0])).toBe(true);
      await clickPersonAction(page, scenario.panel);
      await expect(panel).toBeVisible();
      // Compact inspectors are modal and cannot coexist with composition. Desktop
      // keeps the inspector open so split admission itself must dismiss it.
      if (scenario.width === 320) await panel.getByRole('button', { name: /^Close(?: reader)?$/ }).click();
      const second = await send(texts[1]);
      await expect(page.locator('.parallel-turn-pane')).toHaveCount(2);
      await expect(panel).toHaveCount(0);
      await clickPersonAction(page, scenario.panel);
      await expect(panel).toBeVisible();
      if (scenario.width === 320) await panel.getByRole('button', { name: /^Close(?: reader)?$/ }).click();
      const addendum = await send(supplement);
      expect(addendum).toMatchObject({ episodeId: first.episodeId, rootMessageId: first.messageId, deliveryState: 'queued' });
      if (scenario.width === 1600) await expect(panel).toBeVisible();
      const turns = [first, second];
      for (const text of texts.slice(2)) turns.push(await send(text));
      await expect(page.locator('.parallel-turn-pane')).toHaveCount(5);
      if (scenario.width === 1600) {
        await expect(panel, 'Manually reopened inspector must survive new sibling admissions').toBeVisible();
        await panel.getByRole('button', { name: /^Close(?: reader)?$/ }).click();
      }
      expect(new Set(turns.map(turn => turn.episodeId)).size).toBe(5);
      expect(records('episodes')).toHaveLength(5);
      expect((await snapshot()).activeEpisodes).toHaveLength(5);
      const tabs = page.locator('.parallel-turn-tabs [role="tab"]');
      await tabs.first().focus(); await tabs.first().press('End');
      await expect(tabs.last()).toBeFocused(); await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
      await expect(pane(turns[4].episodeId)).toBeInViewport();
      const geometry = await page.locator('.parallel-turn-track').evaluate(track => {
        const bounds = track.getBoundingClientRect();
        return { width: bounds.width, gap: parseFloat(getComputedStyle(track).columnGap) || 0, panes: [...track.children].map(node => node.getBoundingClientRect().width) };
      });
      expect(geometry.panes.every(width => width >= (geometry.width - 2 * geometry.gap) / 3 - 2)).toBe(true);
      if (scenario.width === 320) expect(geometry.panes.every(width => Math.abs(width - geometry.width) < 3)).toBe(true);
      await screenshot('five-active-keyboard-last');
      await page.reload();
      await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === id && agent.status === 'ready'), mockAgent.agentId);
      if (scenario.width <= 768) await page.locator('.header-sidebar-toggle').click();
      await page.locator('.sidebar-person-trigger:visible').click();
      await expect(page.locator('.parallel-turn-pane')).toHaveCount(5);
      expect((await snapshot()).activeEpisodes.map(turn => turn.episodeId).sort()).toEqual(turns.map(turn => turn.episodeId).sort());
      // A reload restores the active snapshot, not another admission/provider run.
      expect(requests.filter(request => request.op === 'send')).toHaveLength(6);
      expect(started.size).toBe(5);
      await screenshot('reloaded-durable-active-turns');
      await page.locator('.parallel-turn-tabs [role="tab"]').first().click();
      await pane(first.episodeId).getByRole('button', { name: 'Stop', exact: true }).click();
      await expect.poll(async () => (await snapshot()).activeEpisodes.length).toBe(4);
      expect(requests.filter(request => request.op === 'cancel').at(-1).payload).toEqual({ episodeId: first.episodeId });
      expect(records('episodes').find(episode => episode.id === first.episodeId).status).toBe('cancelled');
      // Finish out of order. Remaining siblings must not inherit cancellation.
      for (const index of [3, 1, 4, 2]) {
        gates.get(texts[index]).release();
        await expect.poll(() => records('episodes').find(episode => episode.id === turns[index].episodeId)?.status, { timeout: 20000 }).toBe('completed');
      }
      await expect.poll(async () => (await snapshot()).busy).toBe(false);
      await expect(page.locator('.parallel-turn-pane')).toHaveCount(0);
      const stored = records('messages');
      expect(stored.filter(message => message.role === 'assistant').map(message => message.text).sort()).toEqual([2, 3, 4, 5].map(i => `Public answer ${i}.`).sort());
      // Published sibling context is available at subsequent provider boundaries;
      // private reasoning is neither a public sibling record nor visible UI.
      const published = calls.flatMap(call => call.messages.filter(message => message.role === 'user').map(message => message.content)).filter(content => content.includes('publishedContext'));
      expect(published.some(content => content.includes(second.episodeId))).toBe(true);
      expect(published.every(content => !content.includes(privateMarker))).toBe(true);
      await expect(page.locator('#person-conversation')).not.toContainText(privateMarker);
      expect(routes).toHaveLength(5);
      expect(mockAgent.conversations.size).toBe(0);
      await screenshot('completed-archive');
      await page.reload();
      await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === id && agent.status === 'ready'), mockAgent.agentId);
      if (scenario.width <= 768) await page.locator('.header-sidebar-toggle').click();
      await page.locator('.sidebar-person-trigger:visible').click();
      await expect(page.locator('#person-input')).toBeEnabled();
      await expect(page.locator('.parallel-turn-pane')).toHaveCount(0);
      // Inspect virtualized rows through real keyboard scrolling, collecting
      // identities in DOM order rather than assuming offscreen rows are mounted.
      const messageEpisodes = Object.fromEntries(stored.map(message => [message.id, message.episodeId]));
      const seen = new Map(), messages = page.locator('.person-messages');
      await messages.focus(); await messages.press('Home');
      await expect.poll(() => messages.evaluate(node => node.scrollTop)).toBe(0);
      await page.waitForTimeout(100);
      for (let step = 0; step < 12; step++) {
        const rows = await messages.locator('.user-turn-block, .person-reply').evaluateAll(nodes => nodes.map(node => ({
          id: node.dataset.msgId || node.dataset.messageId, episodeId: node.dataset.episodeId,
        })));
        for (const row of rows) if (!seen.has(row.id)) seen.set(row.id, row.episodeId || messageEpisodes[row.id]);
        await messages.press('PageDown');
        await page.waitForTimeout(50); // Allow the virtualizer's animation-frame measurement.
      }
      expect([...new Set(seen.values())]).toEqual(turns.map(turn => turn.episodeId));
      for (const message of stored.filter(message => ['user', 'assistant'].includes(message.role))) expect(seen.has(message.id)).toBe(true);
      await testInfo.attach('archive-dom-order', { body: JSON.stringify([...seen]), contentType: 'application/json' });
      await screenshot('reloaded-completed-archive');
    } finally {
      await writeFile(testInfo.outputPath('diagnostics.json'), JSON.stringify({ browserLog, serverLog, requests, responses, routes, calls }, null, 2));
      await testInfo.attach('relay-and-provider-log', { body: JSON.stringify({ requests, responses, routes, calls }, null, 2), contentType: 'application/json' });
      mockAgent._messageHandlers.splice(mockAgent._messageHandlers.indexOf(listener), 1);
      for (const gate of gates.values()) gate.release();
      await bridge.close(); await rm(dir, { recursive: true, force: true });
    }
  });
}
