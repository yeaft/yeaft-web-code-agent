import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFullRegistry } from '../../../agent/yeaft/tools/index.js';
import { buildMcpFlattenedTools, mcpListTools, mcpCallTool } from '../../../agent/yeaft/tools/mcp-tools.js';
import { PersonCapabilities } from '../../../agent/yeaft/person/capabilities.js';
import { EXECUTION_GOAL_TOOL } from '../../../agent/yeaft/person/execution-goal.js';
import { LLMToolInputError } from '../../../agent/yeaft/llm/adapter.js';
import { AnthropicAdapter } from '../../../agent/yeaft/llm/anthropic.js';
import { GeminiAdapter } from '../../../agent/yeaft/llm/gemini.js';
import { OpenAIResponsesAdapter } from '../../../agent/yeaft/llm/openai-responses.js';
import { bindProviderState, createProviderContext, replayProviderState } from '../../../agent/yeaft/llm/provider-state.js';
import { decodeResponsesInput, projectResponsesTools } from '../../../agent/yeaft/llm/responses-tool-schema.js';
import {
  createProposeWorkItemActionsTool, createRequestWorkItemReplanTool, createSubmitWorkItemPlanTool,
  createSubmitWorkItemReplanTool, createWorkItemToolRegistry, createWorkItemVpTool,
} from '../../../agent/yeaft/work-center/runner.js';

const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const collect = async iterator => { const events = []; for await (const event of iterator) events.push(event); return events; };
const callItem = (name, args, suffix = '1') => ({ type: 'function_call', id: `fc_${suffix}`, call_id: `call_${suffix}`, name, arguments: JSON.stringify(args), status: 'completed' });
const done = (output = []) => ({ id: 'response_1', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 8 } });
const params = { model: 'gpt-5', messages: [{ role: 'user', content: 'Use the tool.' }] };
const responses = () => new OpenAIResponsesAdapter({ apiKey: 'fixture' });
const inputSchema = { type: 'object', additionalProperties: false, properties: {
  values: { type: 'array', uniqueItems: true, items: { type: 'string' } },
  text: { type: 'string' },
}, required: ['values'] };
const tool = (name, parameters) => ({ name, parameters, description: `Fixture ${name}` });
const asFunction = t => ({ type: 'function', ...t });
afterEach(() => vi.unstubAllGlobals());

// Independent assertion against the supported Responses schema vocabulary.
const strictKeys = new Set(['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'enum',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems']);
function strictSchema(schema, path, root = true) {
  expect(Object.keys(schema).filter(key => !strictKeys.has(key)), path).toEqual([]);
  if (root) { expect(schema.type, path).toBe('object'); expect(schema.anyOf, path).toBeUndefined(); }
  if (schema.type === 'object' || Array.isArray(schema.type) && schema.type.includes('object')) {
    expect(schema.additionalProperties, path).toBe(false);
    expect(schema.required, path).toEqual(Object.keys(schema.properties));
    for (const [key, child] of Object.entries(schema.properties)) strictSchema(child, `${path}.${key}`, false);
  }
  if (schema.enum) expect(schema.enum.length, path).toBeGreaterThan(0);
  if (schema.items) strictSchema(schema.items, `${path}[]`, false);
  schema.anyOf?.forEach((child, i) => strictSchema(child, `${path}/anyOf/${i}`, false));
}

describe('Responses strict tool boundary', () => {
  it('sends every registered Session, Person and Work Center function as strict without mutating its source contract', async () => {
    const source = createFullRegistry();
    source.registerAll([mcpListTools, mcpCallTool]);
    const person = new PersonCapabilities(null, 'fixture');
    const create = [createWorkItemVpTool, createSubmitWorkItemPlanTool, createProposeWorkItemActionsTool, createRequestWorkItemReplanTool, createSubmitWorkItemReplanTool];
    const work = vps => createWorkItemToolRegistry({ workDir: process.cwd(), runTools: create.map(factory => factory({
      workItem: { planRevision: 7 }, vps, actions: [], action: {}, isRunActive: () => true,
    })) }).getToolDefs();
    const catalogs = [source.getToolDefs('en'), source.getToolDefs('zh'), [...person.executionTools(), EXECUTION_GOAL_TOOL],
      work([]), work([{ id: 'vp-fixture', role: 'Fixture' }])];
    for (const tools of catalogs) {
      const before = structuredClone(tools);
      vi.stubGlobal('fetch', vi.fn(async (_url, req) => {
        const body = JSON.parse(req.body);
        expect(body.tools.map(t => t.name)).toEqual(tools.map(t => t.name));
        for (const t of body.tools) {
          expect(t.strict, t.name).toBe(true);
          strictSchema(t.parameters, t.name);
        }
        const reply = body.tools.find(t => t.name === 'Conversation__reply');
        if (reply) expect(reply.parameters.properties.messageIds.description).toMatch(/at most once/);
        const propose = body.tools.find(t => t.name === 'ProposeWorkItemActions');
        if (propose) {
          expect(propose.parameters.properties.dependencyPatches.maxItems).toBe(0);
          const candidates = propose.parameters.properties.actions.items.properties.candidateVpIds;
          if (!candidates.items.enum) expect(candidates.maxItems).toBe(0);
          else expect(candidates.items.enum).toEqual(['vp-fixture']);
        }
        return json(done());
      }));
      expect((await collect(responses().stream({ ...params, tools }))).at(-1).type).toBe('stop');
      expect(tools).toEqual(before);
    }
  });

  it('keeps canonical schemas on Anthropic and Gemini while adapting the identical tool for Responses', async () => {
    const tools = [tool('Inspect', inputSchema)];
    const outgoing = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, req) => {
      const body = JSON.parse(req.body); outgoing.push(body);
      if (body.messages) return json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
      if (body.contents) return json({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
      return json(done());
    }));
    await collect(responses().stream({ ...params, tools }));
    await collect(new AnthropicAdapter({ apiKey: 'fixture' }).stream({ ...params, model: 'claude-sonnet-4', tools }));
    await new GeminiAdapter({ apiKey: 'fixture' }).call({ ...params, model: 'gemini-2.5-flash', tools });
    expect(outgoing[0].tools[0]).toMatchObject({ strict: true, parameters: { required: ['values', 'text'] } });
    expect(outgoing[0].tools[0].parameters.properties.values.uniqueItems).toBeUndefined();
    expect(outgoing[1].tools[0].input_schema).toEqual(inputSchema);
    expect(outgoing[1].tools[0].strict).toBeUndefined();
    expect(outgoing[2].tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(inputSchema);
  });

  it('accepts nested external not and open maps using lossless wire JSON; schema-field names are not keywords', async () => {
    const wireJson = { not: 'ordinary property', payload: { values: [null, '雪', '"\\', { nested: true }] }, choice: 'ok', maybe: null, requiredNullable: null };
    const external = { type: 'object', additionalProperties: false, required: ['not', 'payload', 'choice', 'requiredNullable'], properties: {
      not: { type: 'string' }, payload: { type: 'object', additionalProperties: true },
      choice: { type: 'string', not: { const: 'blocked' } }, maybe: { type: ['string', 'null'] }, requiredNullable: { type: ['string', 'null'], minLength: 2 },
    } };
    const mcp = { callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
      listTools: () => [{ name: 'fixture__inspect', server: 'fixture', inputSchema: external }] };
    const registry = createFullRegistry();
    registry.registerAll(buildMcpFlattenedTools(mcp));
    const tools = registry.getToolDefs().filter(t => t.name === 'mcp__fixture__inspect');
    const name = tools[0].name;
    const encoded = { not: wireJson.not, payload: JSON.stringify(wireJson.payload), choice: '"ok"', maybe: 'null', requiredNullable: null };
    vi.stubGlobal('fetch', vi.fn(async (_url, req) => {
      const sent = JSON.parse(req.body).tools[0];
      strictSchema(sent.parameters, name);
      expect(sent.parameters.properties.not.type).toBe('string');
      expect(sent.parameters.properties.requiredNullable.type).toEqual(['string', 'null']);
      expect(sent.parameters.properties.choice.description).toContain('"not"');
      return json(done([callItem(name, encoded)]));
    }));
    const call = (await collect(responses().stream({ ...params, tools }))).find(e => e.type === 'tool_call');
    expect(call.input).toEqual(wireJson);
    await registry.execute(name, call.input, {});
    expect(mcp.callTool).toHaveBeenCalledWith('fixture__inspect', wireJson);
    const { codecs } = projectResponsesTools(tools.map(asFunction));
    expect(decodeResponsesInput({ ...encoded, maybe: null }, codecs.get(name))).not.toHaveProperty('maybe');
    const openRoot = asFunction(tool('mcp__fixture__open', { type: 'object', properties: {}, additionalProperties: true }));
    const projected = projectResponsesTools([openRoot]);
    strictSchema(projected.tools[0].parameters, openRoot.name);
    expect(decodeResponsesInput({ argumentsJson: JSON.stringify(wireJson) }, projected.codecs.get(openRoot.name))).toEqual(wireJson);
  });

  it('strips optional wire nulls in discriminated objects but preserves required nulls and exact native replay', async () => {
    const identity = { instanceScope: 'test', ownerScope: 'owner', sessionId: 'session', vpId: 'vp', threadId: 'thread' };
    const context = createProviderContext({ protocol: 'openai-responses', model: params.model, credentialScopeId: 'test' });
    const tools = [createFullRegistry().getToolDefs().find(t => t.name === 'PresentResponse'), EXECUTION_GOAL_TOOL];
    const values = { title: null, summary: 'Observed', phase: null, blocks: [{ type: 'cards', title: null, items: [{ title: 'Card', text: 'Result', label: null, image: null, url: null }] }] };
    const present = callItem('PresentResponse', values);
    const goal = callItem('Execution__goal', { blocker: null }, '2');
    const raw = [{ type: 'reasoning', id: 'r1', encrypted_content: 'encrypted' }, present, goal];
    const fetch = vi.fn(async () => json(done(raw)));
    vi.stubGlobal('fetch', fetch);
    const result = await collect(responses().stream({ ...params, tools, providerContext: context, requestIdentity: identity }));
    const toolCalls = result.filter(e => e.type === 'tool_call');
    expect(toolCalls.map(call => call.input)).toEqual([{ summary: 'Observed', blocks: [{ type: 'cards', items: [{ title: 'Card', text: 'Result' }] }] }, { blocker: null }]);
    const state = JSON.parse(JSON.stringify(result.find(e => e.type === 'provider_state').providerState));
    const message = { role: 'assistant', content: '', toolCalls, providerState: bindProviderState(state, { toolCalls }) };
    expect(replayProviderState(message, context, { ...identity, ownerScope: 'other' })).toBeNull();
    expect(replayProviderState(message, context, identity)).toEqual(raw);
    expect(state.version).toBe(2);
    const { title, ...withoutOptionalNull } = values;
    for (const bad of [{ ...values, summary: 'changed' }, withoutOptionalNull]) {
      const tampered = structuredClone(message);
      tampered.providerState.items[1].arguments = JSON.stringify(bad);
      expect(replayProviderState(tampered, context, identity)).toBeNull();
    }
    fetch.mockResolvedValueOnce(json(done()));
    await collect(responses().stream({ ...params, tools: [], providerContext: context, requestIdentity: identity,
      messages: [...params.messages, message, ...toolCalls.map(c => ({ role: 'tool', toolCallId: c.id, content: 'ok' }))] }));
    const replay = JSON.parse(fetch.mock.calls[1][1].body).input;
    expect(replay.slice(1, 4)).toEqual(raw);
    expect(replay.slice(4).map(item => item.call_id)).toEqual(toolCalls.map(call => call.id));
  });

  it('re-encodes tool history without native state only for available tools and preserves result pairing', async () => {
    const gateway = new OpenAIResponsesAdapter({ apiKey: 'fixture', baseUrl: 'https://proxy.test/v1' });
    const open = tool('mcp__fixture__open', { type: 'object', additionalProperties: true });
    const openArgs = { other: [1, null, '雪'] };
    const active = tool('Inspect', inputSchema);
    const items = [callItem(open.name, { argumentsJson: JSON.stringify(openArgs) }), callItem(active.name, { values: ['a'], text: null }, '2')];
    const fetch = vi.fn().mockResolvedValueOnce(json(done(items))).mockImplementation(async () => json(done()));
    vi.stubGlobal('fetch', fetch);
    const first = await collect(gateway.stream({ ...params, tools: [open, active] }));
    expect(first.some(e => e.type === 'provider_state')).toBe(false);
    const toolCalls = first.filter(e => e.type === 'tool_call');
    expect(toolCalls.map(call => call.input)).toEqual([openArgs, { values: ['a'] }]);
    const messages = [...params.messages, { role: 'assistant', toolCalls }, ...toolCalls.map(call => ({ role: 'tool', toolCallId: call.id, content: 'ok' }))];
    for (const tools of [[open, active], [active]]) await collect(gateway.stream({ ...params, tools, messages }));
    const history = index => JSON.parse(fetch.mock.calls[index][1].body).input;
    expect(history(1).slice(1, 3).map(item => item.arguments)).toEqual(items.map(item => item.arguments));
    expect(history(1).slice(3).map(item => item.call_id)).toEqual(toolCalls.map(call => call.id));
    expect(JSON.parse(history(2)[1].arguments)).toEqual(openArgs);
    fetch.mockResolvedValueOnce(json({ status: 'completed', output_text: 'text only', output: {} }));
    await expect(gateway.call({ ...params, tools: [open] })).resolves.toMatchObject({ text: 'text only' });
  });

  it('fails a complete malformed JSON-encoded tool batch without emitting executable calls (SSE, JSON, extraBody)', async () => {
    const active = asFunction(tool('mcp__fixture__open', { type: 'object', additionalProperties: true }));
    const good = callItem(active.name, { argumentsJson: '{"id":"good"}' });
    const malformed = callItem(active.name, { argumentsJson: '{bad inner JSON' }, '2');
    const make = [() => json(done([good, malformed])), () => sse([
      { type: 'response.output_item.added', output_index: 0, item: good },
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: good.arguments },
      { type: 'response.output_item.done', output_index: 1, item: malformed },
      { type: 'response.completed', response: done([good]) },
    ]), () => sse([
      { type: 'response.output_item.done', output_index: 0, item: good },
      { type: 'response.completed', response: done([callItem(active.name, { argumentsJson: '{"id":"different"}' })]) },
    ])];
    const options = { ...params, tools: [tool('Unused', inputSchema)], extraBody: { tools: [active, { type: 'web_search' }] } };
    for (const reply of make) {
      vi.stubGlobal('fetch', vi.fn(async (_url, req) => {
        const body = JSON.parse(req.body);
        expect(body.tools[0]).toMatchObject({ name: active.name, strict: true });
        expect(body.tools[1]).toEqual({ type: 'web_search' });
        return reply();
      }));
      const result = await collect(responses().stream(options));
      expect(result.map(event => event.type)).toEqual(['usage', 'error']);
      expect(result.at(-1)).toMatchObject({ retryable: false, error: expect.any(LLMToolInputError) });
    }
    vi.stubGlobal('fetch', vi.fn(async () => json(done([malformed]))));
    await expect(responses().call(options)).rejects.toBeInstanceOf(LLMToolInputError);
  });
});
