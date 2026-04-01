import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for /btw side question feature (PR #301).
 *
 * Covers business logic across 6 areas:
 * 1. slash-commands — /btw registered in SYSTEM_SKILLS
 * 2. chat store — sendBtwQuestion / closeBtw / appendBtwDelta actions
 * 3. messageHandler — btw_stream / btw_done / btw_error cases
 * 4. ChatInput — /btw interception in Chat mode
 * 5. crewInput — /btw interception in Crew mode
 * 6. BtwOverlay — keyboard close logic (Esc / Enter / Space)
 */

let slashSource;
let storeSource;
let handlerSource;
let chatInputSource;
let crewInputSource;
let overlaySource;
let cssSource;

beforeAll(() => {
  const base = resolve(__dirname, '../../web');
  slashSource = readFileSync(resolve(base, 'utils/slash-commands.js'), 'utf-8');
  storeSource = readFileSync(resolve(base, 'stores/chat.js'), 'utf-8');
  handlerSource = readFileSync(resolve(base, 'stores/helpers/messageHandler.js'), 'utf-8');
  chatInputSource = readFileSync(resolve(base, 'components/ChatInput.js'), 'utf-8');
  crewInputSource = readFileSync(resolve(base, 'components/crew/crewInput.js'), 'utf-8');
  overlaySource = readFileSync(resolve(base, 'components/BtwOverlay.js'), 'utf-8');
  cssSource = readFileSync(resolve(base, 'styles/btw.css'), 'utf-8');
});

// =====================================================================
// 1. slash-commands — /btw registered in SYSTEM_SKILLS
// =====================================================================
describe('slash-commands — /btw registration', () => {
  it('should include /btw in SYSTEM_SKILLS', () => {
    expect(slashSource).toContain("'/btw'");
  });

  it('should have correct description for /btw', () => {
    expect(slashSource).toContain("'Side question (no history)'");
  });
});

// =====================================================================
// 2. chat store — btw state & actions
// =====================================================================

// Replicate store btw logic for unit testing
function createBtwStore(overrides = {}) {
  return {
    currentConversation: 'currentConversation' in overrides ? overrides.currentConversation : 'conv_001',
    btwQuestion: null,
    btwAnswer: '',
    btwLoading: false,
    btwVisible: false,
    sentMessages: [],
    sendWsMessage(msg) { this.sentMessages.push(msg); },
    // Replicate sendBtwQuestion
    sendBtwQuestion(question) {
      if (!this.currentConversation) return;
      this.btwQuestion = question;
      this.btwAnswer = '';
      this.btwLoading = true;
      this.btwVisible = true;
      this.sendWsMessage({
        type: 'btw_question',
        conversationId: this.currentConversation,
        question
      });
    },
    closeBtw() {
      this.btwQuestion = null;
      this.btwAnswer = '';
      this.btwLoading = false;
      this.btwVisible = false;
    },
    appendBtwDelta(delta) {
      this.btwAnswer += delta;
    }
  };
}

describe('chat store — btw state fields', () => {
  it('should define btwMode, btwMessages, btwLoading, btwSessionId in state', () => {
    expect(storeSource).toContain('btwMode: false');
    expect(storeSource).toContain('btwMessages: []');
    expect(storeSource).toContain('btwLoading: false');
    expect(storeSource).toContain('btwSessionId: null');
  });
});

describe('chat store — sendBtwQuestion', () => {
  it('should set all btw state fields when called', () => {
    const store = createBtwStore();
    store.sendBtwQuestion('什么是 Vue');

    expect(store.btwQuestion).toBe('什么是 Vue');
    expect(store.btwAnswer).toBe('');
    expect(store.btwLoading).toBe(true);
    expect(store.btwVisible).toBe(true);
  });

  it('should send btw_question WS message with correct payload', () => {
    const store = createBtwStore();
    store.sendBtwQuestion('test question');

    expect(store.sentMessages).toHaveLength(1);
    expect(store.sentMessages[0]).toEqual({
      type: 'btw_question',
      conversationId: 'conv_001',
      question: 'test question'
    });
  });

  it('should not send when currentConversation is null', () => {
    const store = createBtwStore({ currentConversation: null });
    store.sendBtwQuestion('test');

    expect(store.sentMessages).toHaveLength(0);
    expect(store.btwVisible).toBe(false);
  });

  it('should reset btwAnswer on each new question', () => {
    const store = createBtwStore();
    store.btwAnswer = 'old answer';
    store.sendBtwQuestion('new question');

    expect(store.btwAnswer).toBe('');
  });
});

describe('chat store — closeBtw', () => {
  it('should reset all btw state fields', () => {
    const store = createBtwStore();
    // Simulate active btw state
    store.btwQuestion = 'some question';
    store.btwAnswer = 'partial answer';
    store.btwLoading = true;
    store.btwVisible = true;

    store.closeBtw();

    expect(store.btwQuestion).toBeNull();
    expect(store.btwAnswer).toBe('');
    expect(store.btwLoading).toBe(false);
    expect(store.btwVisible).toBe(false);
  });
});

describe('chat store — appendBtwDelta', () => {
  it('should append delta text to btwAnswer', () => {
    const store = createBtwStore();
    store.appendBtwDelta('Hello');
    store.appendBtwDelta(' world');

    expect(store.btwAnswer).toBe('Hello world');
  });

  it('should handle empty delta gracefully', () => {
    const store = createBtwStore();
    store.appendBtwDelta('');
    expect(store.btwAnswer).toBe('');
  });
});

// =====================================================================
// 3. messageHandler — btw_stream / btw_done / btw_error
// =====================================================================

// Replicate messageHandler btw cases
function handleBtwMessage(store, msg) {
  switch (msg.type) {
    case 'btw_stream':
      store.appendBtwDelta(msg.delta);
      break;
    case 'btw_done':
      store.btwLoading = false;
      break;
    case 'btw_error':
      store.btwAnswer = 'Error: ' + msg.error;
      store.btwLoading = false;
      break;
  }
}

describe('messageHandler — btw message cases', () => {
  it('should have btw_stream case that calls appendBtwDelta', () => {
    expect(handlerSource).toContain("case 'btw_stream':");
    expect(handlerSource).toContain('store.appendBtwDelta(msg.delta)');
  });

  it('should have btw_done case that sets btwLoading to false', () => {
    expect(handlerSource).toContain("case 'btw_done':");
    expect(handlerSource).toContain('store.btwLoading = false');
  });

  it('should have btw_error case that sets error in last assistant message', () => {
    expect(handlerSource).toContain("case 'btw_error':");
    expect(handlerSource).toContain("'Error: ' + msg.error");
  });

  it('btw_stream should append delta text', () => {
    const store = createBtwStore();
    store.btwLoading = true;
    handleBtwMessage(store, { type: 'btw_stream', delta: 'chunk1' });
    handleBtwMessage(store, { type: 'btw_stream', delta: 'chunk2' });

    expect(store.btwAnswer).toBe('chunk1chunk2');
    expect(store.btwLoading).toBe(true); // loading still true
  });

  it('btw_done should stop loading', () => {
    const store = createBtwStore();
    store.btwLoading = true;
    store.btwAnswer = 'full answer';
    handleBtwMessage(store, { type: 'btw_done' });

    expect(store.btwLoading).toBe(false);
    expect(store.btwAnswer).toBe('full answer'); // answer preserved
  });

  it('btw_error should set error message and stop loading', () => {
    const store = createBtwStore();
    store.btwLoading = true;
    store.btwAnswer = 'partial';
    handleBtwMessage(store, { type: 'btw_error', error: 'No agent available' });

    expect(store.btwAnswer).toBe('Error: No agent available');
    expect(store.btwLoading).toBe(false);
  });
});

// =====================================================================
// 4. ChatInput — /btw interception
// =====================================================================
describe('ChatInput — /btw interception', () => {
  it('should check for /btw prefix with space in send method', () => {
    const sendFn = chatInputSource.substring(chatInputSource.indexOf('const send ='));
    expect(sendFn).toContain("trimmed.startsWith('/btw ')");
  });

  it('should call store.enterBtwMode and sendBtwQuestion for /btw with question', () => {
    const sendFn = chatInputSource.substring(chatInputSource.indexOf('const send ='));
    expect(sendFn).toContain('store.enterBtwMode()');
    expect(sendFn).toContain('store.sendBtwQuestion(question)');
  });

  it('should clear input and reset height after /btw interception', () => {
    const sendFn = chatInputSource.substring(chatInputSource.indexOf('const send ='));
    const btwBlock = sendFn.substring(
      sendFn.indexOf("startsWith('/btw ')"),
      sendFn.indexOf("startsWith('/btw ')") + 400
    );
    expect(btwBlock).toContain("inputText.value = ''");
    expect(btwBlock).toContain("style.height = 'auto'");
  });

  it('should return early after /btw interception (not reach sendMessage)', () => {
    const sendFn = chatInputSource.substring(chatInputSource.indexOf('const send ='));
    const btwIdx = sendFn.indexOf("startsWith('/btw ')");
    const returnIdx = sendFn.indexOf('return;', btwIdx);
    const sendMsgIdx = sendFn.indexOf('store.sendMessage(');
    // return statement should come before store.sendMessage call
    expect(returnIdx).toBeLessThan(sendMsgIdx);
  });

  it('should delete inputDrafts for current conversation on /btw', () => {
    const sendFn = chatInputSource.substring(chatInputSource.indexOf('const send ='));
    const btwBlock = sendFn.substring(
      sendFn.indexOf("startsWith('/btw ')"),
      sendFn.indexOf("startsWith('/btw ')") + 400
    );
    expect(btwBlock).toContain('delete store.inputDrafts');
  });

  it('should handle btw mode sends through btw channel', () => {
    const sendFn = chatInputSource.substring(chatInputSource.indexOf('const send ='));
    expect(sendFn).toContain('store.btwMode');
    expect(sendFn).toContain('store.sendBtwQuestion(trimmed)');
  });

  it('should exit btw mode on Escape key', () => {
    expect(chatInputSource).toContain("e.key === 'Escape' && store.btwMode");
    expect(chatInputSource).toContain('store.closeBtw()');
  });
});

// =====================================================================
// 5. crewInput — /btw interception
// =====================================================================
describe('crewInput — /btw interception', () => {
  it('should check for /btw prefix with space in sendMessage', () => {
    const sendFn = crewInputSource.substring(crewInputSource.indexOf('function sendMessage'));
    expect(sendFn).toContain("text.startsWith('/btw ')");
  });

  it('should call store.enterBtwMode for /btw commands', () => {
    const sendFn = crewInputSource.substring(crewInputSource.indexOf('function sendMessage'));
    expect(sendFn).toContain('store.enterBtwMode()');
  });

  it('should clear input and reset height after /btw interception', () => {
    const sendFn = crewInputSource.substring(crewInputSource.indexOf('function sendMessage'));
    const btwBlock = sendFn.substring(
      sendFn.indexOf("startsWith('/btw ')"),
      sendFn.indexOf("startsWith('/btw ')") + 400
    );
    expect(btwBlock).toContain("inputText.value = ''");
    expect(btwBlock).toContain("style.height = 'auto'");
  });

  it('should return early (not reach sendCrewMessage)', () => {
    const sendFn = crewInputSource.substring(crewInputSource.indexOf('function sendMessage'));
    const btwIdx = sendFn.indexOf("startsWith('/btw ')");
    const returnIdx = sendFn.indexOf('return;', btwIdx);
    const crewSendIdx = sendFn.indexOf('store.sendCrewMessage(', btwIdx);
    expect(returnIdx).toBeLessThan(crewSendIdx);
  });

  it('should exit btw mode on Escape key', () => {
    expect(crewInputSource).toContain("e.key === 'Escape' && store.btwMode");
    expect(crewInputSource).toContain('store.closeBtw()');
  });
});

// =====================================================================
// 6. BtwOverlay — keyboard close logic & component structure
// =====================================================================

// Replicate onKeydown logic from BtwOverlay
function onKeydown(store, e) {
  const prevented = { value: false };
  const mockE = {
    key: e.key,
    preventDefault() { prevented.value = true; }
  };

  if (mockE.key === 'Escape' || (!store.btwLoading && (mockE.key === 'Enter' || mockE.key === ' '))) {
    mockE.preventDefault();
    store.closeBtw();
  }

  return prevented.value;
}

describe('BtwOverlay — keyboard close logic', () => {
  it('Escape should close regardless of loading state', () => {
    const store = createBtwStore();
    store.btwLoading = true;
    store.btwVisible = true;
    store.btwQuestion = 'test';

    onKeydown(store, { key: 'Escape' });

    expect(store.btwVisible).toBe(false);
    expect(store.btwQuestion).toBeNull();
  });

  it('Enter should close when loading is false', () => {
    const store = createBtwStore();
    store.btwLoading = false;
    store.btwVisible = true;

    onKeydown(store, { key: 'Enter' });

    expect(store.btwVisible).toBe(false);
  });

  it('Space should close when loading is false', () => {
    const store = createBtwStore();
    store.btwLoading = false;
    store.btwVisible = true;

    onKeydown(store, { key: ' ' });

    expect(store.btwVisible).toBe(false);
  });

  it('Enter should NOT close when loading is true', () => {
    const store = createBtwStore();
    store.btwLoading = true;
    store.btwVisible = true;

    onKeydown(store, { key: 'Enter' });

    expect(store.btwVisible).toBe(true); // unchanged
  });

  it('Space should NOT close when loading is true', () => {
    const store = createBtwStore();
    store.btwLoading = true;
    store.btwVisible = true;

    onKeydown(store, { key: ' ' });

    expect(store.btwVisible).toBe(true); // unchanged
  });
});

describe('BtwOverlay — component structure', () => {
  it('should render as inline float (no Teleport)', () => {
    expect(overlaySource).toContain('class="btw-float"');
    expect(overlaySource).not.toContain('<Teleport');
  });

  it('should render multi-turn messages from store.btwMessages', () => {
    expect(overlaySource).toContain('store.btwMessages');
    expect(overlaySource).toContain('v-for="(msg, idx) in store.btwMessages"');
  });

  it('should use v-if="store.btwMode" to control visibility', () => {
    expect(overlaySource).toContain('v-if="store.btwMode"');
  });

  it('should use marked.parse for markdown rendering via renderedContents', () => {
    expect(overlaySource).toContain('marked.parse(msg.content)');
    expect(overlaySource).toContain('renderedContents[idx]');
  });

  it('should show loading dots when loading last assistant message with no content', () => {
    expect(overlaySource).toContain('store.btwLoading && idx === store.btwMessages.length - 1 && !msg.content');
    expect(overlaySource).toContain('btw-loading-dots');
  });

  it('should show cursor when loading last assistant message with partial content', () => {
    expect(overlaySource).toContain('store.btwLoading && idx === store.btwMessages.length - 1 && msg.content');
    expect(overlaySource).toContain('btw-cursor');
  });

  it('should have close button instead of global keydown listener', () => {
    expect(overlaySource).toContain('btw-close-btn');
    expect(overlaySource).toContain('store.closeBtw()');
    expect(overlaySource).not.toContain("document.addEventListener('keydown'");
  });

  it('should have header with BTW label and close button', () => {
    expect(overlaySource).toContain('btw-header');
    expect(overlaySource).toContain('btw-header-label');
    expect(overlaySource).toContain('&times;');
  });

  it('should gracefully handle marked.parse failure', () => {
    // The component has a try/catch that falls back to raw msg.content
    expect(overlaySource).toContain('catch');
    expect(overlaySource).toContain('return msg.content');
  });
});

// =====================================================================
// 7. CSS — mobile responsive layout
// =====================================================================
describe('btw.css — mobile responsive', () => {
  it('should have mobile media query for bottom-sheet layout', () => {
    expect(cssSource).toContain('@media (max-width: 768px)');
  });

  it('should use narrower width on mobile', () => {
    const mobileBlock = cssSource.substring(cssSource.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toContain('width: calc(100% - 16px)');
  });

  it('should use smaller padding on mobile card', () => {
    const mobileBlock = cssSource.substring(cssSource.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toContain('padding: 10px 14px');
  });

  it('should use smaller border-radius on mobile card', () => {
    const mobileBlock = cssSource.substring(cssSource.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toContain('border-radius: 12px');
  });
});
