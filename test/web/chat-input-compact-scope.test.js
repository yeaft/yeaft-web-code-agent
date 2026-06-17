import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe('ChatInput compact state scoping', () => {
  it('resolves compacting against an explicit conversation id instead of only currentConversation', () => {
    const source = read('web/components/ChatInput.js');

    expect(source).toContain('conversationId: { type: String, default: null }');
    expect(source).toContain('const effectiveConversationId = Vue.computed');
    expect(source).toContain('store.compactStatus?.conversationId === effectiveConversationId.value');
    expect(source).not.toContain("store.compactStatus?.conversationId === store.currentConversation");
  });

  it('passes the controlled conversation id from every ChatInput owner', () => {
    const chatPage = read('web/components/ChatPage.js');
    const splitPane = read('web/components/SplitPane.js');
    const yeaftPage = read('web/components/YeaftPage.js');

    expect(chatPage).toContain('<ChatInput :conversation-id="store.activeConversationId" />');
    expect(splitPane).toContain(':conversationId="conversationId"');
    expect(yeaftPage).toContain(':conversation-id="store.yeaftConversationId"');
  });
});
