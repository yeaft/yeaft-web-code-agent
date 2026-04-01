/**
 * Tests for PR #427 — /btw multi-turn inline dialog mode refactoring.
 *
 * Root cause: The old /btw was single-shot (one question, one answer, done).
 * This PR refactors it to support multi-turn conversations:
 * - enterBtwMode() initialises an empty conversation
 * - sendBtwQuestion() pushes user + assistant placeholder, sends WS with btwSessionId
 * - First question forks the session; subsequent questions resume the fork
 * - btw_done carries btwSessionId for multi-turn persistence
 * - btw_error writes into the last assistant message (not a flat string)
 * - BtwOverlay renders a message list with v-for, not a single answer
 * - ChatInput/crewInput: Esc exits btw mode; btw mode redirects all sends
 * - Crew mode: handleBtwQuestion finds decision maker's session for forking
 *
 * Test areas:
 * 1. Store actions — enterBtwMode, sendBtwQuestion, closeBtw, appendBtwDelta
 * 2. Multi-turn flow — session persistence, message accumulation
 * 3. messageHandler — btw_done stores btwSessionId, btw_error writes to last msg
 * 4. BtwOverlay — multi-turn rendering, header, close button, renderedContents
 * 5. ChatInput — /btw enters mode, btw mode send routing, Esc exit
 * 6. crewInput — same btw mode support
 * 7. Agent — handleBtwQuestion multi-turn fork/resume, Crew decision maker
 * 8. Server — client-conversation passthrough btwSessionId
 * 9. i18n — new keys btw.placeholder, btw.close
 * 10. CSS — new header, messages, input-tag, mobile max-height
 * 11. Boundary conditions
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

let storeSource;
let handlerSource;
let overlaySource;
let chatInputSource;
let crewInputSource;
let agentSource;
let serverSource;
let enSource;
let zhSource;
let cssSource;

beforeAll(() => {
  const webBase = resolve(__dirname, '../../web');
  const agentBase = resolve(__dirname, '../../agent');
  const serverBase = resolve(__dirname, '../../server');

  storeSource = readFileSync(resolve(webBase, 'stores/chat.js'), 'utf-8');
  handlerSource = readFileSync(resolve(webBase, 'stores/helpers/messageHandler.js'), 'utf-8');
  overlaySource = readFileSync(resolve(webBase, 'components/BtwOverlay.js'), 'utf-8');
  chatInputSource = readFileSync(resolve(webBase, 'components/ChatInput.js'), 'utf-8');
  crewInputSource = readFileSync(resolve(webBase, 'components/crew/crewInput.js'), 'utf-8');
  agentSource = readFileSync(resolve(agentBase, 'conversation.js'), 'utf-8');
  serverSource = readFileSync(resolve(serverBase, 'handlers/client-conversation.js'), 'utf-8');
  enSource = readFileSync(resolve(webBase, 'i18n/en.js'), 'utf-8');
  zhSource = readFileSync(resolve(webBase, 'i18n/zh-CN.js'), 'utf-8');
  cssSource = readFileSync(resolve(webBase, 'styles/btw.css'), 'utf-8');
});

// =====================================================================
// Replicated store logic for unit testing
// =====================================================================
function createMultiTurnBtwStore(overrides = {}) {
  return {
    currentConversation: 'currentConversation' in overrides ? overrides.currentConversation : 'conv_001',
    btwMode: false,
    btwMessages: [],
    btwLoading: false,
    btwSessionId: null,
    sentMessages: [],
    sendWsMessage(msg) { this.sentMessages.push(msg); },

    enterBtwMode() {
      this.btwMode = true;
      this.btwMessages = [];
      this.btwLoading = false;
      this.btwSessionId = null;
    },
    sendBtwQuestion(question) {
      if (!this.currentConversation) return;
      this.btwMessages.push({ role: 'user', content: question });
      this.btwMessages.push({ role: 'assistant', content: '' });
      this.btwLoading = true;
      this.sendWsMessage({
        type: 'btw_question',
        conversationId: this.currentConversation,
        question,
        btwSessionId: this.btwSessionId
      });
    },
    closeBtw() {
      this.btwMode = false;
      this.btwMessages = [];
      this.btwLoading = false;
      this.btwSessionId = null;
    },
    appendBtwDelta(delta) {
      const lastMsg = this.btwMessages[this.btwMessages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.content += delta;
      }
    }
  };
}

// Replicated messageHandler btw cases (new implementation)
function handleBtwMessage(store, msg) {
  switch (msg.type) {
    case 'btw_stream':
      store.appendBtwDelta(msg.delta);
      break;
    case 'btw_done':
      store.btwLoading = false;
      if (msg.btwSessionId) store.btwSessionId = msg.btwSessionId;
      break;
    case 'btw_error': {
      const lastBtw = store.btwMessages[store.btwMessages.length - 1];
      if (lastBtw && lastBtw.role === 'assistant') {
        lastBtw.content = 'Error: ' + msg.error;
      }
      store.btwLoading = false;
      break;
    }
  }
}

// =====================================================================
// 1. Store actions — enterBtwMode
// =====================================================================
describe('enterBtwMode — initialises btw conversation', () => {
  it('should set btwMode to true', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    expect(store.btwMode).toBe(true);
  });

  it('should reset btwMessages to empty array', () => {
    const store = createMultiTurnBtwStore();
    store.btwMessages = [{ role: 'user', content: 'old' }];
    store.enterBtwMode();
    expect(store.btwMessages).toEqual([]);
  });

  it('should reset btwLoading to false', () => {
    const store = createMultiTurnBtwStore();
    store.btwLoading = true;
    store.enterBtwMode();
    expect(store.btwLoading).toBe(false);
  });

  it('should reset btwSessionId to null', () => {
    const store = createMultiTurnBtwStore();
    store.btwSessionId = 'old-session';
    store.enterBtwMode();
    expect(store.btwSessionId).toBeNull();
  });
});

// =====================================================================
// 2. Store actions — sendBtwQuestion (multi-turn)
// =====================================================================
describe('sendBtwQuestion — pushes user + assistant placeholder', () => {
  it('should push user message with question content', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('What is Vue?');
    expect(store.btwMessages[0]).toEqual({ role: 'user', content: 'What is Vue?' });
  });

  it('should push assistant placeholder with empty content', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('What is Vue?');
    expect(store.btwMessages[1]).toEqual({ role: 'assistant', content: '' });
  });

  it('should set btwLoading to true', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('test');
    expect(store.btwLoading).toBe(true);
  });

  it('should send WS message with btwSessionId null for first question', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('first question');
    expect(store.sentMessages[0]).toEqual({
      type: 'btw_question',
      conversationId: 'conv_001',
      question: 'first question',
      btwSessionId: null
    });
  });

  it('should send WS message with btwSessionId for subsequent questions', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('first');
    store.btwSessionId = 'forked-session-123'; // simulate btw_done setting it
    store.btwLoading = false;
    store.sendBtwQuestion('second');
    expect(store.sentMessages[1]).toEqual({
      type: 'btw_question',
      conversationId: 'conv_001',
      question: 'second',
      btwSessionId: 'forked-session-123'
    });
  });

  it('should not send when currentConversation is null', () => {
    const store = createMultiTurnBtwStore({ currentConversation: null });
    store.enterBtwMode();
    store.sendBtwQuestion('test');
    expect(store.sentMessages).toHaveLength(0);
    expect(store.btwMessages).toHaveLength(0);
  });

  it('should accumulate messages across multiple questions', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();

    // Turn 1
    store.sendBtwQuestion('Q1');
    store.appendBtwDelta('A1');
    store.btwLoading = false;
    store.btwSessionId = 'session-1';

    // Turn 2
    store.sendBtwQuestion('Q2');
    store.appendBtwDelta('A2');

    expect(store.btwMessages).toHaveLength(4); // Q1, A1, Q2, A2
    expect(store.btwMessages[0]).toEqual({ role: 'user', content: 'Q1' });
    expect(store.btwMessages[1]).toEqual({ role: 'assistant', content: 'A1' });
    expect(store.btwMessages[2]).toEqual({ role: 'user', content: 'Q2' });
    expect(store.btwMessages[3]).toEqual({ role: 'assistant', content: 'A2' });
  });
});

// =====================================================================
// 3. Store actions — appendBtwDelta (targets last assistant message)
// =====================================================================
describe('appendBtwDelta — appends to last assistant message', () => {
  it('should append delta to last assistant message content', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('test');
    store.appendBtwDelta('Hello');
    store.appendBtwDelta(' world');
    expect(store.btwMessages[1].content).toBe('Hello world');
  });

  it('should not modify user messages', () => {
    const store = createMultiTurnBtwStore();
    store.btwMessages = [{ role: 'user', content: 'Q' }];
    store.appendBtwDelta('should be ignored');
    expect(store.btwMessages[0].content).toBe('Q');
  });

  it('should handle empty messages array gracefully', () => {
    const store = createMultiTurnBtwStore();
    store.appendBtwDelta('orphan delta');
    expect(store.btwMessages).toHaveLength(0);
  });

  it('should only affect the LAST assistant message in multi-turn', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('Q1');
    store.appendBtwDelta('A1 content');
    store.btwLoading = false;
    store.btwSessionId = 's1';
    store.sendBtwQuestion('Q2');
    store.appendBtwDelta('A2 content');

    expect(store.btwMessages[1].content).toBe('A1 content'); // first assistant untouched
    expect(store.btwMessages[3].content).toBe('A2 content'); // last assistant gets delta
  });
});

// =====================================================================
// 4. Store actions — closeBtw (full reset)
// =====================================================================
describe('closeBtw — resets all btw state', () => {
  it('should reset btwMode to false', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('test');
    store.closeBtw();
    expect(store.btwMode).toBe(false);
  });

  it('should clear btwMessages', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('test');
    store.closeBtw();
    expect(store.btwMessages).toEqual([]);
  });

  it('should clear btwSessionId', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.btwSessionId = 'session-123';
    store.closeBtw();
    expect(store.btwSessionId).toBeNull();
  });

  it('should stop loading', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('test');
    expect(store.btwLoading).toBe(true);
    store.closeBtw();
    expect(store.btwLoading).toBe(false);
  });
});

// =====================================================================
// 5. messageHandler — btw_done stores btwSessionId
// =====================================================================
describe('messageHandler — btw_done with btwSessionId', () => {
  it('should store btwSessionId from btw_done message', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('Q1');
    handleBtwMessage(store, { type: 'btw_done', btwSessionId: 'forked-abc' });
    expect(store.btwSessionId).toBe('forked-abc');
  });

  it('should stop loading on btw_done', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('Q1');
    expect(store.btwLoading).toBe(true);
    handleBtwMessage(store, { type: 'btw_done', btwSessionId: 'x' });
    expect(store.btwLoading).toBe(false);
  });

  it('should preserve btwSessionId when btw_done has no btwSessionId', () => {
    const store = createMultiTurnBtwStore();
    store.btwSessionId = 'existing';
    handleBtwMessage(store, { type: 'btw_done' });
    expect(store.btwSessionId).toBe('existing');
  });

  it('should update btwSessionId when btw_done has a new one', () => {
    const store = createMultiTurnBtwStore();
    store.btwSessionId = 'old';
    handleBtwMessage(store, { type: 'btw_done', btwSessionId: 'new' });
    expect(store.btwSessionId).toBe('new');
  });

  it('source should contain btwSessionId storage in btw_done handler', () => {
    const doneBlock = handlerSource.substring(
      handlerSource.indexOf("case 'btw_done':"),
      handlerSource.indexOf("case 'btw_done':") + 200
    );
    expect(doneBlock).toContain('msg.btwSessionId');
    expect(doneBlock).toContain('store.btwSessionId = msg.btwSessionId');
  });
});

// =====================================================================
// 6. messageHandler — btw_error writes to last assistant message
// =====================================================================
describe('messageHandler — btw_error writes to last assistant msg', () => {
  it('should set error as last assistant message content', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('test');
    handleBtwMessage(store, { type: 'btw_error', error: 'No agent available' });
    const lastMsg = store.btwMessages[store.btwMessages.length - 1];
    expect(lastMsg.content).toBe('Error: No agent available');
  });

  it('should stop loading on error', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('test');
    handleBtwMessage(store, { type: 'btw_error', error: 'fail' });
    expect(store.btwLoading).toBe(false);
  });

  it('should not crash when btwMessages is empty', () => {
    const store = createMultiTurnBtwStore();
    store.btwMessages = [];
    handleBtwMessage(store, { type: 'btw_error', error: 'orphan error' });
    expect(store.btwLoading).toBe(false);
    expect(store.btwMessages).toHaveLength(0);
  });

  it('should not overwrite user message with error', () => {
    const store = createMultiTurnBtwStore();
    store.btwMessages = [{ role: 'user', content: 'my question' }];
    handleBtwMessage(store, { type: 'btw_error', error: 'fail' });
    expect(store.btwMessages[0].content).toBe('my question');
  });

  it('source should use block scope for btw_error case', () => {
    expect(handlerSource).toContain("case 'btw_error': {");
    const errorBlock = handlerSource.substring(
      handlerSource.indexOf("case 'btw_error': {"),
      handlerSource.indexOf("case 'btw_error': {") + 300
    );
    expect(errorBlock).toContain('store.btwMessages[store.btwMessages.length - 1]');
    expect(errorBlock).toContain("lastBtw.role === 'assistant'");
    expect(errorBlock).toContain("'Error: ' + msg.error");
  });
});

// =====================================================================
// 7. Multi-turn flow — full scenario simulation
// =====================================================================
describe('multi-turn flow — full conversation lifecycle', () => {
  it('SCENARIO: enter → Q1 → stream → done → Q2 → stream → done → close', () => {
    const store = createMultiTurnBtwStore();

    // 1. Enter btw mode
    store.enterBtwMode();
    expect(store.btwMode).toBe(true);
    expect(store.btwMessages).toEqual([]);

    // 2. First question
    store.sendBtwQuestion('What is Vue?');
    expect(store.btwMessages).toHaveLength(2);
    expect(store.sentMessages[0].btwSessionId).toBeNull(); // first → fork

    // 3. Stream response
    handleBtwMessage(store, { type: 'btw_stream', delta: 'Vue is ' });
    handleBtwMessage(store, { type: 'btw_stream', delta: 'a framework' });
    expect(store.btwMessages[1].content).toBe('Vue is a framework');

    // 4. Done with session ID
    handleBtwMessage(store, { type: 'btw_done', btwSessionId: 'fork-001' });
    expect(store.btwLoading).toBe(false);
    expect(store.btwSessionId).toBe('fork-001');

    // 5. Second question (reuses session)
    store.sendBtwQuestion('How does reactivity work?');
    expect(store.btwMessages).toHaveLength(4);
    expect(store.sentMessages[1].btwSessionId).toBe('fork-001'); // reuse

    // 6. Stream second response
    handleBtwMessage(store, { type: 'btw_stream', delta: 'Proxies!' });
    expect(store.btwMessages[3].content).toBe('Proxies!');

    // 7. Done
    handleBtwMessage(store, { type: 'btw_done', btwSessionId: 'fork-001' });
    expect(store.btwLoading).toBe(false);

    // 8. Close
    store.closeBtw();
    expect(store.btwMode).toBe(false);
    expect(store.btwMessages).toEqual([]);
    expect(store.btwSessionId).toBeNull();
  });

  it('SCENARIO: enter → Q1 → error → Q2 (retry) → stream → done', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();

    // First question fails
    store.sendBtwQuestion('test');
    handleBtwMessage(store, { type: 'btw_error', error: 'timeout' });
    expect(store.btwMessages[1].content).toBe('Error: timeout');
    expect(store.btwLoading).toBe(false);

    // Retry with new question
    store.sendBtwQuestion('retry');
    expect(store.btwMessages).toHaveLength(4);
    expect(store.btwLoading).toBe(true);

    // This time it works
    handleBtwMessage(store, { type: 'btw_stream', delta: 'success' });
    handleBtwMessage(store, { type: 'btw_done', btwSessionId: 'new-session' });
    expect(store.btwMessages[3].content).toBe('success');
    expect(store.btwSessionId).toBe('new-session');
  });

  it('SCENARIO: close during loading should reset everything', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('test');
    expect(store.btwLoading).toBe(true);

    store.closeBtw();
    expect(store.btwMode).toBe(false);
    expect(store.btwMessages).toEqual([]);
    expect(store.btwLoading).toBe(false);
    expect(store.btwSessionId).toBeNull();
  });
});

// =====================================================================
// 8. Store source — state field definitions (old → new migration)
// =====================================================================
describe('chat.js — state field migration (old → new)', () => {
  it('should define btwMode: false (replaces btwVisible)', () => {
    expect(storeSource).toContain('btwMode: false');
    expect(storeSource).not.toContain('btwVisible: false');
  });

  it('should define btwMessages: [] (replaces btwQuestion + btwAnswer)', () => {
    expect(storeSource).toContain('btwMessages: []');
    expect(storeSource).not.toContain('btwQuestion: null');
    expect(storeSource).not.toContain("btwAnswer: ''");
  });

  it('should define btwSessionId: null (new for multi-turn)', () => {
    expect(storeSource).toContain('btwSessionId: null');
  });

  it('should still define btwLoading: false', () => {
    expect(storeSource).toContain('btwLoading: false');
  });
});

// =====================================================================
// 9. Store source — enterBtwMode action (new)
// =====================================================================
describe('chat.js — enterBtwMode action structure', () => {
  it('should define enterBtwMode function', () => {
    expect(storeSource).toContain('enterBtwMode()');
  });

  it('should set btwMode to true in enterBtwMode', () => {
    const fnBlock = storeSource.substring(
      storeSource.indexOf('enterBtwMode()'),
      storeSource.indexOf('enterBtwMode()') + 200
    );
    expect(fnBlock).toContain('this.btwMode = true');
  });

  it('should reset btwMessages to empty array', () => {
    const fnBlock = storeSource.substring(
      storeSource.indexOf('enterBtwMode()'),
      storeSource.indexOf('enterBtwMode()') + 200
    );
    expect(fnBlock).toContain('this.btwMessages = []');
  });

  it('should reset btwSessionId to null', () => {
    const fnBlock = storeSource.substring(
      storeSource.indexOf('enterBtwMode()'),
      storeSource.indexOf('enterBtwMode()') + 200
    );
    expect(fnBlock).toContain('this.btwSessionId = null');
  });
});

// =====================================================================
// 10. Store source — sendBtwQuestion action (multi-turn)
// =====================================================================
describe('chat.js — sendBtwQuestion multi-turn structure', () => {
  it('should push user message with role and content', () => {
    const fnStart = storeSource.indexOf('sendBtwQuestion(question)');
    const fnBlock = storeSource.substring(fnStart, fnStart + 500);
    expect(fnBlock).toContain("this.btwMessages.push({ role: 'user', content: question })");
  });

  it('should push assistant placeholder with empty content', () => {
    const fnStart = storeSource.indexOf('sendBtwQuestion(question)');
    const fnBlock = storeSource.substring(fnStart, fnStart + 500);
    expect(fnBlock).toContain("this.btwMessages.push({ role: 'assistant', content: '' })");
  });

  it('should send btwSessionId in WS message', () => {
    const fnStart = storeSource.indexOf('sendBtwQuestion(question)');
    const fnBlock = storeSource.substring(fnStart, fnStart + 500);
    expect(fnBlock).toContain('btwSessionId: this.btwSessionId');
  });

  it('should guard against null currentConversation', () => {
    const fnStart = storeSource.indexOf('sendBtwQuestion(question)');
    const fnBlock = storeSource.substring(fnStart, fnStart + 200);
    expect(fnBlock).toContain('if (!this.currentConversation) return');
  });
});

// =====================================================================
// 11. Store source — appendBtwDelta targets last assistant
// =====================================================================
describe('chat.js — appendBtwDelta targets last assistant message', () => {
  it('should get last message from btwMessages', () => {
    const fnStart = storeSource.indexOf('appendBtwDelta(delta)');
    const fnBlock = storeSource.substring(fnStart, fnStart + 200);
    expect(fnBlock).toContain('this.btwMessages[this.btwMessages.length - 1]');
  });

  it('should check role is assistant before appending', () => {
    const fnStart = storeSource.indexOf('appendBtwDelta(delta)');
    const fnBlock = storeSource.substring(fnStart, fnStart + 200);
    expect(fnBlock).toContain("lastMsg.role === 'assistant'");
  });

  it('should append delta to content', () => {
    const fnStart = storeSource.indexOf('appendBtwDelta(delta)');
    const fnBlock = storeSource.substring(fnStart, fnStart + 200);
    expect(fnBlock).toContain('lastMsg.content += delta');
  });
});

// =====================================================================
// 12. Store source — closeBtw resets all new fields
// =====================================================================
describe('chat.js — closeBtw resets new fields', () => {
  it('should set btwMode to false (not btwVisible)', () => {
    const fnStart = storeSource.indexOf('closeBtw()');
    const fnBlock = storeSource.substring(fnStart, fnStart + 200);
    expect(fnBlock).toContain('this.btwMode = false');
    expect(fnBlock).not.toContain('this.btwVisible');
  });

  it('should clear btwMessages (not btwAnswer)', () => {
    const fnStart = storeSource.indexOf('closeBtw()');
    const fnBlock = storeSource.substring(fnStart, fnStart + 200);
    expect(fnBlock).toContain('this.btwMessages = []');
    expect(fnBlock).not.toContain('this.btwAnswer');
  });

  it('should clear btwSessionId', () => {
    const fnStart = storeSource.indexOf('closeBtw()');
    const fnBlock = storeSource.substring(fnStart, fnStart + 200);
    expect(fnBlock).toContain('this.btwSessionId = null');
  });
});

// =====================================================================
// 13. BtwOverlay — multi-turn message list rendering
// =====================================================================
describe('BtwOverlay — multi-turn rendering structure', () => {
  it('should use role="log" for conversation semantics', () => {
    expect(overlaySource).toContain('role="log"');
  });

  it('should iterate over btwMessages with v-for', () => {
    expect(overlaySource).toContain('v-for="(msg, idx) in store.btwMessages"');
  });

  it('should distinguish user and assistant messages', () => {
    expect(overlaySource).toContain("msg.role === 'user'");
    expect(overlaySource).toContain('btw-msg-user');
    expect(overlaySource).toContain('btw-msg-assistant');
  });

  it('should render user message content as text interpolation', () => {
    expect(overlaySource).toContain('{{ msg.content }}');
  });

  it('should render assistant content via renderedContents computed', () => {
    expect(overlaySource).toContain('renderedContents[idx]');
    expect(overlaySource).toContain('v-html="renderedContents[idx]"');
  });

  it('should use messagesRef for auto-scroll', () => {
    expect(overlaySource).toContain('ref="messagesRef"');
    expect(overlaySource).toContain('messagesRef.value.scrollTop = messagesRef.value.scrollHeight');
  });
});

// =====================================================================
// 14. BtwOverlay — renderedContents computed
// =====================================================================
describe('BtwOverlay — renderedContents computed logic', () => {
  it('should map btwMessages to rendered HTML', () => {
    expect(overlaySource).toContain('store.btwMessages.map(msg =>');
  });

  it('should only render assistant messages with content', () => {
    expect(overlaySource).toContain("msg.role !== 'assistant' || !msg.content");
  });

  it('should use marked.parse for markdown', () => {
    expect(overlaySource).toContain('marked.parse(msg.content)');
  });

  it('should fallback to raw content on parse error', () => {
    expect(overlaySource).toContain('catch');
    expect(overlaySource).toContain('return msg.content');
  });

  it('should return empty string for user messages', () => {
    // The check: if (msg.role !== 'assistant' || !msg.content) return '';
    expect(overlaySource).toContain("return ''");
  });
});

// =====================================================================
// 15. BtwOverlay — header with BTW label and close button
// =====================================================================
describe('BtwOverlay — header structure', () => {
  it('should have btw-header container', () => {
    expect(overlaySource).toContain('class="btw-header"');
  });

  it('should have BTW label span', () => {
    expect(overlaySource).toContain('class="btw-header-label"');
    expect(overlaySource).toContain('>BTW<');
  });

  it('should have close button with &times; content', () => {
    expect(overlaySource).toContain('class="btw-close-btn"');
    expect(overlaySource).toContain('&times;');
  });

  it('should call store.closeBtw() on close button click', () => {
    expect(overlaySource).toContain('@click="store.closeBtw()"');
  });

  it('should NOT have global keydown listener (moved to ChatInput)', () => {
    expect(overlaySource).not.toContain("document.addEventListener('keydown'");
    expect(overlaySource).not.toContain("document.removeEventListener('keydown'");
  });
});

// =====================================================================
// 16. BtwOverlay — loading indicators scoped to last message
// =====================================================================
describe('BtwOverlay — loading indicators per message', () => {
  it('loading dots should only show on last message with no content', () => {
    expect(overlaySource).toContain(
      'store.btwLoading && idx === store.btwMessages.length - 1 && !msg.content'
    );
  });

  it('cursor should only show on last message with partial content', () => {
    expect(overlaySource).toContain(
      'store.btwLoading && idx === store.btwMessages.length - 1 && msg.content'
    );
  });

  it('should have btw-loading-dots class for loading animation', () => {
    expect(overlaySource).toContain('btw-loading-dots');
  });

  it('should have btw-cursor class for streaming cursor', () => {
    expect(overlaySource).toContain('btw-cursor');
  });
});

// =====================================================================
// 17. BtwOverlay — auto-scroll watchers
// =====================================================================
describe('BtwOverlay — auto-scroll watchers', () => {
  it('should watch last message content length for stream scroll', () => {
    expect(overlaySource).toContain("last?.content?.length || 0");
  });

  it('should watch btwMessages.length for new message scroll', () => {
    expect(overlaySource).toContain('store.btwMessages.length');
  });

  it('should use Vue.nextTick for DOM-safe scrolling', () => {
    expect(overlaySource).toContain('Vue.nextTick');
  });
});

// =====================================================================
// 18. ChatInput — /btw enters btw mode
// =====================================================================
describe('ChatInput — /btw mode entry', () => {
  it('should handle both /btw and /btw with question', () => {
    const sendFn = chatInputSource.substring(chatInputSource.indexOf('const send ='));
    expect(sendFn).toContain("trimmed === '/btw'");
    expect(sendFn).toContain("trimmed.startsWith('/btw ')");
  });

  it('should extract question by substring(4).trim()', () => {
    const sendFn = chatInputSource.substring(chatInputSource.indexOf('const send ='));
    expect(sendFn).toContain('trimmed.substring(4).trim()');
  });

  it('should call enterBtwMode before sendBtwQuestion', () => {
    const sendFn = chatInputSource.substring(chatInputSource.indexOf('const send ='));
    const enterIdx = sendFn.indexOf('store.enterBtwMode()');
    const sendIdx = sendFn.indexOf('store.sendBtwQuestion(question)');
    expect(enterIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(-1);
    expect(enterIdx).toBeLessThan(sendIdx);
  });

  it('should only send question if non-empty', () => {
    const sendFn = chatInputSource.substring(chatInputSource.indexOf('const send ='));
    expect(sendFn).toContain('if (question) store.sendBtwQuestion(question)');
  });
});

// =====================================================================
// 19. ChatInput — btw mode redirects all sends
// =====================================================================
describe('ChatInput — btw mode send routing', () => {
  it('should check store.btwMode in send function', () => {
    const sendFn = chatInputSource.substring(chatInputSource.indexOf('const send ='));
    expect(sendFn).toContain('if (store.btwMode)');
  });

  it('should route sends to sendBtwQuestion(trimmed) in btw mode', () => {
    const sendFn = chatInputSource.substring(chatInputSource.indexOf('const send ='));
    // Find the btw mode send block (after the /btw entry block)
    const btwModeIdx = sendFn.indexOf('if (store.btwMode)');
    const btwModeBlock = sendFn.substring(btwModeIdx, btwModeIdx + 300);
    expect(btwModeBlock).toContain('store.sendBtwQuestion(trimmed)');
  });

  it('should clear input in btw mode send', () => {
    const sendFn = chatInputSource.substring(chatInputSource.indexOf('const send ='));
    const btwModeIdx = sendFn.indexOf('if (store.btwMode)');
    const btwModeBlock = sendFn.substring(btwModeIdx, btwModeIdx + 300);
    expect(btwModeBlock).toContain("inputText.value = ''");
  });

  it('should return early in btw mode (not reach sendMessage)', () => {
    const sendFn = chatInputSource.substring(chatInputSource.indexOf('const send ='));
    const btwModeIdx = sendFn.indexOf('if (store.btwMode)');
    const returnIdx = sendFn.indexOf('return;', btwModeIdx);
    const sendMsgIdx = sendFn.indexOf('store.sendMessage(', btwModeIdx);
    expect(returnIdx).toBeLessThan(sendMsgIdx);
  });
});

// =====================================================================
// 20. ChatInput — Esc exits btw mode
// =====================================================================
describe('ChatInput — Esc key exits btw mode', () => {
  it('should check Escape + btwMode in handleKeydown', () => {
    expect(chatInputSource).toContain("e.key === 'Escape' && store.btwMode");
  });

  it('should call store.closeBtw() on Escape', () => {
    const keydownStart = chatInputSource.indexOf('const handleKeydown');
    const keydownBlock = chatInputSource.substring(keydownStart, keydownStart + 300);
    expect(keydownBlock).toContain('store.closeBtw()');
  });

  it('should preventDefault on Escape in btw mode', () => {
    const keydownStart = chatInputSource.indexOf('const handleKeydown');
    const keydownBlock = chatInputSource.substring(keydownStart, keydownStart + 300);
    expect(keydownBlock).toContain('e.preventDefault()');
  });

  it('should return early after btw Esc (not trigger other handlers)', () => {
    const keydownStart = chatInputSource.indexOf('const handleKeydown');
    const keydownBlock = chatInputSource.substring(keydownStart, keydownStart + 300);
    const closeIdx = keydownBlock.indexOf('store.closeBtw()');
    const returnIdx = keydownBlock.indexOf('return;', closeIdx);
    expect(returnIdx).toBeGreaterThan(closeIdx);
  });
});

// =====================================================================
// 21. ChatInput — UI isolation in btw mode
// =====================================================================
describe('ChatInput — UI elements hidden in btw mode', () => {
  it('should hide expert chips bar in btw mode', () => {
    expect(chatInputSource).toContain('!store.btwMode && expertSelections.length > 0');
  });

  it('should hide attachments preview in btw mode', () => {
    expect(chatInputSource).toContain('!store.btwMode && attachments.length > 0');
  });

  it('should hide file input in btw mode', () => {
    expect(chatInputSource).toContain('v-if="!store.btwMode"');
  });

  it('should hide slash autocomplete in btw mode', () => {
    expect(chatInputSource).toContain('!store.btwMode && showAutocomplete');
  });

  it('should hide expert autocomplete in btw mode', () => {
    expect(chatInputSource).toContain('!store.btwMode && showExpertAutocomplete');
  });

  it('should show BTW tag in btw mode', () => {
    expect(chatInputSource).toContain('v-if="store.btwMode"');
    expect(chatInputSource).toContain('btw-input-tag');
    expect(chatInputSource).toContain('>BTW<');
  });

  it('should add btw-active class to input wrapper', () => {
    expect(chatInputSource).toContain("'btw-active': store.btwMode");
  });

  it('should use btw placeholder when in btw mode', () => {
    expect(chatInputSource).toContain("store.btwMode ? $t('btw.placeholder')");
  });
});

// =====================================================================
// 22. crewInput — btw mode support
// =====================================================================
describe('crewInput — btw mode entry and Esc exit', () => {
  it('should handle /btw and /btw with question', () => {
    const sendFn = crewInputSource.substring(crewInputSource.indexOf('function sendMessage'));
    expect(sendFn).toContain("text === '/btw'");
    expect(sendFn).toContain("text.startsWith('/btw ')");
  });

  it('should call enterBtwMode in crewInput', () => {
    const sendFn = crewInputSource.substring(crewInputSource.indexOf('function sendMessage'));
    expect(sendFn).toContain('store.enterBtwMode()');
  });

  it('should route btw mode sends through sendBtwQuestion', () => {
    const sendFn = crewInputSource.substring(crewInputSource.indexOf('function sendMessage'));
    expect(sendFn).toContain('if (store.btwMode)');
    expect(sendFn).toContain('store.sendBtwQuestion(text)');
  });

  it('should exit btw on Escape in crewInput handleKeydown', () => {
    const handleKd = crewInputSource.substring(crewInputSource.indexOf('function handleKeydown'));
    expect(handleKd).toContain("e.key === 'Escape' && store.btwMode");
    expect(handleKd).toContain('store.closeBtw()');
  });

  it('should extract question with substring(4).trim()', () => {
    const sendFn = crewInputSource.substring(crewInputSource.indexOf('function sendMessage'));
    expect(sendFn).toContain('text.substring(4).trim()');
  });
});

// =====================================================================
// 23. Agent — handleBtwQuestion multi-turn fork/resume
// =====================================================================
describe('agent/conversation.js — handleBtwQuestion multi-turn', () => {
  it('should extract btwSessionId from message', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 300);
    expect(fnBlock).toContain('const { conversationId, question, btwSessionId } = msg');
  });

  it('should determine resume target: btwSessionId or baseSessionId', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 3000);
    expect(fnBlock).toContain('const resumeTarget = btwSessionId || baseSessionId');
  });

  it('should fork only when btwSessionId is absent', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 3000);
    expect(fnBlock).toContain('const shouldFork = !btwSessionId');
  });

  it('should use resumeTarget for resume option', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 3000);
    expect(fnBlock).toContain('resume: resumeTarget');
  });

  it('should use shouldFork for forkSession option', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 3000);
    expect(fnBlock).toContain('forkSession: shouldFork');
  });

  it('should capture forked session ID from system init message', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 3000);
    expect(fnBlock).toContain("message.type === 'system' && message.session_id");
    expect(fnBlock).toContain('newBtwSessionId = message.session_id');
  });

  it('should send btwSessionId in btw_done message', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 3000);
    expect(fnBlock).toContain("type: 'btw_done'");
    expect(fnBlock).toContain('btwSessionId: newBtwSessionId');
  });

  it('should initialize newBtwSessionId from incoming btwSessionId', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 3000);
    expect(fnBlock).toContain('let newBtwSessionId = btwSessionId');
  });
});

// =====================================================================
// 24. Agent — handleBtwQuestion Crew mode support
// =====================================================================
describe('agent/conversation.js — handleBtwQuestion Crew mode', () => {
  it('should check chat state first, then crew session', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 800);
    const chatIdx = fnBlock.indexOf('ctx.conversations.get(conversationId)');
    const crewIdx = fnBlock.indexOf('crewSessions.get(conversationId)');
    expect(chatIdx).toBeGreaterThan(-1);
    expect(crewIdx).toBeGreaterThan(-1);
    expect(chatIdx).toBeLessThan(crewIdx);
  });

  it('should find decision maker session for Crew mode', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 800);
    expect(fnBlock).toContain('crewSession.decisionMaker');
    expect(fnBlock).toContain('crewSession.roleStates.get(dmName)');
    expect(fnBlock).toContain('dmState?.claudeSessionId');
  });

  it('should use crewSession.projectDir as workDir for Crew', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 800);
    expect(fnBlock).toContain('workDir = crewSession.projectDir');
  });

  it('should send btw_error when no base session found', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 1000);
    expect(fnBlock).toContain('if (!baseSessionId)');
    expect(fnBlock).toContain("type: 'btw_error'");
    expect(fnBlock).toContain("error: 'No active session'");
  });

  it('should use workDir from chat state or fallback to CONFIG.workDir', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 1500);
    expect(fnBlock).toContain('cwd: workDir || ctx.CONFIG.workDir');
  });
});

// =====================================================================
// 25. Agent — handleBtwQuestion error handling
// =====================================================================
describe('agent/conversation.js — handleBtwQuestion error handling', () => {
  it('should catch errors and send btw_error', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 3000);
    expect(fnBlock).toContain('} catch (err)');
    expect(fnBlock).toContain("type: 'btw_error'");
    expect(fnBlock).toContain('error: err.message');
  });

  it('should log error with conversationId', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 3000);
    expect(fnBlock).toContain('console.error(`[btw] ${conversationId} error:`');
  });

  it('should NOT include question in error response (removed in refactor)', () => {
    const fnStart = agentSource.indexOf('export async function handleBtwQuestion');
    const fnBlock = agentSource.substring(fnStart, fnStart + 3000);
    // The btw_error in catch block no longer includes question field
    const catchIdx = fnBlock.indexOf('catch (err)');
    const errorSend = fnBlock.substring(catchIdx);
    expect(errorSend).not.toContain('question,');
    expect(errorSend).not.toContain('question:');
  });
});

// =====================================================================
// 26. Server — client-conversation passthrough btwSessionId
// =====================================================================
describe('client-conversation.js — btwSessionId passthrough', () => {
  it('should forward btwSessionId to agent', () => {
    const btwBlock = serverSource.substring(
      serverSource.indexOf("type: 'btw_question'"),
      serverSource.indexOf("type: 'btw_question'") + 200
    );
    expect(btwBlock).toContain('btwSessionId: msg.btwSessionId || null');
  });

  it('should still forward question field', () => {
    const btwBlock = serverSource.substring(
      serverSource.indexOf("type: 'btw_question'"),
      serverSource.indexOf("type: 'btw_question'") + 200
    );
    expect(btwBlock).toContain('question: msg.question');
  });
});

// =====================================================================
// 27. i18n — new keys
// =====================================================================
describe('i18n — new btw keys', () => {
  it('EN: should have btw.placeholder', () => {
    expect(enSource).toContain("'btw.placeholder': 'Ask a side question...'");
  });

  it('EN: should have btw.close', () => {
    expect(enSource).toContain("'btw.close': 'Exit BTW mode'");
  });

  it('EN: btw.hint should be "esc to exit"', () => {
    expect(enSource).toContain("'btw.hint': 'esc to exit'");
  });

  it('ZH: should have btw.placeholder', () => {
    expect(zhSource).toContain("'btw.placeholder':");
  });

  it('ZH: should have btw.close', () => {
    expect(zhSource).toContain("'btw.close':");
  });

  it('ZH: btw.hint should be "esc 退出"', () => {
    expect(zhSource).toContain("'btw.hint': 'esc 退出'");
  });
});

// =====================================================================
// 28. CSS — new header, messages, input-tag styling
// =====================================================================
describe('btw.css — new multi-turn styling', () => {
  it('should have btw-header styles', () => {
    expect(cssSource).toContain('.btw-header');
    expect(cssSource).toContain('justify-content: space-between');
  });

  it('should have btw-header-label styles', () => {
    expect(cssSource).toContain('.btw-header-label');
    expect(cssSource).toContain('font-family: monospace');
  });

  it('should have btw-close-btn styles', () => {
    expect(cssSource).toContain('.btw-close-btn');
    expect(cssSource).toContain('cursor: pointer');
  });

  it('should have btw-messages area styles', () => {
    expect(cssSource).toContain('.btw-messages');
    expect(cssSource).toContain('overflow-y: auto');
    expect(cssSource).toContain('flex-direction: column');
  });

  it('should have btw-msg styles for individual messages', () => {
    expect(cssSource).toContain('.btw-msg');
    expect(cssSource).toContain('.btw-msg-user');
    expect(cssSource).toContain('.btw-msg-assistant');
  });

  it('should have user message ">" prefix via ::before', () => {
    expect(cssSource).toContain(".btw-msg-user::before");
    expect(cssSource).toContain("content: '>'");
  });

  it('should have btw-input-tag styles', () => {
    expect(cssSource).toContain('.btw-input-tag');
    expect(cssSource).toContain('font-family: monospace');
  });

  it('should have input-wrapper.btw-active styles', () => {
    expect(cssSource).toContain('.input-wrapper.btw-active');
  });

  it('should NOT have old btw-question class', () => {
    expect(cssSource).not.toContain('.btw-question');
  });

  it('should NOT have old btw-answer class (replaced by btw-messages)', () => {
    expect(cssSource).not.toContain('.btw-answer {');
  });
});

// =====================================================================
// 29. CSS — mobile responsive
// =====================================================================
describe('btw.css — mobile responsive', () => {
  it('should have max-height: 300px on desktop', () => {
    expect(cssSource).toContain('max-height: 300px');
  });

  it('should have max-height: 200px on mobile', () => {
    const mobileBlock = cssSource.substring(cssSource.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toContain('max-height: 200px');
  });

  it('should use smaller padding on mobile', () => {
    const mobileBlock = cssSource.substring(cssSource.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toContain('padding: 10px 14px');
  });

  it('should have smaller border-radius on mobile', () => {
    const mobileBlock = cssSource.substring(cssSource.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toContain('border-radius: 12px');
  });
});

// =====================================================================
// 30. Regression — old state fields removed
// =====================================================================
describe('regression — old single-shot fields removed', () => {
  it('store should NOT have btwQuestion state', () => {
    // Look in the state definition area (not comments)
    const stateBlock = storeSource.substring(
      storeSource.indexOf('// /btw'),
      storeSource.indexOf('// /btw') + 300
    );
    expect(stateBlock).not.toContain('btwQuestion: null');
  });

  it('store should NOT have btwAnswer state', () => {
    const stateBlock = storeSource.substring(
      storeSource.indexOf('// /btw'),
      storeSource.indexOf('// /btw') + 300
    );
    expect(stateBlock).not.toContain("btwAnswer: ''");
  });

  it('store should NOT have btwVisible state', () => {
    const stateBlock = storeSource.substring(
      storeSource.indexOf('// /btw'),
      storeSource.indexOf('// /btw') + 300
    );
    expect(stateBlock).not.toContain('btwVisible: false');
  });

  it('overlay should NOT reference store.btwAnswer', () => {
    expect(overlaySource).not.toContain('store.btwAnswer');
  });

  it('overlay should NOT reference store.btwQuestion', () => {
    expect(overlaySource).not.toContain('store.btwQuestion');
  });

  it('overlay should NOT reference store.btwVisible', () => {
    expect(overlaySource).not.toContain('store.btwVisible');
  });

  it('overlay should NOT have renderedAnswer computed', () => {
    expect(overlaySource).not.toContain('renderedAnswer');
  });

  it('overlay should NOT have answerRef', () => {
    expect(overlaySource).not.toContain('answerRef');
  });

  it('messageHandler should NOT set store.btwAnswer directly', () => {
    // btw_error used to do: store.btwAnswer = 'Error: ' + msg.error
    // Now it writes to last btwMessages entry
    expect(handlerSource).not.toContain("store.btwAnswer = 'Error:");
  });
});

// =====================================================================
// 31. Boundary conditions
// =====================================================================
describe('boundary conditions — edge cases', () => {
  it('appendBtwDelta with empty delta should not crash', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('test');
    store.appendBtwDelta('');
    expect(store.btwMessages[1].content).toBe('');
  });

  it('sendBtwQuestion with null currentConversation should be no-op', () => {
    const store = createMultiTurnBtwStore({ currentConversation: null });
    store.enterBtwMode();
    store.sendBtwQuestion('test');
    expect(store.btwMessages).toHaveLength(0);
    expect(store.sentMessages).toHaveLength(0);
  });

  it('closeBtw when not in btw mode should be safe', () => {
    const store = createMultiTurnBtwStore();
    expect(store.btwMode).toBe(false);
    store.closeBtw();
    expect(store.btwMode).toBe(false);
    expect(store.btwMessages).toEqual([]);
  });

  it('btw_done without btwSessionId should not null-ify existing session', () => {
    const store = createMultiTurnBtwStore();
    store.btwSessionId = 'existing';
    store.btwLoading = true;
    handleBtwMessage(store, { type: 'btw_done' }); // no btwSessionId field
    expect(store.btwSessionId).toBe('existing');
    expect(store.btwLoading).toBe(false);
  });

  it('rapid sendBtwQuestion should accumulate messages correctly', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('Q1');
    store.sendBtwQuestion('Q2');
    store.sendBtwQuestion('Q3');
    // Each sendBtwQuestion adds user + assistant placeholder
    expect(store.btwMessages).toHaveLength(6);
    expect(store.btwMessages[0]).toEqual({ role: 'user', content: 'Q1' });
    expect(store.btwMessages[2]).toEqual({ role: 'user', content: 'Q2' });
    expect(store.btwMessages[4]).toEqual({ role: 'user', content: 'Q3' });
  });

  it('btw_error when btwMessages ends with user message should not crash', () => {
    const store = createMultiTurnBtwStore();
    store.btwMessages = [{ role: 'user', content: 'only user' }];
    store.btwLoading = true;
    handleBtwMessage(store, { type: 'btw_error', error: 'fail' });
    // Should not modify user message
    expect(store.btwMessages[0].content).toBe('only user');
    expect(store.btwLoading).toBe(false);
  });

  it('enterBtwMode should be idempotent (can re-enter)', () => {
    const store = createMultiTurnBtwStore();
    store.enterBtwMode();
    store.sendBtwQuestion('Q1');
    store.btwSessionId = 'sess-1';

    // Re-enter
    store.enterBtwMode();
    expect(store.btwMode).toBe(true);
    expect(store.btwMessages).toEqual([]);
    expect(store.btwSessionId).toBeNull();
  });
});
