import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { test } from '../../fixtures/test-server.js';
import { MockAgent } from '../../fixtures/mock-agent.js';

// Exercise the real application, Pinia actions, WebSocket owner relay and Agent
// protocol. Only the Agent's filesystem/catalog is deterministic; no UI/store
// actions or browser transport are replaced.
test.use({ serverEnv: { YEAFT_LOCAL_RUN: 'true', SERVE_DIST: process.env.SERVE_DIST || 'false' } });

const CAPABILITIES = [
  'work_center', 'plaintext-ok', 'workbench_session_routes',
  'yeaft_plugins', 'yeaft_managed_skills', 'settings_request_correlation',
];
const SESSION_A = 'plugins-session-a';
const SESSION_B = 'plugins-session-b';
const LONG_TOOL = 'InspectAnExtremelyLongUnbrokenPluginIdentifierWithoutHorizontalOverflow';
const PROMPT = '# Review workflow\n\n## When to use\nBefore shipping changes.\n\n## Instructions\n' + 'Check ownership, correctness and recovery.\n'.repeat(160) + '\n<script>window.skillPromptExecuted = true</script>';
const DESCRIPTION = 'Review correctness, ownership and recovery before shipping.\n\n'.repeat(45);

function pluginAgent(agent, initialPlugins = {}) {
  const state = {
    plugins: structuredClone(initialPlugins), requests: [], heldSaves: [], holdSaves: false,
    holdLoads: false, heldLoads: [],
    replyConfig(request) {
      agent.send({ type: 'yeaft_plugins', requestId: request.requestId, plugins: structuredClone(state.plugins) });
    },
    saveError: '', catalogError: '', createError: '', detailError: '', legacyDetails: false,
    catalog: {
      skills: [
        { id: 'user:review-guide', name: 'review-guide', label: 'Review guide', description: DESCRIPTION, tier: 'user', managed: true },
        { id: 'bundled:deploy-playbook', name: 'deploy-playbook', label: 'Deploy playbook', description: 'Release safely with rollback evidence.', tier: 'bundled' },
      ],
      skillSources: [
        { id: 'user:review-guide', name: 'review-guide', label: 'review-guide', tier: 'user', managed: true },
      ],
      tools: [
        { id: 'FileRead', label: 'Read files', description: 'Read a bounded range of project files.' },
        { id: 'Bash', label: 'Run shell commands', description: 'Execute commands in the Agent workspace.' },
        { id: LONG_TOOL, label: LONG_TOOL, description: 'A deliberately long identifier tests responsive text wrapping.' },
      ],
      mcpServers: [{ id: 'github', label: 'GitHub', toolCount: 3, ready: true }],
    },
    replySave(request, error = state.saveError) {
      if (!error) state.plugins = structuredClone(request.plugins);
      agent.send({ type: 'yeaft_plugins_updated', requestId: request.requestId,
        plugins: structuredClone(state.plugins), ...(error ? { error } : {}) });
    },
    advertise() { agent.send({ type: 'agent_capabilities_updated', capabilities: CAPABILITIES }); },
  };
  agent._messageHandlers.push(request => {
    if (['get_yeaft_plugins', 'update_yeaft_plugins', 'yeaft_plugin_catalog', 'yeaft_managed_skill'].includes(request.type)) {
      state.requests.push(structuredClone(request));
    }
    if (request.type === 'get_yeaft_plugins') {
      if (state.holdLoads) state.heldLoads.push(request);
      else state.replyConfig(request);
    } else if (request.type === 'update_yeaft_plugins') {
      if (state.holdSaves) state.heldSaves.push(request);
      else state.replySave(request);
    } else if (request.type === 'yeaft_plugin_catalog') {
      agent.send({ type: 'yeaft_plugin_catalog_result', requestId: request.requestId,
        _requestClientId: request._requestClientId, catalog: state.catalog,
        ...(request.skillName && !state.legacyDetails ? { skillDetail: {
          name: request.skillName, description: 'Review correctness, ownership and recovery before shipping.',
          tier: 'user', trigger: 'review', keywords: ['code review', 'shipping'], content: PROMPT,
          references: ['checklist.md'], templates: ['report.md'],
        } } : {}), error: (request.skillName ? state.detailError : state.catalogError) || null });
    } else if (request.type === 'yeaft_managed_skill') {
      if (!state.createError && request.action === 'create') {
        const skill = { ...request.skill, id: `user:${request.skill.name}`, label: request.skill.name, tier: 'user', managed: true };
        state.catalog.skills.push(skill);
        state.catalog.skillSources.push(skill);
      }
      agent.send({ type: 'yeaft_managed_skill_result', requestId: request.requestId,
        _requestClientId: request._requestClientId, scope: request.scope, sessionId: request.sessionId,
        result: state.createError ? null : { name: request.skill?.name }, catalog: state.catalog, error: state.createError || null });
    } else if (request.type === 'yeaft_load_history' && request.limit !== 0) {
      agent.send({ type: 'yeaft_history_chunk', sessionId: request.sessionId, requestId: request.requestId,
        _requestClientId: request._requestClientId, mode: 'recent', messages: [],
        oldestSeq: 0, latestSeq: 0, hasMore: false });
    }
  });
  state.advertise();
  return state;
}

async function boot(page, serverUrl, agent, { width = 1440, theme = 'light' } = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(theme => {
    localStorage.setItem('locale', 'en');
    localStorage.setItem('theme', theme);
    localStorage.setItem('yeaft-preferred-conversation-view', 'yeaft');
  }, theme);
  await page.goto(serverUrl);
  await expect.poll(() => page.evaluate(agentId => window.Pinia?.useChatStore?.().agents
    .some(item => item.id === agentId && item.online && item.capabilities?.includes('yeaft_plugins')), agent.agentId)).toBe(true);
  agent.send({ type: 'yeaft_output', event: { type: 'session_list_updated', sessions: [
    { id: SESSION_A, name: 'Plugin Session A', roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/plugin-a' },
    { id: SESSION_B, name: 'Plugin Session B', roster: ['omni'], defaultVpId: 'omni', workDir: '/tmp/plugin-b' },
  ] } });
  await expect.poll(() => page.evaluate(agentId => window.Pinia.useChatStore().sidebarSessionCatalog
    .filter(row => row.routeRef.agentId === agentId && row.routeRef.sessionId.startsWith('plugins-session-')).length,
  agent.agentId)).toBe(2);
}

async function showSidebar(page) {
  if (!await page.locator('.sidebar-plugins-entry').isVisible()) {
    const toggle = page.locator('.plugin-center-sidebar-toggle:visible, .header-sidebar-toggle:visible').first();
    await toggle.click();
  }
  await expect(page.locator('.sidebar-plugins-entry')).toBeVisible();
  await expect.poll(() => page.locator('.session-sidebar-shell').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(200);
}

async function openPlugins(page) {
  await showSidebar(page);
  await page.locator('.sidebar-plugins-entry').click();
  await expect(page.locator('.plugin-center-page')).toBeVisible();
  await expect(page.locator('.plugin-center-content')).toHaveAttribute('aria-busy', 'false');
}

async function selectAgent(page, name) {
  await page.getByRole('button', { name: 'Select Agent', exact: true }).click();
  await page.locator('.plugin-center-agent-menu').getByRole('button', { name, exact: false }).click();
  await expect(page.locator('.plugin-center-agent-name')).toHaveText(name);
  await expect(page.locator('.plugin-center-content')).toHaveAttribute('aria-busy', 'false');
}

async function category(page, value) {
  const select = page.getByRole('combobox', { name: 'Plugin categories', exact: true });
  if (await select.isVisible()) await select.selectOption(value);
  else await page.locator('.plugin-center-tabs').getByRole('button', {
    name: { all: 'All', skills: 'Skills', tools: 'Built-in tools', mcpServers: 'MCP servers' }[value], exact: true,
  }).click();
}

async function search(page, value) {
  let input = page.locator('.plugin-center-header input[type="search"]:visible');
  if (!await input.count()) {
    await page.getByRole('button', { name: 'Search tools, skills, and MCP servers', exact: true }).click();
    input = page.locator('.plugin-center-header input[type="search"]:visible');
  }
  await input.fill(value);
}

function toggle(page, name) { return page.getByRole('switch', { name: `Enable ${name}`, exact: true }); }
function row(page, key) { return page.locator(`.plugin-center-row[data-entry="${key}"]`); }

async function screenshot(page, testInfo, name) {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function responsiveGeometry(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await expect.poll(() => page.evaluate(() => {
    const page = document.querySelector('.plugin-center-page');
    const header = page.querySelector('.plugin-center-header');
    const content = page.querySelector('.plugin-center-content');
    const bounds = header.getBoundingClientRect();
    const sidebar = document.querySelector('.session-sidebar-shell');
    const children = [...header.children].filter(element => element.getBoundingClientRect().width > 0);
    return {
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      pageOverflow: page.scrollWidth > page.clientWidth + 1,
      contentOverflow: content.scrollWidth > content.clientWidth + 1,
      headerOverflow: header.scrollWidth > header.clientWidth + 1,
      singleLine: children.every(element => {
        const box = element.getBoundingClientRect();
        return box.top >= bounds.top && box.bottom <= bounds.bottom + 1;
      }),
      headerHeight: bounds.height,
      mobileSidebarHidden: innerWidth > 768 || sidebar.getBoundingClientRect().width <= 1,
    };
  }), { message: `Plugin Center geometry at ${width}px` }).toEqual({
    documentOverflow: false, pageOverflow: false, contentOverflow: false, headerOverflow: false,
    singleLine: true, headerHeight: width <= 768 ? 56 : 64, mobileSidebarHidden: true,
  });
}

test('Plugins keep the existing sidebar and browse responsively in light desktop and dark 320px', async ({ page, serverUrl, mockAgent }, testInfo) => {
  const state = pluginAgent(mockAgent);
  await boot(page, serverUrl, mockAgent);
  await showSidebar(page);
  await expect(page.locator('.sidebar-primary-actions > button').nth(0)).toHaveAccessibleName('New chat');
  expect(await page.locator('.sidebar-plugins-entry').evaluate(element => element.previousElementSibling?.getAttribute('aria-label'))).toBe('New chat');
  await expect(page.locator('.sidebar-plugins-entry')).toHaveCount(1);
  await openPlugins(page);
  await expect(page.locator('.plugin-center-row')).toHaveCount(6);
  await expect(page.locator('.session-item')).toHaveCount(2);
  await expect(page.locator('.sidebar-plugins-entry')).toHaveAttribute('aria-current', 'page');
  await screenshot(page, testInfo, 'plugins-light-desktop.png');

  await category(page, 'mcpServers');
  await expect(page.locator('.plugin-center-row')).toHaveCount(1);
  await expect(row(page, 'mcpServers:github')).toContainText('Connected');
  await category(page, 'skills');
  await expect(page.locator('.plugin-center-row')).toHaveCount(2);
  await category(page, 'all');
  await search(page, 'rollback');
  await expect(page.locator('.plugin-center-row')).toHaveCount(1);
  await expect(row(page, 'skills:bundled:deploy-playbook')).toBeVisible();
  await search(page, 'no-plugin-matches-this');
  await expect(page.getByText('No matching plugins', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('button', { name: 'View Review guide details', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review guide', exact: true })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Skill sources', exact: true })).toBeVisible();
  await expect(page.locator('.plugin-center-skill-content')).toHaveText(PROMPT);
  await expect(page.locator('.plugin-center-skill-command')).toContainText('/skill:review-guide');
  await expect(page.locator('.plugin-center-skill-usage')).toContainText('code review, shipping');
  await expect(page.locator('.plugin-center-skill-files')).toContainText('references/checklist.md');
  expect(await page.evaluate(() => window.skillPromptExecuted)).toBeUndefined();
  expect(state.requests.filter(request => request.skillName)).toHaveLength(1);
  await page.locator('.plugin-center-skill-prompt').scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'plugins-skill-prompt-light.png');
  await page.evaluate(() => window.Pinia.useChatStore().toggleTheme());
  await page.setViewportSize({ width: 320, height: 900 });
  await page.locator('.plugin-center-skill-prompt').scrollIntoViewIfNeeded();
  expect(await page.locator('.plugin-center-content').evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
  await screenshot(page, testInfo, 'plugins-skill-prompt-dark-320.png');
  await page.evaluate(() => window.Pinia.useChatStore().toggleTheme());
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await page.locator('.plugin-center-content').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.getByRole('button', { name: 'All plugins', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View Review guide details', exact: true })).toBeFocused();

  const deploy = state.catalog.skills[1];
  for (const [width, theme, description] of [[1440, 'light', '|'], [1440, 'dark', ''], [320, 'dark', '>'], [320, 'light', undefined]]) {
    deploy.description = description;
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { if (document.documentElement.dataset.theme !== theme) window.Pinia.useChatStore().toggleTheme(); }, theme);
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.locator('.plugin-center-more-menu').getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => page.evaluate(expected => {
      const store = window.Pinia.useChatStore();
      return Object.values(store.pluginCatalogByKey).some(record => record.loaded && !record.loading
        && record.catalog?.skills.some(skill => skill.name === 'deploy-playbook' && skill.description === expected));
    }, description)).toBe(true);
    await expect(row(page, 'skills:bundled:deploy-playbook').locator('.plugin-center-row-copy small')).toHaveCount(0);
    await expect(row(page, 'skills:user:review-guide').locator('.plugin-center-row-copy small')).toContainText('Review correctness');
    const centered = await row(page, 'skills:bundled:deploy-playbook').evaluate(element => {
      const title = element.querySelector('strong').getBoundingClientRect();
      const icon = element.querySelector('.plugin-center-entry-icon').getBoundingClientRect();
      return Math.abs(title.top + title.height / 2 - icon.top - icon.height / 2) < 1;
    });
    expect(centered).toBe(true);
    await screenshot(page, testInfo, `plugins-no-description-${theme}-${width}.png`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.locator('.plugin-center-more-menu').getByRole('button', { name: 'Enabled only', exact: true }).click();
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  const filterGeometry = await page.locator('.plugin-center-menu-check').evaluate(mark => {
    const row = mark.parentElement, style = getComputedStyle(row);
    return {
      aligned: Math.abs(mark.getBoundingClientRect().right - row.getBoundingClientRect().right + parseFloat(style.paddingRight)) < 1,
      margin: getComputedStyle(mark).marginLeft,
    };
  });
  expect(filterGeometry.aligned).toBe(true);
  expect(parseFloat(filterGeometry.margin)).toBeGreaterThan(0);
  await page.locator('.plugin-center-more-menu').getByRole('button', { name: 'Enabled only', exact: true }).click();

  // Keep the sidebar's actual width in the calculation at tablet/desktop sizes.
  for (const width of [1440, 1280, 1024, 900, 768, 375, 320]) await responsiveGeometry(page, width);
  await page.evaluate(() => window.Pinia.useChatStore().toggleTheme());
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.locator('.plugin-center-agent-trigger').evaluate(element => ({
    background: getComputedStyle(element).backgroundColor,
    color: getComputedStyle(element).color,
    expectedColor: getComputedStyle(element).getPropertyValue('--text-primary').trim(),
  }))).toMatchObject({ background: 'rgba(0, 0, 0, 0)' });
  await screenshot(page, testInfo, 'plugins-dark-320.png');
  await category(page, 'tools');
  await expect(page.locator('.plugin-center-row')).toHaveCount(3);
  await search(page, 'Read files');
  await expect(page.locator('.plugin-center-row')).toHaveCount(1);
  await expect(page.locator('.plugin-center-expanded-search input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Search tools, skills, and MCP servers', exact: true })).toBeFocused();
  await showSidebar(page);
  await expect(page.locator('.sidebar-plugins-entry')).toHaveAttribute('aria-current', 'page');
  await screenshot(page, testInfo, 'plugins-dark-320-sidebar.png');
});

test('Agent picker uses aligned sidebar-style names without dots or checkmarks across selection, themes and offline cache', async ({ page, serverUrl, mockAgent }, testInfo) => {
  pluginAgent(mockAgent);
  await boot(page, serverUrl, mockAgent);
  const second = new MockAgent(serverUrl, 'server-2');
  const third = new MockAgent(serverUrl, 'C1');
  await second.connect(); pluginAgent(second);
  await third.connect(); pluginAgent(third);
  try {
    await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().agents.filter(agent => agent.online).length)).toBe(3);
    await openPlugins(page);
    await selectAgent(page, 'C1');
    await third.disconnect();
    await selectAgent(page, 'server-2');
    for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [320, 'dark'], [320, 'light']]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => { if (document.documentElement.dataset.theme !== theme) window.Pinia.useChatStore().toggleTheme(); }, theme);
      await page.getByRole('button', { name: 'Select Agent', exact: true }).click();
      const menu = page.locator('.plugin-center-agent-menu');
      await expect(menu.locator('button')).toHaveCount(3);
      await expect(menu.locator('.plugin-center-dot')).toHaveCount(0);
      expect(await menu.innerText()).not.toContain('✓');
      await expect(menu.locator('button[aria-pressed="true"]')).toHaveText('server-2');
      const geometry = await menu.evaluate(element => {
        const labels = [...element.querySelectorAll('.plugin-center-agent-option-name')];
        const rows = [...element.querySelectorAll('button')];
        const x = labels[0].getBoundingClientRect().left;
        return {
          aligned: labels.every(label => Math.abs(label.getBoundingClientRect().left - x) < 1),
          sameHeight: rows.every(row => Math.abs(row.getBoundingClientRect().height - rows[0].getBoundingClientRect().height) < 1),
          fits: element.getBoundingClientRect().right <= innerWidth && element.getBoundingClientRect().left >= 0,
          textAlign: rows.every(row => getComputedStyle(row).textAlign === 'left'),
        };
      });
      expect(geometry).toEqual({ aligned: true, sameHeight: true, fits: true, textAlign: true });
      await screenshot(page, testInfo, `plugins-agent-picker-${theme}-${width}.png`);
      await page.keyboard.press('End');
      await expect(menu.locator('button').last()).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Select Agent', exact: true })).toBeFocused();
    }
  } finally { await second.disconnect(); await third.disconnect(); }
});

test('Agent-scoped auto-save survives slow replies, Agent switching and leaving for the same or another Session', async ({ page, serverUrl, mockAgent }, testInfo) => {
  const alpha = pluginAgent(mockAgent, { tools: ['FileRead', 'Bash', LONG_TOOL], skills: ['review-guide'], mcpServers: ['github'] });
  await boot(page, serverUrl, mockAgent);
  // Establish an active Session through the same sidebar users click.
  await page.locator('.session-item').filter({ hasText: 'Plugin Session A' }).click();
  const betaAgent = new MockAgent(serverUrl, 'Agent Beta');
  await betaAgent.connect();
  const beta = pluginAgent(betaAgent, { tools: ['FileRead'], skills: [], mcpServers: [] });
  try {
    await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().agents.filter(agent => agent.online).length)).toBe(2);
    await openPlugins(page);
    alpha.holdSaves = true;
    await toggle(page, 'Read files').click();
    await expect(toggle(page, 'Read files')).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => alpha.heldSaves.length).toBe(1);
    await expect(page.locator('.plugin-center-save-indicator.is-visible').first()).toBeVisible();
    await selectAgent(page, 'Agent Beta');
    await expect(toggle(page, 'Read files')).toHaveAttribute('aria-checked', 'true');
    await expect(toggle(page, 'Review guide')).toHaveAttribute('aria-checked', 'false');
    await toggle(page, 'Read files').click();
    await expect.poll(() => beta.plugins.tools).toEqual([]);
    alpha.replySave(alpha.heldSaves.shift());
    await expect(toggle(page, 'Read files')).toHaveAttribute('aria-checked', 'false');
    expect(alpha.plugins).toEqual({ tools: ['Bash', LONG_TOOL], skills: ['review-guide'], mcpServers: ['github'] });
    expect(beta.plugins).toEqual({ tools: [], skills: [], mcpServers: [] });
    await selectAgent(page, 'test-agent');
    await expect(toggle(page, 'Read files')).toHaveAttribute('aria-checked', 'false');

    // A second click while the first write is slow queues intent for this Agent,
    // not a component-owned Promise. Leave before either reply is delivered.
    await toggle(page, 'Run shell commands').click();
    await expect.poll(() => alpha.heldSaves.length).toBe(1);
    await toggle(page, 'Read files').click();
    await page.locator('.session-item').filter({ hasText: 'Plugin Session A' }).click();
    await expect(page.locator('.plugin-center-page')).toHaveCount(0);
    alpha.replySave(alpha.heldSaves.shift());
    await expect.poll(() => alpha.heldSaves.length).toBe(1);
    alpha.replySave(alpha.heldSaves.shift());
    await expect.poll(() => alpha.plugins.tools).toEqual([LONG_TOOL, 'FileRead']);
    expect(beta.plugins.tools).toEqual([]);
    alpha.holdSaves = false;
    await openPlugins(page);
    await expect(toggle(page, 'Read files')).toHaveAttribute('aria-checked', 'true');
    await expect(toggle(page, 'Run shell commands')).toHaveAttribute('aria-checked', 'false');
    await page.locator('.session-item').filter({ hasText: 'Plugin Session B' }).click();
    await expect(page.locator('.plugin-center-page')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.Pinia.useChatStore().activeSessionRoute?.sessionId)).toBe(SESSION_B);
    await openPlugins(page);
    await expect(toggle(page, 'Run shell commands')).toHaveAttribute('aria-checked', 'false');
    await screenshot(page, testInfo, 'plugins-auto-save-isolated.png');
    expect(alpha.requests.filter(request => request.type === 'update_yeaft_plugins')).toHaveLength(3);
    expect(beta.requests.filter(request => request.type === 'update_yeaft_plugins')).toHaveLength(1);
    // Reopening retains rows but must not authorize stale edits while a fresh
    // remote configuration is in flight. Preserve changes in other fields.
    await page.locator('.session-item').filter({ hasText: 'Plugin Session A' }).click();
    alpha.plugins = { tools: [LONG_TOOL, 'FileRead', 'remote-only-tool'], skills: [], mcpServers: [] };
    alpha.holdLoads = true;
    await page.locator('.sidebar-plugins-entry').click();
    await expect.poll(() => alpha.heldLoads.length).toBe(1);
    await expect(toggle(page, 'Read files')).toBeDisabled();
    expect(alpha.requests.filter(request => request.type === 'update_yeaft_plugins')).toHaveLength(3);
    alpha.replyConfig(alpha.heldLoads.shift());
    alpha.holdLoads = false;
    await expect(toggle(page, 'Read files')).toBeEnabled();
    await toggle(page, 'Read files').click();
    await expect.poll(() => alpha.plugins).toEqual({ tools: [LONG_TOOL, 'remote-only-tool'], skills: [], mcpServers: [] });
  } finally { await betaAgent.disconnect(); }
});

test('Plugin failures retry explicitly, managed skill creation uses Agent relay, and offline caches are read-only', async ({ page, serverUrl, mockAgent }, testInfo) => {
  const agent = pluginAgent(mockAgent);
  agent.catalogError = 'Catalog temporarily unavailable';
  await boot(page, serverUrl, mockAgent);
  await openPlugins(page);
  await expect(page.getByRole('alert')).toContainText('Catalog temporarily unavailable');
  agent.catalogError = '';
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.plugin-center-row')).toHaveCount(6);
  agent.saveError = 'Disk is read-only';
  await toggle(page, 'Read files').click();
  await expect(page.getByRole('alert')).toContainText('Disk is read-only');
  await expect(toggle(page, 'Read files')).toHaveAttribute('aria-checked', 'true');
  await page.locator('.session-item').filter({ hasText: 'Plugin Session A' }).click();
  await expect(page.locator('.plugin-center-page')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Disk is read-only');
  const writesBeforeRetry = agent.requests.filter(request => request.type === 'update_yeaft_plugins').length;
  await openPlugins(page);
  expect(agent.requests.filter(request => request.type === 'update_yeaft_plugins')).toHaveLength(writesBeforeRetry);
  agent.saveError = '';
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(toggle(page, 'Read files')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.locator('.plugin-center-create').click();
  const dialog = page.getByRole('dialog', { name: 'Create skill', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Create skill', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('browser-regression');
  await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('A reusable browser regression workflow.');
  await dialog.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Verify responsive layout and Agent ownership.');
  agent.createError = 'Skill name already exists';
  await dialog.getByRole('button', { name: 'Create skill', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Skill name already exists');
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('browser-regression');
  agent.createError = '';
  await dialog.getByRole('button', { name: 'Create skill', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, 'skills:user:browser-regression')).toBeVisible();
  const mutation = agent.requests.filter(request => request.type === 'yeaft_managed_skill').at(-1);
  expect(mutation).toMatchObject({ action: 'create', scope: 'user', skill: { name: 'browser-regression' } });

  await mockAgent.disconnect();
  await expect(page.getByRole('status').filter({ hasText: 'cached configuration is read-only' })).toBeVisible();
  await screenshot(page, testInfo, 'plugins-offline-cached.png');
  const offlineStatePath = testInfo.outputPath('offline-cache-state.json');
  await writeFile(offlineStatePath, JSON.stringify(await page.evaluate(() => {
    const store = window.Pinia.useChatStore();
    return { agents: store.agents, pluginCenterAgentId: store.pluginCenterAgentId,
      activeSession: store.activePluginSession(), config: store.pluginConfigByAgent,
      catalogKeys: Object.keys(store.pluginCatalogByKey),
      catalogSizes: Object.fromEntries(Object.entries(store.pluginCatalogByKey).map(([key, value]) =>
        [key, { skills: value.catalog?.skills?.length, tools: value.catalog?.tools?.length }])) };
  }), null, 2));
  await testInfo.attach('offline-cache-state.json', { path: offlineStatePath, contentType: 'application/json' });
  // Soft assertions preserve the reconnect evidence even when a missing-Agent
  // rendering regression hides the otherwise populated per-Agent cache.
  await expect.soft(page.locator('.plugin-center-row')).toHaveCount(7);
  await expect.soft(page.getByRole('switch')).toHaveCount(7);
  await expect.soft(toggle(page, 'Read files')).toHaveAttribute('aria-checked', 'false');
  for (const control of await page.getByRole('switch').all()) await expect(control).toBeDisabled();
  await expect(page.locator('.plugin-center-create')).toBeDisabled();
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await openPlugins(page);
  await expect(page.locator('.plugin-center-row')).toHaveCount(7);
  const writesBeforeReconnect = agent.requests.filter(request => request.type === 'update_yeaft_plugins').length;
  await mockAgent.connect();
  agent.advertise();
  await expect(toggle(page, 'Read files')).toBeEnabled();
  await expect(toggle(page, 'Read files')).toHaveAttribute('aria-checked', 'false');
  expect(agent.requests.filter(request => request.type === 'update_yeaft_plugins')).toHaveLength(writesBeforeReconnect);
});
