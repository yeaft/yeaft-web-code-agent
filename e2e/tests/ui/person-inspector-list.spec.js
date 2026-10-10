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

const knowledgeFixture = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/web/styles/index.css">
<style>body{margin:0;display:block}.person-page{height:100dvh;width:min(100%,460px);margin:auto}.person-panel-header{display:flex;justify-content:space-between}button{min-height:32px}</style>
</head><body><div id="fixture"></div><script src="/web/vendor/vue.global.prod.js"></script>
<script type="module">
import PersonKnowledgeBrowser from '/web/components/PersonKnowledgeBrowser.js';
import zhCN from '/web/i18n/zh-CN.js';
const statement = '数据核查宜分别记录源码入口、连接与集合存在、记录数、时间范围，并区分已确认的事实与仍需验证的假设。'.repeat(8);
const description = 'Read and manage background work and collect the actual result, without starting another model call. '.repeat(8);
window.fixtureState = Vue.reactive({section:'memory', requests:0, loading:false, token:'older-1', identity:'agent-a'});
const memories = Array.from({length:40}, (_,i) => ({id:'memory-' + i, kind:i === 0 ? 'method' : 'claim', statement:i + ' ' + statement, epistemicState:'uncertain', revision:1, updatedAt:1000-i}));
const tools = Array.from({length:40}, (_,i) => ({id:i === 0 ? 'CancelTask' : i === 1 ? 'CloseAgent' : i === 2 ? 'Output.publish' : 'Tool.' + i, domain:i === 0 ? 'tasks' : i === 1 ? 'orchestration' : i === 2 ? 'delivery' : 'filesystem', version:1, description, contract:{useWhen:'Actual work requires this tool.'}}));
const app = Vue.createApp({components:{PersonKnowledgeBrowser}, setup(){
  const state = window.fixtureState;
  const page = Vue.computed(() => ({items:state.section === 'memory' ? memories : tools, loaded:true, loading:state.loading, nextCursor:state.token}));
  function more(){state.requests++; state.loading=true; setTimeout(() => {state.token='older-' + (state.requests+1); state.loading=false},80)}
  return {state,page,more};
}, template: \`<div class="person-page"><header class="person-panel-header"><h3>数字人内核</h3><button class="btn-ghost" @click="state.section = state.section === 'memory' ? 'skills' : 'memory'">切换</button></header>
<PersonKnowledgeBrowser :section="state.section" :page="page" :identity-key="state.identity + ':' + state.section" @more="more" /></div>\`});
app.config.globalProperties.$t = key => zhCN[key] || key;
app.mount('#fixture'); window.fixtureReady=true;
</script></body></html>`;

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    if (['/', '/tasks', '/knowledge'].includes(request.url)) {
      response.setHeader('Content-Type', 'text/html');
      response.end(request.url === '/tasks' ? taskFixture : request.url === '/knowledge' ? knowledgeFixture : fixture);
      return;
    }
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
  for (const width of [1280, 320, 1920]) {
    test(`compact knowledge shows useful content without clipped lines: ${theme}, ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/knowledge');
      await page.waitForFunction(() => window.fixtureReady);
      if (width === 1920) await page.locator('.person-page').evaluate(el => { el.style.width = '100%'; });
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const scroller = page.locator('.person-inspector-list');
      const memory = page.locator('[data-knowledge-id="memory-0"]');
      await expect(memory).toBeVisible();
      expect(await page.locator('[data-knowledge-id]').count()).toBeLessThan(20);
      const excerpt = memory.locator('summary .person-knowledge-excerpt');
      const geometry = await memory.locator('summary').evaluate(el => {
        const text = el.querySelector('.person-knowledge-excerpt');
        const kind = el.querySelector('.person-knowledge-kind');
        return {height:el.getBoundingClientRect().height, textHeight:text.getBoundingClientRect().height, lineHeight:parseFloat(getComputedStyle(text).lineHeight),
          sameRow:Math.abs(text.getBoundingClientRect().top - kind.getBoundingClientRect().top) < 4, fullText:text.textContent.length};
      });
      expect(geometry.height).toBeLessThanOrEqual(60);
      expect(geometry.textHeight).toBe(geometry.lineHeight * 2);
      expect(geometry.sameRow).toBe(true);
      expect(geometry.fullText).toBeGreaterThan(300);
      if (width === 1920) expect((await memory.boundingBox()).width).toBeLessThanOrEqual(880);
      await page.screenshot({path:test.info().outputPath(`memory-${theme}-${width}.png`)});
      await memory.locator('summary').focus();
      await page.keyboard.press('Enter');
      await expect(memory).toHaveAttribute('open', '');
      await expect(memory.locator('.person-knowledge-detail .person-prose')).toHaveText(await excerpt.textContent());
      await page.keyboard.press('Escape');
      await expect(memory).not.toHaveAttribute('open', '');
      await expect(memory.locator('summary')).toBeFocused();
      await scroller.evaluate(el => {el.scrollTop=el.scrollHeight});
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => window.fixtureState.requests)).toBe(0);
      await scroller.hover(); await page.mouse.wheel(0,150);
      await expect.poll(() => page.evaluate(() => window.fixtureState.requests)).toBe(1);
      await page.getByRole('button', {name:'切换', exact:true}).click();
      const task = page.locator('[data-knowledge-id="CancelTask"]');
      await expect(task).toBeVisible();
      await expect(task.locator('summary .person-knowledge-kind')).toHaveText('后台任务');
      await expect(page.locator('[data-knowledge-id="CloseAgent"] summary .person-knowledge-kind')).toHaveText('子线程');
      await expect(task.locator('summary .person-knowledge-excerpt')).toBeVisible();
      expect((await task.locator(':scope > summary').boundingBox()).height).toBeLessThanOrEqual(84);
      await expect(page.locator('.person-knowledge')).not.toContainText('person.group.');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
      await page.screenshot({path:test.info().outputPath(`knowledge-${theme}-${width}.png`)});
    });
  }

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

    for (const gesture of ['wheel', 'touch', 'scrollbar']) {
      test(`keyboard target yields to ${gesture} before resize: ${theme}, ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 600 });
        await page.goto(origin); await page.waitForFunction(() => window.fixtureReady);
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        const scroller = page.getByRole('region', { name: 'Inspector records' });
        const row = page.locator('[data-row-id="row-0"]');
        await scroller.focus(); await page.keyboard.press('Home');
        await expect(row.locator('summary')).toBeFocused();
        await page.keyboard.press('Enter'); await expect(row).toHaveAttribute('open', '');
        await page.waitForTimeout(150);
        // Keyboard pin still keeps the row aligned while measurements settle.
        const pinned = await scroller.evaluate(el => el.scrollTop);
        await page.setViewportSize({ width, height: 550 }); await page.waitForTimeout(150);
        expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - pinned)).toBeLessThan(4);
        if (gesture === 'wheel') {
          await scroller.hover(); await page.mouse.wheel(0, 400);
        } else {
          // Chromium desktop fixture: synthesize the same touch/scrollbar intent
          // and then its resulting native scroll, without external services.
          await scroller.evaluate((el, gesture) => {
            if (gesture === 'touch') {
              el.dispatchEvent(new TouchEvent('touchstart', { bubbles:true, touches:[new Touch({identifier:1,target:el,clientY:500})] }));
              el.dispatchEvent(new TouchEvent('touchmove', { bubbles:true, touches:[new Touch({identifier:1,target:el,clientY:100})] }));
            } else el.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true }));
            el.scrollTop += 400;
          }, gesture);
        }
        await page.waitForTimeout(180);
        const middle = await scroller.evaluate(el => el.scrollTop);
        expect(middle - pinned).toBeGreaterThan(250);
        await page.setViewportSize({ width, height: 500 }); await page.waitForTimeout(200);
        expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - middle)).toBeLessThan(4);
        expect(await page.evaluate(() => window.fixtureState.requests)).toBe(0);
      });
    }

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
