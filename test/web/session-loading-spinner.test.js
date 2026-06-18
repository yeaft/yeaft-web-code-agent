import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

describe('session message loading spinner', () => {
  it('shows a centered loading state while an empty transcript is loading history', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain('showInitialMessagesLoading');
    expect(source).toContain('messageBlocks.value.length > 0');
    expect(source).toContain("store.currentView === 'yeaft'");
    expect(source).toContain('store.yeaftLoadingMoreHistory');
    expect(source).toContain('store.sessionLoading');
    expect(source).toContain('class="initial-message-loading"');
  });

  it('keeps the blocking session overlay mutually exclusive with the initial transcript spinner', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain('v-if="showSessionLoadingOverlay"');
    expect(source).toContain('const showSessionLoadingOverlay = Vue.computed(() => {');
    expect(source).toContain('!!store.sessionLoading && !showInitialMessagesLoading.value');
  });

  it('marks cold chat session selection as history loading', () => {
    const source = read('stores/helpers/conversation.js');

    expect(source).toContain('setSessionLoading(store, true, t(\'chat.session.loadingHistory\'))');
    expect(source).toContain("type: 'sync_messages'");
    expect(source).toContain('turns: 5');
  });
});
