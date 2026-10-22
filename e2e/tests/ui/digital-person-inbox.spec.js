import { expect } from '@playwright/test';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { test } from '../../fixtures/test-server.js';
import { personInput, personCognition, personToolCall, personStop } from '../../fixtures/person-provider.js';
import { createPersonBridge } from '../../../agent/yeaft/person/bridge.js';
import { createPersonService } from '../../../agent/yeaft/person/service.js';
import { config, finalProposal, goalInput } from '../../../test/agent/yeaft/person/fixtures.js';

// Real browser -> authenticated relay -> Person service/SQLite -> native FileWrite.
// Only inference is scripted; the held provider deliberately returns obsolete work.
test.use({ serverEnv: { SERVE_DIST: process.env.PERSON_UI_PRODUCTION || 'false' } });

for (const scenario of [{ width: 1280, theme: 'light' }, { width: 320, theme: 'dark' }]) {
  test(`Person receives live addenda and separately replies without stale effects (${scenario.theme}, ${scenario.width}px)`, async ({ page, serverUrl, mockAgent }, testInfo) => {
    test.setTimeout(60000);
    const dir = await mkdtemp(join(tmpdir(), 'person-inbox-e2e-'));
    const obsoletePath = join(dir, 'obsolete.txt'), revisedPath = join(dir, 'revised.txt');
    const content = 'Only the revised direction is authorized.\n';
    const initial = 'Create obsolete.txt containing the original plan.';
    const supplement = `New restriction: do not write obsolete.txt. Instead create revised.txt containing exactly ${JSON.stringify(content)}.`;
    const question = 'Separately, what is six multiplied by seven?';
    const answer = 'Six multiplied by seven is 42.';
    const completion = 'Created revised.txt and verified its actual contents; obsolete.txt was not written.';
    const objective = 'Create the authorized file, incorporating the latest restriction, and answer the separate question.';
    const acceptance = 'Only revised.txt exists with the requested contents, and the separate question has an explicitly linked answer.';
    const requests = [], responses = [], sessionRequests = [], calls = [], incoming = new Map(), observed = new Map();
    let service, ownerId, held = false, released = false, release, writeObserved = false;
    const gate = new Promise(resolve => { release = () => { released = true; resolve(); }; });
    const adapter = { async *stream(params) {
      await setImmediate(); // Real provider I/O gives relay/SQLite workers a boundary.
      calls.push(params);
      const input = personInput(params);
      expect(input.trigger.text).toBe(initial);
      const results = params.messages.filter(message => message.role === 'tool')
        .map(message => ({ toolUseId: message.toolCallId, ...JSON.parse(message.content) }));
      for (const result of results) observed.set(result.executionTraceCallId ?? result.toolUseId, result);
      // Read only actual model-delivered records, never infer IDs from our test's
      // receipt or DB. Runtime may bound several incoming batches separately.
      for (const message of params.messages.filter(message => message.role === 'user')) {
        let payload;
        const text = typeof message.content === 'string' ? message.content
          : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        try { payload = JSON.parse(text); } catch { continue; }
        const items = payload.phase === 'incoming-user-messages'
          ? payload.messages ?? payload.items ?? payload.input?.messages ?? []
          : payload.role === 'user' && payload.sourceRef?.startsWith('message:') ? [payload] : [];
        for (const item of items) {
          const id = item.id ?? item.messageId;
          if (id && typeof item.text === 'string') incoming.set(id, item);
        }
      }
      const all = [...observed.values()];
      const reports = all.filter(result => result.id === 'Execution.goal');
      for (const report of reports) expect(report).toMatchObject({ ok: true, goal: { objective, acceptance } });
      if (personCognition(params)) {
        expect(released && writeObserved).toBe(true);
        expect([...incoming.values()].map(message => message.text)).toEqual(expect.arrayContaining([supplement, question]));
        expect(all.some(result => result.id === 'Conversation.reply' && result.ok)).toBe(true);
        expect(reports.some(result => result.goal.status === 'completed')).toBe(true);
        const proposal = finalProposal(input.state.version);
        proposal.concepts = []; proposal.state.focusConceptIds = [];
        proposal.activity.sourceRefs = [input.trigger.ref];
        proposal.reply = null; // The two public replies already exist; do not repeat them.
        yield { type: 'text_delta', text: JSON.stringify(proposal) };
        yield personStop(false);
        return;
      }
      let event;
      if (!reports.length) {
        event = personToolCall('start-goal', 'Execution.goal', goalInput([input.trigger.ref], {
          objective, acceptance, kind: 'work', status: 'active', reason: '',
          nextStep: 'Create the authorized file, verify it and answer the separate question.',
        }));
      } else if (!held) {
        held = true;
        await gate;
        event = personToolCall('obsolete-write', 'FileWrite', { file_path: obsoletePath, content: 'The superseded original plan.\n' });
      } else {
        const delivered = [...incoming.values()];
        expect(delivered.map(message => message.text)).toEqual(expect.arrayContaining([supplement, question]));
        const skipped = all.find(result => result.toolUseId === 'obsolete-write');
        expect(skipped).toMatchObject({ ok: false, code: 'INPUT_SUPERSEDED' });
        await expect(access(obsoletePath)).rejects.toMatchObject({ code: 'ENOENT' });
        const written = all.find(result => result.id === 'FileWrite' && result.ok === true);
        const replied = all.find(result => result.id === 'Conversation.reply' && result.ok === true);
        if (!written) {
          event = personToolCall('revised-write', 'FileWrite', { file_path: revisedPath, content });
        } else {
          // Goal acceptance is based on this spec's real temp filesystem, not a
          // scripted success string, precreated fixture file or publication ACK.
          expect(await readFile(revisedPath, 'utf8')).toBe(content);
          writeObserved = true;
          expect(written.sourceRef).toBeTruthy();
          if (!replied) {
            const target = delivered.find(message => message.text === question);
            event = personToolCall('separate-answer', 'Conversation.reply', { messageIds: [target.id ?? target.messageId], text: answer });
          } else if (!reports.some(result => result.goal.status === 'completed')) {
            expect(replied.replyToMessageIds).toEqual([delivered.find(message => message.text === question).id ?? delivered.find(message => message.text === question).messageId]);
            const check = 'Read the actual revised.txt and matched its exact contents; obsolete.txt is absent; the separate answer is durably linked.';
            event = personToolCall('complete-goal', 'Execution.goal', goalInput([written.sourceRef], {
              objective, acceptance, kind: 'work', reason: check,
              acceptanceChecks: [{ check, sourceRefs: [written.sourceRef] }],
            }));
          }
        }
      }
      if (event) yield event;
      else yield { type: 'text_delta', text: completion };
      yield personStop(!!event);
    } };
    const bridge = createPersonBridge({
      context: { agentId: mockAgent.agentId, CONFIG: { serverUrl, yeaftDir: dir, workDir: dir } },
      send: message => { responses.push(message); return mockAgent.send(message); },
      createService: options => (service = createPersonService({ ...options, workDir: dir, config, adapter, embedding: { enabled: false } })),
    });
    const listener = message => {
      if (['create_conversation', 'yeaft_session_create', 'yeaft_session_send', 'yeaft_session_send_message'].includes(message.type)) sessionRequests.push(message);
      if (message.type !== 'person_request') return;
      requests.push(message); ownerId = message.ownerId;
      void bridge.request(message);
    };
    mockAgent._messageHandlers.push(listener);
    const sendRequests = () => requests.filter(request => request.op === 'send');
    const sendResponses = () => sendRequests().map(request => responses.find(response => response.requestId === request.requestId));
    const receipt = index => service.request({ ownerId, op: 'receipt', payload: { clientMessageId: sendRequests()[index].payload.clientMessageId } });
    const snapshot = () => service.request({ ownerId, op: 'snapshot' });
    const records = table => {
      // Each case owns this whole database. No application database is inspected.
      const db = new DatabaseSync(join(dir, 'person', 'person.db'), { readOnly: true });
      try { return db.prepare(`SELECT record FROM ${table}`).all().map(row => JSON.parse(row.record)); }
      finally { db.close(); }
    };
    const attach = async name => {
      const path = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(name, { path, contentType: 'image/png' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };
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
      const input = page.locator('#person-input');
      const stop = page.locator('.person-composer').getByRole('button', { name: 'Stop execution', exact: true });
      const send = async text => {
        const index = sendRequests().length;
        await expect(input).toBeEnabled();
        await input.fill(text);
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect.poll(() => sendResponses()[index]?.ok).toBe(true);
        await expect(input).toHaveValue('');
        return sendResponses()[index].data;
      };
      const first = await send(initial);
      await expect.poll(() => held).toBe(true);
      await expect(stop).toBeEnabled();
      const active = await snapshot();
      expect(active.busy).toBe(true);
      expect(active.main.episodeId).toBe(first.episodeId);
      const second = await send(supplement);
      await expect(stop).toBeEnabled();
      const third = await send(question);
      await expect(stop).toBeEnabled();
      for (const ack of [second, third]) expect(ack).toMatchObject({ episodeId: first.episodeId, deliveryState: 'queued' });
      for (const index of [1, 2]) expect(await receipt(index)).toMatchObject({ found: true, episodeId: first.episodeId, deliveryState: 'queued' });
      expect((await snapshot()).main.episodeId).toBe(first.episodeId);
      expect(records('episodes')).toHaveLength(1);
      const queued = records('messages').filter(message => message.deliveryState === 'queued');
      expect(queued.map(message => message.text)).toEqual([supplement, question]);
      expect(calls.filter(personCognition)).toHaveLength(0);
      await expect(page.locator('.person-messages')).toContainText(supplement);
      await expect(page.locator('.person-messages')).toContainText(question);
      // Queued is transport receipt, not a claim that the held model read it.
      const pendingDelivery = page.locator('.person-delivery[data-delivery-state="queued"]');
      await expect(pendingDelivery).toHaveCount(2);
      await expect(pendingDelivery.first()).not.toBeEmpty();
      // The active-response anchor intentionally focuses new replies. A real
      // keyboard scroll releases it so queued messages are visibly inspectable.
      await page.locator('.person-messages').focus();
      await page.locator('.person-messages').press('Home');
      await pendingDelivery.last().scrollIntoViewIfNeeded();
      await expect(pendingDelivery.last()).toBeInViewport();
      await attach(`person-inbox-pending-${scenario.theme}-${scenario.width}`);
      release();
      await expect(page.locator('.person-messages')).toContainText(completion, { timeout: 20000 });
      await expect.poll(async () => (await snapshot()).busy).toBe(false);
      await expect(stop).toHaveCount(0);
      await expect(input).toBeEnabled();
      await expect(access(obsoletePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(revisedPath, 'utf8')).toBe(content);
      const receipts = await Promise.all([0, 1, 2].map(receipt));
      expect(new Set(receipts.map(item => item.messageId)).size).toBe(3);
      for (const item of receipts) expect(item).toMatchObject({ found: true, episodeId: first.episodeId, deliveryState: 'received' });
      const messages = records('messages');
      expect(messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([initial, supplement, question]);
      const direct = messages.find(message => message.text === answer);
      expect(direct).toMatchObject({ role: 'assistant', episodeId: first.episodeId, replyToMessageIds: [receipts[2].messageId] });
      const final = messages.find(message => message.text === completion);
      expect(final).toMatchObject({ role: 'assistant', episodeId: first.episodeId });
      expect(final.id).not.toBe(direct.id);
      const traces = records('traces');
      const writes = traces.filter(trace => trace.kind === 'capability_started' && trace.capability?.id === 'FileWrite');
      expect(writes).toHaveLength(1);
      expect(writes[0].capability.args).toEqual({ file_path: revisedPath, content });
      expect(traces.some(trace => trace.kind === 'call_output' && trace.output?.toolCalls?.some(call => call.id === 'obsolete-write'))).toBe(true);
      const modelStarts = traces.filter(trace => trace.kind === 'call_started');
      expect(modelStarts.filter(trace => trace.manifest?.phase === 'cognition')).toHaveLength(1);
      expect(modelStarts.at(-1).manifest.phase).toBe('cognition');
      expect(calls.filter(personCognition)).toHaveLength(1);
      expect(personCognition(calls.at(-1))).toBe(true);
      expect(records('state_commits')).toHaveLength(1);
      expect(records('episodes')).toHaveLength(1);
      expect(mockAgent.conversations.size).toBe(0);
      expect(sessionRequests).toEqual([]);
      const directReply = page.locator('.person-reply').filter({ hasText: answer });
      const finalReply = page.locator('.person-reply').filter({ hasText: completion });
      await expect(directReply).toHaveCount(1);
      await expect(finalReply).toHaveCount(1);
      await expect(directReply).not.toContainText(completion);
      await expect(directReply.locator('.person-reply-context blockquote')).toHaveText(question);
      await finalReply.scrollIntoViewIfNeeded();
      await expect(finalReply).toBeInViewport();
      await expect(directReply.locator('.person-reply-context blockquote')).toBeInViewport();
      await expect(page.locator('html')).toHaveAttribute('data-theme', scenario.theme);
      await attach(`person-inbox-complete-${scenario.theme}-${scenario.width}`);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        const outcomes = responses.map(({ requestId, op, ok, error, errorCode, data }) => ({ requestId, op, ok, error, errorCode,
          ...(op === 'snapshot' ? { busy: data?.busy, main: data?.main } : op === 'send' ? { data } : {}) }));
        await testInfo.attach('person-inbox-diagnostics', { body: JSON.stringify({ requests, outcomes }, null, 2), contentType: 'application/json' });
      }
      mockAgent._messageHandlers.splice(mockAgent._messageHandlers.indexOf(listener), 1);
      release();
      await bridge.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
