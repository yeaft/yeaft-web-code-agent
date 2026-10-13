import { createPersonService as createService } from '../../../../agent/yeaft/person/service.js';

/** Translate historical proposal scripts at the test boundary only. Runtime sees
 * real native calls, its own assistant/tool transcript, and tools-free cognition.
 * The terminal proposal is reused for the additional final request so scripted
 * counters still describe decisions, not a duplicate invocation of the script. */
export function nativeFixtureAdapter(adapter) {
  const episodes = new Map();
  return { ...adapter, async *stream(params) {
    if (!params.requestIdentity?.threadId || !params.requestIdentity.threadId.match(/^[0-9a-f-]{36}$/)) { yield* adapter.stream(params); return; }
    const id = params.requestIdentity.threadId;
    const state = episodes.get(id) ?? { previous: null, final: null, calls: 0 };
    episodes.set(id, state);
    if (!params.tools.length && state.final) {
      yield { type: 'text_delta', text: state.final.text };
      for (const event of state.final.usage) yield event;
      yield { type: 'stop', stopReason: 'end_turn' };
      state.final = null;
      return;
    }
    const first = params.messages[0].content;
    const input = JSON.parse(Array.isArray(first) ? first[0].text : first);
    const lastTool = params.messages.findLast(message => message.role === 'tool');
    if (lastTool) {
      const projection = JSON.parse(lastTool.content);
      let result = projection;
      const call = params.messages.flatMap(message => message.toolCalls ?? []).find(call => call.id === lastTool.toolCallId);
      if (call?.name?.startsWith('catalog__') || call?.name?.startsWith('Script__') || call?.name === 'Capability__create' || call?.name === 'PresentResponse') {
        try { result = JSON.parse(projection.output); } catch { /* Native text result. */ }
      }
      input.capabilityResult = lastTool.toolCallId === state.continuationCall ? null : result;
    }
    const finalInstruction = params.messages.findLast(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('"phase":"final-cognition"'));
    if (finalInstruction) input.sourceRefs = JSON.parse(finalInstruction.content).sourceRefs;
    for (const message of params.messages.filter(message => message.role === 'tool')) {
      const result = JSON.parse(message.content);
      if (result.sourceRef && !input.sourceRefs.includes(result.sourceRef)) input.sourceRefs.push(result.sourceRef);
      for (const record of result.items ?? []) {
        if (!['messages', 'concepts'].includes(result.kind)) break;
        const ref = `${result.kind === 'messages' ? 'message' : 'concept'}:${record.id}:${record.revision}`;
        if (!input.sourceRefs.includes(ref)) input.sourceRefs.push(ref);
      }
    }
    input.previousProposal = state.previous ? { activity: state.previous.activity, decision: state.previous.decision, concepts: state.previous.concepts, state: state.previous.state, reply: state.previous.reply } : null;
    input.nativeTools = params.tools;
    const correction = params.messages.findLast(message => message.role === 'user' && message.content?.includes?.('rejectedBeforeExecution'));
    if (correction) input.outputRecovery = JSON.parse(correction.content);
    const content = Array.isArray(first) ? [{ ...first[0], text: JSON.stringify(input) }, ...first.slice(1)] : JSON.stringify(input);
    const scriptParams = { ...params, messages: [{ ...params.messages[0], content }, ...params.messages.slice(1)] };
    const events = [];
    let text = '', stop = null;
    try {
      for await (const event of adapter.stream(scriptParams)) {
        if (event.type === 'text_delta') text += event.text;
        else if (event.type === 'stop') stop = event.stopReason;
        events.push(event);
        if (!['text_delta', 'stop'].includes(event.type)) yield event;
      }
    } catch (error) {
      yield* events.filter(event => event.type === 'text_delta' || event.type === 'stop');
      throw error;
    }
    let proposal;
    try { proposal = JSON.parse(text); } catch { /* Preserve malformed output. */ }
    // Incomplete responses are never converted into executable calls.
    if (stop !== 'end_turn' || !proposal || !Object.hasOwn(proposal, 'next')) { yield* events.filter(event => event.type === 'stop' || event.type === 'text_delta'); return; }
    state.calls++;
    state.previous = proposal;
    if (!params.tools.length) {
      // No historical continuation authority can leak into the final contract.
      yield* events.filter(event => event.type === 'stop' || event.type === 'text_delta');
      return;
    }
    if (proposal.next?.capability) {
      const { id: capability, args = {} } = proposal.next.capability;
      if (proposal.reply) yield { type: 'text_delta', text: proposal.reply };
      yield { type: 'tool_call', id: `fixture-${state.calls}`, name: capability.replaceAll('.', '__'), input: args };
      yield { type: 'stop', stopReason: 'tool_use' };
      return;
    }
    if (proposal.next !== null) {
      // A historical no-capability continuation is a harmless, real catalog
      // inspection, not a runtime proposal or an invented tool result.
      yield { type: 'text_delta', text: proposal.reply ?? '' };
      yield { type: 'tool_call', id: `fixture-${state.calls}`, name: 'catalog__search', input: { query: proposal.next.reason } };
      state.continuationCall = `fixture-${state.calls}`;
      yield { type: 'stop', stopReason: 'tool_use' };
      return;
    }
    state.final = { text, usage: events.filter(event => event.type === 'usage') };
    if (proposal.reply) yield { type: 'text_delta', text: proposal.reply };
    yield { type: 'stop', stopReason: 'end_turn' };
  } };
}

export function createPersonService(options) {
  return createService({ ...options, ...(options.adapter && options.nativeFixture !== false ? { adapter: nativeFixtureAdapter(options.adapter) } : {}) });
}
