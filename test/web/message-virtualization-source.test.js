import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

describe('MessageList virtualization wiring', () => {
  it('routes Chat and Yeaft message blocks through the shared VirtualTranscript', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain("import VirtualTranscript from './VirtualTranscript.js';");
    expect(source).toContain('<VirtualTranscript');
    expect(source).toContain(':items="messageBlocks"');
    expect(source).toContain('@scroll-state="onVirtualTranscriptScrollState"');
    expect(source).toContain('the following VP replies into one virtual item');
    expect(source).toContain('v-if="block.type === \'message-block\'"');
    expect(source).not.toContain('<template v-for="block in messageBlocks"');
  });

  it('keeps remounted assistant action and tool UI state keyed by turn id', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain('const assistantTurnActionStates = Vue.reactive({});');
    expect(source).toContain('const toolExpandStates = Vue.reactive({});');
    expect(source).toContain(':actions-expanded="assistantTurnActionsExpandedFor(block)"');
    expect(source).toContain(':tool-expand-states="toolExpandStates"');
    expect(source).not.toContain('vpTurnExpandStates');
    expect(source).not.toContain(':expand-state="vpTurnExpandStateFor(block)"');
  });
});
