import { expect } from '@playwright/test';
import { test } from '../../fixtures/test-server.js';

const ORIGIN = 'https://browser-fixture.test';
const SESSION_A = 'client-browser-a';
const SESSION_B = 'client-browser-b';
const URL_A = `${ORIGIN}/response-a`;
const URL_B = `${ORIGIN}/response-b`;

// Actual application + owner relay + deterministic Agent history. Destinations
// are real cross-origin documents fulfilled in Chromium, not component harnesses.
test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: 'false' } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__browserTransportEvidence = { rtc: 0, requests: [] };
    if (window.RTCPeerConnection) {
      window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
        construct(target, args) {
          window.__browserTransportEvidence.rtc++;
          return Reflect.construct(target, args);
        },
      });
    }
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string') {
        try {
          const message = JSON.parse(data);
          if (message.type?.startsWith('browser_')) window.__browserTransportEvidence.requests.push(message);
        } catch { /* Non-JSON websocket data is unrelated to the Agent protocol. */ }
      }
      return send.call(this, data);
    };
  });
});

async function externalPages(page) {
  const requests = [];
  await page.context().route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // Count document navigations, not incidental native-tab favicon requests.
    if (request.isNavigationRequest()) requests.push({ url: request.url(), referer: request.headers().referer || '', path });
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: path === '/blocked' ? { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" } : {},
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>External ${path}</title></head>
        <body><h1>External ${path}</h1><p id="script">Script pending</p>
        <script>
          let parentAccess = 'allowed';
          try { void parent.document.cookie; } catch { parentAccess = 'denied'; }
          document.getElementById('script').textContent = 'Script executed; parent access ' + parentAccess;
        </script></body></html>`,
    });
  });
  return requests;
}

async function openSession(page, mockAgent, sessionId = SESSION_A) {
  await page.evaluate(({ agentId, sessionId }) => {
    const store = window.Pinia.useChatStore();
    store.openCatalogSession(store.sessionCatalog.find(row => row.routeRef.agentId === agentId && row.routeRef.sessionId === sessionId));
  }, { agentId: mockAgent.agentId, sessionId });
  await expect(page.locator('.assistant-turn a').filter({ hasText: 'Response destination' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute?.sessionId)).toBe(sessionId);
}

async function sessionFixture(page, mockAgent, capabilities = [
  'terminal', 'file_editor', 'workbench_session_routes', 'work_center', 'work_center_message_v2', 'plaintext-ok',
]) {
  mockAgent._messageHandlers.push(request => {
    if (request.type !== 'yeaft_load_history' || request.limit === 0
      || ![SESSION_A, SESSION_B].includes(request.sessionId)) return;
    const sessionId = request.sessionId;
    const url = sessionId === SESSION_A ? URL_A : URL_B;
    const identity = { sessionId, turnId: `turn-${sessionId}`, speakerVpId: 'omni', ts: Date.now() };
    mockAgent.send({
      type: 'yeaft_history_chunk', conversationId: 'client-browser-conversation', sessionId,
      requestId: request.requestId, _requestClientId: request._requestClientId, mode: 'recent',
      messages: [
        { ...identity, id: 'm1', seq: 1, role: 'user', content: 'Show the external delivery.' },
        { ...identity, id: 'm2', seq: 2, role: 'assistant', responseKind: 'result', content: `[Response destination](${url})` },
      ],
      oldestSeq: 1, nextBeforeSeq: 1, latestSeq: 2, hasMore: false,
      streamId: `client-browser-stream-${sessionId}`, revision: 1,
      pageKind: request.pageKind, gapStopAtSeq: request.gapStopAtSeq, cacheEpoch: request.cacheEpoch,
    });
  });
  // No Agent browser capability, runtime setup, WebRTC, or installer is needed.
  mockAgent.send({ type: 'agent_capabilities_updated', capabilities });
  await expect.poll(() => page.evaluate(agentId => window.Pinia.useChatStore().agents
    .find(agent => agent.id === agentId)?.capabilities, mockAgent.agentId)).toEqual(capabilities);
  mockAgent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [
    { id: SESSION_A, name: 'Browser A', roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/browser-a' },
    { id: SESSION_B, name: 'Browser B', roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/browser-b' },
  ] } });
  await expect.poll(() => page.evaluate(agentId => window.Pinia.useChatStore().sessionCatalog
    .filter(row => row.routeRef.agentId === agentId && [ 'client-browser-a', 'client-browser-b' ].includes(row.routeRef.sessionId)).length,
  mockAgent.agentId)).toBe(2);
  await openSession(page, mockAgent);
}

function responseLink(page) {
  return page.locator('.assistant-turn a').filter({ hasText: 'Response destination' });
}

async function rendered(page, path, panel = page.locator('.workbench-panel:visible')) {
  await expect(panel).toHaveClass(/expanded/);
  await expect(panel.locator('.browser-frame')).toHaveAttribute('src', `${ORIGIN}${path}`);
  await expect(panel.frameLocator('.browser-frame').getByRole('heading', { name: `External ${path}`, exact: true })).toBeVisible();
  await expect(panel.frameLocator('.browser-frame').locator('#script')).toHaveText('Script executed; parent access denied');
}

async function oneNavigation(page, requests, path, action, panel = page.locator('.workbench-panel:visible')) {
  const before = requests.length;
  await action();
  await expect.poll(() => requests.length).toBe(before + 1);
  await rendered(page, path, panel);
  await expect(panel.locator('.browser-status')).toHaveCount(0);
  // Flush Vue/browser render turns after load to catch a duplicate reactive
  // navigation, including a same-URL iframe recreation.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(requests.slice(before).map(request => request.path)).toEqual([path]);
}

async function noRemoteBrowser(page, mockAgent) {
  expect(mockAgent.messages().filter(message => message.type?.startsWith('browser_'))).toEqual([]);
  expect(mockAgent.browserSessions.size).toBe(0);
  expect(await page.evaluate(() => window.__browserTransportEvidence)).toEqual({ rtc: 0, requests: [] });
  await expect(page.locator('.browser-panel video, .browser-panel canvas')).toHaveCount(0);
}

async function launchBrowser(panel) {
  await panel.locator('.workbench-add-btn').click();
  await panel.locator('.workbench-add-menu [data-workbench-capability="browser"]').click();
}

for (const width of [1440, 320]) {
  for (const theme of ['light', 'dark']) {
    test(`plaintext-only Agent response opens iframe; single navigation and retention at ${width}px ${theme}`, async ({ chatPage: page, mockAgent }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const requests = await externalPages(page);
      // Server ignores an empty capability refresh; plaintext-ok only preserves
      // fixture transport framing and grants no Agent Workbench capability.
      await sessionFixture(page, mockAgent, ['plaintext-ok']);
      expect(await page.evaluate(() => {
        const store = window.Pinia.useChatStore();
        return store.agents.find(agent => agent.id === store.activeSessionRoute.agentId)?.capabilities;
      })).toEqual(['plaintext-ok']);
      const appUrl = page.url();
      await oneNavigation(page, requests, '/response-a', () => responseLink(page).click());
      const panel = page.locator('.workbench-panel:visible');
      const frame = panel.locator('.browser-frame');
      const address = panel.getByRole('textbox', { name: 'Browser address', exact: true });
      await rendered(page, '/response-a', panel);
      expect(page.url()).toBe(appUrl);
      expect(page.context().pages()).toHaveLength(1);
      await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
      await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
      await expect(address).toHaveValue(URL_A);
      await expect(panel.locator('.browser-hint')).toContainText('not the Agent');
      await expect(panel.locator('.browser-hint')).toContainText('address stays at the URL you opened');

      await address.focus();
      await expect(address).toBeFocused();
      expect(await address.evaluate(element => {
        const style = getComputedStyle(element.closest('.browser-location'));
        return style.boxShadow !== 'none';
      })).toBe(true);
      await address.fill('browser-fixture.test/edited');
      await oneNavigation(page, requests, '/edited', () => address.press('Enter'), panel);
      await expect(address).toHaveValue(`${ORIGIN}/edited`);
      const key = await frame.getAttribute('data-frame-key');
      await oneNavigation(page, requests, '/edited', () => panel.getByRole('button', { name: 'Refresh', exact: true }).click(), panel);
      await expect(frame).not.toHaveAttribute('data-frame-key', key);

      // Invalid drafts never replace a successfully rendered destination.
      const validLoads = requests.length;
      await address.fill('javascript:alert(1)');
      await address.press('Enter');
      await expect(panel.getByRole('alert')).toContainText('HTTP or HTTPS');
      await expect(frame).toHaveAttribute('src', `${ORIGIN}/edited`);
      expect(requests).toHaveLength(validLoads);
      await address.fill(`${ORIGIN}/retained`);
      await oneNavigation(page, requests, '/retained', () => address.press('Enter'), panel);
      await panel.locator('.workbench-add-btn').click();
      await panel.locator('[data-workbench-capability="git"]').click();
      await expect(panel.locator('.browser-frame')).toHaveCount(0);
      // Switching to an unavailable Agent capability remains honest, and does
      // not prevent the always-available client Browser from being reopened.
      await expect(panel.locator('.workbench-capability-empty')).toBeVisible();
      await oneNavigation(page, requests, '/retained', () => launchBrowser(panel), panel);
      await expect(address).toHaveValue(`${ORIGIN}/retained`);

      expect(await page.evaluate(() => {
        const store = window.Pinia.useChatStore();
        return store.agents.find(agent => agent.id === store.activeSessionRoute.agentId)?.capabilities;
      })).toEqual(['plaintext-ok']);
      // A reopened URL is an explicit new navigation, including the identical URL.
      await panel.locator('.workbench-panel-close').click();
      await oneNavigation(page, requests, '/response-a', () => responseLink(page).click(), panel);
      await panel.locator('.workbench-panel-close').click();
      await oneNavigation(page, requests, '/response-a', () => responseLink(page).click(), panel);
      await panel.evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await panel.locator('.browser-panel').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const bounds = await panel.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      if (width === 320) expect(bounds.width).toBe(width);
      await panel.getByRole('link', { name: 'Open in new tab', exact: true }).focus();
      await expect(panel.getByRole('link', { name: 'Open in new tab', exact: true })).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath(`client-browser-${width}-${theme}.png`) });
      expect(requests.filter(request => request.path !== '/blocked').every(request => !request.referer)).toBe(true);
      await noRemoteBrowser(page, mockAgent);
      expect(errors).toEqual([]);
    });
  }
}

test('modifier and middle clicks keep native new-tab navigation, not Workbench', async ({ chatPage: page, mockAgent }) => {
  const requests = await externalPages(page);
  await sessionFixture(page, mockAgent);
  const link = responseLink(page);
  const appUrl = page.url();
  for (const options of [{ modifiers: ['Control'] }, { button: 'middle' }, { modifiers: ['Shift'] }]) {
    const loads = requests.length;
    const popupPromise = page.context().waitForEvent('page');
    await link.click(options);
    const popup = await popupPromise;
    await expect(popup.getByRole('heading', { name: 'External /response-a', exact: true })).toBeVisible();
    expect(requests.slice(loads).map(request => request.path)).toEqual(['/response-a']);
    expect(popup.url()).toBe(URL_A);
    await popup.close();
    expect(page.url()).toBe(appUrl);
    await expect(page.locator('.browser-frame')).toHaveCount(0);
    await expect(page.locator('.workbench-panel')).not.toHaveClass(/expanded/);
  }
  await noRemoteBrowser(page, mockAgent);
});

test('Browser URLs remain isolated across Sessions and workspace generations', async ({ chatPage: page, mockAgent }) => {
  const requests = await externalPages(page);
  await sessionFixture(page, mockAgent);
  await oneNavigation(page, requests, '/response-a', () => responseLink(page).click());
  const address = page.getByRole('textbox', { name: 'Browser address', exact: true });
  await address.fill(`${ORIGIN}/a-private`);
  await oneNavigation(page, requests, '/a-private', () => address.press('Enter'));
  await openSession(page, mockAgent, SESSION_B);
  await expect(page.locator('.browser-frame')).toHaveCount(0);
  await oneNavigation(page, requests, '/response-b', () => responseLink(page).click());
  await oneNavigation(page, requests, '/a-private', () => openSession(page, mockAgent, SESSION_A));
  await expect(address).toHaveValue(`${ORIGIN}/a-private`);

  const changeWorkspace = async workDir => {
    await page.evaluate(({ agentId, sessionId, workDir }) => {
      window.Pinia.useSessionsStore().sessionById(sessionId, agentId).workDir = workDir;
    }, { agentId: mockAgent.agentId, sessionId: SESSION_A, workDir });
    await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().effectiveWorkDir)).toBe(workDir);
  };
  await changeWorkspace('/tmp/browser-a-other');
  await expect(page.locator('.browser-frame')).toHaveCount(0);
  const panel = page.locator('.workbench-panel');
  await launchBrowser(panel);
  await expect(address).toHaveValue('');
  await expect(panel.locator('.browser-stage-placeholder')).toBeVisible();
  await address.fill(`${ORIGIN}/other-workspace`);
  await oneNavigation(page, requests, '/other-workspace', () => address.press('Enter'));
  await oneNavigation(page, requests, '/a-private', () => changeWorkspace('/tmp/browser-a'));
  await oneNavigation(page, requests, '/response-b', () => openSession(page, mockAgent, SESSION_B));
  await noRemoteBrowser(page, mockAgent);
});

test('Work Center output, Coordinator and Action reply links own their WorkItem Browser, never the hidden Session', async ({ chatPage: page, mockAgent }) => {
  const requests = await externalPages(page);
  await sessionFixture(page, mockAgent, ['work_center', 'work_center_message_v2', 'plaintext-ok']);
  await oneNavigation(page, requests, '/response-a', () => responseLink(page).click());
  const details = ['item-a', 'item-b'].map((id, index) => ({
    id, title: `Browser output ${index + 1}`, goal: 'Inspect external delivery', status: 'done', boardLane: 'closed', revision: 1,
    updatedAt: Date.now(), workbench: { workDir: `/tmp/${id}` },
    outputs: [{ kind: 'link', label: 'Delivered page', ref: `${ORIGIN}/${id}` }],
    messages: [{ id: `${id}-coordinator`, role: 'assistant', status: 'completed', createdAt: Date.now(),
      speaker: { id: 'coordinator', name: 'Coordinator' }, text: `[Coordinator destination](${ORIGIN}/${id}-coordinator)` }],
    actions: [{ id: `${id}-action`, sequence: 1, generation: 1, type: 'execute', status: 'completed',
      createdAt: Date.now(), assignedVp: { id: 'omni', name: 'Implementer' }, brief: { objective: `Deliver ${id}` },
      messages: [{ id: `${id}-action-reply`, role: 'assistant', status: 'completed', createdAt: Date.now(),
        speaker: { id: 'omni', name: 'Implementer' }, text: `[Action destination](${ORIGIN}/${id}-action)` }] }],
  }));
  mockAgent._messageHandlers.push(message => {
    if (message.type !== 'work_center_request') return;
    const data = message.op === 'list' ? { items: details }
      : message.op === 'get' ? details.find(detail => detail.id === message.workItemId)
        : { settings: {}, runtime: { vps: [], models: [] } };
    mockAgent.send({ type: 'work_center_response', requestId: message.requestId, op: message.op, ok: true, data });
  });
  const before = await page.evaluate(agentId => {
    const store = window.Pinia.useChatStore();
    const state = { route: store.activeSessionRoute, workDir: store.effectiveWorkDir, conversation: store.currentConversation };
    store.enterWorkCenter(agentId);
    return state;
  }, mockAgent.agentId);
  const panel = page.locator('.work-center-main > .workbench-panel');
  const sessionFrame = page.locator('.yeaft-page > .workbench-panel .browser-frame');
  const sessionKey = await sessionFrame.getAttribute('data-frame-key');
  const sessionLoads = requests.filter(request => request.path === '/response-a').length;
  const openItemLinks = async index => {
    const id = `item-${index ? 'b' : 'a'}`;
    await page.locator('.work-center-card-open').filter({ hasText: `Browser output ${index + 1}` }).click();
    await page.locator('#work-item-info-tab-outputs').click();
    const output = page.locator('.work-center-output-list a');
    await expect(output).toHaveAttribute('href', `${ORIGIN}/${id}`);
    await oneNavigation(page, requests, `/${id}`, () => output.click(), panel);
    await panel.locator('.workbench-panel-close').click();
    const coordinator = page.locator('.work-center-main .assistant-turn a').filter({ hasText: 'Coordinator destination' });
    await expect(coordinator).toHaveAttribute('href', `${ORIGIN}/${id}-coordinator`);
    await oneNavigation(page, requests, `/${id}-coordinator`, () => coordinator.click(), panel);
    await panel.locator('.workbench-panel-close').click();
    const actionsButton = page.locator('.work-center-actions-button');
    if (await actionsButton.getAttribute('aria-expanded') === 'false') await actionsButton.click();
    await page.locator('.work-center-action-summary').filter({ hasText: `Deliver ${id}` }).click();
    const action = page.locator('.work-center-action-detail-pane .assistant-turn a').filter({ hasText: 'Action destination' });
    await expect(action).toHaveAttribute('href', `${ORIGIN}/${id}-action`);
    await oneNavigation(page, requests, `/${id}-action`, () => action.click(), panel);
    await expect(sessionFrame).toHaveAttribute('src', URL_A);
    await expect(sessionFrame).toHaveAttribute('data-frame-key', sessionKey);
    expect(requests.filter(request => request.path === '/response-a')).toHaveLength(sessionLoads);
    await panel.locator('.workbench-panel-close').click();
  };
  await openItemLinks(0);
  await page.getByRole('button', { name: 'Work items', exact: true }).click();
  await openItemLinks(1);
  await page.locator('.work-center-return').click();
  expect(await page.evaluate(() => {
    const store = window.Pinia.useChatStore();
    return { route: store.activeSessionRoute, workDir: store.effectiveWorkDir, conversation: store.currentConversation };
  })).toEqual(before);
  await rendered(page, '/response-a');
  await noRemoteBrowser(page, mockAgent);
});

test('blocked embeds keep honest guidance and a working native Open in new tab fallback', async ({ chatPage: page, mockAgent }) => {
  await externalPages(page);
  await sessionFixture(page, mockAgent);
  await responseLink(page).click();
  await rendered(page, '/response-a');
  const blockedMessages = [];
  page.on('console', message => { if (message.type() === 'error') blockedMessages.push(message.text()); });
  const panel = page.locator('.workbench-panel:visible');
  const address = panel.getByRole('textbox', { name: 'Browser address', exact: true });
  await address.fill(`${ORIGIN}/blocked`);
  await address.press('Enter');
  await expect(panel.locator('.browser-frame')).toHaveAttribute('src', `${ORIGIN}/blocked`);
  await expect.poll(() => blockedMessages.join('\n')).toMatch(/refused|frame-ancestors/i);
  // A load event can also fire for a blocked document: it is deliberately NOT
  // asserted as success, nor treated as reliable XFO/CSP failure detection.
  await expect(panel.frameLocator('.browser-frame').getByRole('heading', { name: 'External /blocked', exact: true })).toHaveCount(0);
  await expect(panel.locator('.browser-hint')).toContainText('Sites may block embedding');
  await expect(panel.locator('.browser-hint')).toContainText('If blank, open in a new tab');
  const external = panel.getByRole('link', { name: 'Open in new tab', exact: true });
  await expect(external).toHaveAttribute('href', `${ORIGIN}/blocked`);
  await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
  const popupPromise = page.waitForEvent('popup');
  await external.click();
  const popup = await popupPromise;
  await expect(popup.getByRole('heading', { name: 'External /blocked', exact: true })).toBeVisible();
  expect(await popup.evaluate(() => window.opener)).toBe(null);
  await popup.close();
  await expect(address).toHaveValue(`${ORIGIN}/blocked`);
  await noRemoteBrowser(page, mockAgent);
});

test('external redirects back to Yeaft keep the opaque sandbox and cannot reach parent storage or escape', async ({ chatPage: page, mockAgent }) => {
  const requests = await externalPages(page);
  await sessionFixture(page, mockAgent, ['plaintext-ok']);
  const appUrl = page.url();
  // Playwright routing handles only the first URL of a redirect chain. Use
  // the real fixture Server document rather than claiming a second fulfill ran.
  const target = `${new URL(appUrl).origin}/`;
  await page.route(`${ORIGIN}/redirect`, route => route.fulfill({ status: 302, headers: { location: target }, body: '' }));
  await responseLink(page).click();
  await rendered(page, '/response-a');
  const panel = page.locator('.workbench-panel:visible');
  const address = panel.getByRole('textbox', { name: 'Browser address', exact: true });
  await address.fill(`${ORIGIN}/redirect`);
  await address.press('Enter');
  await expect.poll(() => page.frames().filter(frame => frame.parentFrame() && frame.url() === target).length).toBe(1);
  const redirectedFrame = page.frames().find(frame => frame.parentFrame() && frame.url() === target);
  const isolation = await redirectedFrame.evaluate(escape => {
    const result = {};
    try { void parent.document.cookie; result.parent = 'allowed'; } catch { result.parent = 'denied'; }
    try { void localStorage.length; result.storage = 'allowed'; } catch { result.storage = 'denied'; }
    result.popup = window.open('about:blank') === null ? 'denied' : 'allowed';
    try { top.location.href = escape; result.top = 'allowed'; } catch { result.top = 'denied'; }
    return result;
  }, `${ORIGIN}/escaped`);
  expect(isolation).toEqual({ parent: 'denied', storage: 'denied', popup: 'denied', top: 'denied' });
  expect(page.url()).toBe(appUrl);
  expect(page.context().pages()).toHaveLength(1);
  await expect(address).toHaveValue(`${ORIGIN}/redirect`);
  await expect(panel.locator('.browser-frame')).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
  expect(requests.some(request => request.path === '/escaped')).toBe(false);
  await noRemoteBrowser(page, mockAgent);
});
