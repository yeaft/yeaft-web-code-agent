import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../../../agent/yeaft/engine.js';
import { AdapterRouter } from '../../../agent/yeaft/llm/router.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { ConversationStore, projectVisibleSessionMessages } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { createBashTool } from '../../../agent/yeaft/tools/bash.js';
import fileRead from '../../../agent/yeaft/tools/file-read.js';
import { runProcess } from '../../../agent/yeaft/tools/process-runner.js';
import webFetch from '../../../agent/yeaft/tools/web-fetch.js';
import { resolveActiveToolNames } from '../../../agent/yeaft/tools/activation.js';
import exitWorktree from '../../../agent/yeaft/tools/exit-worktree.js';
import gitRead, { createGitReadTool, MAX_RESULT_BYTES } from '../../../agent/yeaft/tools/git-read.js';
import { ToolRegistry, truncateToolResultIfNeeded, toolValidationError } from '../../../agent/yeaft/tools/registry.js';
import { estimateContentTokens, estimateMessageTokens, estimateMessagesTokens, trimSnapshotForBudget } from '../../../agent/yeaft/history-window.js';
import { createProviderContext, createProviderState, MAX_PROVIDER_STATE_BYTES, replayProviderState } from '../../../agent/yeaft/llm/provider-state.js';

const MODEL = 'gpt-5';
const SESSION = 'session_harness';
const VP = 'harness-vp';
const textItem = (text, id = 'message') => ({
  type: 'message', id, role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const toolItem = (id, name, input) => ({
  type: 'function_call', id: `item_${id}`, call_id: id, name,
  arguments: JSON.stringify(input), status: 'completed',
});
async function collect(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yeaft-harness-integration-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  closeConversationHistoryIndexes();
  rmSync(root, { recursive: true, force: true });
});

// Only the HTTP boundary is mocked: routing, native normalization, query loop,
// tool scheduling, project rules and transcript persistence remain production code.
function nativeFixture(outputs, { tools = [], store = null, extraBody = null } = {}) {
  const requests = [];
  const fetch = vi.fn(async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const output = outputs.shift();
    if (!output) throw new Error('Unexpected native provider request');
    return new Response(JSON.stringify({
      id: `response_${requests.length}`, status: 'completed', output,
      usage: { input_tokens: 12, output_tokens: 4 },
    }), { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  const router = new AdapterRouter({ providers: [{
    name: 'harness', apiKey: 'synthetic-not-a-secret', credentialScopeId: 'fixture-account', protocol: 'openai-responses',
    models: [{ id: MODEL, supportsEffort: true, thinkingProtocol: 'openai-reasoning',
      effortOptions: ['low', 'medium', 'high', 'max'] }],
  }] });
  const registry = new ToolRegistry();
  tools.forEach(tool => registry.register(tool));
  const adapter = extraBody ? {
    captureStream: params => router.captureStream({ ...params, extraBody }),
  } : router;
  const makeEngine = (overrides = {}) => new Engine({
    adapter, trace: new NullTrace(),
    config: { model: MODEL, maxOutputTokens: 1024, projectDocMaxBytes: 64 * 1024,
      yeaft: { relatedTurnsLimit: 0 } },
    toolRegistry: registry, conversationStore: store,
    yeaftDir: root, sessionId: SESSION, vpId: VP,
    ...overrides,
  });
  return { requests, fetch, router, makeEngine };
}

function readTool(execute) {
  return {
    name: 'FileRead', description: 'Read a fixture file.',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    isReadOnly: () => true, isConcurrencySafe: () => true, cacheWithinQuery: true,
    execute,
  };
}
function writeTool(execute) {
  return {
    name: 'FileWrite', description: 'Write a fixture file.',
    parameters: { type: 'object', properties: {
      file_path: { type: 'string' }, content: { type: 'string' },
    }, required: ['file_path', 'content'] },
    isReadOnly: () => false, execute,
  };
}
function writeScopedRules() {
  writeFileSync(join(root, 'CLAUDE.md'), [
    '# Fixture',
    '## Product Model and Terminology',
    'CORE_RULE '.repeat(1000),
    '## Web and Server',
    'WEB_SCOPE_RULE_MUST_BE_REVIEWED',
    '## Agent Engine',
    'AGENT_SCOPE_RULE',
    '## Testing',
    'TEST_SCOPE_RULE',
  ].join('\n'));
}
function assertSuccessfulTurn(events) {
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  expect(events.filter(event => event.type === 'turn_end' && event.terminal)).toHaveLength(1);
}

describe('native history window replay', () => {
  function signedFixture({ content = 'Inspecting.', thinking = 'Private reasoning.' } = {}) {
    const context = createProviderContext({ protocol: 'anthropic', providerId: 'fixture',
      credentialScopeId: 'fixture-account', model: 'claude-sonnet-4' });
    const identity = { instanceScope: 'fixture', ownerScope: 'owner', sessionId: SESSION,
      vpId: VP, threadId: 'main' };
    const toolCalls = ['first', 'second'].map(id => ({ id, name: 'FileRead', input: {} }));
    const items = [{ type: 'thinking', thinking, signature: 'signed-prefix' },
      { type: 'text', text: content }, ...toolCalls.map(call => ({ type: 'tool_use', ...call }))];
    const owner = { role: 'assistant', content, toolCalls,
      providerState: createProviderState({ context, identity, items }) };
    const snapshot = [{ role: 'user', content: 'Inspect.' }, owner,
      ...toolCalls.map(call => ({ role: 'tool', toolCallId: call.id, content: 'ok' }))];
    return { context, identity, items, owner, snapshot };
  }

  it('restores the complete signed multi-tool group losslessly when it fits', () => {
    const { snapshot, owner, context, identity, items } = signedFixture();
    const original = structuredClone(snapshot);
    const trimmed = trimSnapshotForBudget(snapshot, { messageTokenBudget: 1024 });
    const replay = trimmed.find(message => message.toolCalls?.length);
    expect(replay?.toolCalls).toEqual(owner.toolCalls);
    expect(replayProviderState(replay, context, identity)).toEqual(items);
    expect(trimmed.filter(message => message.role === 'tool')).toHaveLength(2);
    expect(snapshot).toEqual(original);
  });

  it.each(['row cap', 'token cap', 'missing result', 'changed projection'])('drops the entire signed group under %s, never an unsigned subset', reason => {
    const { snapshot } = signedFixture();
    const options = { messageTokenBudget: 1024 };
    if (reason === 'row cap') options.maxMessageCount = 3;
    if (reason === 'token cap') options.messageTokenBudget = 32;
    if (reason === 'missing result') snapshot.pop();
    if (reason === 'changed projection') snapshot[1].content = 'Changed after signing.';
    const original = structuredClone(snapshot);
    const trimmed = trimSnapshotForBudget(snapshot, options);
    expect(trimmed.flatMap(message => message.toolCalls || [])).toEqual([]);
    expect(trimmed.filter(message => message.role === 'tool')).toEqual([]);
    expect(snapshot).toEqual(original);
  });

  it('charges native Anthropic thinking once without duplicating text/tool projections or legacy thinking', () => {
    const { owner } = signedFixture({ thinking: 'reasoning '.repeat(4000) });
    const { providerState, ...projection } = owner;
    const nativeThinking = providerState.items.filter(item => item.type === 'thinking');
    expect(estimateMessageTokens(owner)).toBe(estimateMessageTokens(projection) + estimateContentTokens(nativeThinking));
    expect(estimateMessageTokens({ ...owner, thinkingBlocks: [{ thinking: 'legacy duplicate', signature: 'legacy' }] }))
      .toBe(estimateMessageTokens(owner));
    const textToolState = { ...providerState, items: providerState.items.filter(item => item.type !== 'thinking') };
    expect(estimateMessageTokens({ ...owner, providerState: textToolState })).toBe(estimateMessageTokens(projection));
  });

  it('omits oversized plaintext thinking and its whole tool group within the token budget', () => {
    const { snapshot } = signedFixture({ thinking: 'reasoning '.repeat(4000) });
    const trimmed = trimSnapshotForBudget(snapshot, { messageTokenBudget: 128 });
    expect(trimmed.some(message => message.providerState || message.toolCalls?.length || message.role === 'tool')).toBe(false);
    expect(estimateMessagesTokens(trimmed)).toBeLessThanOrEqual(128);
  });

  it('keeps Responses opaque ciphertext on the byte budget rather than the text token budget', () => {
    const projection = { role: 'assistant', content: 'Answer.' };
    const providerState = { protocol: 'openai-responses', items: [
      { type: 'reasoning', encrypted_content: 'opaque'.repeat(10000), summary: [] }, textItem(projection.content),
    ] };
    expect(estimateMessageTokens({ ...projection, providerState })).toBe(estimateMessageTokens(projection));
    providerState.items[0].encrypted_content = 'x'.repeat(MAX_PROVIDER_STATE_BYTES);
    expect(() => estimateMessageTokens({ ...projection, providerState })).toThrow('state exceeds byte budget');
  });
});

describe('Engine native harness integration', () => {
  it('persists private native state, replays it only in-loop, and omits it from later turns and UI', async () => {
    const storeDir = join(root, 'sessions', SESSION);
    const store = new ConversationStore(storeDir);
    const reasoning = { type: 'reasoning', id: 'reasoning_original',
      encrypted_content: 'PRIVATE-HARNESS-CONTINUATION', summary: [] };
    const original = [reasoning, textItem('Inspecting the fixture.', 'original_message'),
      toolItem('read_original', 'FileRead', { file_path: 'fixture.txt' })];
    const execute = vi.fn(async () => 'fixture contents');
    const fixture = nativeFixture([
      original, [textItem('First turn finished.', 'first_final')],
      [textItem('Second turn finished.', 'second_final')],
      [textItem('Restored turn finished.', 'restored_final')],
    ], { store, tools: [readTool(execute)] });
    const engine = fixture.makeEngine();
    const first = await collect(engine.query({ prompt: 'Inspect the fixture.' }));
    assertSuccessfulTurn(first);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fixture.requests[1].input.filter(item => original.some(row => row.id === item.id))).toEqual(original);
    const persisted = new ConversationStore(storeDir).loadSessionHistoryForVp(SESSION, VP);
    const assistant = persisted.find(message => message.providerState?.items.some(item => item.id === reasoning.id));
    expect(assistant?.providerState.items).toEqual(original);

    const second = await collect(engine.query({ prompt: 'Continue from that result.' }));
    const restarted = fixture.makeEngine({ conversationStore: new ConversationStore(storeDir) });
    const restored = await collect(restarted.query({ prompt: 'Continue after restart.' }));
    for (const index of [2, 3]) {
      expect(fixture.requests[index].input.filter(item => original.some(row => row.id === item.id))).toEqual([]);
    }
    for (const events of [first, second, restored]) {
      assertSuccessfulTurn(events);
      expect(events.some(event => event.type === 'provider_state')).toBe(false);
      expect(JSON.stringify(events)).not.toContain(reasoning.encrypted_content);
    }
    expect(JSON.stringify(projectVisibleSessionMessages(persisted))).not.toContain(reasoning.encrypted_content);
    expect(fixture.fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    { parentEffort: 'max', expectedCap: 'high', flag: '1' },
    { parentEffort: 'low', expectedCap: 'low', flag: '0' },
  ])('passes final parent $parentEffort decision to tools and caps child /max + extraBody at $expectedCap (flag=$flag)', async ({ parentEffort, expectedCap, flag }) => {
    vi.stubEnv('YEAFT_THINKING_V1', flag);
    let parentContext;
    let childEvents;
    let fixture;
    const delegate = readTool(async (_input, ctx) => {
      parentContext = ctx;
      // A tool starts an actual child Engine with the immutable decision from
      // the response that invoked it. Inject hostile config at the router edge.
      const child = fixture.makeEngine({
        adapter: { captureStream: params => fixture.router.captureStream({
          ...params, extraBody: { reasoning: { effort: 'max' },
            output_config: { effort: 'max' }, thinking: { type: 'enabled', budget_tokens: 99999 } },
        }) },
        toolRegistry: new ToolRegistry(), sessionId: `${SESSION}_child`, vpId: 'child',
      });
      childEvents = await collect(child.query({
        prompt: '/max Complete the delegated inspection.', isSubAgent: true,
        parentEffortDecision: ctx.effortDecision,
      }));
      return 'Child finished.';
    });
    fixture = nativeFixture([
      [toolItem('delegate', 'FileRead', { file_path: 'fixture.txt' })],
      [textItem('Child answer.', 'child_final')],
      [textItem('Parent answer.', 'parent_final')],
    ], { tools: [delegate] });
    const events = await collect(fixture.makeEngine().query({ prompt: `/${parentEffort} Inspect the fixture.` }));
    assertSuccessfulTurn(events);
    expect(parentContext?.effortDecision).toMatchObject({
      effective: fixture.requests[0].reasoning.effort,
      thinkingEnabled: true, wireMode: 'reasoning-effort',
    });
    expect(Object.isFrozen(parentContext.effortDecision)).toBe(true);
    assertSuccessfulTurn(childEvents);
    expect(fixture.requests[1].reasoning.effort).toBe(expectedCap);
    expect(fixture.requests[1].thinking).toBeUndefined();
    expect(fixture.requests[1].output_config?.effort).toBeUndefined();
    expect(JSON.stringify(fixture.requests[1].input)).not.toContain('/max');
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
  });

  it('preloads scope from a successful read so the next response can write without a retry', async () => {
    writeScopedRules();
    const read = vi.fn(async () => 'fixture contents');
    const write = vi.fn(async () => 'written');
    const fixture = nativeFixture([
      [toolItem('read_scope', 'FileRead', { file_path: 'web/stores/chat.js' })],
      [toolItem('write_scope', 'FileWrite', { file_path: 'web/stores/chat.js', content: 'updated' })],
      [textItem('Finished.')],
    ], { tools: [readTool(read), writeTool(write)] });
    const events = await collect(fixture.makeEngine().query({ prompt: 'Inspect the target.', workDir: root }));
    assertSuccessfulTurn(events);
    expect(fixture.requests[0].instructions).not.toContain('WEB_SCOPE_RULE_MUST_BE_REVIEWED');
    expect(fixture.requests[1].instructions).toContain('WEB_SCOPE_RULE_MUST_BE_REVIEWED');
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.type === 'tool_end').map(event => event.isError)).toEqual([false, false]);
    expect(events.some(event => event.skipped)).toBe(false);
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
  });

  it('fails closed for read/write in the same response until the model sees the newly loaded scope', async () => {
    writeScopedRules();
    const read = vi.fn(async () => 'fixture contents');
    const write = vi.fn(async () => 'written');
    const fixture = nativeFixture([
      [toolItem('read_scope', 'FileRead', { file_path: 'web/stores/chat.js' }),
        toolItem('unsafe_write', 'FileWrite', { file_path: 'web/stores/chat.js', content: 'updated' })],
      [textItem('Reviewed the newly loaded rules.')],
    ], { tools: [readTool(read), writeTool(write)] });
    const events = await collect(fixture.makeEngine().query({ prompt: 'Inspect the target.', workDir: root }));
    assertSuccessfulTurn(events);
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(events.find(event => event.type === 'tool_end' && event.id === 'unsafe_write')).toMatchObject({
      isError: true, skipped: true,
    });
    expect(fixture.requests[0].instructions).not.toContain('WEB_SCOPE_RULE_MUST_BE_REVIEWED');
    expect(fixture.requests[1].instructions).toContain('WEB_SCOPE_RULE_MUST_BE_REVIEWED');
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one execution for identical cacheable reads in a parallel batch and pairs both wire results', async () => {
    const execute = vi.fn(async () => {
      await new Promise(resolve => setImmediate(resolve));
      return 'shared fixture contents';
    });
    const fixture = nativeFixture([
      [toolItem('read_one', 'FileRead', { file_path: 'fixture.txt' }),
        toolItem('read_two', 'FileRead', { file_path: 'fixture.txt' })],
      [textItem('Finished.')],
    ], { tools: [readTool(execute)] });
    const events = await collect(fixture.makeEngine().query({ prompt: 'Inspect the fixture.' }));
    assertSuccessfulTurn(events);
    expect(execute).toHaveBeenCalledTimes(1);
    const results = events.filter(event => event.type === 'tool_end');
    expect(results.map(event => event.id)).toEqual(['read_one', 'read_two']);
    expect(results.every(event => !event.isError && event.output.includes('shared fixture contents'))).toBe(true);
    const wireResults = fixture.requests[1].input.filter(item => item.type === 'function_call_output');
    expect(wireResults.map(item => item.call_id)).toEqual(['read_one', 'read_two']);
    expect(wireResults.every(item => item.output.includes('shared fixture contents'))).toBe(true);
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
  });
});


describe('tool efficiency contracts', () => {
  it('resolves shell cwd against the Session for foreground and background execution', async () => {
    const child = join(root, 'child');
    mkdirSync(child);
    const runProcessImpl = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }));
    const tool = createBashTool({ runProcessImpl });
    const ctx = { cwd: root, runtimePlatform: { platform: 'darwin', isLinux: false,
      isWindows: false, shellFamily: 'posix', defaultShell: '/bin/sh' } };
    for (const [cwd, expected] of [['.', root], ['child', child], [child, child], ['', root]]) {
      await tool.execute({ command: 'pwd', cwd }, ctx);
      expect(runProcessImpl.mock.lastCall[2].cwd).toBe(expected);
    }
    const startShellTask = vi.fn(() => ({ id: 'task-fixture', status: 'running', log: { path: '/log' } }));
    const output = await tool.execute({ command: 'pwd', cwd: 'child', background: true }, {
      ...ctx, taskManager: { startShellTask },
    });
    expect(startShellTask.mock.lastCall[0].cwd).toBe(child);
    expect(output).toContain(child);
    expect(JSON.parse(await exitWorktree.execute({ path: 'child', action: 'keep' }, ctx)).path).toBe(child);
    await expect(tool.execute({ command: 'pwd', cwd: 'missing' }, ctx)).rejects.toThrow(join(root, 'missing'));
    runProcessImpl.mockResolvedValueOnce({ code: 2, stdout: '', stderr: 'failed' });
    expect(await tool.execute({ command: 'exit 2', cwd: '.' }, ctx)).toContain(`Working directory: ${root}`);
  });

  it('returns file version and overlap hints without suppressing new or changed reads', async () => {
    const path = join(root, 'sample.txt');
    writeFileSync(path, 'one\ntwo\nthree\nfour');
    const ctx = { cwd: root, fileReadObservations: new Map() };
    const first = await fileRead.execute({ file_path: 'sample.txt', limit: 2 }, ctx);
    expect(first).toContain('observed version:');
    expect(first).not.toContain('Previously returned');
    const overlap = await fileRead.execute({ file_path: 'sample.txt', offset: 1, limit: 2 }, ctx);
    expect(overlap).toContain('Previously returned unchanged lines in this query: 2-2');
    expect(overlap).toContain('3\tthree');
    writeFileSync(path, 'ONE\ntwo\nthree\nfour');
    const changed = await fileRead.execute({ file_path: 'sample.txt', limit: 2 }, ctx);
    expect(changed).not.toContain('Previously returned');
    expect(changed).toContain('1\tONE');
    expect(await fileRead.execute({ file_path: 'sample.txt', limit: 2 }, { cwd: root, fileReadObservations: new Map() }))
      .not.toContain('Previously returned');
  });

  it('re-reads a file changed outside the Engine between identical calls', async () => {
    writeFileSync(join(root, 'external.txt'), 'first');
    const input = { file_path: 'external.txt' };
    const fixture = nativeFixture([
      [toolItem('before', 'FileRead', input)],
      [toolItem('after', 'FileRead', input)],
      [textItem('Observed the current content.')],
    ], { tools: [fileRead] });
    const events = [];
    for await (const event of fixture.makeEngine().query({ prompt: 'Read external.txt twice.', workDir: root })) {
      events.push(event);
      if (event.type === 'tool_end' && event.id === 'before') writeFileSync(join(root, 'external.txt'), 'second');
    }
    assertSuccessfulTurn(events);
    const after = events.find(event => event.type === 'tool_end' && event.id === 'after');
    expect(after.output).toContain('second');
    expect(after.output).not.toContain('Previously returned');
    expect(after.reused).not.toBe(true);
  });

  it('keeps both ends of large shell output but never changes its raw persistence value', () => {
    const raw = 'START\n' + '中'.repeat(30000) + '\nFINAL TEST FAILURE';
    for (const language of ['en', 'zh']) {
      const bounded = truncateToolResultIfNeeded(raw, { toolName: 'Bash', language });
      expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(32 * 1024);
      expect(bounded).toContain('START');
      expect(bounded).toContain('FINAL TEST FAILURE');
      expect(bounded).not.toContain('\uFFFD');
    }
    expect(raw.endsWith('FINAL TEST FAILURE')).toBe(true);
    expect(truncateToolResultIfNeeded('small', { toolName: 'Bash' })).toBe('small');
    expect(truncateToolResultIfNeeded(raw, { toolName: 'FileRead' })).not.toContain('FINAL TEST FAILURE');
  });

  it('does not kill verbose commands at the output cap and retains their actual exit and tail', async () => {
    for (const maxBytes of [0, 1, 32, 128, 4096]) {
      const result = await runProcess(process.execPath, ['-e',
        "process.stdout.write('START\\n' + '中'.repeat(10000)); setTimeout(() => { process.stdout.write('\\nFINAL'); process.stderr.write('ERROR'); process.exitCode = 7 }, 20)",
      ], { cwd: root, maxBytes, outputLimitAction: 'head-tail', timeoutMs: 5000 });
      expect(result.code).toBe(7);
      expect(result.timedOut).toBe(false);
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(maxBytes);
      expect(result.stdout).not.toContain('\uFFFD');
      if (maxBytes > 32) {
        expect(result.stdout).toContain('START');
        expect(result.stdout).toContain('FINAL');
        expect(result.stderr).toBe('ERROR');
      }
    }
  });

  it('removes site navigation before budgeting while preserving source data and fallback content', async () => {
    const html = '<script>ignore()</script><nav>MENU '.repeat(1) + 'links '.repeat(500)
      + '</nav><main>API CONTRACT</main><aside>Important caveat</aside><footer>FOOTER</footer>';
    const fetch = vi.fn(async () => new Response(html, { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetch);
    const result = JSON.parse(await webFetch.execute({ url: 'https://example.test/docs', max_length: 100 }, {}));
    expect(result.content).toContain('API CONTRACT');
    expect(result.content).toContain('Important caveat');
    expect(result.content).not.toContain('MENU');
    expect(result.content).not.toContain('FOOTER');
    expect(result.truncated).toBe(false);
    expect(JSON.parse(await webFetch.execute({ url: 'https://example.test/docs', raw: true }, {})).content).toBe(html);
    fetch.mockImplementationOnce(async () => new Response('<style>body{}</style><nav>Only directory</nav>', {
      headers: { 'content-type': 'text/html' },
    }));
    expect(JSON.parse(await webFetch.execute({ url: 'https://example.test' }, {})).content).toBe('Only directory');
    fetch.mockImplementationOnce(async () => new Response('{"nav":"data"}', {
      headers: { 'content-type': 'application/json' },
    }));
    expect(JSON.parse(await webFetch.execute({ url: 'https://example.test' }, {})).content).toBe('{"nav":"data"}');
  });

  it('exposes safe batch editing for explicit code-change intent, not every query', () => {
    const toolNames = ['FileRead', 'ApplyPatch'];
    for (const prompt of ['fix the failing test', 'refactor the runner', '修复所有问题']) {
      expect(resolveActiveToolNames({ toolNames, prompt })).toContain('ApplyPatch');
    }
    expect(resolveActiveToolNames({ toolNames, prompt: 'explain the architecture' })).not.toContain('ApplyPatch');
  });

  it('reports Git runtime failures as tool errors while keeping display-only truncation successful', async () => {
    const runProcessImpl = vi.fn()
      .mockResolvedValueOnce({ code: 128, stdout: '', stderr: 'fatal: unknown revision' })
      .mockResolvedValueOnce({ code: 124, timedOut: true, stdout: '' })
      .mockResolvedValueOnce({ code: 1, truncated: true, stdout: 'partial' })
      .mockResolvedValueOnce({ code: 0, stdout: 'x'.repeat(MAX_RESULT_BYTES * 2) });
    const input = { operation: 'log', revision: 'missing-ref' };
    const fixture = nativeFixture([
      [toolItem('git1', 'GitRead', input)], [toolItem('git2', 'GitRead', input)],
      [toolItem('git3', 'GitRead', input)], [toolItem('git4', 'GitRead', input)], [textItem('Evidence inspected.')],
    ], { tools: [createGitReadTool({ runProcessImpl })] });
    const events = await collect(fixture.makeEngine().query({ prompt: 'Inspect Git history.', workDir: root }));
    assertSuccessfulTurn(events);
    expect(events.filter(event => event.type === 'tool_end').map(event => event.isError)).toEqual([true, true, true, false]);
    expect(runProcessImpl).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(fixture.requests.at(-1).input)).not.toContain('rejected the same arguments twice');
  });

  it('keeps reviewer GitRead visible without intent but hides it from unrelated normal requests', async () => {
    for (const pinned of [false, true]) {
      const fixture = nativeFixture([[textItem('Ready.')]], { tools: [gitRead] });
      const engine = fixture.makeEngine({ config: {
        model: MODEL, maxOutputTokens: 1024, projectDocMaxBytes: 0, _gitReadAlwaysVisible: pinned,
      } });
      assertSuccessfulTurn(await collect(engine.query({ prompt: 'Continue.', workDir: root })));
      expect(fixture.requests[0].tools?.some(tool => tool.name === 'GitRead') || false).toBe(pinned);
    }
  });

  it('diagnoses repeated explicit validation failures once, not runtime failures', async () => {
    const bad = { operation: 'status', revision: 'HEAD' };
    const fixture = nativeFixture([
      [toolItem('bad1', 'GitRead', bad)], [toolItem('bad2', 'GitRead', bad)],
      [toolItem('bad3', 'GitRead', bad)], [textItem('Use a corrected call next time.')],
    ], { tools: [gitRead] });
    const events = await collect(fixture.makeEngine().query({ prompt: 'Inspect GitRead.', workDir: root }));
    assertSuccessfulTurn(events);
    expect(events.filter(event => event.type === 'tool_end').every(event => event.isError)).toBe(true);
    const lastInput = JSON.stringify(fixture.requests.at(-1).input);
    expect(lastInput.match(/rejected the same arguments twice/g)).toHaveLength(1);
    expect(toolValidationError('{"error":"network timeout"}')).toBeNull();
    expect(toolValidationError('{"error":"test failed","code":"invalid_arguments"}')).toBeNull();
  });
});
