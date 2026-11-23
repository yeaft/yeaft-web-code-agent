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
  let catalogSnapshot;
  const cancellations = [];
  const hiddenAgents = new Set();
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
          { id: 'beta', name: 'Beta', online: true, capabilities: ['session_discovery', 'digital_person'] },
          { id: 'legacy', name: 'Legacy', online: true, capabilities: [] },
          { id: 'offline', name: 'Offline', online: false, capabilities: ['session_discovery'] },
        ];
      } else if (msg.type === 'session_catalog_snapshot') {
        const row = (agentId, title) => ({
          catalogKey: `yeaft:${agentId}:same`, runtimeProvider: 'yeaft', title, workDir: '/tmp/discovery',
          routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: 'same' }, availability: 'online',
        });
        msg.catalog = [row('alpha', 'Alpha Session'), row('beta', 'Beta Session')];
        catalogSnapshot = { ...msg };
        msg.catalog = msg.catalog.filter(row => !hiddenAgents.has(row.routeRef.agentId));
        msg.projectsAuthoritative = true;
        msg.projects = [{ id: 'project', name: 'Design', sortOrder: 0, parentId: null, members: [{ agentId: 'beta', sessionId: 'same' }] }];
      }
      route.send(JSON.stringify(msg));
    });
    route.onMessage(message => {
      const req = JSON.parse(String(message));
      if (req.type === 'session_discovery_cancel') { cancellations.push(req); return; }
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
    chat.digitalPersonUiEnabledByAgent = { beta: true };
    chat.sidebarCollapsed = false;
    if (mobile) chat.sessionSidebarOpen = true;
  }, mobile);
  return {
    enableDiscovery: () => enableDiscovery(),
    cancellations,
    hideSession: agentId => {
      hiddenAgents.add(agentId);
      sendFrame({ ...catalogSnapshot, catalog: catalogSnapshot.catalog.filter(row => !hiddenAgents.has(row.routeRef.agentId)) });
    },
    deleteTurn: (agentId, turnId) => sendFrame({ type: 'yeaft_session_turn_deleted', agentId, sessionId: 'same', turnId }),
  };
}

const hit = (snippet, activeAt) => ({ sessionId: 'same', title: 'Stale index title', snippet, activeAt });
const indexed = (...results) => ({ indexedAt: 123, results });

function mockSearch() {
  const requests = [];
  return {
    requests,
    handle: (req, reply) => requests.push({ ...req, reply }),
    async take(query, after = 0) {
      const matching = () => requests.slice(after).filter(req => req.payload.query === query);
      await expect.poll(() => matching().map(req => req.agentId).sort()).toEqual(['alpha', 'beta']);
      return Object.fromEntries(matching().map(req => [req.agentId, req.reply]));
    },
  };
}

test('sidebar search before Digital Person searches as you type, with scoped results and no dialog', async ({ page, serverUrl }) => {
  const search = mockSearch();
  const socket = await openSidebar(page, serverUrl, search.handle, { holdDiscoveryAck: true });
  const sidebar = page.locator('.sidebar-navigation:visible');
  const tree = sidebar.locator('.sidebar-session-results');
  await expect(tree.getByRole('button', { name: /Beta Session/ })).toBeVisible();
  const trigger = sidebar.getByRole('button', { name: 'Search Sessions' });
  await expect(trigger).toHaveCount(0);
  socket.enableDiscovery();
  await expect(trigger).toBeVisible();
  const order = await sidebar.locator('.sidebar-primary-actions > button').evaluateAll(buttons => buttons.map(button => button.className));
  expect(order.findIndex(classes => classes.includes('sidebar-search-trigger')) + 1)
    .toBe(order.findIndex(classes => classes.includes('sidebar-person-trigger')));
  await trigger.press('Enter');
  const query = sidebar.getByRole('searchbox');
  await expect(query).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(tree.getByRole('button', { name: /Beta Session/ })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);

  await query.fill('obsolete');
  const obsolete = await search.take('obsolete');
  await query.fill('  architecture  ');
  const first = await search.take('architecture');
  expect(socket.cancellations.map(frame => frame.requestId).sort())
    .toEqual(search.requests.filter(req => req.payload.query === 'obsolete').map(req => req.requestId).sort());
  obsolete.alpha(indexed(hit('stale result', 10)));
  first.alpha({ indexedAt: null, results: [] });
  first.beta({ indexedAt: null, results: [] });
  await expect(tree.getByRole('status')).toContainText('index is not ready');
  await expect(tree.getByText('stale result')).toHaveCount(0);
  await expect(tree.getByRole('button', { name: /Beta Session/ })).toHaveCount(0);
  const offset = search.requests.length;
  await tree.getByRole('button', { name: 'Retry' }).click();
  const retried = await search.take('architecture', offset);
  retried.beta(indexed(), { agentId: 'alpha' });
  retried.beta(indexed(), { op: 'share_list' });
  await expect(tree.getByRole('status')).toContainText('Searching');
  retried.alpha(indexed(hit('Alpha match', 3)));
  retried.beta(indexed(hit('<strong>Beta match</strong>', 4), { ...hit('Private match', 5), sessionId: 'not-in-catalog' }));
  const results = tree.getByRole('list', { name: 'Session search results' });
  await expect(results.getByRole('button')).toHaveCount(2);
  const beta = results.getByRole('button', { name: /Beta Session/ });
  await expect(beta).toContainText('Beta · Design');
  await expect(beta).toContainText('<strong>Beta match</strong>');
  await expect(results.getByText('Private match')).toHaveCount(0);
  await expect(results.getByRole('button').first()).toHaveText(/Beta Session/);
  socket.hideSession('alpha');
  await expect(results.getByRole('button')).toHaveCount(1);
  await beta.press('Enter');
  await expect(query).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute)).toMatchObject({
    runtimeProvider: 'yeaft', agentId: 'beta', sessionId: 'same',
  });
});

test('inline search fits the compact sidebar at 320px and clears or closes without a modal', async ({ page, serverUrl }) => {
  await page.route('**/api/user/preferences', route => route.fulfill({ json: { sidebarActionsCompact: true } }));
  const search = mockSearch();
  await openSidebar(page, serverUrl, (req, reply) => {
    if (req.op === 'share_list') return reply({ items: [
      { id: 'existing', kind: 'output', status: 'published', title: '旧调研成果', body: '报告摘要', updatedAt: 123 },
      { id: 'candidate', kind: 'consensus', status: 'candidate', title: '未发布的旧候选', body: '候选共识', updatedAt: 124 },
    ] });
    if (req.op === 'share_delete') {
      expect(req.agentId).toBe('beta');
      expect(req.payload).toEqual({ id: 'existing', expectedUpdatedAt: 123 });
      return reply({});
    }
    search.handle(req, reply);
  }, { mobile: true, locale: 'zh-CN' });
  const sidebar = page.locator('.sidebar-navigation:visible');
  const trigger = sidebar.getByRole('button', { name: '搜索会话', exact: true });
  await trigger.click();
  const box = sidebar.getByRole('searchbox');
  await expect(box).toBeFocused();
  await box.fill('检索');
  const replies = await search.take('检索');
  replies.alpha(null, { ok: false });
  replies.beta(indexed(hit('很长的搜索片段'.repeat(22), 5)));
  const result = sidebar.getByRole('list', { name: '会话搜索结果' }).getByRole('button');
  await expect(result).toHaveCount(1);
  await expect(sidebar.getByText('部分 Agent 暂时无法搜索。')).toBeVisible();
  await expect(sidebar.getByRole('button', { name: '分享', exact: true })).toHaveCount(0);
  const shortcuts = sidebar.locator('.sidebar-primary-actions');
  await expect(shortcuts).toHaveClass(/is-compact/);
  expect(await shortcuts.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const form = sidebar.getByRole('search');
  await expect(form).toBeVisible();
  const bounds = await form.boundingBox();
  expect(bounds.x + bounds.width).toBeLessThan(320);
  expect(await form.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await sidebar.getByRole('button', { name: '清除搜索' }).click();
  await expect(box).toHaveValue('');
  await expect(box).toBeFocused();
  await expect(sidebar.getByRole('button', { name: /Beta Session/ })).toBeVisible();
  await box.press('Escape');
  await expect(box).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: /^设置/ }).click();
  await page.getByRole('button', { name: '通用', exact: true }).click();
  const saved = page.locator('.saved-share-settings');
  await saved.getByText('已保存的分享', { exact: true }).click();
  await expect(saved.getByText('旧调研成果')).toBeVisible();
  await expect(saved.getByText('未发布的旧候选')).toHaveCount(0);
  await saved.getByRole('button', { name: '移除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click();
  await expect(saved.getByText('这台 Agent 上没有已保存的条目。')).toBeVisible();
});

test('a turn deletion invalidates inline results and late replies', async ({ page, serverUrl }) => {
  const search = mockSearch();
  const socket = await openSidebar(page, serverUrl, search.handle);
  const sidebar = page.locator('.sidebar-navigation:visible');
  await sidebar.getByRole('button', { name: 'Search Sessions' }).click();
  const query = sidebar.getByRole('searchbox');
  await query.fill('topic');
  const initial = await search.take('topic');
  initial.alpha(indexed());
  initial.beta(indexed(hit('Deleted excerpt', 9)));
  await expect(sidebar.getByText('Deleted excerpt')).toBeVisible();
  const offset = search.requests.length;
  socket.deleteTurn('beta', 'deleted');
  const next = await search.take('topic', offset);
  await expect(sidebar.getByText('Deleted excerpt')).toHaveCount(0);
  const nextOffset = search.requests.length;
  socket.deleteTurn('beta', 'while-requesting');
  const fresh = await search.take('topic', nextOffset);
  next.beta(indexed(hit('Late excerpt', 10)));
  fresh.alpha(indexed());
  fresh.beta(indexed());
  await expect(sidebar.getByText('No matching sessions.')).toBeVisible();
  await expect(sidebar.getByText('Late excerpt')).toHaveCount(0);
});
