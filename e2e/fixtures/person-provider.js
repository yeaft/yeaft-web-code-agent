// Scripted inference only; uses the production adapter protocol and transcript.
// Person execution supplies native schemas, then tools:[] for final cognition.
export const personInput = params => JSON.parse(params.messages[0].content);
export const personToolResults = params => params.messages.filter(message => message.role === 'tool')
  .map(message => ({ toolUseId: message.toolCallId, ...JSON.parse(message.content) }));
export const personCognition = params => params.tools.length === 0;
export const personToolCall = (id, name, input = {}) => ({ type: 'tool_call', id, name: name.replaceAll('.', '__'), input });
export const personStop = hasTools => ({ type: 'stop', stopReason: hasTools ? 'tool_use' : 'end_turn' });
