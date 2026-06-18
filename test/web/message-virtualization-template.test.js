import { compile } from '@vue/compiler-dom';
import { describe, expect, it } from 'vitest';

globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.window = globalThis.window || globalThis;
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = globalThis.Pinia.defineStore || ((_id, options) => () => ({
  ...(options.state ? options.state() : {}),
  ...(options.actions || {}),
}));
globalThis.window.Pinia = globalThis.Pinia;

describe('message virtualization templates', () => {
  it('compile after wiring VirtualTranscript into MessageList', async () => {
    const [messageList, virtualTranscript, assistantTurn, vpTurnBlock, toolLine] = await Promise.all([
      import('../../web/components/MessageList.js'),
      import('../../web/components/VirtualTranscript.js'),
      import('../../web/components/AssistantTurn.js'),
      import('../../web/components/VpTurnBlock.js'),
      import('../../web/components/ToolLine.js'),
    ]);

    for (const component of [
      messageList.default,
      virtualTranscript.default,
      assistantTurn.default,
      vpTurnBlock.default,
      toolLine.default,
    ]) {
      try {
        compile(component.template);
      } catch (error) {
        throw new Error(`${component.name} template failed to compile: ${error.message} ${JSON.stringify(error.loc || {})}`);
      }
    }
  });
});
