import { expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, TestServer, getAvailablePort, useTestServer, useMockAgent } from '../../fixtures/test-server.js';
import { MockAgent } from '../../fixtures/mock-agent.js';
import { pane, sessionTurnWire } from '../../helpers/session-turns.js';
import { sessionConfigPath } from '../../../agent/yeaft/sessions/session-config.js';
import { SESSION_SCENE_CAPABILITIES } from '../../../agent/yeaft/sessions/scene-ids.js';
import { seedDefaultVps } from '../../../agent/yeaft/vp/seed-defaults.js';
import { createVp } from '../../../agent/yeaft/vp/vp-crud.js';
import { scanVpLibrary } from '../../../agent/yeaft/vp/vp-store.js';
import { serializeVpForWire } from '../../../agent/yeaft/vp/vp-bridge.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import {
  addMember, createSessionFromSpec, removeMember, renameSession, setSessionDefaultVp,
  snapshotSessions, updateSessionAnnouncement, updateSessionConfig,
} from '../../../agent/yeaft/sessions/session-crud.js';

const customId = 'catalog-custom';
const conversationId = 'yeaft-vp-catalog-fixture';

// Every Server/Agent data root is disposable. Nothing uses the user's ~/.yeaft.
const test = base.extend({
  testServer: [async ({}, use) => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-vp-catalog-server-'));
    const server = new TestServer(await getAvailablePort());
    Object.assign(server.env, { HOME: root, YEAFT_DIR: join(root, 'yeaft'), TEST_DB_DIR: join(root, 'db'),
      SERVE_DIST: 'false', YEAFT_LOCAL_RUN: 'true' });
    try { await useTestServer(server, use); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }, { scope: 'worker' }],
  mockAgent: async ({ serverUrl }, use) => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-vp-catalog-agent-'));
    const libDir = join(root, 'virtual-persons');
    const agent = new MockAgent(serverUrl, 'VP catalog regression');
    try {
      expect(seedDefaultVps(libDir).errors).toEqual([]);
      createVp({ vpId: customId, displayName: 'Custom research partner',
        description: 'A user-authored assistant with a deliberately long capability description for narrow-screen wrapping and scroll coverage.',
        persona: 'Use only disposable test data.' }, { libDir, memoryRoot: join(root, 'memory') });
      const legacy = createSessionFromSpec(root, { name: 'Legacy collaboration', roster: ['linus', 'martin'],
        defaultVpId: 'linus', workDir: root }, { libDir });
      const history = new ConversationStore(root);
      for (const [index, vpId] of ['linus', 'martin'].entries()) {
        const turnId = `legacy-turn-${vpId}`;
        const user = history.append({ sessionId: legacy.id, role: 'user', content: `Ask ${vpId}`, turnId,
          time: `2026-11-01T00:00:0${index * 2}.000Z` });
        history.append({ sessionId: legacy.id, role: 'assistant', content: `${vpId} preserved historical answer`,
          speakerVpId: vpId, turnId, causalRootId: user.id, stopReason: 'end_turn',
          time: `2026-11-01T00:00:0${index * 2 + 1}.000Z` });
      }
      const send = (event, requestId) => agent.send({ type: 'yeaft_output', ...(requestId ? { requestId } : {}), event });
      const publish = () => send({ type: 'session_list_updated', sessions: snapshotSessions(root) });
      const models = [{ id: 'catalog-model-a', label: 'Catalog model A', provider: 'fixture', effortOptions: ['medium', 'xhigh', 'ultra'] },
        { id: 'catalog-model-b', label: 'Catalog model B', provider: 'fixture' }];
      const status = () => ({ model: 'fixture/catalog-model-a', availableModels: models,
        catalogRevision: 1, catalogEpoch: 'vp-catalog-fixture', catalogRefreshedAt: Date.now() });
      agent.catalog = { root, libDir, legacyId: legacy.id, publish, errors: [], turnWire: null,
        session: () => snapshotSessions(root).find(row => row.id === legacy.id) };
      agent._messageHandlers.push(request => {
        const reply = (op, payload) => agent.send({ type: 'yeaft_output', requestId: request.requestId,
          _requestClientId: request._requestClientId,
          event: { type: 'session_crud_result', op, requestId: request.requestId, ok: true, ...payload } });
        try {
          switch (request.type) {
            case 'yeaft_vp_subscribe':
              send({ type: 'vp_snapshot', vps: scanVpLibrary({ dir: libDir }).map(serializeVpForWire), emptyLibrary: false }, request.requestId);
              return;
            case 'yeaft_load_history': {
              const sessionId = request.sessionId;
              if (!sessionId) return;
              agent.send({ type: 'yeaft_output', conversationId, sessionId,
                event: { type: 'session_ready', conversationId, sessionId, ...status() } });
              if (request.limit === 0) return;
              const wire = agent.catalog.turnWire;
              const messages = wire?.sessionId === sessionId ? wire.history
                : history.loadAllBySession(sessionId).map(row => ({ ...row,
                  seq: Number(row.id.slice(1)), ts: Date.parse(row.time) }));
              agent.send({ type: 'yeaft_history_chunk', sessionId, requestId: request.requestId,
                mode: 'recent', messages, oldestSeq: messages[0]?.seq ?? null,
                latestSeq: messages.at(-1)?.seq ?? null, hasMore: false });
              if (wire?.sessionId === sessionId) wire.snapshot();
              return;
            }
            case 'yeaft_list_sessions': reply('list', { sessions: snapshotSessions(root) }); return;
            case 'yeaft_scan_workdir_sessions': reply('scan_workdir', { sessions: snapshotSessions(root)
              .filter(row => row.workDir === request.workDir).map(row => ({ ...row, alreadyRegistered: true })) }); return;
            case 'yeaft_create_session': {
              const created = createSessionFromSpec(root, request.payload, { libDir });
              reply('create', { session: snapshotSessions(root).find(row => row.id === created.id) });
              break;
            }
            case 'yeaft_rename_session': reply('rename', { session: renameSession(root, request.sessionId, request.name) }); break;
            case 'yeaft_update_session': reply('update', { session: updateSessionAnnouncement(root, request.sessionId, request.patch.announcement) }); break;
            case 'yeaft_update_session_config': {
              const { sessionId } = request;
              const config = updateSessionConfig(root, sessionId, request.config);
              if (!agent.catalog.omitSceneReceipt) {
                reply('update_config', { sessionId, config, session: snapshotSessions(root).find(row => row.id === sessionId) });
              }
              return;
            }
            case 'yeaft_session_add_member': reply('add_member', { session: addMember(root, request.sessionId, request.vpId) }); break;
            case 'yeaft_session_remove_member': reply('remove_member', { session: removeMember(root, request.sessionId, request.vpId) }); break;
            case 'yeaft_session_set_default_vp': reply('set_default_vp', { session: setSessionDefaultVp(root, request.sessionId, request.vpId) }); break;
            default: return;
          }
          publish();
        } catch (error) {
          agent.catalog.errors.push({ type: request.type, message: error.message });
        }
      });
      await useMockAgent(agent, async () => {
        agent.send({ type: 'agent_capabilities_updated', capabilities: [
          'plaintext-ok', 'work_center', 'workbench_session_routes', 'scheduled_tasks', 'session_scenes',
          ...Object.values(SESSION_SCENE_CAPABILITIES),
        ] });
        await use(agent);
      });
    } finally {
      await closeConversationHistoryIndexes();
      rmSync(root, { recursive: true, force: true });
    }
  },
});

async function expectWithinViewport(locator, page) {
  await expect(locator).toBeVisible();
  const viewport = page.viewportSize();
  // Popup placement is computed in requestAnimationFrame; wait for its layout.
  // Soft geometry assertions retain the remaining protocol evidence on failure.
  await expect.configure({ soft: true }).poll(() => locator.evaluate((el, viewport) => {
    const box = el.getBoundingClientRect();
    return Object.entries({
      left: Math.max(0, -box.left), top: Math.max(0, -box.top),
      right: Math.max(0, box.right - viewport.width), bottom: Math.max(0, box.bottom - viewport.height),
      horizontalOverflow: Math.max(0, el.scrollWidth - el.clientWidth),
    }).filter(([, overflow]) => overflow > 1);
  }, viewport), { message: `${locator} must fit ${viewport.width}×${viewport.height}` }).toEqual([]);
}

async function showSidebar(page) {
  if (!await page.locator('.sidebar-navigation:visible').count()) {
    await page.locator('.header-sidebar-toggle:visible, .yeaft-topbar-sidebar-toggle:visible').first().click();
  }
  await expect(page.locator('.sidebar-navigation:visible')).toBeVisible();
}

async function hideMobileSidebar(page) {
  if (page.viewportSize().width <= 640 && await page.locator('.sidebar-navigation:visible').count()) {
    await page.locator('.yeaft-sidebar .sidebar-icon-btn[title="Collapse sidebar"]:visible').click();
  }
}

const member = (dialog, id) => dialog.locator('.group-settings-roster-item')
  .filter({ has: dialog.page().locator(`input[value="${id}"]`) });

// One end-to-end catalog/legacy-Session journey, repeated in two presentation
// environments rather than splitting the same protocol contract into many cases.
test('ordinary Session scenes persist through a live switch and reload without exposing VP names', async ({ page, serverUrl, mockAgent }, info) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => localStorage.setItem('locale', 'en'));
  await page.setViewportSize({ width: 1360, height: 900 });
  const fixture = mockAgent.catalog;
  await page.goto(serverUrl);
  await expect(page.locator('.chat-page, .yeaft-page').first()).toBeVisible();
  fixture.publish();
  await showSidebar(page);
  await expect(page.locator('.sidebar-session-row:visible').filter({ hasText: 'Legacy collaboration' })).toBeVisible();
  await page.locator('.sidebar-primary-action:visible').filter({ hasText: 'New chat' }).click();
  const create = page.locator('.yeaft-session-create-modal');
  const createScene = create.getByRole('combobox', { name: 'Scene', exact: true });
  await expect(createScene).toHaveValue('general');
  await expect(createScene.locator('option')).toHaveText([
    'General', 'Software', 'Frontend', 'Writing', 'Content creation', 'Video editing', 'Primary education', 'Investment',
  ]);
  await expect(create.locator('.yeaft-roster-trigger')).toHaveCount(0);
  await createScene.focus();
  await createScene.press('ArrowDown');
  await expect(createScene).toHaveValue('software');
  const title = 'Scene switch regression';
  await create.getByPlaceholder('Session name (optional)').fill(title);
  await create.locator('.workdir-input-group input').fill(fixture.root);
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(create).toHaveCount(0);
  const [{ payload }] = mockAgent.messages('yeaft_create_session');
  expect(payload).toMatchObject({ name: title, sceneId: 'software' });
  for (const key of ['roster', 'vpIds', 'defaultVpId', 'task']) expect(payload).not.toHaveProperty(key);
  const sessions = () => snapshotSessions(fixture.root).filter(row => row.name === title);
  const [{ id: sessionId }] = sessions();
  const readConfig = () => JSON.parse(readFileSync(sessionConfigPath(fixture.root, sessionId), 'utf8'));
  expect(readConfig()).toMatchObject({ sceneId: 'software' });
  expect(sessions()).toEqual([expect.objectContaining({ id: sessionId, roster: ['omni'], defaultVpId: 'omni' })]);

  const wire = sessionTurnWire(page, mockAgent, { sessionId, conversationId });
  fixture.turnWire = { sessionId, ...wire };
  // Creating from the vendor chat surface opens the new native Session.
  const composer = page.locator('.yeaft-session-input [data-message-composer]');
  const scene = composer.getByRole('button', { name: /^Scene:/ });
  const sceneMenu = composer.getByRole('listbox', { name: 'Scene', exact: true });
  const expectScene = id => expect(scene).toHaveAccessibleName(`Scene: ${id}`);
  const activity = page.locator('.yeaft-session-status-toggle');
  const statusPane = page.locator('.yeaft-session-status-pane');
  const status = text => statusPane.locator('.yeaft-vp-timeline-row').filter({ hasText: text });
  await expectScene('Software');
  await expect(scene.locator('.yeaft-model-chevron')).toBeVisible();
  await scene.press('ArrowDown');
  await expect(sceneMenu).toBeVisible();
  const software = sceneMenu.getByRole('option', { name: 'Software', exact: true });
  await expect(software).toBeFocused();
  await expect(software).toHaveAttribute('aria-selected', 'true');
  await expect(software.locator('.yeaft-model-check')).toHaveText('✓');
  await expect(sceneMenu.locator('.yeaft-model-option-label')).toHaveText([
    'General', 'Software', 'Frontend', 'Writing', 'Content creation', 'Video editing', 'Primary education', 'Investment',
  ]);
  await expectWithinViewport(sceneMenu, page);
  await software.press('Escape');
  await expect(sceneMenu).toHaveCount(0);
  await expect(scene).toBeFocused();
  const model = composer.locator('.yeaft-composer-model');
  await model.click();
  await expect(model).toHaveAttribute('aria-expanded', 'true');
  await scene.click();
  await expect(model).toHaveAttribute('aria-expanded', 'false');
  await expect(sceneMenu).toBeVisible();
  await page.screenshot({ path: info.outputPath('scene-menu-desktop.png'), fullPage: true });
  await model.click();
  await expect(sceneMenu).toHaveCount(0);
  await expect(model).toHaveAttribute('aria-expanded', 'true');
  await model.press('Escape');
  await expect(composer.locator('.chat-composer-actions .session-scene-select__trigger')).toHaveCount(1);
  const sendUsage = (turn, inputTokens, outputTokens) => wire.event({
    type: 'query_progress', sessionId, ...turn.executions[0], revision: 1,
    inputTokens, outputTokens, modelRequests: 1, toolExecutions: 0, reusedCalls: 0, repeatedCalls: 0,
    failedCalls: 0, lastEvidenceAt: null, stage: 'running', reason: null, stagnantBatches: 0,
  });
  const first = await wire.send('First scene question');
  wire.delta(first, 'First scene answer');
  const firstAnswer = page.locator('.assistant-turn').filter({ hasText: 'First scene answer' });
  await expect(firstAnswer).toBeVisible();
  await expect(firstAnswer).toHaveClass(/streaming/);

  await scene.press('ArrowDown');
  await software.press('ArrowDown');
  const frontend = sceneMenu.getByRole('option', { name: 'Frontend', exact: true });
  await expect(frontend).toBeFocused();
  await frontend.press('ArrowDown');
  const writing = sceneMenu.getByRole('option', { name: 'Writing', exact: true });
  await expect(writing).toBeFocused();
  await writing.press('Enter');
  await expect(scene).toBeEnabled();
  await expectScene('Writing');
  expect(mockAgent.messages('yeaft_update_session_config')).toEqual([
    expect.objectContaining({ sessionId, config: { sceneId: 'writing' } }),
  ]);
  expect(readConfig()).toMatchObject({ sceneId: 'writing' });
  expect(sessions()).toEqual([expect.objectContaining({ id: sessionId, roster: ['omni'], defaultVpId: 'omni' })]);
  await expect(firstAnswer).toHaveClass(/streaming/);

  const second = await wire.send('Second scene question');
  expect(second.userTurnId).not.toBe(first.userTurnId);
  wire.delta(second, 'Second scene answer');
  const region = page.locator('.parallel-turn-region');
  const expectAnonymous = async (surface) => {
    await expect(surface.locator('.vp-turn-block-name, .vp-speaker-header')).toHaveCount(0);
    await expect(surface).not.toContainText(/\bOmni\b/i);
  };
  await expect(region.locator('.parallel-turn-pane')).toHaveCount(2);
  await expect(pane(page, first)).toContainText('First scene answer');
  await expect(pane(page, first)).not.toContainText('Second scene answer');
  await expect(pane(page, second)).toContainText('Second scene answer');
  await expect(pane(page, second)).not.toContainText('First scene answer');
  await expectAnonymous(region);
  if (await activity.getAttribute('aria-expanded') === 'false') await activity.click();
  sendUsage(first, 1111, 21);
  sendUsage(second, 2222, 43);
  await expect(status('First scene question')).toContainText('1,111');
  await expect(status('Second scene question')).toContainText('2,222');
  await expect(status('Second scene question')).not.toContainText('1,111');
  await expect(status('Second scene question').locator('.yeaft-session-activity-elapsed')).toContainText(/Elapsed .+s/);
  await expect(statusPane.getByText('Execution status')).toBeVisible();
  await expect(statusPane).not.toContainText(/\b(VPs?|Omni)\b/i);

  await scene.press('ArrowDown');
  await expect(sceneMenu.getByRole('option', { name: 'Writing', exact: true })).toBeFocused();
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(sceneMenu).toHaveCount(0);
  await expect(scene).toBeFocused();
  await page.evaluate(() => window.Pinia.useChatStore().closeSessionSidebar());
  const effort = composer.locator('.yeaft-composer-effort');
  const modelMenu = composer.locator('.yeaft-composer-model-dropdown');
  const attach = composer.locator('.attach-btn');
  const stop = composer.locator('.stop-btn');
  const send = composer.locator('.send-btn:not(.stop-btn)');
  for (const [width, theme] of [[390, 'light'], [320, 'dark']]) {
    await page.setViewportSize({ width, height: 740 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const control of [attach, scene, model, effort, stop, send]) await expectWithinViewport(control, page);
    // Geometry matters: attachment and scene sit above the editor (not a
    // wrapped row below it), with the trailing actions on a single row.
    await expect(composer.locator('.chat-composer-top-actions .attach-btn')).toHaveCount(1);
    await expect(composer.locator('.chat-composer-top-actions .session-scene-select__trigger')).toHaveCount(1);
    await expect(composer.locator('input[type="file"]')).toHaveCount(1);
    expect(await composer.evaluate(el => {
      const container = el.getBoundingClientRect();
      const input = el.querySelector('textarea').getBoundingClientRect();
      const top = [...el.querySelectorAll('.chat-composer-top-actions button')].map(button => button.getBoundingClientRect());
      const bottom = [...el.querySelectorAll('.chat-composer-actions-end button')].map(button => button.getBoundingClientRect());
      const within = bounds => bounds.every((rect, index) => rect.left >= container.left - 1 && rect.right <= container.right + 1
        && bounds.slice(index + 1).every(other => rect.right <= other.left + 1));
      return { top: within(top) && top.every(rect => rect.bottom <= input.top + 1),
        bottom: within(bottom) && bottom.every(rect => rect.top >= input.bottom - 1 && Math.abs(rect.top - bottom[0].top) < 1) };
    })).toEqual({ top: true, bottom: true });
    expect(await model.locator('.yeaft-composer-model-name').evaluate(el => el.clientWidth)).toBeGreaterThanOrEqual(60);
    await model.click();
    await expectWithinViewport(modelMenu, page);
    await expect(modelMenu.getByRole('menuitemradio', { name: /Catalog model A/ })).toHaveAttribute('aria-checked', 'true');
    await effort.click();
    await expect(modelMenu).toHaveCount(0);
    await expectWithinViewport(composer.locator('.yeaft-composer-effort-dropdown'), page);
    await effort.press('Escape');
  }
  await page.screenshot({ path: info.outputPath('scene-model-toolbar-dark-320.png'), fullPage: true });
  await scene.click();
  await expectWithinViewport(sceneMenu, page);
  await expect(sceneMenu.getByRole('option', { name: 'Writing', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: info.outputPath('scene-menu-dark-320.png'), fullPage: true });
  await sceneMenu.getByRole('option', { name: 'Writing', exact: true }).press('Tab');
  await expect(sceneMenu).toHaveCount(0);
  await expect(composer.getByRole('textbox')).toBeFocused();
  const tabs = region.getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await tabs.filter({ hasText: 'Second scene question' }).press('Enter');
  await expect(tabs.filter({ hasText: 'Second scene question' })).toHaveAttribute('aria-selected', 'true');
  await expect(pane(page, second).getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await activity.click();
  await expect(statusPane).toBeVisible();
  await expectWithinViewport(statusPane, page);
  await page.screenshot({ path: info.outputPath('scene-status-dark-320.png'), fullPage: true });
  await status('First scene question').getByRole('button', { name: 'Stop First scene question', exact: true }).click();
  await expect.poll(() => mockAgent.messages('yeaft_abort_turn').at(-1)).toMatchObject({ sessionId, userTurnId: first.userTurnId });
  expect(mockAgent.messages('yeaft_abort_turn')).toHaveLength(1);
  wire.finish(first, 'aborted');
  await expect(status('First scene question')).toHaveCount(0);
  await expect(status('Second scene question')).toContainText('2,222');
  await statusPane.getByRole('button', { name: 'Close Session status', exact: true }).click();
  await expect(pane(page, first)).toHaveCount(0);
  await expect(firstAnswer).not.toHaveClass(/streaming/);
  wire.delta(second, ' continues after the first Turn finishes');
  await expect(pane(page, second)).toContainText('Second scene answer continues after the first Turn finishes');
  wire.finish(second);
  await expect(region).toHaveCount(0);
  await expect(page.locator('.assistant-turn.streaming')).toHaveCount(0);

  await page.reload();
  await showSidebar(page);
  await page.locator('.sidebar-session-row:visible').filter({ hasText: title }).click();
  await hideMobileSidebar(page);
  await expectScene('Writing');
  await expect(page.locator('.assistant-turn')).toContainText(['First scene answer', 'Second scene answer continues after the first Turn finishes']);
  await expectAnonymous(page.locator('.chat-container'));
  await expect(region).toHaveCount(0);

  // A converted Session does not need the compatibility owner in its old
  // roster. Verify the activity and Stop action still follow the live turn.
  await attach.focus();
  await page.setViewportSize({ width: 1360, height: 900 });
  await expect(composer.locator('.chat-composer-actions .attach-btn')).toBeFocused();
  // Wait for the responsive layout to commit instead of sampling visibility
  // in the frame between a mobile sidebar closing and the desktop layout.
  await expect(page.locator('.sidebar-navigation:visible')).toBeVisible();
  await page.locator('.sidebar-session-row:visible').filter({ hasText: 'Legacy collaboration' }).click();
  const legacyInput = composer.getByRole('textbox');
  await legacyInput.fill('@linus');
  await expect(page.locator('.vp-mention-autocomplete')).toBeVisible();
  await legacyInput.fill('');
  if (await activity.getAttribute('aria-expanded') === 'false') await activity.click();
  mockAgent.send({ type: 'yeaft_output', conversationId, sessionId: fixture.legacyId,
    event: { type: 'session_turns', sessionId: fixture.legacyId, turns: [] } });
  const legacyStatus = state => mockAgent.send({ type: 'yeaft_output', conversationId, sessionId: fixture.legacyId,
    event: { type: 'vp_status_changed', sessionId: fixture.legacyId, vpId: 'linus', state } });
  legacyStatus('tool');
  await expect(statusPane.getByText('using tool…')).toBeVisible();
  await expect(statusPane).not.toContainText(/\b(VPs?|Linus|Martin)\b/i);
  await statusPane.getByRole('button', { name: 'Stop Turn 1', exact: true }).click();
  await expect.poll(() => mockAgent.messages('yeaft_abort_turn').at(-1)).toMatchObject({ sessionId: fixture.legacyId, vpId: 'linus' });
  legacyStatus('idle');
  await expect(statusPane.getByText('No active turns.')).toBeVisible();
  await scene.click();
  await sceneMenu.getByRole('option', { name: 'Investment', exact: true }).click();
  await expect(scene).toBeEnabled();
  await expectScene('Investment');
  expect(fixture.session()).toMatchObject({ roster: ['linus', 'martin'], config: { sceneId: 'investment' } });
  const converted = sessionTurnWire(page, mockAgent, { sessionId: fixture.legacyId, conversationId });
  fixture.turnWire = { sessionId: fixture.legacyId, ...converted };
  const convertedTurn = await converted.send('Evaluate the finding');
  converted.delta(convertedTurn, 'Converted Session response');
  if (await activity.getAttribute('aria-expanded') === 'false') await activity.click();
  await expect(status('Evaluate the finding')).toContainText('streaming');
  await expect(statusPane).not.toContainText(/\b(VPs?|Omni|Linus|Martin)\b/i);
  await expectAnonymous(page.locator('.chat-container'));
  converted.finish(convertedTurn);

  // Reproduce a committed scene whose receipt is lost: the browser must
  // verify it from the Agent, rather than roll back or send a second write.
  fixture.omitSceneReceipt = true;
  const initialLists = mockAgent.messages('yeaft_list_sessions').length;
  await scene.click();
  await sceneMenu.getByRole('option', { name: 'Frontend', exact: true }).click();
  await expect(scene).toHaveAttribute('aria-busy', 'true');
  const sceneError = composer.locator('.yeaft-composer-scene-error');
  await expect(scene).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 });
  await expectScene('Frontend');
  await expect(sceneError).toHaveCount(0);
  expect(fixture.session()).toMatchObject({ config: { sceneId: 'frontend' } });
  expect(mockAgent.messages('yeaft_list_sessions')).toHaveLength(initialLists + 1);
  expect(mockAgent.messages('yeaft_update_session_config').filter(msg => msg.config?.sceneId === 'frontend')).toHaveLength(1);
  fixture.omitSceneReceipt = false;

  // Newer scenes need an Agent that advertises them. Without those capabilities
  // the menu keeps the original scenes plus the newer scene this Session uses.
  await scene.click();
  await sceneMenu.getByRole('option', { name: 'Primary education', exact: true }).click();
  await expect(scene).toBeEnabled();
  await expectScene('Primary education');
  expect(fixture.session()).toMatchObject({ config: { sceneId: 'primary-education' } });
  mockAgent.send({ type: 'agent_capabilities_updated', capabilities: [
    'plaintext-ok', 'work_center', 'workbench_session_routes', 'scheduled_tasks', 'session_scenes',
  ] });
  await scene.click();
  await expect(sceneMenu.locator('.yeaft-model-option-label')).toHaveText([
    'General', 'Software', 'Writing', 'Content creation', 'Primary education', 'Investment',
  ]);
  await expect(sceneMenu.getByRole('option', { name: 'Primary education', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(fixture.errors).toEqual([]);
});
