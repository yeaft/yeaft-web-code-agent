import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCliSessionRunner, createCliVpEngine } from '../../../agent/yeaft/cli-session-runner.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import {
  normalizeStreamSessionBootstrap,
  runStreamSessionTurn,
} from '../../../agent/yeaft/stdio-protocol.js';
import { buildStreamSubAgentFrame } from '../../../agent/yeaft/sub-agent/public-event.js';
import {
  emitStreamTaskEvent,
  taskResultReentryContext,
} from '../../../agent/yeaft/tasks/result-delivery.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';
import { sessionsRoot } from '../../../agent/yeaft/sessions/session-crud.js';
import routeForwardTool from '../../../agent/yeaft/tools/route-forward.js';

const tempRoots = [];

function tempRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `yeaft-${label}-`));
  tempRoots.push(root);
  return root;
}

function createFormalSession(root, sessionId, roster = ['linus', 'martin']) {
  const handle = createSession(sessionsRoot(root), {
    id: sessionId,
    name: 'stdio protocol test',
    roster,
    defaultVpId: roster[0] || null,
    workDir: '/durable/workdir',
  });
  handle.close();
}

function makeConversationStore() {
  const rows = [];
  return {
    rows,
    append: vi.fn((row) => {
      const persisted = { id: `row-${rows.length + 1}`, ...row };
      rows.push(persisted);
      return persisted;
    }),
    loadSessionHistoryForVp: vi.fn(() => rows.slice()),
  };
}

class RecordingAdapter {
  constructor() {
    this.streamCalls = [];
  }

  async *stream(params) {
    this.streamCalls.push({
      ...params,
      messages: structuredClone(params.messages || []),
    });
    yield { type: 'text_delta', text: 'recorded response' };
    yield { type: 'stop', stopReason: 'end_turn' };
  }

  async call() {
    return { text: 'recorded summary', usage: {} };
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class CausalRecordingAdapter {
  constructor(vpId, { blockPrompt = null, release = null } = {}) {
    this.vpId = vpId;
    this.blockPrompt = blockPrompt;
    this.release = release;
    this.streamCalls = [];
    this.promptCalls = new Map();
  }

  async *stream(params) {
    const snapshot = {
      ...params,
      vpId: this.vpId,
      messages: structuredClone(params.messages || []),
    };
    this.streamCalls.push(snapshot);
    const prompt = [...snapshot.messages].reverse().find(message => (
      message.role === 'user' && message.userAuthored !== false
    ))?.content || null;
    const callNumber = (this.promptCalls.get(prompt) || 0) + 1;
    this.promptCalls.set(prompt, callNumber);
    if (prompt === this.blockPrompt && callNumber === 1) await this.release.promise;
    if (prompt === 'FUTURE_ROOT' && callNumber === 1) {
      yield { type: 'text_delta', text: 'future truncated' };
      yield { type: 'stop', stopReason: 'max_tokens' };
      return;
    }
    yield { type: 'text_delta', text: `${this.vpId}:${prompt || 'response'}` };
    yield { type: 'stop', stopReason: 'end_turn' };
  }

  async call() {
    return { text: 'recorded summary', usage: {} };
  }
}

function writeLateTaskProviderServer(root) {
  const scriptPath = join(root, 'late-task-provider.mjs');
  const portPath = join(root, 'late-task-provider-port');
  const requestLogPath = join(root, 'late-task-provider-requests.jsonl');
  writeFileSync(requestLogPath, '');
  writeFileSync(scriptPath, [
    "import { createServer } from 'node:http';",
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    "function send(res, events, delayMs = 0) {",
    "  setTimeout(() => {",
    "    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });",
    "    res.end(events.map(event => `data: ${JSON.stringify(event)}\\n\\n`).join(''));",
    "  }, delayMs);",
    "}",
    "function textEvents(text) {",
    "  return [",
    "    { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },",
    "    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },",
    "    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },",
    "    { type: 'content_block_stop', index: 0 },",
    "    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },",
    "    { type: 'message_stop' },",
    "  ];",
    "}",
    "function spawnEvents() {",
    "  const input = JSON.stringify({ name: 'late-child', mission: 'return the late child payload' });",
    "  return [",
    "    { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },",
    "    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'spawn-late-child', name: 'SpawnAgent' } },",
    "    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: input } },",
    "    { type: 'content_block_stop', index: 0 },",
    "    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },",
    "    { type: 'message_stop' },",
    "  ];",
    "}",
    "const server = createServer((req, res) => {",
    "  let body = '';",
    "  req.on('data', chunk => { body += chunk; });",
    "  req.on('end', () => {",
    "    appendFileSync(process.argv[3], `${body}\\n`);",
    "    let parsed = {};",
    "    try { parsed = JSON.parse(body); } catch {}",
    "    const system = JSON.stringify(parsed.system || '');",
    "    const messages = JSON.stringify(parsed.messages || []);",
    "    if (system.includes('You are a sub-agent')) {",
    "      send(res, textEvents('late child payload'), 350);",
    "    } else if (messages.includes('<task-result id=')) {",
    "      send(res, textEvents('owner consumed late child result exactly once'));",
    "    } else if (!messages.includes('\\\"name\\\":\\\"SpawnAgent\\\"')) {",
    "      send(res, spawnEvents());",
    "    } else {",
    "      send(res, textEvents('root turn deferred while child runs'));",
    "    }",
    "  });",
    "});",
    "server.listen(0, '127.0.0.1', () => writeFileSync(process.argv[2], String(server.address().port)));",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
  ].join('\n'));
  const child = spawn(process.execPath, [scriptPath, portPath, requestLogPath], { stdio: 'ignore' });
  return { child, portPath, requestLogPath };
}

function writeMockProviderServer(root) {
  const scriptPath = join(root, 'provider.mjs');
  const portPath = join(root, 'provider-port');
  const requestLogPath = join(root, 'provider-requests.jsonl');
  writeFileSync(requestLogPath, '');
  writeFileSync(scriptPath, [
    "import { createServer } from 'node:http';",
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    "const server = createServer((req, res) => {",
    "  let body = '';",
    "  req.on('data', chunk => { body += chunk; });",
    "  req.on('end', () => {",
    "    appendFileSync(process.argv[3], `${body}\\n`);",
    "    let text = 'success';",
    "    try {",
    "      const parsed = JSON.parse(body);",
    "      const users = (parsed.messages || []).filter(message => message.role === 'user');",
    "      const latest = JSON.stringify(users.at(-1)?.content || '');",
    "      if (latest.includes('second prompt')) text = 'second-success';",
    "    } catch {}",
    "    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });",
    "    res.end([",
    "      'event: message_start',",
    "      'data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}',",
    "      '',",
    "      'event: content_block_start',",
    "      'data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}',",
    "      '',",
    "      `event: content_block_delta`,",
    "      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,",
    "      '',",
    "      'event: content_block_stop',",
    "      'data: {\"type\":\"content_block_stop\",\"index\":0}',",
    "      '',",
    "      'event: message_delta',",
    "      'data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}',",
    "      '',",
    "      'event: message_stop',",
    "      'data: {\"type\":\"message_stop\"}',",
    "      '',",
    "    ].join('\\n'));",
    "  });",
    "});",
    "server.listen(0, '127.0.0.1', () => writeFileSync(process.argv[2], String(server.address().port)));",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
  ].join('\n'));
  const child = spawn(process.execPath, [scriptPath, portPath, requestLogPath], { stdio: 'ignore' });
  return { child, portPath, requestLogPath };
}

function writeRouteForwardProviderServer(root) {
  const scriptPath = join(root, 'route-forward-provider.mjs');
  const portPath = join(root, 'route-forward-provider-port');
  const requestLogPath = join(root, 'route-forward-provider-requests.jsonl');
  writeFileSync(requestLogPath, '');
  writeFileSync(scriptPath, [
    "import { createServer } from 'node:http';",
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    "let routeForwardIssued = false;",
    "function send(res, events) {",
    "  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });",
    "  res.end(events.map(event => `data: ${JSON.stringify(event)}\\n\\n`).join(''));",
    "}",
    "function textEvents(text) {",
    "  return [",
    "    { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },",
    "    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },",
    "    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },",
    "    { type: 'content_block_stop', index: 0 },",
    "    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },",
    "    { type: 'message_stop' },",
    "  ];",
    "}",
    "function routeForwardEvents() {",
    "  const input = JSON.stringify({ to: 'margaret', text: 'Please answer the routed request.' });",
    "  return [",
    "    { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },",
    "    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'route-forward', name: 'RouteForward' } },",
    "    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: input } },",
    "    { type: 'content_block_stop', index: 0 },",
    "    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },",
    "    { type: 'message_stop' },",
    "  ];",
    "}",
    "const server = createServer((req, res) => {",
    "  let body = '';",
    "  req.on('data', chunk => { body += chunk; });",
    "  req.on('end', () => {",
    "    appendFileSync(process.argv[3], `${body}\\n`);",
    "    if (!routeForwardIssued && body.includes('route-forward request')) {",
    "      routeForwardIssued = true;",
    "      send(res, routeForwardEvents());",
    "    } else {",
    "      send(res, textEvents('mock response'));",
    "    }",
    "  });",
    "});",
    "server.listen(0, '127.0.0.1', () => writeFileSync(process.argv[2], String(server.address().port)));",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
  ].join('\n'));
  const child = spawn(process.execPath, [scriptPath, portPath, requestLogPath], { stdio: 'ignore' });
  return { child, portPath, requestLogPath };
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      if (readFileSync(path, 'utf8').trim()) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function runCli(root, args, input, extraEnv = {}) {
  const child = spawn(process.execPath, [
    join(process.cwd(), 'agent', 'yeaft', 'cli.js'),
    '--skip-mcp',
    '--skip-skills',
    ...args,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      YEAFT_DIR: root,
      YEAFT_SKIP_MANAGED_CLI_INSTALLS: 'true',
      ...extraEnv,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out; stdout=${stdout}; stderr=${stderr}`));
    }, 30_000);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('stream-json Session runtime protocol', () => {
  it('validates opt-in stream-json Session bootstrap metadata', () => {
    expect(normalizeStreamSessionBootstrap({
      roster: ['omni', 'margaret'],
      vps: ['omni', 'margaret'],
      defaultVpId: 'omni',
    })).toEqual({
      roster: ['omni', 'margaret'],
      defaultVpId: 'omni',
    });
    expect(normalizeStreamSessionBootstrap({ roster: ['omni'] })).toEqual({
      roster: ['omni'],
      defaultVpId: 'omni',
    });
    expect(normalizeStreamSessionBootstrap({ roster: [], defaultVpId: null })).toEqual({
      roster: [],
      defaultVpId: null,
    });
    expect(() => normalizeStreamSessionBootstrap({ defaultVpId: 'omni' }))
      .toThrow('requires roster or vps');
    expect(() => normalizeStreamSessionBootstrap({ roster: ['omni'], vps: ['margaret'] }))
      .toThrow('must contain the same VP ids');
    expect(() => normalizeStreamSessionBootstrap({ roster: ['omni', 'omni'] }))
      .toThrow('duplicate VP id');
    expect(() => normalizeStreamSessionBootstrap({ roster: ['all'] }))
      .toThrow('invalid VP id');
    expect(() => normalizeStreamSessionBootstrap({ roster: ['omni'], defaultVpId: 'margaret' }))
      .toThrow('not in roster');
  });

  it('projects the same scoped execution events for the live multi-VP runner', async () => {
    const writes = [];
    const runner = {
      async run(_prompt, options) {
        const events = [
          { type: 'turn_open', turnId: 'turn-martin', threadId: 'thread-review', vpId: 'martin' },
          { type: 'text_delta', text: 'reviewing', threadId: 'thread-review' },
          {
            type: 'tool_end',
            id: 'tool-image',
            name: 'ViewImage',
            output: 'loaded',
            displayImages: [{ media_type: 'image/png', data: 'safe-image' }],
            threadId: 'thread-review',
          },
          {
            type: 'async_task_wait_start',
            loopNumber: 2,
            pendingTaskIds: ['task-review'],
            threadId: 'thread-review',
          },
          {
            type: 'async_task_wait_end',
            loopNumber: 2,
            remainingTaskIds: [],
            deferredTaskIds: [],
            timedOut: false,
            aborted: false,
            threadId: 'thread-review',
          },
          {
            type: 'turn_end',
            stopReason: 'tool_handoff',
            terminal: true,
            threadId: 'thread-review',
          },
          {
            type: 'turn_close',
            turnId: 'turn-martin',
            threadId: 'thread-review',
            totalMs: 12,
            loopCount: 2,
            totalTokens: 8,
          },
        ];
        for (const event of events) await options.onEvent({ vpId: 'martin', event });
        return { report: { dispatched: ['martin'] }, results: [{ vpId: 'martin', result: 'reviewing' }] };
      },
    };

    const result = await runStreamSessionTurn({
      runner,
      prompt: 'review this',
      sessionId: 'session_stdio_projection',
      workDir: '/workspace',
      write: event => writes.push(event),
    });

    const executionFrames = writes.filter(event => event.type !== 'result');
    expect(executionFrames.length).toBeGreaterThan(0);
    expect(executionFrames.every(event => (
      event.vp_id === 'martin' && event.thread_id === 'thread-review'
    ))).toBe(true);
    expect(writes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'async_task',
        subtype: 'wait_start',
        pending_task_ids: ['task-review'],
      }),
      expect.objectContaining({
        type: 'async_task',
        subtype: 'wait_end',
        remaining_task_ids: [],
        timed_out: false,
      }),
      expect.objectContaining({
        type: 'tool',
        subtype: 'result',
        display_images: [{ media_type: 'image/png', data: 'safe-image' }],
      }),
    ]));
    expect(result).toMatchObject({
      subtype: 'success',
      stop_reason: 'tool_handoff',
      vp_results: [expect.objectContaining({
        vp_id: 'martin',
        thread_id: 'thread-review',
        stop_reason: 'tool_handoff',
      })],
    });
  });

  it('uses structured routing intent without rewriting the prompt or Session metadata', async () => {
    const root = tempRoot('stdio-routing-intent');
    const sessionId = 'session_stdio_routing_intent';
    createFormalSession(root, sessionId);
    const conversationStore = makeConversationStore();
    const calls = [];
    const runner = createCliSessionRunner({
      loaded: { yeaftDir: root, config: {}, conversationStore },
      sessionId,
      workDir: '/ephemeral/cwd',
      engineFactory: (_loaded, _sessionId, vpId) => ({
        async *query(options) {
          calls.push({ vpId, prompt: options.prompt });
          yield { type: 'turn_open', turnId: `turn-${vpId}`, threadId: 'main', vpId };
          yield { type: 'turn_end', stopReason: 'end_turn', terminal: true, threadId: 'main' };
          yield { type: 'turn_close', turnId: `turn-${vpId}`, threadId: 'main' };
        },
        abort: () => true,
      }),
      personaFactory: vpId => ({ vpId }),
    });
    const before = structuredClone(runner.meta);

    const outcome = await runner.run('plain prompt with no mention', {
      routingIntent: { targetVpIds: ['martin'], explicit: true },
    });

    expect(outcome.report.dispatched).toEqual(['martin']);
    expect(calls).toEqual([{ vpId: 'martin', prompt: 'plain prompt with no mention' }]);
    expect(runner.meta).toEqual(before);
    await runner.close();
  });

  it.each([
    {
      label: 'single VP',
      roster: ['linus'],
      routingIntent: { targetVpIds: ['linus'], explicit: true },
      expectedVpIds: ['linus'],
    },
    {
      label: 'multi-VP broadcast',
      roster: ['linus', 'martin'],
      routingIntent: { targetVpIds: ['linus', 'martin'], broadcast: true, explicit: true },
      expectedVpIds: ['linus', 'martin'],
    },
  ])('sends the current formal-Session prompt exactly once for $label', async ({
    roster,
    routingIntent,
    expectedVpIds,
  }) => {
    const root = tempRoot('stdio-current-prompt-once');
    const sessionId = `session_stdio_prompt_once_${roster.length}`;
    createFormalSession(root, sessionId, roster);
    const conversationStore = new ConversationStore(root);
    conversationStore.append({
      role: 'user',
      content: 'prior prompt stays in history',
      sessionId,
      threadId: 'main',
      clientMessageId: 'prior-client-message',
      userAuthored: true,
    });
    const adapter = new RecordingAdapter();
    const loaded = {
      yeaftDir: root,
      config: {
        model: 'test-model',
        primaryModel: 'test-model',
        maxOutputTokens: 1024,
        language: 'en',
        _readOnly: true,
      },
      adapter,
      trace: new NullTrace(),
      conversationStore,
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: null,
      skillManager: null,
      mcpManager: null,
      taskManager: null,
      toolStats: null,
      managedCliReady: null,
    };
    const runner = createCliSessionRunner({ loaded, sessionId });
    const currentPrompt = 'current prompt must reach each provider request once';

    const outcome = await runner.run(currentPrompt, { routingIntent });

    expect(outcome.report.dispatched.slice().sort()).toEqual(expectedVpIds.slice().sort());
    expect(adapter.streamCalls).toHaveLength(expectedVpIds.length);
    for (const call of adapter.streamCalls) {
      const userContents = call.messages
        .filter(message => message.role === 'user')
        .map(message => message.content);
      expect(userContents.filter(content => content === currentPrompt)).toHaveLength(1);
      expect(userContents).toContain('prior prompt stays in history');
    }
    const persistedCurrentRows = conversationStore.loadAllBySession(sessionId).filter(message => (
      message.role === 'user' && message.content === currentPrompt
    ));
    expect(persistedCurrentRows).toHaveLength(1);
    await runner.close();
  });

  it('keeps concurrent formal-Session provider history causal by root turn identity', async () => {
    const root = tempRoot('stdio-concurrent-causal-history');
    const sessionId = 'session_stdio_concurrent_causal_history';
    createFormalSession(root, sessionId, ['linus']);
    const conversationStore = new ConversationStore(root);
    const adapter = new RecordingAdapter();
    const loaded = {
      yeaftDir: root,
      config: {
        model: 'test-model',
        primaryModel: 'test-model',
        maxOutputTokens: 1024,
        language: 'en',
      },
      adapter,
      trace: new NullTrace(),
      conversationStore,
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: null,
      skillManager: null,
      mcpManager: null,
      taskManager: null,
      toolStats: null,
      managedCliReady: null,
    };
    const runner = createCliSessionRunner({ loaded, sessionId });

    const first = runner.run('FIRST_PROMPT', {
      routingIntent: { targetVpIds: ['linus'], explicit: true },
    });
    const future = runner.run('FUTURE_PROMPT', {
      routingIntent: { targetVpIds: ['linus'], explicit: true },
    });
    await Promise.all([first, future]);

    const providerUsers = adapter.streamCalls.map(call => call.messages
      .filter(message => message.role === 'user')
      .map(message => message.content));
    expect(providerUsers).toEqual([
      ['FIRST_PROMPT'],
      ['FIRST_PROMPT', 'FUTURE_PROMPT'],
    ]);
    expect(adapter.streamCalls[0].messages.some(message => message.role === 'assistant')).toBe(false);
    expect(adapter.streamCalls[1].messages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      content: 'recorded response',
    }));
    await runner.close();
  });

  it('includes a Session publication summary in CLI aggregate results without requiring duplicate text', async () => {
    const root = tempRoot('stdio-response-publication');
    const sessionId = 'session_stdio_response_publication';
    createFormalSession(root, sessionId, ['linus']);
    const conversationStore = new ConversationStore(root);
    const frames = [];
    const presentation = { version: 1, title: 'Verified', summary: 'Checks passed.', phase: 'final', blocks: [{ type: 'markdown', text: 'Evidence' }] };
    const loaded = { yeaftDir: root, config: { model: 'test-model' }, conversationStore };
    const runner = createCliSessionRunner({ loaded, sessionId, engineFactory: () => ({
      async *query() {
        yield { type: 'response_presentation', message: { id: 'm001', content: presentation.summary, presentation } };
        yield { type: 'turn_end', terminal: true, stopReason: 'end_turn' };
      },
    }) });
    try {
      const outcome = await runner.run('Show result', { onEvent: frame => frames.push(frame) });
      expect(outcome.results).toHaveLength(1);
      expect(outcome.results[0]).toMatchObject({ result: presentation.summary, stopReason: 'end_turn', error: null });
      expect(frames.find(frame => frame.event.type === 'response_presentation')).toMatchObject({ sessionId, vpId: 'linus', event: { message: { presentation } } });
    } finally { await runner.close(); }
  });

  it('excludes a later VP root and its synthetic continuation from an earlier queued provider request', async () => {
    const root = tempRoot('stdio-cross-vp-causal-control');
    const sessionId = 'session_stdio_cross_vp_causal_control';
    createFormalSession(root, sessionId, ['linus', 'martin']);
    const conversationStore = new ConversationStore(root);
    const releaseBlockingRoot = deferred();
    const adapters = new Map([
      ['linus', new CausalRecordingAdapter('linus', {
        blockPrompt: 'BLOCKING_ROOT',
        release: releaseBlockingRoot,
      })],
      ['martin', new CausalRecordingAdapter('martin')],
    ]);
    const loaded = {
      yeaftDir: root,
      config: {
        model: 'test-model',
        primaryModel: 'test-model',
        maxOutputTokens: 1024,
        language: 'en',
      },
      trace: new NullTrace(),
      conversationStore,
      memoryIndex: null,
      amsRegistry: null,
      toolRegistry: null,
      skillManager: null,
      mcpManager: null,
      taskManager: null,
      toolStats: null,
      managedCliReady: null,
    };
    const runner = createCliSessionRunner({
      loaded,
      sessionId,
      engineFactory: (_loaded, _sessionId, vpId) => createCliVpEngine({
        ..._loaded,
        adapter: adapters.get(vpId),
      }, _sessionId, vpId),
    });

    const blocking = runner.run('BLOCKING_ROOT', {
      routingIntent: { targetVpIds: ['linus'], explicit: true },
    });
    await vi.waitFor(() => expect(adapters.get('linus').streamCalls).toHaveLength(1));
    const earlier = runner.run('EARLIER_ROOT', {
      routingIntent: { targetVpIds: ['linus'], explicit: true },
    });
    const future = runner.run('FUTURE_ROOT', {
      routingIntent: { targetVpIds: ['martin'], explicit: true },
    });

    const futureOutcome = await future;
    const futureRootId = futureOutcome.report.message.id;
    const beforeRelease = conversationStore.loadAllBySession(sessionId);
    expect(beforeRelease.find(message => message.content === 'FUTURE_ROOT')).toMatchObject({
      causalRootId: futureRootId,
      userAuthored: true,
    });
    expect(beforeRelease.find(message => message.content === 'Continue')).toMatchObject({
      causalRootId: futureRootId,
      userAuthored: false,
    });
    expect(beforeRelease.find(message => message.content === 'future truncated')).toMatchObject({
      causalRootId: futureRootId,
      speakerVpId: 'martin',
    });

    releaseBlockingRoot.resolve();
    await Promise.all([blocking, earlier]);

    const earlierRequest = adapters.get('linus').streamCalls.find(call => (
      [...call.messages].reverse().find(message => (
        message.role === 'user' && message.userAuthored !== false
      ))?.content === 'EARLIER_ROOT'
    ));
    expect(earlierRequest).toBeTruthy();
    expect(earlierRequest.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([
      'BLOCKING_ROOT',
      'EARLIER_ROOT',
    ]);
    expect(earlierRequest.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([
      'linus:BLOCKING_ROOT',
    ]);
    expect(earlierRequest.messages.some(message => message.causalRootId === futureRootId)).toBe(false);
    await runner.close();
  });

  it('routes internal task-result reentry to its owner without appending a user transcript row', async () => {
    const root = tempRoot('stdio-task-result-routing');
    const sessionId = 'session_stdio_task_result_routing';
    createFormalSession(root, sessionId);
    const conversationStore = makeConversationStore();
    const calls = [];
    const runner = createCliSessionRunner({
      loaded: { yeaftDir: root, config: {}, conversationStore },
      sessionId,
      engineFactory: (_loaded, _sessionId, vpId) => ({
        async *query(options) {
          calls.push({ vpId, prompt: options.prompt, inboundEnvelope: options.inboundEnvelope });
          yield { type: 'turn_end', stopReason: 'end_turn', terminal: true, threadId: 'main' };
        },
        abort: () => true,
      }),
      personaFactory: vpId => ({ vpId }),
    });

    const outcome = await runner.run('<task-result id="task-1">done</task-result>', {
      internal: true,
      taskId: 'task-1',
      meta: {
        injectedBy: 'task_result',
        routeTargetVpId: 'martin',
        threadId: 'thread-review',
      },
      routingIntent: { targetVpIds: ['martin'], explicit: true },
    });

    expect(outcome.report.dispatched).toEqual(['martin']);
    expect(conversationStore.append).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      vpId: 'martin',
      prompt: '<task-result id="task-1">done</task-result>',
      inboundEnvelope: {
        taskId: 'task-1',
        msg: {
          role: 'assistant',
          meta: expect.objectContaining({ injectedBy: 'task_result', routeTargetVpId: 'martin' }),
        },
      },
    });
    await runner.close();
  });

  it('claims each VP at most once across root broadcast and direct forwards', async () => {
    const root = tempRoot('stdio-claimed-vps');
    const sessionId = 'session_stdio_claimed_vps';
    createFormalSession(root, sessionId);
    const conversationStore = makeConversationStore();
    const calls = [];
    const causalRoots = [];
    let forwarded = false;
    const runner = createCliSessionRunner({
      loaded: { yeaftDir: root, config: {}, conversationStore },
      sessionId,
      engineFactory: (_loaded, _sessionId, vpId) => ({
        async *query(options) {
          calls.push(vpId);
          causalRoots.push({
            vpId,
            causalRootId: options.causalRootId,
            envelopeRootId: options.inboundEnvelope?._cliCausalRootId,
          });
          yield { type: 'turn_open', turnId: `turn-${vpId}-${calls.length}`, threadId: 'main', vpId };
          if (vpId === 'linus' && !forwarded) {
            forwarded = true;
            options.router.forward({
              from: 'linus',
              to: 'martin',
              text: 'review the same root turn',
              inboundEnvelope: options.inboundEnvelope,
              sourceThreadId: 'main',
            });
          }
          yield { type: 'turn_end', stopReason: 'end_turn', terminal: true, threadId: 'main' };
          yield { type: 'turn_close', turnId: `turn-${vpId}-${calls.length}`, threadId: 'main' };
        },
        abort: () => true,
      }),
      personaFactory: vpId => ({ vpId }),
    });

    const outcome = await runner.run('broadcast without prompt directives', {
      routingIntent: { targetVpIds: ['linus', 'martin'], broadcast: true, explicit: true },
    });

    expect(outcome.report.dispatched).toEqual(['linus', 'martin']);
    expect(calls.filter(vpId => vpId === 'linus')).toHaveLength(1);
    expect(calls.filter(vpId => vpId === 'martin')).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(new Set(causalRoots.map(entry => entry.causalRootId)).size).toBe(1);
    expect(causalRoots.every(entry => entry.causalRootId === entry.envelopeRootId)).toBe(true);
    await runner.close();
  });

  it('filters task frames by Session and separates public snapshots from owner-only reentry context', () => {
    const write = vi.fn();
    const task = {
      id: 'task-secret',
      sessionId: 'session_task_owner',
      ownerVpId: 'linus',
      kind: 'sub_agent',
      title: 'private review',
      status: 'succeeded',
      resultDelivery: 'model_reentry',
      runtime: { command: 'echo private-command', threadId: 'thread-owner' },
      source: { threadId: 'thread-owner' },
      result: { summary: 'private-summary' },
      log: { path: '/private/task.log', preview: 'private-log-preview' },
    };

    const sibling = emitStreamTaskEvent({
      event: { event: 'completed', task },
      asyncTaskOwners: new Map(),
      write,
      sessionId: 'session_other',
    });
    expect(sibling).toEqual({ projected: false, delivered: false });
    expect(write).not.toHaveBeenCalled();

    const ownerEngine = {
      ownsPendingAsyncTask: vi.fn(() => true),
      notifyAsyncTaskCompleted: vi.fn(() => true),
    };
    const active = emitStreamTaskEvent({
      event: { event: 'completed', task },
      asyncTaskOwners: new Map([['task-secret', {
        engine: ownerEngine,
        sessionId: 'session_task_owner',
        vpId: 'linus',
        threadId: 'thread-owner',
      }]]),
      write,
      sessionId: 'session_task_owner',
    });
    expect(active).toEqual({ projected: true, delivered: true });
    const publicFrame = write.mock.calls[0][0];
    expect(publicFrame).toMatchObject({
      type: 'task',
      session_id: 'session_task_owner',
      vp_id: 'linus',
      thread_id: 'thread-owner',
    });
    expect(JSON.stringify(publicFrame)).not.toContain('private-command');
    expect(JSON.stringify(publicFrame)).not.toContain('private-log-preview');
    expect(JSON.stringify(publicFrame)).not.toContain('/private/task.log');
    const modelContext = taskResultReentryContext(
      { event: 'completed', task },
      { sessionId: 'session_task_owner' },
    );
    expect(modelContext.content).toContain('private-summary');
    expect(modelContext.content).toContain('private-log-preview');
  });

  it('projects sub-agent events through an owner-scoped allowlist', () => {
    const raw = {
      type: 'loop',
      agentId: 'agent-secret',
      agentName: 'reviewer',
      parentSessionId: 'session_subagent_owner',
      parentVpId: 'linus',
      parentThreadId: 'thread-parent',
      systemPrompt: 'do-not-publish-system',
      messages: [{ role: 'user', content: 'do-not-publish-message' }],
      toolCalls: [{ input: { token: 'do-not-publish-token' } }],
      rawRequest: { authorization: 'do-not-publish-request' },
      rawResponse: { body: 'do-not-publish-response' },
    };
    expect(buildStreamSubAgentFrame({
      event: raw,
      sessionId: 'session_subagent_owner',
      vpId: 'linus',
      threadId: 'thread-parent',
    })).toBeNull();

    const statusFrame = buildStreamSubAgentFrame({
      event: {
        ...raw,
        type: 'sub_agent_status',
        status: 'completed',
        error: null,
      },
      sessionId: 'session_subagent_owner',
      vpId: 'linus',
      threadId: 'thread-parent',
    });
    expect(statusFrame).toMatchObject({
      type: 'sub_agent',
      subtype: 'status',
      session_id: 'session_subagent_owner',
      vp_id: 'linus',
      thread_id: 'thread-parent',
      payload: {
        type: 'sub_agent_status',
        status: 'completed',
        parentSessionId: 'session_subagent_owner',
        parentVpId: 'linus',
        parentThreadId: 'thread-parent',
      },
    });
    const wire = JSON.stringify(statusFrame);
    for (const secret of [
      'do-not-publish-system',
      'do-not-publish-message',
      'do-not-publish-token',
      'do-not-publish-request',
      'do-not-publish-response',
    ]) expect(wire).not.toContain(secret);
  });

  it('lets RouteForward broadcast reach each unclaimed peer once', async () => {
    const root = tempRoot('stdio-route-broadcast');
    const sessionId = 'session_stdio_route_broadcast';
    createFormalSession(root, sessionId, ['linus', 'martin', 'steve']);
    const conversationStore = makeConversationStore();
    const calls = [];
    const causalRoots = [];
    let forwarded = false;
    let forwardResult = null;
    const runner = createCliSessionRunner({
      loaded: { yeaftDir: root, config: {}, conversationStore },
      sessionId,
      engineFactory: (_loaded, _sessionId, vpId) => ({
        async *query(options) {
          calls.push(vpId);
          causalRoots.push({
            vpId,
            causalRootId: options.causalRootId,
            envelopeRootId: options.inboundEnvelope?._cliCausalRootId,
          });
          if (vpId === 'linus' && !forwarded) {
            forwarded = true;
            forwardResult = options.router.forward({
              from: 'linus',
              to: 'all',
              text: 'review this together',
              inboundEnvelope: options.inboundEnvelope,
              sourceThreadId: 'main',
            });
          }
          yield { type: 'turn_end', stopReason: vpId === 'linus' ? 'tool_handoff' : 'end_turn', terminal: true };
        },
        abort: () => true,
      }),
      personaFactory: vpId => ({ vpId }),
    });

    const outcome = await runner.run('start with Linus', {
      routingIntent: { targetVpIds: ['linus'], explicit: true },
    });

    expect(forwardResult).toMatchObject({ ok: true, dispatched: ['martin', 'steve'] });
    expect(outcome.results.map(result => result.vpId).sort()).toEqual(['linus', 'linus', 'martin', 'steve']);
    expect(calls.filter(vpId => vpId === 'linus')).toHaveLength(2);
    expect(calls.filter(vpId => vpId === 'martin')).toHaveLength(1);
    expect(calls.filter(vpId => vpId === 'steve')).toHaveLength(1);
    expect(new Set(causalRoots.map(entry => entry.causalRootId)).size).toBe(1);
    expect(causalRoots.every(entry => entry.causalRootId === entry.envelopeRootId)).toBe(true);
    await runner.close();
  });

  it('keeps child-process JSONL init-first, rejects unknown selectors terminally, and continues later input', async () => {
    const root = tempRoot('stdio-child-process');
    const sessionId = 'session_stdio_child_process';
    createFormalSession(root, sessionId, ['linus', 'martin']);
    const sessionMetaPath = join(root, 'sessions', sessionId, 'session.json');
    const durableMeta = JSON.parse(readFileSync(sessionMetaPath, 'utf8'));
    durableMeta.workDir = '/durable/workdir';
    writeFileSync(sessionMetaPath, `${JSON.stringify(durableMeta, null, 2)}\n`);

    const staleTaskDir = join(root, 'tasks', 'sessions', 'session_other');
    mkdirSync(staleTaskDir, { recursive: true });
    writeFileSync(join(staleTaskDir, 'task_stale.json'), JSON.stringify({
      id: 'task_stale',
      sessionId: 'session_other',
      ownerVpId: 'intruder',
      kind: 'shell',
      title: 'secret sibling command',
      status: 'running',
      resultDelivery: 'status_only',
      runtime: { command: 'echo sibling-secret' },
      source: { threadId: 'sibling-thread' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2));

    const provider = writeMockProviderServer(root);
    try {
      await waitForFile(provider.portPath);
      const port = readFileSync(provider.portPath, 'utf8').trim();
      writeFileSync(join(root, 'config.json'), JSON.stringify({
        providers: [{
          name: 'mock',
          baseUrl: `http://127.0.0.1:${port}`,
          apiKey: 'test',
          protocol: 'anthropic',
          models: ['claude-test'],
        }],
        primaryModel: 'mock/claude-test',
        llmRetry: { maxRetries: 0, forbiddenRetryDelaysMs: [] },
      }));
      writeFileSync(join(root, 'models_dev_cache.json'), '{}');
      const input = [
        JSON.stringify({
          type: 'prompt',
          prompt: 'must reject before provider',
          targetVpId: 'missing',
          roster: ['linus', 'martin'],
          vps: ['linus', 'martin'],
          defaultVpId: 'linus',
        }),
        JSON.stringify({ type: 'prompt', prompt: 'second prompt', targetVpId: 'martin' }),
        '',
      ].join('\n');
      const outcome = await runCli(root, [
        '--session-id', sessionId,
        '--cwd', root,
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
      ], input);
      const frames = outcome.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

      expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: sessionId });
      expect(outcome.stdout).not.toContain('session_other');
      expect(outcome.stdout).not.toContain('sibling-secret');
      const results = frames.filter(frame => frame.type === 'result');
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ subtype: 'error', is_error: true, stop_reason: 'error' });
      expect(results[0].error).toContain('not in roster');
      expect(results[1]).toMatchObject({ subtype: 'success', is_error: false });
      expect(frames.some(frame => frame.vp_id === 'martin' && frame.type === 'assistant')).toBe(true);
      expect(outcome).toMatchObject({ code: 1, signal: null });
      expect(readFileSync(sessionMetaPath, 'utf8')).toBe(`${JSON.stringify(durableMeta, null, 2)}\n`);
      const requests = readFileSync(provider.requestLogPath, 'utf8').trim().split('\n').filter(Boolean);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain('second prompt');
      expect(requests[0]).not.toContain('must reject before provider');
    } finally {
      provider.child.kill('SIGTERM');
      await new Promise(resolve => provider.child.once('close', resolve));
    }
  }, 40_000);

  it('bootstraps an AgentLink Session from its first roster payload and returns aggregate turns', async () => {
    const root = tempRoot('stdio-agentlink-bootstrap');
    const sessionId = 'session_agentlink_stream_bootstrap';
    const sessionDir = join(root, 'sessions', sessionId);
    createFormalSession(root, 'session_existing_sibling', ['omni']);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      workDir: root,
      providerId: 'yeaft',
      sessionId,
      roster: ['omni', 'margaret'],
      defaultVpId: 'omni',
    }, null, 2));
    writeFileSync(join(root, 'sessions-manifest.json'), '{broken');

    const provider = writeRouteForwardProviderServer(root);
    try {
      await waitForFile(provider.portPath);
      const port = readFileSync(provider.portPath, 'utf8').trim();
      writeFileSync(join(root, 'config.json'), JSON.stringify({
        providers: [{
          name: 'mock',
          baseUrl: `http://127.0.0.1:${port}`,
          apiKey: 'test',
          protocol: 'anthropic',
          models: ['claude-test'],
        }],
        primaryModel: 'mock/claude-test',
        llmRetry: { maxRetries: 0, forbiddenRetryDelaysMs: [] },
      }));
      writeFileSync(join(root, 'models_dev_cache.json'), '{}');
      const input = [
        JSON.stringify({
          type: 'user',
          prompt: 'plain first prompt',
          vps: ['omni', 'margaret'],
          roster: ['omni', 'margaret'],
          defaultVpId: 'omni',
        }),
        JSON.stringify({ type: 'user', prompt: 'route-forward request' }),
        '',
      ].join('\n');

      const outcome = await runCli(root, [
        '--session-id', sessionId,
        '--cwd', root,
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
      ], input);
      const frames = outcome.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const results = frames.filter(frame => frame.type === 'result');
      const sessionMeta = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8'));
      const manifest = JSON.parse(readFileSync(join(root, 'sessions-manifest.json'), 'utf8'));
      const routeForward = frames.find(frame => (
        frame.type === 'tool' && frame.subtype === 'result' && frame.name === 'RouteForward'
      ));

      expect(outcome).toMatchObject({ code: 0, signal: null });
      expect(frames[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: sessionId });
      expect(sessionMeta).toMatchObject({
        id: sessionId,
        name: sessionId,
        roster: ['omni', 'margaret'],
        defaultVpId: 'omni',
        workDir: root,
        workspaceKey: realpathSync(root),
      });
      expect(manifest.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: sessionId,
          path: sessionDir,
          workDir: root,
          workspaceKey: realpathSync(root),
        }),
        expect.objectContaining({ id: 'session_existing_sibling' }),
      ]));
      expect(results).toHaveLength(2);
      expect(results.every(result => (
        Array.isArray(result.dispatched_vp_ids)
        && Array.isArray(result.vp_results)
        && result.vp_id === undefined
      ))).toBe(true);
      expect(results[0]).toMatchObject({
        subtype: 'success',
        is_error: false,
        dispatched_vp_ids: ['omni'],
        vp_results: [expect.objectContaining({ vp_id: 'omni', stop_reason: 'end_turn' })],
      });
      expect(results[1]).toMatchObject({
        subtype: 'success',
        is_error: false,
        dispatched_vp_ids: ['omni'],
      });
      expect(results[1].vp_results.map(result => result.vp_id)).toEqual(
        expect.arrayContaining(['omni', 'margaret']),
      );
      expect(routeForward).toBeDefined();
      expect(JSON.parse(routeForward.content)).toMatchObject({
        ok: true,
        dispatched: ['margaret'],
      });
      expect(outcome.stdout).not.toContain('router_unavailable');
    } finally {
      provider.child.kill('SIGTERM');
      await new Promise(resolve => provider.child.once('close', resolve));
    }
  }, 40_000);

  it('rejects ad-hoc VP selectors before provider dispatch and continues later input', async () => {
    const root = tempRoot('stdio-adhoc-selector-rejection');
    const sessionId = 'session_stdio_adhoc_selector_rejection';
    const provider = writeMockProviderServer(root);
    try {
      await waitForFile(provider.portPath);
      const port = readFileSync(provider.portPath, 'utf8').trim();
      writeFileSync(join(root, 'config.json'), JSON.stringify({
        providers: [{
          name: 'mock',
          baseUrl: `http://127.0.0.1:${port}`,
          apiKey: 'test',
          protocol: 'anthropic',
          models: ['claude-test'],
        }],
        primaryModel: 'mock/claude-test',
        llmRetry: { maxRetries: 0, forbiddenRetryDelaysMs: [] },
      }));
      writeFileSync(join(root, 'models_dev_cache.json'), '{}');
      const input = [
        JSON.stringify({ type: 'prompt', prompt: 'must reject before provider', targetVpId: 'martin' }),
        JSON.stringify({ type: 'prompt', prompt: 'second prompt' }),
        '',
      ].join('\n');

      const outcome = await runCli(root, [
        '--session-id', sessionId,
        '--cwd', root,
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
      ], input);
      const frames = outcome.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const results = frames.filter(frame => frame.type === 'result');
      const requests = readFileSync(provider.requestLogPath, 'utf8').trim().split('\n').filter(Boolean);

      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ subtype: 'error', is_error: true, stop_reason: 'error' });
      expect(results[0].error).toContain('formal Session');
      expect(results[1]).toMatchObject({ subtype: 'success', is_error: false });
      expect(results.every(frame => frame.vp_id === undefined && frame.vpId === undefined)).toBe(true);
      expect(outcome).toMatchObject({ code: 1, signal: null });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain('second prompt');
      expect(requests[0]).not.toContain('must reject before provider');
    } finally {
      provider.child.kill('SIGTERM');
      await new Promise(resolve => provider.child.once('close', resolve));
    }
  }, 40_000);

  it('drains a model-reentry task that completes after stdin EOF before closing the Session runner', async () => {
    const root = tempRoot('stdio-late-task-shutdown');
    const sessionId = 'session_stdio_late_task_shutdown';
    createFormalSession(root, sessionId, ['linus']);
    const provider = writeLateTaskProviderServer(root);
    const timeShiftPath = join(root, 'shift-time.mjs');
    writeFileSync(timeShiftPath, [
      'const realNow = Date.now.bind(Date);',
      'Date.now = () => realNow() + 180_000;',
    ].join('\n'));

    try {
      await waitForFile(provider.portPath);
      const port = readFileSync(provider.portPath, 'utf8').trim();
      writeFileSync(join(root, 'config.json'), JSON.stringify({
        providers: [{
          name: 'mock',
          baseUrl: `http://127.0.0.1:${port}`,
          apiKey: 'test',
          protocol: 'anthropic',
          models: ['claude-test'],
        }],
        primaryModel: 'mock/claude-test',
        llmRetry: { maxRetries: 0, forbiddenRetryDelaysMs: [] },
      }));
      writeFileSync(join(root, 'models_dev_cache.json'), '{}');
      const input = `${JSON.stringify({
        type: 'prompt',
        prompt: 'spawn a child that completes after the root turn is deferred',
        targetVpId: 'linus',
      })}\n`;

      const outcome = await runCli(root, [
        '--session-id', sessionId,
        '--cwd', root,
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
      ], input, {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(timeShiftPath).href}`.trim(),
      });
      const frames = outcome.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const results = frames.filter(frame => frame.type === 'result');
      const taskCompletions = frames.filter(frame => frame.type === 'task' && frame.subtype === 'completed');
      const runnerClosedErrors = frames.filter(frame => (
        frame.type === 'error' && JSON.stringify(frame).includes('CLI Session runner is closed')
      ));
      const requestBodies = readFileSync(provider.requestLogPath, 'utf8')
        .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const taskResultRequests = requestBodies.filter(body => JSON.stringify(body.messages || []).includes('<task-result id='));

      expect(outcome).toMatchObject({ code: 0, signal: null });
      expect(outcome.stdout).not.toContain('CLI Session runner is closed');
      expect(outcome.stderr).not.toContain('CLI Session runner is closed');
      expect(runnerClosedErrors).toEqual([]);
      expect(results).toHaveLength(2);
      const terminalResultsByTurn = Map.groupBy(results, frame => frame.turn_id);
      expect(terminalResultsByTurn.size).toBe(2);
      expect(Array.from(terminalResultsByTurn.values()).map(turnResults => turnResults.length)).toEqual([1, 1]);
      expect(results[0].turn_id).not.toBe(results[1].turn_id);
      expect(results.every(frame => frame.subtype === 'success' && frame.is_error === false)).toBe(true);
      expect(results[0].result).toContain('root turn deferred while child runs');
      expect(taskCompletions).toHaveLength(1);
      expect(taskResultRequests).toHaveLength(1);
      expect(results[1].result).toContain('owner consumed late child result exactly once');
      expect(frames.indexOf(results[0])).toBeLessThan(frames.indexOf(taskCompletions[0]));
      expect(frames.indexOf(taskCompletions[0])).toBeLessThan(frames.indexOf(results[1]));
    } finally {
      provider.child.kill('SIGTERM');
      await new Promise(resolve => provider.child.once('close', resolve));
    }
  }, 40_000);

  it('rescues an ad-hoc model-reentry task after stdin EOF through the single Engine', async () => {
    const root = tempRoot('stdio-adhoc-late-task-shutdown');
    const sessionId = 'session_stdio_adhoc_late_task_shutdown';
    const provider = writeLateTaskProviderServer(root);
    const timeShiftPath = join(root, 'shift-time.mjs');
    writeFileSync(timeShiftPath, [
      'const realNow = Date.now.bind(Date);',
      'Date.now = () => realNow() + 180_000;',
    ].join('\n'));

    try {
      await waitForFile(provider.portPath);
      const port = readFileSync(provider.portPath, 'utf8').trim();
      writeFileSync(join(root, 'config.json'), JSON.stringify({
        providers: [{
          name: 'mock',
          baseUrl: `http://127.0.0.1:${port}`,
          apiKey: 'test',
          protocol: 'anthropic',
          models: ['claude-test'],
        }],
        primaryModel: 'mock/claude-test',
        llmRetry: { maxRetries: 0, forbiddenRetryDelaysMs: [] },
      }));
      writeFileSync(join(root, 'models_dev_cache.json'), '{}');
      const input = `${JSON.stringify({
        type: 'prompt',
        prompt: 'spawn a child that completes after the ad-hoc root turn is deferred',
      })}\n`;

      const outcome = await runCli(root, [
        '--session-id', sessionId,
        '--cwd', root,
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
      ], input, {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${pathToFileURL(timeShiftPath).href}`.trim(),
      });
      const frames = outcome.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const results = frames.filter(frame => frame.type === 'result');
      const taskCompletions = frames.filter(frame => frame.type === 'task' && frame.subtype === 'completed');
      const requestBodies = readFileSync(provider.requestLogPath, 'utf8')
        .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const taskResultRequests = requestBodies.filter(body => JSON.stringify(body.messages || []).includes('<task-result id='));

      expect(outcome).toMatchObject({ code: 0, signal: null });
      expect(results).toHaveLength(2);
      expect(results.every(frame => frame.vp_id === undefined && frame.vpId === undefined)).toBe(true);
      expect(results[0].result).toContain('root turn deferred while child runs');
      expect(taskCompletions).toHaveLength(1);
      expect(taskResultRequests).toHaveLength(1);
      expect(results[1].result).toContain('owner consumed late child result exactly once');
      expect(frames.indexOf(results[0])).toBeLessThan(frames.indexOf(taskCompletions[0]));
      expect(frames.indexOf(taskCompletions[0])).toBeLessThan(frames.indexOf(results[1]));
    } finally {
      provider.child.kill('SIGTERM');
      await new Promise(resolve => provider.child.once('close', resolve));
    }
  }, 40_000);

  it('re-enters the RouteForward source after a terminal review and emits one root aggregate', async () => {
    const root = tempRoot('stdio-route-forward-reentry');
    const sessionId = 'session_stdio_route_forward_reentry';
    createFormalSession(root, sessionId);
    const conversationStore = makeConversationStore();
    const calls = [];
    const frames = [];
    let routeHandoff = null;
    const runner = createCliSessionRunner({
      loaded: { yeaftDir: root, config: {}, conversationStore },
      sessionId,
      engineFactory: (_loaded, _sessionId, vpId) => ({
        async *query(options) {
          calls.push({
            vpId,
            prompt: options.prompt,
            injectedBy: options.inboundEnvelope?.msg?.meta?.injectedBy || null,
          });
          yield { type: 'turn_open', turnId: `turn-${vpId}`, threadId: 'main', vpId };
          if (vpId === 'linus' && !routeHandoff) {
            yield {
              type: 'tool_call',
              id: 'route-to-martin',
              name: 'RouteForward',
              input: { to: 'martin', text: 'review this implementation', reason: 'review' },
              threadId: 'main',
            };
            const output = await routeForwardTool.execute({
              to: 'martin',
              text: 'review this implementation',
              reason: 'review',
            }, {
              router: options.router,
              senderVpId: vpId,
              inboundEnvelope: options.inboundEnvelope,
              threadId: 'main',
              requestEndTurn: detail => { routeHandoff = detail; },
            });
            yield { type: 'tool_end', id: 'route-to-martin', name: 'RouteForward', output, threadId: 'main' };
            yield {
              type: 'turn_end',
              stopReason: 'tool_handoff',
              terminal: true,
              threadId: 'main',
              detail: routeHandoff,
            };
          } else if (vpId === 'martin') {
            yield { type: 'text_delta', text: 'FAIL: the implementation needs a null guard.', threadId: 'main' };
            yield { type: 'turn_end', stopReason: 'end_turn', terminal: true, threadId: 'main' };
          } else {
            expect(options.inboundEnvelope?.msg?.meta).toMatchObject({
              injectedBy: 'route_forward_result',
              routeTargetVpId: 'linus',
            });
            expect(options.prompt).toContain('FAIL: the implementation needs a null guard.');
            expect(options.messages).toEqual(expect.arrayContaining([
              expect.objectContaining({ role: 'user', content: 'start with Linus' }),
            ]));
            yield { type: 'text_delta', text: 'Omni applied the null guard and is ready for another review.', threadId: 'main' };
            yield { type: 'turn_end', stopReason: 'end_turn', terminal: true, threadId: 'main' };
          }
          yield { type: 'turn_close', turnId: `turn-${vpId}`, threadId: 'main' };
        },
        abort: () => true,
      }),
      personaFactory: vpId => ({ vpId }),
    });

    const result = await runStreamSessionTurn({
      runner,
      prompt: 'start with Linus',
      sessionId,
      write: frame => frames.push(frame),
      routingIntent: { targetVpIds: ['linus'], explicit: true },
    });

    expect(JSON.parse(frames.find(frame => frame.type === 'tool' && frame.name === 'RouteForward').content))
      .toMatchObject({ ok: true, dispatched: ['martin'] });
    expect(calls.map(call => call.vpId)).toEqual(['linus', 'martin', 'linus']);
    expect(calls[2]).toMatchObject({ injectedBy: 'route_forward_result' });
    const aggregateResults = frames.filter(frame => frame.type === 'result' && frame.vp_id === undefined);
    expect(aggregateResults).toHaveLength(1);
    expect(aggregateResults[0]).toBe(result);
    expect(result).toMatchObject({
      stop_reason: 'end_turn',
      result: expect.stringContaining('Omni applied the null guard'),
      vp_results: expect.arrayContaining([
        expect.objectContaining({ vp_id: 'linus', stop_reason: 'end_turn' }),
        expect.objectContaining({ vp_id: 'martin', result: 'FAIL: the implementation needs a null guard.' }),
      ]),
    });
    await runner.close();
  });

  it('does not re-enter a RouteForward source after the root is cancelled', async () => {
    const root = tempRoot('stdio-route-forward-cancel');
    const sessionId = 'session_stdio_route_forward_cancel';
    createFormalSession(root, sessionId, ['linus', 'martin']);
    const targetStarted = Promise.withResolvers();
    const releaseTarget = Promise.withResolvers();
    const calls = [];
    const runner = createCliSessionRunner({
      loaded: { yeaftDir: root, config: {}, conversationStore: makeConversationStore() },
      sessionId,
      engineFactory: (_loaded, _sessionId, vpId) => ({
        async *query(options) {
          calls.push(vpId);
          if (vpId === 'linus') {
            options.router.forward({
              from: 'linus',
              to: 'martin',
              text: 'review this',
              inboundEnvelope: options.inboundEnvelope,
            });
            yield { type: 'turn_end', stopReason: 'tool_handoff', terminal: true };
          } else {
            targetStarted.resolve();
            await releaseTarget.promise;
            yield { type: 'turn_end', stopReason: 'aborted', terminal: true };
          }
        },
        abort: () => true,
      }),
      personaFactory: vpId => ({ vpId }),
    });

    const turn = runner.run('start', {
      routingIntent: { targetVpIds: ['linus'], explicit: true },
    });
    await targetStarted.promise;
    expect(runner.abort('user')).toBeGreaterThan(0);
    releaseTarget.resolve();
    const outcome = await turn;

    expect(calls).toEqual(['linus', 'martin']);
    expect(outcome.results.map(row => row.stopReason)).toEqual(['tool_handoff', 'aborted']);
    await runner.close();
  });

  it('scopes cancellation to the selected concurrent root', async () => {
    const root = tempRoot('stdio-route-forward-scoped-cancel');
    const sessionId = 'session_stdio_route_forward_scoped_cancel';
    createFormalSession(root, sessionId, ['linus', 'martin']);
    const gates = new Map([
      ['linus', Promise.withResolvers()],
      ['martin', Promise.withResolvers()],
    ]);
    const aborted = new Set();
    const runner = createCliSessionRunner({
      loaded: { yeaftDir: root, config: {}, conversationStore: makeConversationStore() },
      sessionId,
      engineFactory: (_loaded, _sessionId, vpId) => ({
        async *query() {
          await gates.get(vpId).promise;
          yield {
            type: 'turn_end',
            stopReason: aborted.has(vpId) ? 'aborted' : 'end_turn',
            terminal: true,
          };
        },
        abort: () => {
          aborted.add(vpId);
          return true;
        },
      }),
      personaFactory: vpId => ({ vpId }),
    });

    const first = runner.run('first', {
      cancellationId: 'root-first',
      routingIntent: { targetVpIds: ['linus'], explicit: true },
    });
    const second = runner.run('second', {
      cancellationId: 'root-second',
      routingIntent: { targetVpIds: ['martin'], explicit: true },
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(runner.abort('user', { cancellationId: 'root-first' })).toBe(1);
    gates.get('linus').resolve();
    gates.get('martin').resolve();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(firstOutcome.results[0].stopReason).toBe('aborted');
    expect(secondOutcome.results[0].stopReason).toBe('end_turn');
    expect(aborted).toEqual(new Set(['linus']));
    await runner.close();
  });

  it('bubbles nested RouteForward results back through each source VP', async () => {
    const root = tempRoot('stdio-route-forward-nested');
    const sessionId = 'session_stdio_route_forward_nested';
    createFormalSession(root, sessionId, ['linus', 'martin', 'steve']);
    const calls = [];
    const runner = createCliSessionRunner({
      loaded: { yeaftDir: root, config: {}, conversationStore: makeConversationStore() },
      sessionId,
      engineFactory: (_loaded, _sessionId, vpId) => ({
        async *query(options) {
          const injectedBy = options.inboundEnvelope?.msg?.meta?.injectedBy || null;
          calls.push({ vpId, injectedBy, prompt: options.prompt });
          if (vpId === 'linus' && !injectedBy) {
            options.router.forward({
              from: 'linus',
              to: 'martin',
              text: 'review this',
              inboundEnvelope: options.inboundEnvelope,
            });
            yield { type: 'turn_end', stopReason: 'tool_handoff', terminal: true };
          } else if (vpId === 'martin' && injectedBy === 'route_forward') {
            options.router.forward({
              from: 'martin',
              to: 'steve',
              text: 'validate this review',
              inboundEnvelope: options.inboundEnvelope,
            });
            yield { type: 'turn_end', stopReason: 'tool_handoff', terminal: true };
          } else if (vpId === 'steve') {
            yield { type: 'text_delta', text: 'FAIL: missing guard.' };
            yield { type: 'turn_end', stopReason: 'end_turn', terminal: true };
          } else if (vpId === 'martin') {
            expect(options.prompt).toContain('FAIL: missing guard.');
            yield { type: 'text_delta', text: 'Martin confirmed the missing guard.' };
            yield { type: 'turn_end', stopReason: 'end_turn', terminal: true };
          } else {
            expect(options.prompt).toContain('Martin confirmed the missing guard.');
            yield { type: 'text_delta', text: 'Linus fixed the guard.' };
            yield { type: 'turn_end', stopReason: 'end_turn', terminal: true };
          }
        },
        abort: () => true,
      }),
      personaFactory: vpId => ({ vpId }),
    });

    const outcome = await runner.run('start', {
      routingIntent: { targetVpIds: ['linus'], explicit: true },
    });

    expect(calls.map(call => call.vpId)).toEqual(['linus', 'martin', 'steve', 'martin', 'linus']);
    expect(outcome.results.at(-1)).toMatchObject({ vpId: 'linus', result: 'Linus fixed the guard.' });
    await runner.close();
  });

  it('reports truncated RouteForward fan-out to the source VP', async () => {
    const root = tempRoot('stdio-route-forward-partial');
    const sessionId = 'session_stdio_route_forward_partial';
    const roster = ['linus', ...Array.from({ length: 18 }, (_, index) => `reviewer-${index}`)];
    createFormalSession(root, sessionId, roster);
    let sourcePrompt = '';
    let forwarded = false;
    const runner = createCliSessionRunner({
      loaded: { yeaftDir: root, config: {}, conversationStore: makeConversationStore() },
      sessionId,
      engineFactory: (_loaded, _sessionId, vpId) => ({
        async *query(options) {
          if (vpId === 'linus' && !forwarded) {
            forwarded = true;
            options.router.forward({
              from: 'linus',
              to: 'all',
              text: 'review this',
              inboundEnvelope: options.inboundEnvelope,
            });
            yield { type: 'turn_end', stopReason: 'tool_handoff', terminal: true };
          } else if (vpId === 'linus') {
            sourcePrompt = options.prompt;
            yield { type: 'turn_end', stopReason: 'end_turn', terminal: true };
          } else {
            yield { type: 'text_delta', text: `${vpId} reviewed` };
            yield { type: 'turn_end', stopReason: 'end_turn', terminal: true };
          }
        },
        abort: () => true,
      }),
      personaFactory: vpId => ({ vpId }),
    });

    await runner.run('start', {
      routingIntent: { targetVpIds: ['linus'], explicit: true },
    });

    expect(sourcePrompt).toContain('fan-out was truncated');
    await runner.close();
  });
});
