import { expect } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, TestServer, getAvailablePort, useTestServer, useMockAgent } from '../../fixtures/test-server.js';
import { MockAgent } from '../../fixtures/mock-agent.js';
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

const recommended = ['omni', 'software-omni', 'writing-omni', 'short-video-omni', 'quant-omni'];
const customId = 'catalog-custom';

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
      const models = [{ id: 'catalog-model-a', label: 'Catalog model A', provider: 'fixture' },
        { id: 'catalog-model-b', label: 'Catalog model B', provider: 'fixture' }];
      const status = () => ({ model: 'fixture/catalog-model-a', availableModels: models,
        catalogRevision: 1, catalogEpoch: 'vp-catalog-fixture', catalogRefreshedAt: Date.now() });
      agent.catalog = { root, libDir, legacyId: legacy.id, publish, errors: [],
        session: () => snapshotSessions(root).find(row => row.id === legacy.id) };
      agent._messageHandlers.push(request => {
        const reply = (op, payload) => send({ type: 'session_crud_result', op, requestId: request.requestId,
          ok: true, ...payload }, request.requestId);
        try {
          switch (request.type) {
            case 'yeaft_vp_subscribe':
              send({ type: 'vp_snapshot', vps: scanVpLibrary({ dir: libDir }).map(serializeVpForWire), emptyLibrary: false }, request.requestId);
              return;
            case 'yeaft_load_history': {
              const sessionId = request.sessionId;
              if (!sessionId) return;
              const conversationId = 'yeaft-vp-catalog-fixture';
              agent.send({ type: 'yeaft_output', conversationId, sessionId,
                event: { type: 'session_ready', conversationId, sessionId, ...status() } });
              if (request.limit === 0) return;
              const messages = history.loadAllBySession(sessionId).map(row => ({ ...row,
                seq: Number(row.id.slice(1)), ts: Date.parse(row.time) }));
              agent.send({ type: 'yeaft_history_chunk', sessionId, requestId: request.requestId,
                mode: 'recent', messages, oldestSeq: messages[0]?.seq ?? null,
                latestSeq: messages.at(-1)?.seq ?? null, hasMore: false });
              return;
            }
            case 'yeaft_list_sessions': reply('list', { sessions: snapshotSessions(root) }); return;
            case 'yeaft_scan_workdir_sessions': reply('scan_workdir', { sessions: snapshotSessions(root)
              .filter(row => row.workDir === request.workDir).map(row => ({ ...row, alreadyRegistered: true })) }); return;
            case 'yeaft_create_session': reply('create', { session: createSessionFromSpec(root, request.payload, { libDir }) }); break;
            case 'yeaft_rename_session': reply('rename', { session: renameSession(root, request.sessionId, request.name) }); break;
            case 'yeaft_update_session': reply('update', { session: updateSessionAnnouncement(root, request.sessionId, request.patch.announcement) }); break;
            case 'yeaft_update_session_config': reply('update_config', { sessionId: request.sessionId,
              config: updateSessionConfig(root, request.sessionId, request.config) }); break;
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
      await useMockAgent(agent, use);
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

async function openSettings(page, title) {
  await showSidebar(page);
  const row = page.locator('.sidebar-session-row:visible').filter({ hasText: title });
  await row.hover();
  await row.locator('.session-dots-btn').click();
  await page.locator('.session-menu-floating').getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.group-settings-modal')).toBeVisible();
  return page.locator('.group-settings-overlay');
}

const member = (dialog, id) => dialog.locator('.group-settings-roster-item')
  .filter({ has: dialog.page().locator(`input[value="${id}"]`) });

// One end-to-end catalog/legacy-Session journey, repeated in two presentation
// environments rather than splitting the same protocol contract into many cases.
test('scenario catalog preserves legacy Session members, history and mentions through real relay and disk CRUD', async ({ page, serverUrl, mockAgent }, info) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    localStorage.setItem('locale', 'en');
    localStorage.setItem('theme', new URL(location.href).searchParams.get('catalogTheme') || 'light');
  });
  const fixture = mockAgent.catalog;
  const vpFilesBefore = readdirSync(fixture.libDir).sort();
  const legacySouls = ['linus', 'martin'].map(id => readFileSync(join(fixture.libDir, id, 'role.md'), 'utf8'));
  let title = 'Legacy collaboration';
  for (const surface of [{ width: 1360, height: 900, theme: 'light' }, { width: 320, height: 740, theme: 'dark' }]) {
    const suffix = `${surface.theme}-${surface.width}`;
    await test.step(suffix, async () => {
      await page.setViewportSize({ width: surface.width, height: surface.height });
      await page.goto(`${serverUrl}/?catalogTheme=${surface.theme}`);
      await expect(page.locator('.chat-page, .yeaft-page').first()).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', surface.theme);
      fixture.publish();
      await showSidebar(page);
      await expect(page.locator('.sidebar-session-row:visible').filter({ hasText: title })).toBeVisible();
      await page.locator('.sidebar-primary-action:visible').filter({ hasText: 'New chat' }).click();
      const create = page.locator('.yeaft-session-create-modal');
      await expect(create).toBeVisible();
      const trigger = create.locator('.yeaft-roster-trigger');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(trigger).toHaveAttribute('aria-controls', 'yeaft-session-create-vp-picker');
      const picker = create.locator('#yeaft-session-create-vp-picker');
      const ids = () => picker.locator('input[type="checkbox"]').evaluateAll(inputs => inputs.map(input => input.value));
      expect(await ids()).toEqual([...recommended, customId]);
      await expect(picker.locator('input[value="omni"]')).toBeChecked();
      await info.attach(`vp-create-geometry-${suffix}`, { contentType: 'application/json',
        body: JSON.stringify(await create.evaluate(el => {
          const box = el.getBoundingClientRect();
          const overlay = el.closest('.modal-overlay');
          const style = getComputedStyle(overlay);
          return { viewport: { width: innerWidth, height: innerHeight },
            modal: { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom },
            overlay: { padding: style.padding, boxSizing: style.boxSizing } };
        }), null, 2) });
      await expectWithinViewport(create, page);
      await expectWithinViewport(picker, page);
      const toggle = picker.locator('.vp-catalog-legacy-toggle');
      await toggle.focus();
      await expect(toggle).toBeFocused();
      await page.keyboard.press('Space');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(await ids()).toEqual(expect.arrayContaining(['linus', 'martin']));
      expect(await ids()).toHaveLength(vpFilesBefore.length);
      expect(await picker.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
      // A selected legacy draft stays pinned when the catalog is collapsed.
      await picker.locator('input[value="martin"]').check();
      await picker.getByRole('button', { name: 'Hide legacy VPs', exact: true }).click();
      await expect(picker.locator('input[value="martin"]')).toBeChecked();
      await expect(picker.locator('input[value="linus"]')).toHaveCount(0);
      await picker.getByRole('button', { name: 'Show legacy VPs', exact: true }).click();
      await picker.locator(`input[value="${customId}"]`).scrollIntoViewIfNeeded();
      expect(await picker.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      await expectWithinViewport(picker, page);
      await page.screenshot({ path: info.outputPath(`vp-create-expanded-${suffix}.png`) });
      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('Escape');
      await expect(create).toHaveCount(0);
      // Cancelling the presentation-only catalog does not mutate any Session.
      expect(fixture.session()).toMatchObject({ roster: ['linus', 'martin'], defaultVpId: 'linus' });
      await page.locator('.sidebar-session-row:visible').filter({ hasText: title }).click();
      await expect(page.locator('.assistant-turn').filter({ hasText: 'linus preserved historical answer' })).toBeVisible();
      await expect(page.locator('.assistant-turn').filter({ hasText: 'martin preserved historical answer' })).toBeVisible();
      let dialog = await openSettings(page, title);
      await dialog.getByRole('tab', { name: 'Members', exact: true }).click();
      for (const id of ['linus', 'martin']) await expect(member(dialog, id).locator('input')).toBeChecked();
      await expect(member(dialog, 'linus').locator('.group-settings-default-star')).toHaveAttribute('aria-pressed', 'true');
      await expect(member(dialog, 'linus').locator('.group-settings-default-star')).toBeDisabled();
      await expect(dialog.locator('.vp-catalog-help')).toContainText('until you explicitly remove them');
      await expect(dialog.getByRole('button', { name: 'Show legacy VPs', exact: true })).toHaveAttribute('aria-expanded', 'false');
      await expectWithinViewport(dialog.locator('.group-settings-modal'), page);
      await dialog.getByRole('tab', { name: 'Session', exact: true }).click();
      const renamed = `Legacy collaboration ${suffix}`;
      await dialog.locator('.group-settings-section-session .group-settings-input').first().fill(renamed);
      await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
      await expect.poll(() => fixture.session().name).toBe(renamed);
      await expect(dialog.getByRole('button', { name: 'Save name', exact: true })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
      title = renamed;
      expect(fixture.session()).toMatchObject({ roster: ['linus', 'martin'], defaultVpId: 'linus' });
      await dialog.locator('textarea').fill(`Shared briefing ${suffix}\n${'Long collaboration context. '.repeat(40).trim()}`);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => fixture.session().announcement).toContain(`Shared briefing ${suffix}`);
      await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
      expect(fixture.session()).toMatchObject({ roster: ['linus', 'martin'], defaultVpId: 'linus' });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await hideMobileSidebar(page);
      await page.locator('.yeaft-composer-model').click();
      const model = surface.theme === 'light' ? 'B' : 'A';
      await page.getByRole('menuitemradio', { name: new RegExp(`Catalog model ${model}`) }).click();
      await expect.poll(() => fixture.session().config.model).toBe(`fixture/catalog-model-${model.toLowerCase()}`);
      expect(fixture.session()).toMatchObject({ roster: ['linus', 'martin'], defaultVpId: 'linus' });
      dialog = await openSettings(page, title);
      await dialog.getByRole('tab', { name: 'Members', exact: true }).click();
      // Remove only the non-default member; collapsing does not rebuild a roster.
      await member(dialog, 'martin').locator('input').uncheck();
      await expect.poll(() => fixture.session().roster).toEqual(['linus']);
      expect(fixture.session().defaultVpId).toBe('linus');
      await expect(member(dialog, 'martin')).toHaveCount(0);
      const showLegacy = dialog.locator('.vp-catalog-legacy-toggle');
      await showLegacy.focus();
      await page.keyboard.press('Enter');
      await expect(showLegacy).toHaveAttribute('aria-expanded', 'true');
      await expect(member(dialog, 'martin').locator('input')).not.toBeChecked();
      await member(dialog, 'martin').locator('input').check();
      await expect.poll(() => fixture.session().roster).toEqual(['linus', 'martin']);
      await dialog.getByRole('button', { name: 'Hide legacy VPs', exact: true }).click();
      await expect(member(dialog, 'martin').locator('input')).toBeChecked();
      await member(dialog, customId).scrollIntoViewIfNeeded();
      expect(await dialog.locator('.group-settings-pane').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      await expectWithinViewport(dialog.locator('.group-settings-modal'), page);
      await page.screenshot({ path: info.outputPath(`vp-legacy-members-${suffix}.png`) });
      // The library has the same default catalog, not a destructive migration.
      await dialog.getByRole('button', { name: 'Open VP Library', exact: true }).click();
      const library = page.locator('.vp-crud-panel:visible');
      await expect(library.locator('.vp-crud-card')).toHaveCount(6);
      await expect(library.locator('.vp-crud-card').filter({ hasText: 'Custom research partner' })).toBeVisible();
      const libraryToggle = library.locator('.vp-catalog-legacy-toggle');
      await libraryToggle.focus();
      await page.keyboard.press('Enter');
      await expect(libraryToggle).toHaveAttribute('aria-expanded', 'true');
      await expect(library.locator('.vp-crud-card')).toHaveCount(vpFilesBefore.length);
      const linus = library.locator('.vp-crud-card').filter({ hasText: 'Linus Torvalds' });
      await linus.scrollIntoViewIfNeeded();
      await expect(linus.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
      await expect(linus.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
      await expectWithinViewport(page.locator('.settings-dialog:visible'), page);
      await page.screenshot({ path: info.outputPath(`vp-library-expanded-${suffix}.png`) });
      await library.getByRole('button', { name: 'Hide legacy VPs', exact: true }).click();
      await expect(library.locator('.vp-crud-card')).toHaveCount(6);
      await page.locator('.settings-close:visible').click();
      await hideMobileSidebar(page);
      const input = page.locator('.yeaft-session-input textarea');
      for (const id of ['linus', 'martin']) {
        await input.fill(`@${id.slice(0, 3)}`);
        const option = page.getByRole('option').filter({ hasText: `@${id}` });
        await expect(option).toBeVisible();
        await expectWithinViewport(page.locator('.vp-mention-autocomplete'), page);
        if (id === 'martin') await page.screenshot({ path: info.outputPath(`vp-mention-${suffix}.png`) });
        await input.press('ArrowDown');
        await input.press('Tab');
        await expect(input).toHaveValue(`@${id} `);
      }
      await input.fill('');
      await expect(page.locator('.assistant-turn').filter({ hasText: 'linus preserved historical answer' })).toBeVisible();
      await expect(page.locator('.assistant-turn').filter({ hasText: 'martin preserved historical answer' })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`vp-history-${suffix}.png`) });
      expect(fixture.session()).toMatchObject({ roster: ['linus', 'martin'], defaultVpId: 'linus' });
      expect(fixture.errors).toEqual([]);
      expect(readdirSync(fixture.libDir).sort()).toEqual(vpFilesBefore);
      expect(['linus', 'martin'].map(id => readFileSync(join(fixture.libDir, id, 'role.md'), 'utf8'))).toEqual(legacySouls);
    });
  }
  const requests = mockAgent.messages();
  expect(requests.filter(row => row.type === 'yeaft_session_remove_member').map(row => row.vpId)).toEqual(['martin', 'martin']);
  expect(requests.filter(row => row.type === 'yeaft_session_add_member').map(row => row.vpId)).toEqual(['martin', 'martin']);
  expect(requests.some(row => /delete|archive/.test(row.type))).toBe(false);
  expect(new ConversationStore(fixture.root).loadAllBySession(fixture.legacyId).filter(row => row.role === 'assistant')
    .map(row => row.content)).toEqual(['linus preserved historical answer', 'martin preserved historical answer']);
});
