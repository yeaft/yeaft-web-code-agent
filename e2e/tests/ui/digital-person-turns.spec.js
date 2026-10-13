import { expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '../../fixtures/test-server.js';
import { personInput, personCognition, personToolCall, personStop } from '../../fixtures/person-provider.js';
import { createPersonBridge } from '../../../agent/yeaft/person/bridge.js';
import { createPersonService } from '../../../agent/yeaft/person/service.js';
import { config, finalProposal } from '../../../test/agent/yeaft/person/fixtures.js';

// Real production browser -> owner relay -> Agent bridge -> isolated SQLite.
// Only inference is scripted, with additive usage and a multi-tool provider response.
test.use({ serverEnv: { SERVE_DIST: process.env.PERSON_UI_PRODUCTION || 'false' } });
test('Person turn diagnostics persist complete flow and partial usage without starting inference', async ({ page, serverUrl, mockAgent }, testInfo) => {
  test.setTimeout(90000);
  const dir = await mkdtemp(join(tmpdir(), 'person-turn-e2e-'));
  let calls = 0, release;
  const responses = [];
  const gate = new Promise(resolve => { release = resolve; });
  const adapter = { async *stream(params) {
    calls++;
    const input = personInput(params);
    if (input.trigger.text === 'Fail after usage') {
      yield { type: 'usage', inputTokens: 5, outputTokens: 2 };
      yield { type: 'error', error: new Error('private provider error') };
      return;
    }
    if (input.trigger.text === 'Output too long') {
      yield { type: 'text_delta', text: '{"unfinished":' };
      yield { type: 'usage', inputTokens: 5, outputTokens: 4096 };
      yield { type: 'stop', stopReason: 'max_tokens' };
      return;
    }
    params.onEffortDecision?.({ effective: calls === 1 ? null : 'low', wireMode: 'test' });
    if (calls === 1) {
      await gate;
      expect(params.tools.map(t => t.name)).toEqual(expect.arrayContaining(['FileWrite', 'FileRead']));
      yield personToolCall('provider-write', 'FileWrite', { file_path: join(dir, 'result.txt'), content: 'PRIVATE_TOOL_ARGUMENT' });
      yield personToolCall('provider-read', 'FileRead', { file_path: join(dir, 'result.txt') });
      yield { type: 'usage', inputTokens: 100, outputTokens: 1, cacheReadTokens: 20, cacheTokensAreIncludedInInput: false };
      yield { type: 'usage', inputTokens: 0, outputTokens: 19, reasoningTokens: 5 };
      yield personStop(true);
    } else if (!personCognition(params)) {
      expect(params.messages.filter(m => m.role === 'tool').map(m => m.toolCallId)).toEqual(['provider-write', 'provider-read']);
      yield { type: 'text_delta', text: 'PRIVATE_EXECUTION_TEXT' };
      yield { type: 'usage', inputTokens: 40, outputTokens: 10, cacheReadTokens: 10, cacheTokensAreIncludedInInput: true };
      yield personStop(false);
    } else {
      const proposal = finalProposal(input.state.version);
      proposal.concepts = []; proposal.state.focusConceptIds = [];
      proposal.activity.sourceRefs = [input.trigger.ref];
      proposal.reply = 'Completed with three model calls and two native tools.';
      expect(proposal.next).toBeNull();
      yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
      yield { type: 'text_delta', text: JSON.stringify(proposal) };
      yield personStop(false);
    }
  } };
  const makeBridge = () => createPersonBridge({ context: { agentId: mockAgent.agentId, CONFIG: { serverUrl, yeaftDir: dir, workDir: dir } },
    send: msg => { responses.push(msg); mockAgent.send(msg); }, createService: options => createPersonService({ ...options, config, adapter, effortEnabled: true, embedding: { enabled: false } }) });
  let bridge = makeBridge();
  const listener = msg => { if (msg.type === 'person_request') void bridge.request(msg); };
  mockAgent._messageHandlers.push(listener);
  try {
    await page.goto(serverUrl);
    if (process.env.PERSON_UI_PRODUCTION === 'true') {
      await expect(page.locator('script[src^="app.bundle.js"]')).toHaveCount(1);
      await expect(page.locator('script[src="app.js"]')).toHaveCount(0);
    }
    await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(a => a.id === id && a.status === 'ready'), mockAgent.agentId);
    mockAgent.send({ type: 'agent_capabilities_updated', capabilities: ['digital_person', 'plaintext-ok'] });
    await page.waitForFunction(id => window.Pinia?.useChatStore?.().agents.some(a => a.id === id && a.capabilities?.includes('digital_person')), mockAgent.agentId);
    await page.evaluate(id => window.Pinia.useChatStore().setDigitalPersonUiEnabled(true, id), mockAgent.agentId);
    await page.locator('.sidebar-person-trigger:visible').click();
    await expect(page.locator('#person-input')).toBeEnabled();
    await page.locator('#person-input').fill('Inspect the model flow');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    await page.locator('.person-thoughts-button').click();
    await page.locator('.person-inspector-nav').getByRole('button', { name: 'Flow & usage', exact: true }).click();
    await expect(page.locator('.person-turn-row')).toHaveCount(1);
    await expect(page.locator('.person-turn-row')).toContainText('Running');
    await expect(page.locator('.person-turn-row')).toContainText('Incomplete usage (known values)');
    await page.locator('.person-turn-row > summary').click();
    await expect(page.locator('.person-call-step')).toHaveCount(1);
    release();
    await expect(page.locator('.person-messages')).toContainText('Completed with three model calls and two native tools.');
    await page.locator('#person-turns').getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.person-turn-row > summary')).toContainText('3 loops');
    await expect(page.locator('.person-turn-row > summary')).toContainText('Total tokens: 205');
    await expect(page.locator('.person-call-step')).toHaveCount(3);
    await expect(page.locator('.person-turn-row')).toContainText('test/first');
    const tools = page.locator('.person-call-step').first().locator('.person-call-capability');
    await expect(tools).toHaveCount(2);
    await expect(tools.nth(0)).toContainText('FileWrite');
    await expect(tools.nth(1)).toContainText('FileRead');
    const ids = await tools.evaluateAll(rows => rows.map(row => row.dataset.toolCallId));
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain(await page.locator('.person-call-step').first().getAttribute('data-call-id'));
    await page.locator('.person-inspector-nav').getByRole('button', { name: 'Thought journal', exact: true }).click();
    await expect(page.locator('#person-thoughts')).toContainText('Reconsider the available experience.');
    await expect(page.locator('#person-thoughts')).not.toContainText('PRIVATE_');
    const traces = responses.filter(r => r.op === 'traces' && r.ok).at(-1).data.items;
    expect(traces.filter(t => t.kind === 'call_output' && t.output.protocol === 'cognition')).toHaveLength(1);
    expect(traces.filter(t => t.kind === 'activity')).toHaveLength(1);
    expect(traces.filter(t => t.kind === 'committed')).toHaveLength(1);
    const nativeOutput = traces.find(t => t.kind === 'call_output' && t.output.toolCalls?.length === 2);
    expect(nativeOutput.output).toMatchObject({ protocol: 'native-tools', text: '', toolCalls: [
      { id: 'provider-write', name: 'FileWrite' }, { id: 'provider-read', name: 'FileRead' },
    ] });
    // Repository trace pages are newest-first; provider order is toolIndex.
    const toolTraces = traces.filter(t => t.kind === 'capability_started').sort((a, b) => a.toolIndex - b.toolIndex);
    expect(toolTraces.map(t => [t.callId, t.modelCallId, t.toolUseId, t.toolIndex])).toEqual([
      [ids[0], nativeOutput.callId, 'provider-write', 0], [ids[1], nativeOutput.callId, 'provider-read', 1],
    ]);
    const cognition = traces.find(t => t.kind === 'call_output' && t.output.protocol === 'cognition');
    expect(JSON.parse(cognition.output.text).next).toBeNull();
    expect(traces.filter(t => ['activity', 'committed'].includes(t.kind)).map(t => t.callId)).toEqual([cognition.callId, cognition.callId]);
    await expect(page.locator('#person-thoughts article.person-thought')).toHaveCount(1);
    await page.locator('.person-inspector-nav').getByRole('button', { name: 'Flow & usage', exact: true }).click();
    await expect(page.locator('.person-call-step').nth(1)).toContainText('low');
    await expect(page.locator('.person-messages')).not.toContainText('Total tokens');
    await expect(page.locator('.person-turn-row pre')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('person-usage-light.png'), fullPage: true });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: testInfo.outputPath('person-usage-dark.png'), fullPage: true });
    await bridge.close(); bridge = makeBridge();
    await page.reload();
    await page.waitForFunction(() => window.Pinia?.useChatStore?.().sessionCatalogLoaded);
    await page.locator('.sidebar-person-trigger:visible').click();
    await expect(page.locator('#person-input')).toBeEnabled();
    await page.locator('.person-thoughts-button').click();
    await page.locator('.person-inspector-nav').getByRole('button', { name: 'Flow & usage', exact: true }).click();
    await expect(page.locator('.person-turn-row')).toContainText('Total tokens: 205');
    expect(calls).toBe(3);
    await page.locator('.person-panel-header .header-action-btn').click();
    await page.locator('#person-input').fill('Fail after usage');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => calls).toBe(4);
    await expect(page.locator('#person-input')).toBeEnabled();
    await page.locator('.person-thoughts-button').click();
    await page.locator('.person-inspector-nav').getByRole('button', { name: 'Flow & usage', exact: true }).click();
    await expect(page.locator('.person-turn-row')).toHaveCount(2);
    const failed = page.locator('.person-turn-row').first();
    await expect(failed).toContainText('Failed');
    await expect(failed).toContainText('Total tokens: 7');
    await expect(failed).toContainText('Incomplete usage (known values)');
    await expect(failed).not.toContainText('private provider error');
    await failed.locator(':scope > summary').click();
    await page.setViewportSize({ width: 320, height: 680 });
    await page.locator('#person-turns .person-journal-scroll').focus();
    await page.keyboard.press('End');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('person-usage-mobile.png'), fullPage: true });
    await page.locator('.person-panel-header .header-action-btn').click();
    await expect(page.locator('#person-input')).toHaveValue('');
    expect(calls).toBe(4);
    await page.locator('#person-input').fill('Output too long');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => calls).toBe(7); // Initial response plus two bounded output corrections.
    await expect(page.locator('.person-error')).toContainText('not an activity timeout');
    await page.locator('.person-thoughts-button').click();
    await page.locator('.person-inspector-nav').getByRole('button', { name: 'Flow & usage', exact: true }).click();
    const truncated = page.locator('.person-turn-row').first();
    await expect(truncated).toContainText('3 loops');
    await expect(truncated).toContainText('Output: 12,288');
    await truncated.locator(':scope > summary').click();
    await expect(truncated).toContainText('OUTPUT_TRUNCATED');
    await expect(truncated).toContainText('this proposal did not execute a tool');
    await expect(truncated).not.toContainText('unfinished');
    expect(mockAgent.conversations.size).toBe(0);
  } finally {
    mockAgent._messageHandlers.splice(mockAgent._messageHandlers.indexOf(listener), 1);
    release(); await bridge.close(); await rm(dir, { recursive: true, force: true });
  }
});
