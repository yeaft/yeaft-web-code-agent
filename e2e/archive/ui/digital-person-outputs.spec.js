import { expect } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from '../../fixtures/test-server.js';
import { clickPersonAction } from '../../helpers/person-actions.js';
import { personInput, personCognition, personToolResults, personToolCall, personStop, personGoal } from '../../fixtures/person-provider.js';
import { createPersonBridge } from '../../../agent/yeaft/person/bridge.js';
import { createPersonService } from '../../../agent/yeaft/person/service.js';
import { config, finalProposal } from '../../../test/agent/yeaft/person/fixtures.js';

// Production browser -> isolated Server relay -> real Agent bridge -> local SQLite.
// Only inference is scripted. No native user configuration, online service or paid model.
test.use({ serverEnv: { SERVE_DIST: process.env.PERSON_UI_PRODUCTION || 'false' } });

async function outputRuntime(mockAgent, serverUrl) {
  const root = await mkdtemp(join(tmpdir(), 'person-outputs-e2e-'));
  const publications = new Map();
  const inputs = [];
  const completed = [];
  const requests = [];
  const responses = [];
  let deferredRead = null;
  let holdReads = false;
  const adapter = { async *stream(params) {
    await setImmediate(); // Model I/O yields to the relay and native workers.
    const input = personInput(params);
    inputs.push(input);
    const args = publications.get(input.trigger.text);
    if (!args) throw new Error(`Unexpected scripted trigger: ${input.trigger.text}`);
    if (!personCognition(params)) {
      expect(params.tools.some(t => t.name === 'Output__publish')).toBe(true);
      if (!personToolResults(params).length) {
        yield personToolCall('publish-output', 'Output.publish', args);
        yield personStop(true);
      } else {
        expect(personToolResults(params)).toHaveLength(1); // No replay while reporting/confirming the goal.
        const result = personToolResults(params)[0];
        expect(result.ok).not.toBe(false);
        expect(result).toMatchObject({ title: args.title, kind: args.url ? 'link' : 'file' });
        expect(result.id).toBeTruthy();
        expect(result.episodeId).toBeTruthy();
        const goal = personGoal(params, {
          objective: `Deliver ${args.title}`, acceptance: 'Publish an immutable, identified output with the requested title.',
          check: `Output.publish returned a durable output identity, episode and the requested title ${args.title}.`,
        });
        if (goal) yield goal;
        else yield { type: 'text_delta', text: 'Publication complete.' };
        yield personStop(!!goal);
      }
      return;
    }
    completed.push(input.trigger.text);
    const proposal = finalProposal(input.state.version);
    proposal.concepts[0].expectedRevision = input.concepts.find(c => c.id === 'curiosity')?.revision || 0;
    proposal.activity.sourceRefs = input.sourceRefs;
    proposal.concepts[0].sourceRefs = input.sourceRefs;
    proposal.reply = `Published ${args.title}.`;
    yield { type: 'text_delta', text: JSON.stringify(proposal) };
    yield personStop(false);
  } };
  const context = { agentId: mockAgent.agentId, CONFIG: { serverUrl, yeaftDir: join(root, 'data'), workDir: root } };
  const send = async message => {
    responses.push(message);
    if (holdReads && message.op === 'output_read') {
      await new Promise(resolve => { deferredRead = { message, resolve }; });
    }
    mockAgent.send(message);
  };
  const makeBridge = () => createPersonBridge({ context, env: {}, send,
    createService: options => createPersonService({ ...options, config, adapter, embedding: { enabled: false } }) });
  let bridge = makeBridge();
  const listener = message => {
    if (message.type !== 'person_request') return;
    requests.push(message);
    void bridge.request(message);
  };
  mockAgent._messageHandlers.push(listener);
  return {
    root, inputs, completed, requests, responses,
    async file(name, content, title = name) {
      const path = join(root, name);
      await writeFile(path, content);
      publications.set(`Deliver ${title}`, { file_path: path, title });
      return path;
    },
    link(url, title) { publications.set(`Deliver ${title}`, { url, title }); },
    async restart() { await bridge.close(); bridge = makeBridge(); },
    holdReads() { holdReads = true; },
    get readHeld() { return deferredRead !== null; },
    releaseRead() { holdReads = false; deferredRead?.resolve(); deferredRead = null; },
    async close() {
      holdReads = false; deferredRead?.resolve();
      mockAgent._messageHandlers = mockAgent._messageHandlers.filter(h => h !== listener);
      await bridge.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function enableAgent(page, agent) {
  await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(a => a.id === id && a.status === 'ready'), agent.agentId);
  agent.send({ type: 'agent_capabilities_updated', capabilities: ['digital_person', 'plaintext-ok'] });
  await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(a => a.id === id && a.capabilities?.includes('digital_person')), agent.agentId);
  await page.evaluate(id => window.Pinia.useChatStore().setDigitalPersonUiEnabled(true, id), agent.agentId);
}

async function openPerson(page, serverUrl, agent) {
  await page.goto(serverUrl);
  if (process.env.PERSON_UI_PRODUCTION === 'true') {
    await expect(page.locator('script[src^="app.bundle.js"]')).toHaveCount(1);
    await expect(page.locator('link[href^="style.bundle.css"]')).toHaveCount(1);
    await expect(page.locator('script[src="app.js"]')).toHaveCount(0);
  }
  await enableAgent(page, agent);
  await page.locator('.sidebar-person-trigger:visible').click();
  await expect(page.locator('#person-input')).toBeEnabled();
}

async function publish(page, title) {
  await page.locator('#person-input').fill(`Deliver ${title}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.person-messages')).toContainText(`Published ${title}.`, { timeout: 15000 });
  await expect(page.locator('#person-input')).toBeEnabled();
}

async function openOutputs(page) {
  await clickPersonAction(page, 'outputs');
  await expect(page.locator('#person-side-panel')).toBeVisible();
}

async function openOutputLibrary(page) {
  const panel = page.locator('#person-side-panel');
  const library = panel.locator('#person-output-library');
  if (!await library.isVisible()) {
    await panel.getByRole('button', { name: 'Delivered outputs', exact: true }).click();
  }
  await expect(library).toBeVisible();
}

async function selectOutput(page, title) {
  await openOutputLibrary(page);
  await page.locator('#person-output-library .person-output-item').filter({ hasText: title }).click();
  await expect(documentTab(page, title)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#person-output-library')).toHaveCount(0);
}

function documentTab(page, title) {
  return page.locator('#person-side-panel').getByRole('tab', { name: title, exact: true });
}

async function downloadOutput(page, expectedBytes) {
  const pending = page.waitForEvent('download');
  await page.locator('#person-side-panel').getByRole('link', { name: 'Download', exact: true }).click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  expect(await readFile(await download.path())).toEqual(expectedBytes);
  return download;
}

test('Output.publish markdown travels through relay and survives source deletion, bridge and browser restart', async ({ page, browser, serverUrl, mockAgent }) => {
  test.setTimeout(60000);
  const runtime = await outputRuntime(mockAgent, serverUrl);
  let restartedContext;
  try {
    const original = Buffer.from('# Immutable deliverable\n\nThis is **stored evidence**, not the live workspace.\n\n- first result\n- second result\n');
    const source = await runtime.file('report.md', original, 'Research report');
    await openPerson(page, serverUrl, mockAgent);
    await publish(page, 'Research report');
    await openOutputs(page);
    await selectOutput(page, 'Research report');
    const panel = page.locator('#person-side-panel');
    await expect(panel.getByRole('heading', { name: 'Immutable deliverable', exact: true })).toBeVisible();
    await expect(panel.locator('strong')).toHaveText('stored evidence');
    await openOutputLibrary(page);
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => runtime.requests.filter(r => r.op === 'outputs').length).toBe(1);
    expect(runtime.requests.find(r => r.op === 'outputs').payload).toEqual({ limit: 20 });
    expect(runtime.completed).toEqual(['Deliver Research report']);
    const idleCalls = runtime.inputs.length;
    expect(runtime.inputs[0].capabilities.active).toEqual([]); // native schemas, not prepared proposals
    expect(runtime.requests.every(r => !Object.hasOwn(r.payload, 'ownerId'))).toBe(true);
    const status = runtime.responses.find(r => r.op === 'status' && r.ok);
    expect(status.data.outputsSupported).toBe(true);
    const snapshot = runtime.responses.filter(r => r.op === 'snapshot' && r.ok).at(-1);
    const stored = snapshot.data.outputs.items.find(item => item.title === 'Research report');
    expect(stored).toMatchObject({ kind: 'file', mimeType: 'text/markdown', size: original.length });
    expect(stored.id).toBeTruthy();
    expect(stored.episodeId).toBeTruthy();
    expect(Number.isFinite(Date.parse(stored.createdAt))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(runtime.root);
    await writeFile(source, '# Replaced workspace content');
    await rm(source);
    await runtime.restart();
    restartedContext = await browser.newContext({ storageState: await page.context().storageState() });
    await page.close();
    const freshPage = await restartedContext.newPage();
    await openPerson(freshPage, serverUrl, mockAgent);
    await openOutputs(freshPage);
    await selectOutput(freshPage, 'Research report');
    await expect(freshPage.locator('#person-side-panel').getByRole('heading', { name: 'Immutable deliverable', exact: true })).toBeVisible();
    await expect(freshPage.locator('#person-side-panel')).not.toContainText('Replaced workspace content');
    await downloadOutput(freshPage, original);
    expect(runtime.inputs).toHaveLength(idleCalls); // Reading/restarting does not invoke inference.
    expect(mockAgent.conversations.size).toBe(0); // Outputs do not create a hidden Session.
  } finally {
    await restartedContext?.close();
    await runtime.close();
  }
});

test('HTML output is actually inert: scripts, network, forms and nested frames cannot escape the sandbox', async ({ page, context, serverUrl, mockAgent }) => {
  const runtime = await outputRuntime(mockAgent, serverUrl);
  const leakedRequests = [];
  await context.route('https://output-attacker.invalid/**', route => {
    leakedRequests.push(route.request().url());
    return route.abort();
  });
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="https://output-attacker.invalid/style.css">
    <style>@import url('https://output-attacker.invalid/import.css'); body { background-image: url('https://output-attacker.invalid/background.png'); }</style>
    </head><body><h1>Static HTML result</h1><p id="static-marker">Visible safe content</p>
    <script>document.body.dataset.executed = 'yes'; parent.document.documentElement.dataset.outputEscape = 'yes'; fetch('https://output-attacker.invalid/fetch');</script>
    <script src="https://output-attacker.invalid/script.js"></script>
    <img src="https://output-attacker.invalid/image.png" onerror="document.body.dataset.handler = 'yes'">
    <iframe src="https://output-attacker.invalid/frame"></iframe>
    <form action="https://output-attacker.invalid/form" method="post"><button id="exfiltrate">Submit malicious form</button></form>
    <a id="navigate" href="https://output-attacker.invalid/navigate" target="_top">Navigate parent</a>
    </body></html>`;
  try {
    await runtime.file('static.html', html, 'Static report');
    await openPerson(page, serverUrl, mockAgent);
    await publish(page, 'Static report');
    await openOutputs(page);
    await selectOutput(page, 'Static report');
    const iframe = page.locator('#person-side-panel iframe');
    await expect(iframe).toBeVisible();
    const frame = iframe.contentFrame();
    await expect(frame.getByRole('heading', { name: 'Static HTML result', exact: true })).toBeVisible();
    await expect(frame.locator('#static-marker')).toHaveText('Visible safe content');
    expect(await frame.locator('body').evaluate(el => ({ executed: el.dataset.executed || null, handler: el.dataset.handler || null })))
      .toEqual({ executed: null, handler: null });
    expect(await page.evaluate(() => document.documentElement.dataset.outputEscape || null)).toBeNull();
    // Removed active controls cannot submit or nest browsing contexts. The
    // surviving anchor is actually clicked to prove it cannot navigate the parent.
    await expect(frame.locator('script, form, iframe, #exfiltrate')).toHaveCount(0);
    await frame.locator('#navigate').click();
    await expect(frame.getByRole('heading', { name: 'Static HTML result', exact: true })).toBeVisible();
    await expect(page).toHaveURL(serverUrl + '/');
    expect(leakedRequests).toEqual([]);
    await downloadOutput(page, Buffer.from(html));
  } finally { await runtime.close(); }
});

// A valid one-page PDF (correct xref offsets), not just a signature fixture.
