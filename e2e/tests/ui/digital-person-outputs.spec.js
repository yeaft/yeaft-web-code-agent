import { expect } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '../../fixtures/test-server.js';
import { MockAgent } from '../../fixtures/mock-agent.js';
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
  const requests = [];
  const responses = [];
  let deferredRead = null;
  let holdReads = false;
  const adapter = { async *stream(params) {
    const input = JSON.parse(params.messages[0].content);
    inputs.push(input);
    const proposal = finalProposal(input.state.version);
    proposal.concepts[0].expectedRevision = input.concepts.find(c => c.id === 'curiosity')?.revision || 0;
    proposal.activity.sourceRefs = input.sourceRefs;
    proposal.concepts[0].sourceRefs = input.sourceRefs;
    const args = publications.get(input.trigger.text);
    if (!args) throw new Error(`Unexpected scripted trigger: ${input.trigger.text}`);
    const use = (id, capabilityArgs) => {
      proposal.next = { model: params.model, effort: null, reason: 'Publish the prepared deliverable.', capability: { id, args: capabilityArgs } };
    };
    if (!input.previousProposal) use('catalog.view', { id: 'Output.publish' });
    else if (input.previousProposal.next?.capability?.id === 'catalog.view') {
      expect(input.capabilities.active.some(c => c.id === 'Output.publish')).toBe(true);
      use('Output.publish', args);
    } else {
      expect(input.previousProposal.next?.capability?.id).toBe('Output.publish');
      expect(input.capabilityResult).toBeTruthy();
      proposal.reply = `Published ${args.title}.`;
    }
    yield { type: 'text_delta', text: JSON.stringify(proposal) };
    yield { type: 'stop', stopReason: 'end_turn' };
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
    root, inputs, requests, responses,
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
  await page.getByRole('button', { name: 'Outputs', exact: true }).first().click();
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

async function closeDocumentTab(page, title) {
  await page.locator('#person-side-panel').getByRole('button', { name: `Close document: ${title}`, exact: true }).click();
}

async function downloadOutput(page, expectedBytes) {
  const pending = page.waitForEvent('download');
  await page.locator('#person-side-panel').getByRole('link', { name: 'Download', exact: true }).click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  expect(await readFile(await download.path())).toEqual(expectedBytes);
  return download;
}

async function expectNoOverflow(page) {
  expect(await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth })))
    .toEqual({ width: (await page.viewportSize()).width, document: (await page.viewportSize()).width, body: (await page.viewportSize()).width });
  const panel = await page.locator('#person-side-panel').boundingBox();
  expect(panel.x).toBeGreaterThanOrEqual(-1);
  expect(panel.x + panel.width).toBeLessThanOrEqual((await page.viewportSize()).width + 1);
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
    expect(runtime.inputs).toHaveLength(3);
    expect(runtime.inputs[0].capabilities.active.some(c => c.id === 'Output.publish')).toBe(false);
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
    expect(runtime.inputs).toHaveLength(3); // Reading/restarting does not invoke inference.
    expect(mockAgent.conversations.size).toBe(0); // Outputs do not create a hidden Session.
  } finally {
    await restartedContext?.close();
    await runtime.close();
  }
});

test('Link output still opens externally when its embedded preview is refused', async ({ page, context, serverUrl, mockAgent }) => {
  const runtime = await outputRuntime(mockAgent, serverUrl);
  const url = 'https://deliverable.invalid/report?version=1';
  const externalRequests = [];
  await context.route('https://deliverable.invalid/**', route => {
    externalRequests.push(route.request().url());
    return route.fulfill({ contentType: 'text/html', headers: { 'x-frame-options': 'DENY' }, body: '<h1>Isolated external destination</h1>' });
  });
  try {
    runtime.link(url, 'Reference website');
    await openPerson(page, serverUrl, mockAgent);
    await publish(page, 'Reference website');
    await openOutputs(page);
    const refused = page.waitForEvent('console', { predicate: message => message.text().includes('X-Frame-Options') && message.text().includes('Refused to display') });
    await selectOutput(page, 'Reference website');
    await refused;
    const panel = page.locator('#person-side-panel');
    await expect(panel.locator('iframe').contentFrame().getByRole('heading', { name: 'Isolated external destination' })).toHaveCount(0);
    await expect(panel).toContainText('Some sites block embedding; use Open externally.');
    await expect(panel.locator('iframe')).toHaveAttribute('src', url);
    await expect.poll(() => externalRequests.length).toBe(1);
    const link = panel.getByRole('link', { name: 'Open externally', exact: true });
    await expect(link).toHaveAttribute('href', url);
    await expect(link).toHaveAttribute('rel', /noopener/);
    const pending = page.waitForEvent('popup');
    await link.click();
    const popup = await pending;
    await expect(popup.getByRole('heading', { name: 'Isolated external destination' })).toBeVisible();
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    expect(externalRequests).toEqual([url, url]);
    await popup.close();
    await expect(panel).toBeVisible();
    expect(runtime.inputs).toHaveLength(3);
  } finally { await runtime.close(); }
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
function readablePdf() {
  const stream = 'BT /F1 18 Tf 30 100 Td (Readable PDF result) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('Image, UTF-8 text, PDF fallback and multi-chunk binary outputs preserve their bytes when downloaded', async ({ page, serverUrl, mockAgent }) => {
  test.setTimeout(60000);
  const runtime = await outputRuntime(mockAgent, serverUrl);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwTpv5HwAENAIyWy0K4AAAAABJRU5ErkJggg==', 'base64');
  const text = Buffer.from('UTF-8 result: 知微\n<not-html> & plain text\n');
  const binary = Buffer.from(Array.from({ length: 150123 }, (_, i) => i % 256));
  try {
    await runtime.file('pixel.png', image, 'Result image');
    await runtime.file('notes.txt', text, 'Result text');
    await runtime.file('result.bin', binary, 'Result binary');
    await openPerson(page, serverUrl, mockAgent);
    for (const title of ['Result image', 'Result text', 'Result binary']) await publish(page, title);
    await openOutputs(page);
    await selectOutput(page, 'Result image');
    const panel = page.locator('#person-side-panel');
    await expect(panel.locator('img')).toBeVisible();
    expect(await panel.locator('img').evaluate(img => ({ complete: img.complete, width: img.naturalWidth, height: img.naturalHeight })))
      .toEqual({ complete: true, width: 1, height: 1 });
    await downloadOutput(page, image);
    await selectOutput(page, 'Result text');
    await expect(panel.locator('pre')).toHaveText(text.toString());
    await expect(panel.locator('not-html')).toHaveCount(0);
    await downloadOutput(page, text);
    await selectOutput(page, 'Result binary');
    await expect(panel.locator('iframe, img, pre')).toHaveCount(0);
    await downloadOutput(page, binary);
    const pdf = readablePdf();
    await runtime.file('report.pdf', pdf, 'Result PDF');
    await publish(page, 'Result PDF');
    await selectOutput(page, 'Result PDF');
    await expect(panel.locator('.person-output-preview')).toContainText('PDF preview is unavailable');
    await expect(panel.locator('iframe, object, embed')).toHaveCount(0);
    await downloadOutput(page, pdf);
    const reads = runtime.requests.filter(r => r.op === 'output_read');
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(reads.every(r => r.payload.maxBytes > 0 && r.payload.maxBytes <= 65536)).toBe(true);
    expect(reads.some(r => r.payload.offset >= 65536)).toBe(true);
    expect(runtime.inputs).toHaveLength(12);
  } finally { await runtime.close(); }
});

test('Output drawer resizes by keyboard and pointer, restores fullscreen and focus, and fits light/dark 320px', async ({ page, serverUrl, mockAgent }, testInfo) => {
  test.setTimeout(60000);
  const runtime = await outputRuntime(mockAgent, serverUrl);
  try {
    await runtime.file('layout.md', '# Layout result\n\n' + 'Long_unbroken_content_'.repeat(120), 'Layout report');
    await page.setViewportSize({ width: 1280, height: 800 });
    await openPerson(page, serverUrl, mockAgent);
    await publish(page, 'Layout report');
    await openOutputs(page);
    await selectOutput(page, 'Layout report');
    const panel = page.locator('#person-side-panel');
    await expect(panel.getByRole('heading', { name: 'Layout result', exact: true })).toBeVisible();
    const handle = page.getByRole('separator', { name: 'Resize output panel', exact: true });
    const initial = await panel.boundingBox();
    await handle.focus();
    await handle.press('ArrowLeft');
    await expect.poll(async () => (await panel.boundingBox()).width).toBeGreaterThan(initial.width);
    const resized = await panel.boundingBox();
    await panel.getByRole('button', { name: 'Expand', exact: true }).click();
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    await expect.poll(async () => (await panel.boundingBox()).width).toBeGreaterThan(1100);
    await panel.getByRole('button', { name: 'Restore split view', exact: true }).click();
    await expect.poll(async () => Math.abs((await panel.boundingBox()).width - resized.width)).toBeLessThan(2);
    await panel.getByRole('button', { name: 'Expand', exact: true }).click();
    await panel.getByRole('button', { name: 'Close reader', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Outputs', exact: true }).first()).toBeFocused();
    await openOutputs(page);
    await expect.poll(async () => Math.abs((await panel.boundingBox()).width - resized.width)).toBeLessThan(2);
    await expect(panel).not.toHaveAttribute('aria-modal', 'true');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expectNoOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`outputs-desktop-${theme}.png`) });
      await page.setViewportSize({ width: 320, height: 740 });
      await expect(panel).toHaveAttribute('role', 'dialog');
      await expect(panel).toHaveAttribute('aria-modal', 'true');
      await expectNoOverflow(page);
      const focusable = panel.locator('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex="0"]').filter({ visible: true });
      await focusable.last().focus();
      await page.keyboard.press('Tab');
      await expect(focusable.first()).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(focusable.last()).toBeFocused();
      await page.evaluate(() => document.querySelector('#person-input').focus());
      expect(await panel.evaluate(el => el.contains(document.activeElement))).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`outputs-320-${theme}.png`) });
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Outputs', exact: true }).first()).toBeFocused();
      await openOutputs(page);
      await expect(panel.getByRole('heading', { name: 'Layout result', exact: true })).toBeVisible();
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    const keyboardWidth = (await panel.boundingBox()).width;
    const grip = await handle.boundingBox();
    expect(grip.width, 'Pointer divider needs a real hit target').toBeGreaterThan(0);
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 - 75, grip.y + grip.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await panel.boundingBox()).width).toBeGreaterThan(keyboardWidth + 40);
    expect(runtime.inputs).toHaveLength(3);
  } finally { await runtime.close(); }
});

test('Output reader keeps only explicitly opened document tabs and stays separate from the inspector', async ({ page, context, serverUrl, mockAgent }) => {
  test.setTimeout(60000);
  const runtime = await outputRuntime(mockAgent, serverUrl);
  const url = 'https://reader-deliverable.invalid/reference';
  await context.route(url, route => route.fulfill({ contentType: 'text/html', body: '<h1>Reader reference</h1>' }));
  try {
    await runtime.file('first.md', '# First document\n\n' + Array.from({ length: 100 }, (_, i) => `First document paragraph ${i}.\n\n`).join(''), 'First document');
    await runtime.file('second.txt', Array.from({ length: 100 }, (_, i) => `Second document line ${i}.`).join('\n'), 'Second document');
    runtime.link(url, 'Reference link');
    await page.setViewportSize({ width: 1280, height: 800 });
    await openPerson(page, serverUrl, mockAgent);
    for (const title of ['First document', 'Second document', 'Reference link']) await publish(page, title);
    await expect(page.locator('#person-side-panel')).toHaveCount(0); // Deliveries never open the reader.
    await openOutputs(page);
    const panel = page.locator('#person-side-panel');
    await expect(panel.locator('.person-inspector-nav')).toHaveCount(0);
    await expect(panel.getByRole('tab')).toHaveCount(0);
    for (const title of ['Overview', 'Thought journal', 'Flow & usage', 'Tasks', 'Memory', 'Skills & capabilities']) {
      await expect(panel.getByRole('button', { name: title, exact: true })).toHaveCount(0);
      await expect(panel.getByRole('tab', { name: title, exact: true })).toHaveCount(0);
    }

    await selectOutput(page, 'First document');
    const firstTab = documentTab(page, 'First document');
    const secondTab = documentTab(page, 'Second document');
    const linkTab = documentTab(page, 'Reference link');
    const preview = panel.locator('.person-output-preview');
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('.person-output-item')).toHaveCount(0); // The library is not persistent history.
    await expect(preview.getByRole('heading', { name: 'First document', exact: true })).toBeVisible();
    const firstScroll = await preview.evaluate(el => {
      el.scrollTop = 480;
      return el.scrollTop;
    });
    expect(firstScroll).toBeGreaterThan(300);
    await selectOutput(page, 'Second document');
    await expect(preview.locator('pre')).toContainText('Second document line 99.');
    await expect(panel.getByRole('link', { name: 'Download', exact: true })).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Open externally', exact: true })).toHaveCount(0);
    const secondScroll = await preview.evaluate(el => {
      el.scrollTop = 260;
      return el.scrollTop;
    });
    expect(secondScroll).toBeGreaterThan(200);
    await selectOutput(page, 'Reference link');
    await expect(linkTab).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('link', { name: 'Download', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('link', { name: 'Open externally', exact: true })).toHaveAttribute('href', url);
    await expect(preview.locator('iframe').contentFrame().getByRole('heading', { name: 'Reader reference', exact: true })).toBeVisible();
    await expect(panel.getByRole('tab')).toHaveCount(3);
    await expect(firstTab).toHaveCount(1);
    await expect(secondTab).toHaveCount(1);
    await expect(linkTab).toHaveCount(1);
    await firstTab.click();
    await expect(preview.getByRole('heading', { name: 'First document', exact: true })).toBeVisible();
    await expect.poll(async () => Math.abs(await preview.evaluate(el => el.scrollTop) - firstScroll)).toBeLessThan(2);
    await secondTab.click();
    await expect(preview.locator('pre')).toContainText('Second document line 99.');
    await expect.poll(async () => Math.abs(await preview.evaluate(el => el.scrollTop) - secondScroll)).toBeLessThan(2);

    // A fourth delivery updates the library, never the selected reader or tabs.
    await runtime.file('later.txt', 'New delivery must stay unopened.', 'Later delivery');
    await publish(page, 'Later delivery');
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('tab')).toHaveCount(3);
    await expect(documentTab(page, 'Later delivery')).toHaveCount(0);
    await expect(preview.locator('pre')).toContainText('Second document line 99.');
    await expect.poll(async () => Math.abs(await preview.evaluate(el => el.scrollTop) - secondScroll)).toBeLessThan(2);

    await closeDocumentTab(page, 'Second document');
    await expect(secondTab).toHaveCount(0);
    await expect(linkTab).toHaveAttribute('aria-selected', 'true'); // Closing the middle selects its right neighbor.
    await panel.getByRole('button', { name: 'Close reader', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await openOutputs(page);
    await expect(panel.getByRole('tab')).toHaveCount(2);
    await expect(linkTab).toHaveAttribute('aria-selected', 'true');
    await expect(preview.locator('iframe')).toHaveAttribute('src', url);
    await closeDocumentTab(page, 'Reference link');
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => Math.abs(await preview.evaluate(el => el.scrollTop) - firstScroll)).toBeLessThan(2);
    await closeDocumentTab(page, 'First document');
    await expect(panel.getByRole('tab')).toHaveCount(0);
    await expect(panel.locator('iframe, img, pre, .markdown-body')).toHaveCount(0);
    await expect(panel.locator('.person-output-item')).toHaveCount(4); // Empty reader exposes the picker, not a resurrected document.
    await expect(panel.locator('#person-output-library')).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Download', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('link', { name: 'Open externally', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Close reader', exact: true }).click();
    await openOutputs(page);
    await expect(panel.getByRole('tab')).toHaveCount(0);
    await expect(panel.locator('iframe, img, pre, .markdown-body')).toHaveCount(0);

    await page.getByRole('button', { name: 'Inside the digital person', exact: true }).click();
    await expect(panel.locator('.person-inspector-nav')).toBeVisible();
    await expect(panel.locator('.person-inspector-nav').getByRole('button', { name: 'Outputs', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('tab')).toHaveCount(0);
    await expect(panel.locator('.person-outputs')).not.toBeVisible();
    expect(runtime.inputs).toHaveLength(12); // All reader/inspector operations stay inference-free.
    expect(mockAgent.conversations.size).toBe(0);
  } finally { await runtime.close(); }
});

test('Agent switch fences delayed output bytes and clears another Agent private deliveries', async ({ page, serverUrl, mockAgent }) => {
  test.setTimeout(60000);
  const runtime = await outputRuntime(mockAgent, serverUrl);
  const otherAgent = new MockAgent(serverUrl, 'Empty output Agent');
  let otherRuntime;
  try {
    await otherAgent.connect();
    otherRuntime = await outputRuntime(otherAgent, serverUrl);
    await runtime.file('private.md', '# Private Agent A bytes\nDo not show this on Agent B.', 'Private Agent A report');
    await openPerson(page, serverUrl, mockAgent);
    await enableAgent(page, otherAgent);
    await publish(page, 'Private Agent A report');
    await openOutputs(page);
    runtime.holdReads();
    await selectOutput(page, 'Private Agent A report');
    await expect.poll(() => runtime.readHeld).toBe(true);
    await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: 'Empty output Agent', exact: true }).click();
    await expect(page.locator('#person-input')).toBeEnabled();
    await expect(page.locator('#person-side-panel')).toHaveCount(0);
    runtime.releaseRead();
    await openOutputs(page);
    const panel = page.locator('#person-side-panel');
    await expect(panel).not.toContainText('Private Agent A');
    await expect(panel.locator('.person-output-item').filter({ hasText: 'Private Agent A report' })).toHaveCount(0);
    await expect(panel.locator('iframe, img, pre, .markdown-content')).toHaveCount(0);
    await expect(page.locator('.person-messages')).not.toContainText('Published Private Agent A report.');
    expect(otherRuntime.inputs).toHaveLength(0);
    // Returning to A re-reads A's immutable delivery; it was not deleted by close/switch.
    await panel.getByRole('button', { name: 'Close reader', exact: true }).click();
    await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: 'test-agent', exact: true }).click();
    await expect(page.locator('#person-input')).toBeEnabled();
    await openOutputs(page);
    await selectOutput(page, 'Private Agent A report');
    await expect(page.locator('#person-side-panel').getByRole('heading', { name: 'Private Agent A bytes', exact: true })).toBeVisible();
    expect(runtime.inputs).toHaveLength(3);
  } finally {
    runtime.releaseRead();
    await otherRuntime?.close();
    await otherAgent.disconnect();
    await runtime.close();
  }
});
