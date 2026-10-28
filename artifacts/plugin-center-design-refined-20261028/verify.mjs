import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const errors = [], requests = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) requests.push(r.url()); });
async function check(name, run) { await run(); checks.push(name); }
async function screenshot(name) { await page.waitForTimeout(300); await page.screenshot({ path: path.join(dir, name), fullPage: true, animations: 'disabled' }); }
async function setAgent(name) { await page.getByRole('button', { name: '选择 Agent', exact: true }).click(); await page.getByRole('menuitemradio', { name, exact: true }).click(); }
async function singleRow() {
  const layout = await page.evaluate(() => {
    const header = document.querySelector('.preview-header');
    const rect = header.getBoundingClientRect();
    const children = [...header.children].filter(e => getComputedStyle(e).display !== 'none').map(e => e.getBoundingClientRect());
    return { height: rect.height, inside: children.every(r => r.top >= rect.top && r.bottom <= rect.bottom), overflow: document.documentElement.scrollWidth > innerWidth, headerOverflow: header.scrollWidth > header.clientWidth };
  });
  assert(layout.height <= 64 && layout.inside && !layout.overflow && !layout.headerOverflow, JSON.stringify(layout));
}
try {
  await page.goto(pathToFileURL(path.join(dir, 'index.html')).href);
  await page.locator('.preview-plugin').first().waitFor();
  await check('复用真实 Session 列表，插件入口紧跟新建聊天', async () => {
    assert.deepEqual(await page.locator('.sidebar-primary-actions > button').allTextContents().then(xs => xs.map(x => x.trim())), ['新建聊天', '插件']);
    assert.equal(await page.locator('.sidebar-session-row').count(), 7);
    assert.equal(await page.locator('.preview-plugin').count(), 8);
  });
  await check('桌面顶部单行工具栏，无多行标题提示', singleRow);
  await screenshot('01-overview-dark.png');
  await page.getByRole('button', { name: '查看 代码审查 详情', exact: true }).click();
  await screenshot('02-detail-dark.png');
  await page.getByRole('button', { name: '所有插件', exact: true }).click();
  const reviewSwitch = () => page.locator('[data-entry="code-review"]').getByRole('switch');
  await check('不同 Agent 开关互不影响', async () => {
    await reviewSwitch().click();
    await setAgent('C1');
    assert.equal(await reviewSwitch().getAttribute('aria-checked'), 'true');
    await page.waitForTimeout(600);
    assert.equal(await reviewSwitch().getAttribute('aria-checked'), 'true');
    await setAgent('server');
    assert.equal(await reviewSwitch().getAttribute('aria-checked'), 'false');
    await reviewSwitch().click();
    await page.waitForTimeout(600);
  });
  await setAgent('C1');
  await screenshot('05-agent-c1-dark.png');
  await page.getByRole('button', { name: '选择 Agent', exact: true }).click();
  await screenshot('06-agent-picker-dark.png');
  await page.getByRole('menuitemradio', { name: 'server', exact: true }).click();
  await check('搜索和分类共同筛选', async () => {
    await page.getByRole('button', { name: '技能', exact: true }).click();
    await page.getByRole('searchbox', { name: '搜索插件' }).fill('审查');
    assert.equal(await page.locator('.preview-plugin').count(), 1);
    await page.getByRole('searchbox', { name: '搜索插件' }).fill('');
    await page.getByRole('button', { name: 'MCP', exact: true }).click();
    assert.equal(await page.locator('.preview-plugin').count(), 0);
    assert.equal(await page.getByText('尚未配置 MCP', { exact: true }).count(), 1);
    await page.getByRole('button', { name: '全部', exact: true }).click();
  });
  await check('保存中点击 Session 直接离开，再点同一 Session 也能离开', async () => {
    await reviewSwitch().click();
    await page.locator('.sidebar-session-row').filter({ hasText: '插件中心体验优化' }).click();
    assert.equal(await page.locator('.preview-catalog').count(), 0);
    assert.equal(await page.locator('.preview-chat').count(), 1);
    await page.waitForTimeout(600);
    await page.locator('.preview-plugin-entry').click();
    await page.locator('.sidebar-session-row').filter({ hasText: '插件中心体验优化' }).click();
    assert.equal(await page.locator('.preview-chat').count(), 1);
    await page.locator('.preview-plugin-entry').click();
    await reviewSwitch().click();
    await page.waitForTimeout(600);
  });
  await check('模拟保存失败可回滚并显示所属 Agent，离开后仍提示', async () => {
    await page.evaluate(() => { window.designPreview.failNext = true; });
    await reviewSwitch().click();
    await page.locator('.sidebar-session-row').filter({ hasText: '插件中心体验优化' }).click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').textContent(), /server.*代码审查.*保存失败/);
    await page.locator('.preview-plugin-entry').click();
    assert.equal(await reviewSwitch().getAttribute('aria-checked'), 'true');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    assert.equal(await reviewSwitch().getAttribute('aria-checked'), 'false');
    await reviewSwitch().click();
    await page.waitForTimeout(600);
    await page.evaluate(() => { window.designPreview.notice = ''; });
  });
  await check('离线时只读，展示必要异常状态', async () => {
    await setAgent('server-2 离线');
    for (const toggle of await page.getByRole('switch').all()) assert(await toggle.isDisabled());
    assert.match(await page.locator('.preview-offline').textContent(), /离线.*只读/);
    await setAgent('server');
  });
  await page.evaluate(() => { window.designPreview.toggleTheme(); });
  await screenshot('03-overview-light.png');
  await page.evaluate(() => { window.designPreview.toggleTheme(); });
  await check('320/375/768/900/1024/1280/1440 宽度顶部单行且无横向溢出', async () => {
    for (const width of [320, 375, 768, 900, 1024, 1280, 1440]) { await page.setViewportSize({ width, height: 900 }); await singleRow(); }
  });
  await check('键盘可进入详情并返回，focus 可见', async () => {
    await page.getByRole('button', { name: '查看 代码审查 详情', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.preview-detail h1').textContent(), '代码审查');
    await page.getByRole('button', { name: '所有插件', exact: true }).focus();
    assert(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none'));
    await page.keyboard.press('Enter');
  });
  await page.setViewportSize({ width: 320, height: 780 });
  await screenshot('04-mobile-dark.png');
  await check('窄屏搜索、分类和侧栏可用', async () => {
    await page.getByRole('button', { name: '搜索插件', exact: true }).click();
    await page.getByRole('searchbox', { name: '搜索插件' }).fill('审查');
    await singleRow();
    assert.equal(await page.locator('.preview-plugin').count(), 1);
    await page.getByRole('searchbox', { name: '搜索插件' }).fill('');
    await page.getByRole('button', { name: '收起搜索', exact: true }).click();
    await page.getByRole('combobox', { name: '插件类型' }).selectOption('tool');
    assert.equal(await page.locator('.preview-plugin').count(), 2);
    await page.getByRole('combobox', { name: '插件类型' }).selectOption('all');
    await page.getByRole('button', { name: '展开 Session 侧栏', exact: true }).click();
    assert(await page.locator('.preview-plugin-entry').isVisible());
    await page.locator('.sidebar-session-row').filter({ hasText: '插件中心体验优化' }).click();
    assert.equal(await page.locator('.preview-chat').count(), 1);
    await page.getByRole('button', { name: '展开 Session 侧栏', exact: true }).click();
    await page.locator('.preview-plugin-entry').click();
  });
  await page.evaluate(() => { window.designPreview.toggleTheme(); });
  await singleRow();
  await screenshot('07-mobile-light.png');
  await check('长名称和长描述不会挤掉开关或导致横向溢出', async () => {
    await page.evaluate(() => {
      document.querySelector('.preview-plugin-name').textContent = '很长的插件名称'.repeat(12);
      document.querySelector('.preview-plugin-description').textContent = 'long-tool-description-'.repeat(40);
    });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(await page.locator('.preview-plugin').first().getByRole('switch').isVisible());
  });
  await check('无浏览器异常，无外部网络请求', async () => { assert.deepEqual(errors, []); assert.deepEqual(requests, []); });
  const report = { scope: '仅静态设计原型；不是产品回归或真实配置写入验证', checks, errors, externalRequests: requests };
  await writeFile(path.join(dir, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
