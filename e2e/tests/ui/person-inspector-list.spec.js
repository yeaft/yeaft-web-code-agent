import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { test, expect } from '@playwright/test';

// Component browser fixture: real Vue, VirtualTranscript and inspector styles,
// no auth/Agent services or external models needed for scroll geometry evidence.
const webRoot = resolve(process.env.E2E_PROJECT_ROOT || process.cwd(), 'web');
let server;
let origin;
const fixture = `<!doctype html><html><head>
<link rel="stylesheet" href="/web/styles/variables.css"><link rel="stylesheet" href="/web/styles/digital-person.css">
<style>*{box-sizing:border-box}body{margin:0}.person-page{height:100dvh}.person-inspector-list{padding:12px}summary{min-height:60px}pre{margin:0}button{min-height:32px}</style>
</head><body><div id="fixture"></div><script src="/web/vendor/vue.global.prod.js"></script>
<script type="module">
import PersonInspectorList from '/web/components/PersonInspectorList.js';
const makeRows = (count, prefix = 'row') => Array.from({length:count}, (_, i) => ({id:prefix + '-' + i, text:'Record ' + i}));
window.fixtureState = Vue.reactive({ items:makeRows(40), token:1, loading:false, identity:'agent-a', requests:0 });
Vue.createApp({components:{PersonInspectorList}, setup(){
  const state = window.fixtureState;
  function more(){ state.requests++; state.loading = true; setTimeout(() => {
    state.items.push(...makeRows(20, 'page-' + state.token)); state.token++; state.loading = false;
  }, 80); }
  return {state, more};
}, template: \`<div class="person-page"><PersonInspectorList :items="state.items" label="Inspector records" more-label="Load older" :more="true" :page-token="state.token" :reset-key="state.identity" :loading="state.loading" :estimate-height="() => 80" @more="more">
  <template #before><p>Bounded latest-first records</p></template>
  <template #default="{item}"><details :data-row-id="item.id"><summary>{{item.text}}</summary><pre style="height:800px;white-space:pre-wrap">Long detail — {{item.id}}</pre></details></template>
</PersonInspectorList></div>\`}).mount('#fixture');
window.fixtureReady = true;
</script></body></html>`;

const taskFixture = `<!doctype html><html><head>
<link rel="stylesheet" href="/web/styles/variables.css"><link rel="stylesheet" href="/web/styles/digital-person.css">
<style>*{box-sizing:border-box}body{margin:0}.person-page{height:100dvh}.person-inspector-list{padding:12px}button{min-height:32px}</style>
</head><body><div id="fixture"></div><script src="/web/vendor/vue.global.prod.js"></script>
<script type="module">
import PersonTaskBrowser from '/web/components/PersonTaskBrowser.js';
import en from '/web/i18n/en.js';
const makeHistory = count => Array.from({length:count}, (_, i) => ({id:'history-' + i, title:'Settled ' + i, status:'completed', createdAt:1000-i}));
window.fixtureState = Vue.reactive({ identity:'agent-a', requests:0, stops:[], logs:[], page:{tasks:makeHistory(200), agents:[], nextCursor:'older-1', loaded:true, loading:false,
  active:{ tasks:[{id:'old-shell', title:'Old running shell', status:'running', createdAt:1}, {id:'child-task', kind:'sub_agent', agentId:'old-agent', status:'running', createdAt:2}],
    agents:[{id:'old-agent', name:'Detached tools', status:'completed', executionPending:true, createdAt:2}], truncated:false }} });
const app = Vue.createApp({components:{PersonTaskBrowser}, setup(){
  const state = window.fixtureState;
  function more(){ state.requests++; state.page.loading = true; setTimeout(() => {
    state.page.tasks.push({id:'older-page', title:'Older record', status:'completed', createdAt:0}); state.page.nextCursor='older-2'; state.page.loading=false;
  },80); }
  return {state, more};
}, template: \`<div class="person-page"><PersonTaskBrowser :page="state.page" :log="{}" :identity-key="state.identity" @more="more" @log="id => state.logs.push(id)" @stop="(kind,id) => state.stops.push([kind,id])" /></div>\`});
app.config.globalProperties.$t = key => en[key] || key;
app.mount('#fixture'); window.fixtureReady = true;
</script></body></html>`;

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    if (request.url === '/' || request.url === '/tasks') { response.setHeader('Content-Type', 'text/html'); response.end(request.url === '/tasks' ? taskFixture : fixture); return; }
    const path = resolve(webRoot, decodeURIComponent(request.url.replace(/^\/web\//, '')));
    if (!request.url.startsWith('/web/') || !path.startsWith(webRoot + sep)) { response.writeHead(404).end(); return; }
    try {
      response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

for (const theme of ['light', 'dark']) {
  for (const width of [1280, 320]) {
    test(`bounded inspector scroll and keyboard continuity: ${theme}, ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 600 });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      await page.waitForFunction(() => window.fixtureReady);
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const scroller = page.getByRole('region', { name: 'Inspector records' });
      const row0 = page.locator('[data-row-id="row-0"]');
      await expect(row0).toBeVisible();
      expect(await page.locator('[data-row-id]').count()).toBeLessThan(20);
      await expect.poll(() => page.evaluate(() => window.fixtureState.requests)).toBe(0);

      // Programmatic layout/scroll does not page. A deliberate forward wheel
      // requests exactly one page and response/height changes do not drain more.
      await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(120);
      expect(await page.evaluate(() => window.fixtureState.requests)).toBe(0);
      await scroller.hover();
      await page.mouse.wheel(0, 150);
      await expect.poll(() => page.evaluate(() => window.fixtureState.items.length)).toBe(60);
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => window.fixtureState.requests)).toBe(1);

      // Home/End navigates through virtual rows; details persist across unmounts.
      await scroller.focus();
      await page.keyboard.press('Home');
      await expect(row0.locator('summary')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(row0).toHaveAttribute('open', '');
      await page.keyboard.press('End');
      await expect(page.locator('[data-row-id="page-1-19"] summary')).toBeFocused();
      await page.keyboard.press('Home');
      await expect(row0.locator('summary')).toBeFocused();
      await expect(row0).toHaveAttribute('open', '');
      await page.keyboard.press('Escape');
      await expect(row0).not.toHaveAttribute('open', '');
      await expect(row0.locator('summary')).toBeFocused();

      // Switching identity clears measured windows/disclosure, even reused ids.
      await page.keyboard.press('Enter');
      await expect(row0).toHaveAttribute('open', '');
      await page.evaluate(() => {
        window.fixtureState.identity = 'agent-b';
        window.fixtureState.items = Array.from({ length: 40 }, (_, i) => ({ id: 'row-' + i, text: 'Replacement ' + i }));
      });
      await expect(row0).not.toHaveAttribute('open', '');
      await expect(row0.locator('summary')).toHaveText('Replacement 0');
      await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    });

    test(`old active task controls and history paging: ${theme}, ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 600 });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/tasks');
      await page.waitForFunction(() => window.fixtureReady);
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const scroller = page.locator('.person-inspector-list');
      const child = page.locator('[data-task-id="old-agent"]');
      const shell = page.locator('[data-task-id="old-shell"]');
      await expect(child).toBeVisible();
      await expect(shell).toBeVisible();
      expect(await page.locator('[data-task-id]').count()).toBeLessThan(20);
      await child.getByRole('button', { name: 'View log', exact: true }).click();
      expect(await page.evaluate(() => window.fixtureState.logs)).toEqual(['child-task']);
      await child.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(child.locator('.btn-secondary')).toBeFocused();
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => window.fixtureState.stops)).toEqual([['agent', 'old-agent']]);

      // A fresh empty control snapshot removes active-only records immediately,
      // without draining history or retaining executable cleanup controls.
      await page.evaluate(() => { window.fixtureState.page.active = {tasks:[], agents:[], truncated:false}; });
      await expect(child).toHaveCount(0);
      await expect(shell).toHaveCount(0);
      await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(120);
      expect(await page.evaluate(() => window.fixtureState.requests)).toBe(0);
      await scroller.hover();
      await page.mouse.wheel(0, 150);
      await expect.poll(() => page.evaluate(() => window.fixtureState.page.tasks.length)).toBe(201);
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => window.fixtureState.requests)).toBe(1);
      await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.getByRole('button', { name: 'Load more', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.fixtureState.requests)).toBe(2);
      await expect.poll(() => page.evaluate(() => window.fixtureState.page.loading)).toBe(false);

      await page.evaluate(() => {
        window.fixtureState.identity = 'agent-b';
        window.fixtureState.page = {tasks:[], agents:[], active:{tasks:[], agents:[]}, loaded:true, nextCursor:null};
      });
      await expect(page.getByText('No background tasks or child threads yet.')).toBeVisible();
      await expect(page.locator('[data-task-id]')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    });
  }
}
