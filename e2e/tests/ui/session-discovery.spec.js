import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: 'false' } });

// Stub just the new wire boundary; the browser renders the real sidebar and
// opens a Session through the production catalog route.
async function openSidebar(page, serverUrl, handle, { mobile = false, locale = 'en', holdDiscoveryAck = false } = {}) {
  await page.setViewportSize({ width: mobile ? 320 : 1280, height: 800 });
  await page.addInitScript(locale => localStorage.setItem('locale', locale), locale);
  let sendFrame;
  let enableDiscovery;
  await page.routeWebSocket(/.*/, route => {
    const server = route.connectToServer();
    sendFrame = msg => route.send(JSON.stringify(msg));
    server.onMessage(message => {
      const msg = JSON.parse(String(message));
      if (msg.type === 'client_hello_ack') {
        enableDiscovery = () => sendFrame({ ...msg, sessionDiscoverySupported: true });
        if (holdDiscoveryAck) delete msg.sessionDiscoverySupported;
        else msg.sessionDiscoverySupported = true;
      } else if (msg.type === 'agent_list') {
        msg.agents = [
          { id: 'alpha', name: 'Alpha', online: true, capabilities: ['session_discovery'] },
          { id: 'beta', name: 'Beta', online: true, capabilities: ['session_discovery'] },
          { id: 'legacy', name: 'Legacy', online: true, capabilities: [] },
          { id: 'offline', name: 'Offline', online: false, capabilities: ['session_discovery'] },
        ];
      } else if (msg.type === 'session_catalog_snapshot') {
        const row = (agentId, title) => ({
          catalogKey: `yeaft:${agentId}:same`, runtimeProvider: 'yeaft', title, workDir: '/tmp/discovery',
          routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: 'same' }, availability: 'online',
        });
        msg.catalog = [row('alpha', 'Alpha Session'), row('beta', 'Beta Session')];
        msg.projectsAuthoritative = true;
        msg.projects = [{ id: 'project', name: 'Design', sortOrder: 0, parentId: null, members: [{ agentId: 'beta', sessionId: 'same' }] }];
      }
      route.send(JSON.stringify(msg));
    });
    route.onMessage(message => {
      const req = JSON.parse(String(message));
      if (req.type !== 'session_discovery_request') return server.send(message);
      handle(req, (data, overrides = {}) => route.send(JSON.stringify({
        type: 'session_discovery_response', agentId: req.agentId, requestId: req.requestId, op: req.op,
        ok: true, data, ...overrides,
      })));
    });
  });
  await page.goto(serverUrl);
  await page.waitForFunction(() => window.Pinia?.useChatStore?.().agents.some(agent => agent.id === 'alpha'));
  await page.evaluate(mobile => {
    const chat = window.Pinia.useChatStore();
    chat.currentView = mobile ? 'yeaft' : 'chat';
    chat.currentAgent = 'beta';
    chat.sidebarCollapsed = false;
    if (mobile) chat.sessionSidebarOpen = true;
  }, mobile);
  return {
    enableDiscovery: () => enableDiscovery(),
    deleteTurn: (agentId, turnId) => sendFrame({ type: 'yeaft_session_turn_deleted', agentId, sessionId: 'same', turnId }),
  };
}

test('keyboard search ignores mismatched replies and opens only a matching catalog Session in its folder', async ({ page, serverUrl }) => {
  let request;
  let reply;
  const socket = await openSidebar(page, serverUrl, (req, respond) => { request = req; reply = respond; }, { holdDiscoveryAck: true });
  await expect(page.getByRole('button', { name: /Beta Session/ })).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Search Sessions' });
  await expect(trigger).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
  socket.enableDiscovery();
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await trigger.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Search Sessions' });
  const query = dialog.getByRole('searchbox');
  await expect(query).toBeFocused();
  await expect(dialog.getByRole('option')).toHaveText(['Alpha', 'Beta']);
  await expect(dialog.getByLabel('Agent')).toHaveValue('beta');
  await query.fill('  architecture  ');
  await query.press('Enter');
  await expect.poll(() => request).toMatchObject({ agentId: 'beta', op: 'search', payload: { query: 'architecture' } });
  reply({ results: [], indexedAt: null });
  await expect(dialog.getByRole('status')).toContainText('first search index is not ready');
  await expect(dialog.getByText('No matching Sessions', { exact: false })).toHaveCount(0);
  const submit = dialog.getByRole('button', { name: 'Search', exact: true });
  await submit.click();
  const results = { results: [
    { sessionId: 'same', title: 'From index', snippet: '<strong>match</strong>', activeAt: 1 },
    { sessionId: 'not-in-catalog', title: 'Private match', snippet: 'Private snippet', activeAt: 2 },
  ], indexedAt: 3 };
  reply({ results: [] }, { agentId: 'alpha' });
  reply({ results: [] }, { op: 'share_list' });
  await expect(dialog.getByRole('status')).toContainText('Searching');
  reply(results);
  const result = dialog.getByRole('button', { name: /Beta Session/ });
  await expect(result).toContainText('Design');
  await expect(result).toContainText('<strong>match</strong>');
  await expect(dialog.getByText('Private snippet')).toHaveCount(0);
  socket.deleteTurn('alpha', 'different-agent');
  await page.waitForFunction(() => Object.values(window.Pinia.useChatStore().yeaftTurnDeleteHistoryBySession)
    .some(entry => entry.lastDeletedTurnId === 'different-agent'));
  await expect(result).toBeVisible();
  socket.deleteTurn('beta', 'same-agent');
  await expect(result).toHaveCount(0);
  const previous = request.requestId;
  await submit.click();
  await expect.poll(() => request.requestId).not.toBe(previous);
  const lateReply = reply;
  socket.deleteTurn('beta', 'during-search');
  await expect(submit).toBeEnabled();
  lateReply(results);
  await expect(result).toHaveCount(0);
  await submit.click();
  await expect.poll(() => reply).not.toBe(lateReply);
  reply(results);
  await result.press('Enter');
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute)).toMatchObject({
    runtimeProvider: 'yeaft', agentId: 'beta', sessionId: 'same',
  });
  await page.getByRole('button', { name: 'Search Sessions' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Search Sessions' })).toBeFocused();
});

test('Share works at 320px in Chinese, scopes items per Agent, and publishes, edits, and removes plain text', async ({ page, serverUrl }) => {
  const candidate = { id: 'candidate', kind: 'consensus', status: 'candidate', title: 'Draft title', body: '<b>Draft</b>', sourceSessionId: 'same', createdAt: 1, updatedAt: 1 };
  const requests = [];
  const deletedCandidate = { ...candidate, id: 'deleted-candidate', title: 'Deleted turn draft' };
  const items = { alpha: [], beta: [candidate, deletedCandidate, { ...candidate, id: 'remove-me', title: 'Discard draft' }] };
  let failList = true;
  let loseCreateAck = true;
  const socket = await openSidebar(page, serverUrl, (req, reply) => {
    requests.push(req);
    const list = items[req.agentId];
    if (req.op === 'share_list') {
      if (failList) { failList = false; return reply(null, { ok: false, error: 'temporary error' }); }
      return reply({ items: list });
    }
    if (req.op === 'share_save') {
      const { id, createId, expectedUpdatedAt, ...fields } = req.payload;
      const existing = list.find(row => row.id === (id || createId));
      if (createId && existing) return reply({ item: existing });
      if (id && (!existing || expectedUpdatedAt !== existing.updatedAt)) return reply(null, { ok: false });
      const item = { ...existing, ...fields, id: id || createId, status: 'published', updatedAt: (existing?.updatedAt || 0) + 1 };
      items[req.agentId] = [item, ...list.filter(row => row.id !== item.id)];
      if (createId && loseCreateAck) { loseCreateAck = false; return reply(null, { ok: false }); }
      return reply({ item });
    }
    if (req.op === 'share_delete') {
      const existing = list.find(row => row.id === req.payload.id);
      if (existing && existing.updatedAt !== req.payload.expectedUpdatedAt) return reply(null, { ok: false });
      items[req.agentId] = list.filter(row => row.id !== req.payload.id);
      return reply({});
    }
  }, { mobile: true, locale: 'zh-CN' });
  await page.getByRole('button', { name: '分享', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分享' });
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: '重试' }).click();
  const deletedDraft = dialog.getByRole('listitem').filter({ hasText: 'Deleted turn draft' });
  await deletedDraft.getByRole('button', { name: '审核并发布' }).click();
  await expect(dialog.getByLabel('内容')).toHaveValue('<b>Draft</b>');
  items.beta = items.beta.filter(item => item !== deletedCandidate);
  socket.deleteTurn('beta', 'candidate-source-deleted');
  await expect(dialog.getByLabel('内容')).toHaveCount(0);
  await expect(deletedDraft).toHaveCount(0);
  const draft = dialog.getByRole('listitem').filter({ hasText: 'Draft title' });
  await expect(draft).toContainText('<b>Draft</b>');
  await draft.getByRole('button', { name: '审核并发布' }).click();
  await dialog.getByLabel('标题').fill('Edited candidate');
  await dialog.getByRole('button', { name: '发布', exact: true }).click();
  await expect(dialog.getByRole('listitem').filter({ hasText: 'Edited candidate' })).toContainText('已发布');
  expect(requests.at(-1)).toMatchObject({ agentId: 'beta', op: 'share_save', payload: { id: 'candidate', expectedUpdatedAt: 1, kind: 'consensus', title: 'Edited candidate', body: '<b>Draft</b>' } });
  await dialog.getByRole('listitem').filter({ hasText: 'Discard draft' }).getByRole('button', { name: '移除' }).click();
  await dialog.getByRole('button', { name: '确认移除' }).click();
  await expect(dialog.getByText('Discard draft')).toHaveCount(0);
  expect(requests.at(-1)).toMatchObject({ agentId: 'beta', op: 'share_delete', payload: { id: 'remove-me', expectedUpdatedAt: 1 } });
  await dialog.getByLabel('Agent').selectOption('alpha');
  await expect(dialog.getByText('Edited candidate')).toHaveCount(0);
  await dialog.getByRole('button', { name: '添加分享' }).click();
  await dialog.getByLabel('标题').fill('Long title ' + 'x'.repeat(120));
  await dialog.getByLabel('内容').fill('Manual output');
  await dialog.getByRole('button', { name: '发布', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByLabel('内容')).toHaveValue('Manual output');
  const firstCreate = requests.at(-1);
  expect(firstCreate.payload.createId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  await dialog.getByRole('button', { name: '发布', exact: true }).click();
  await expect(dialog.getByText('Manual output')).toBeVisible();
  expect(requests.at(-1).payload).toEqual(firstCreate.payload);
  expect(requests.at(-1).requestId).not.toBe(firstCreate.requestId);
  expect(items.alpha).toHaveLength(1);
  expect(requests.at(-1)).toMatchObject({ agentId: 'alpha', op: 'share_save', payload: { kind: 'output', body: 'Manual output' } });
  expect(requests.at(-1).payload).not.toHaveProperty('id');
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth)).toBe(true);
});
