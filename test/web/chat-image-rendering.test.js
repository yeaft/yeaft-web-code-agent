/**
 * Tests for task-245: Chat mode AI response image rendering
 *
 * Covers 6 changed files:
 * 1. agent/claude.js — extractAndSendChatImages: image extraction + local persistence
 * 2. server/handlers/agent-output.js — chat_image: server caching + forwarding
 * 3. web/stores/helpers/messageHandler.js — WebSocket chat_image dispatch
 * 4. web/components/MessageList.js — turn aggregation with imageMsgs
 * 5. web/components/AssistantTurn.js — image rendering template + helpers
 * 6. web/styles/chat-messages.css — image CSS styles
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ─── Source file contents ───────────────────────────────────────────────
let agentClaudeSource;
let agentOutputSource;
let messageHandlerSource;
let messageListSource;
let assistantTurnSource;
let chatMessagesCss;

beforeAll(() => {
  const base = resolve(__dirname, '../..');
  agentClaudeSource = readFileSync(resolve(base, 'agent/claude.js'), 'utf-8');
  agentOutputSource = readFileSync(resolve(base, 'server/handlers/agent-output.js'), 'utf-8');
  messageHandlerSource = readFileSync(resolve(base, 'web/stores/helpers/messageHandler.js'), 'utf-8');
  messageListSource = readFileSync(resolve(base, 'web/components/MessageList.js'), 'utf-8');
  assistantTurnSource = readFileSync(resolve(base, 'web/components/AssistantTurn.js'), 'utf-8');
  chatMessagesCss = readFileSync(resolve(base, 'web/styles/chat-messages.css'), 'utf-8');
});

// ─────────────────────────────────────────────────────────────────────────
// 1. agent/claude.js — extractAndSendChatImages
// ─────────────────────────────────────────────────────────────────────────
describe('agent/claude.js — extractAndSendChatImages', () => {
  it('imports writeFile and mkdir from fs/promises', () => {
    expect(agentClaudeSource).toMatch(/import\s*\{[^}]*writeFile[^}]*\}\s*from\s*['"]fs\/promises['"]/);
    expect(agentClaudeSource).toMatch(/import\s*\{[^}]*mkdir[^}]*\}\s*from\s*['"]fs\/promises['"]/);
  });

  it('imports join from path', () => {
    expect(agentClaudeSource).toMatch(/import\s*\{[^}]*join[^}]*\}\s*from\s*['"]path['"]/);
  });

  it('defines extractAndSendChatImages function', () => {
    expect(agentClaudeSource).toContain('async function extractAndSendChatImages(conversationId, state, message)');
  });

  it('is called from processClaudeOutput', () => {
    expect(agentClaudeSource).toContain('await extractAndSendChatImages(conversationId, state, message)');
  });

  it('handles assistant message type (image blocks in message.message.content)', () => {
    expect(agentClaudeSource).toMatch(/message\.type\s*===?\s*['"]assistant['"]/);
    expect(agentClaudeSource).toContain("Array.isArray(message.message?.content)");
  });

  it('handles user/tool_result message type (screenshot results)', () => {
    expect(agentClaudeSource).toMatch(/message\.type\s*===?\s*['"]user['"]/);
  });

  it('checks for image block with base64 source', () => {
    expect(agentClaudeSource).toContain("block.type === 'image'");
    expect(agentClaudeSource).toContain("block.source?.type === 'base64'");
    expect(agentClaudeSource).toContain("block.source?.data");
  });

  it('extracts mime type with fallback to image/png', () => {
    expect(agentClaudeSource).toContain("block.source.media_type || 'image/png'");
  });

  it('converts jpeg extension to jpg', () => {
    expect(agentClaudeSource).toContain(".replace('jpeg', 'jpg')");
  });

  it('creates image directory under .data/images/', () => {
    expect(agentClaudeSource).toContain("join(state.workDir, '.data', 'images')");
    expect(agentClaudeSource).toContain("await mkdir(imageDir, { recursive: true })");
  });

  it('generates unique filename with timestamp and counter', () => {
    expect(agentClaudeSource).toMatch(/`chat-\$\{Date\.now\(\)\}-\$\{.*_imageCounter\}.\$\{ext\}`/);
  });

  it('enforces 10MB size limit', () => {
    expect(agentClaudeSource).toContain('10 * 1024 * 1024');
    expect(agentClaudeSource).toMatch(/buffer\.length\s*>\s*10\s*\*\s*1024\s*\*\s*1024/);
  });

  it('writes image buffer to local file', () => {
    expect(agentClaudeSource).toContain('await writeFile(filePath, buffer)');
  });

  it('sends chat_image message to server with required fields', () => {
    // Must include type, conversationId, mimeType, data, filePath, filename
    expect(agentClaudeSource).toContain("type: 'chat_image'");
    expect(agentClaudeSource).toMatch(/ctx\.sendToServer\(\{[^}]*type:\s*'chat_image'/s);
    expect(agentClaudeSource).toMatch(/ctx\.sendToServer\(\{[^}]*conversationId/s);
    expect(agentClaudeSource).toMatch(/ctx\.sendToServer\(\{[^}]*mimeType/s);
    expect(agentClaudeSource).toMatch(/ctx\.sendToServer\(\{[^}]*data:\s*block\.source\.data/s);
    expect(agentClaudeSource).toMatch(/ctx\.sendToServer\(\{[^}]*filePath/s);
    expect(agentClaudeSource).toMatch(/ctx\.sendToServer\(\{[^}]*filename/s);
  });

  it('has error handling with try/catch', () => {
    // The function should gracefully handle errors
    expect(agentClaudeSource).toMatch(/catch\s*\(err\)/);
    expect(agentClaudeSource).toContain('[Chat Image] Failed to save image');
  });

  it('skips non-image blocks silently', () => {
    // Only processes blocks where type === 'image' && source.type === 'base64' && source.data
    // Text blocks, tool_use blocks, etc. should be ignored
    expect(agentClaudeSource).toContain("if (block.type === 'image' && block.source?.type === 'base64' && block.source?.data)");
  });

  it('returns early when contentBlocks is null (non-matching message types)', () => {
    expect(agentClaudeSource).toContain('if (!contentBlocks) return');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. server/handlers/agent-output.js — chat_image case
// ─────────────────────────────────────────────────────────────────────────
describe('server/handlers/agent-output.js — chat_image handling', () => {
  it('imports randomUUID from crypto', () => {
    expect(agentOutputSource).toMatch(/import\s*\{[^}]*randomUUID[^}]*\}\s*from\s*['"]crypto['"]/);
  });

  it('imports previewFiles from context', () => {
    expect(agentOutputSource).toMatch(/import\s*\{[^}]*previewFiles[^}]*\}\s*from\s*['"]\.\.\/context/);
  });

  it('has chat_image case in switch', () => {
    expect(agentOutputSource).toContain("case 'chat_image':");
  });

  it('enforces 10MB size limit on server side', () => {
    // Check base64 data size before processing
    expect(agentOutputSource).toContain("Buffer.byteLength(msg.data, 'base64')");
    expect(agentOutputSource).toMatch(/dataSize\s*>\s*10\s*\*\s*1024\s*\*\s*1024/);
  });

  it('generates unique fileId and token via randomUUID', () => {
    // Within the chat_image case
    const startIdx = agentOutputSource.indexOf("case 'chat_image':");
    const endIdx = agentOutputSource.indexOf('default:', startIdx);
    const chatImageBlock = agentOutputSource.substring(startIdx, endIdx);
    expect(chatImageBlock).toContain('randomUUID()');
    // Should call randomUUID twice — once for fileId, once for token
    const uuidCalls = chatImageBlock.match(/randomUUID\(\)/g);
    expect(uuidCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('stores image in previewFiles with required fields', () => {
    expect(agentOutputSource).toContain('previewFiles.set(fileId');
    // Extract the full chat_image case block (until the next case or default)
    const startIdx = agentOutputSource.indexOf("case 'chat_image':");
    const endIdx = agentOutputSource.indexOf('default:', startIdx);
    const chatImageBlock = agentOutputSource.substring(startIdx, endIdx);
    expect(chatImageBlock).toContain('buffer:');
    expect(chatImageBlock).toContain('mimeType:');
    expect(chatImageBlock).toContain('filename:');
    expect(chatImageBlock).toContain('createdAt:');
    expect(chatImageBlock).toContain('token');
  });

  it('decodes base64 data to buffer for storage', () => {
    expect(agentOutputSource).toContain("Buffer.from(msg.data, 'base64')");
  });

  it('forwards chat_image to web clients with fileId and previewToken', () => {
    // Extract the full chat_image case block
    const startIdx = agentOutputSource.indexOf("case 'chat_image':");
    const endIdx = agentOutputSource.indexOf('default:', startIdx);
    const chatImageBlock = agentOutputSource.substring(startIdx, endIdx);
    expect(chatImageBlock).toContain('forwardToClients');
    expect(chatImageBlock).toContain("type: 'chat_image'");
    expect(chatImageBlock).toContain('fileId');
    expect(chatImageBlock).toContain('previewToken: token');
    expect(chatImageBlock).toContain('mimeType:');
  });

  it('does NOT forward raw base64 data to clients (only fileId reference)', () => {
    // The forwarded message in the chat_image case should NOT include raw data
    const startIdx = agentOutputSource.indexOf("case 'chat_image':");
    const endIdx = agentOutputSource.indexOf('default:', startIdx);
    const chatImageBlock = agentOutputSource.substring(startIdx, endIdx);
    // Find the forwardToClients call within the chat_image block
    const fwdIdx = chatImageBlock.indexOf('forwardToClients');
    const fwdBlock = chatImageBlock.substring(fwdIdx, fwdIdx + 300);
    // The forward payload should not contain "data: msg.data" — it should only have fileId/token
    expect(fwdBlock).not.toContain('data: msg.data');
    expect(fwdBlock).toContain('fileId');
    expect(fwdBlock).toContain('previewToken');
  });

  it('provides filename fallback when msg.filename is missing', () => {
    expect(agentOutputSource).toMatch(/msg\.filename\s*\|\|\s*`chat-/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. web/stores/helpers/messageHandler.js — chat_image dispatch
// ─────────────────────────────────────────────────────────────────────────
describe('web/stores/helpers/messageHandler.js — chat_image dispatch', () => {
  it('has case for chat_image WebSocket message', () => {
    expect(messageHandlerSource).toContain("case 'chat_image':");
  });

  it('guards on conversationId and fileId', () => {
    expect(messageHandlerSource).toContain('msg.conversationId && msg.fileId');
  });

  it('calls addMessageToConversation with chat-image type', () => {
    expect(messageHandlerSource).toContain('store.addMessageToConversation(msg.conversationId');
    // The message object passed to store
    const chatImageBlock = messageHandlerSource.substring(
      messageHandlerSource.indexOf("case 'chat_image':"),
      messageHandlerSource.indexOf("case 'chat_image':") + 300
    );
    expect(chatImageBlock).toContain("type: 'chat-image'");
  });

  it('passes fileId, previewToken, and mimeType to store', () => {
    const startIdx = messageHandlerSource.indexOf("case 'chat_image':");
    const endIdx = messageHandlerSource.indexOf('break;', startIdx);
    const chatImageBlock = messageHandlerSource.substring(startIdx, endIdx + 10);
    expect(chatImageBlock).toContain('fileId: msg.fileId');
    expect(chatImageBlock).toContain('previewToken: msg.previewToken');
    expect(chatImageBlock).toContain('mimeType: msg.mimeType');
  });

  it('does NOT process when conversationId or fileId missing', () => {
    // The if-guard ensures both must be truthy
    expect(messageHandlerSource).toMatch(/if\s*\(\s*msg\.conversationId\s*&&\s*msg\.fileId\s*\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. web/components/MessageList.js — turn aggregation with imageMsgs
// ─────────────────────────────────────────────────────────────────────────
describe('web/components/MessageList.js — imageMsgs turn aggregation', () => {
  it('initializes imageMsgs as empty array in startTurn', () => {
    expect(messageListSource).toMatch(/imageMsgs:\s*\[\]/);
  });

  it('handles chat-image message type', () => {
    expect(messageListSource).toContain("msg.type === 'chat-image'");
  });

  it('pushes chat-image messages to currentTurn.imageMsgs', () => {
    expect(messageListSource).toContain('currentTurn.imageMsgs.push(msg)');
  });

  it('also pushes to currentTurn.messages for generic tracking', () => {
    // After imageMsgs.push, should also push to messages
    const chatImageBlock = messageListSource.substring(
      messageListSource.indexOf("msg.type === 'chat-image'"),
      messageListSource.indexOf("msg.type === 'chat-image'") + 200
    );
    expect(chatImageBlock).toContain('currentTurn.imageMsgs.push(msg)');
    expect(chatImageBlock).toContain('currentTurn.messages.push(msg)');
  });

  it('starts a new turn if none exists when receiving chat-image', () => {
    const chatImageBlock = messageListSource.substring(
      messageListSource.indexOf("msg.type === 'chat-image'"),
      messageListSource.indexOf("msg.type === 'chat-image'") + 200
    );
    expect(chatImageBlock).toContain('if (!currentTurn) startTurn()');
  });

  it('includes imageMsgs in finishTurn non-empty check', () => {
    // finishTurn should not skip turns that only have images
    expect(messageListSource).toContain('currentTurn.imageMsgs.length > 0');
  });

  it('preserves existing turn fields (textContent, toolMsgs, todoMsg, askMsg)', () => {
    // startTurn must still initialize all existing fields
    const startTurnBlock = messageListSource.substring(
      messageListSource.indexOf('const startTurn = ()'),
      messageListSource.indexOf('const startTurn = ()') + 300
    );
    expect(startTurnBlock).toContain("type: 'assistant-turn'");
    expect(startTurnBlock).toContain("textContent: ''");
    expect(startTurnBlock).toContain('toolMsgs: []');
    expect(startTurnBlock).toContain('imageMsgs: []');
    expect(startTurnBlock).toContain('todoMsg: null');
    expect(startTurnBlock).toContain('askMsg: null');
  });
});

// ─── Pure function test: turn aggregation logic ─────────────────────────
describe('MessageList turn aggregation — pure function behavior', () => {
  // Extract and test the aggregation logic with mock data
  function aggregateTurns(messages) {
    const result = [];
    let currentTurn = null;
    let turnCounter = 0;

    const finishTurn = () => {
      if (currentTurn) {
        if (currentTurn.textContent || currentTurn.toolMsgs.length > 0 || currentTurn.todoMsg || currentTurn.askMsg || currentTurn.imageMsgs.length > 0) {
          result.push(currentTurn);
        }
        currentTurn = null;
      }
    };

    const startTurn = () => {
      turnCounter++;
      currentTurn = {
        type: 'assistant-turn',
        id: 'turn_' + turnCounter,
        textContent: '',
        isStreaming: false,
        todoMsg: null,
        toolMsgs: [],
        imageMsgs: [],
        askMsg: null,
        messages: []
      };
    };

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.type === 'user') {
        if (!msg.content || !msg.content.trim()) continue;
        finishTurn();
        result.push({ type: 'user', id: msg.id || 'u_' + i, message: msg });
        continue;
      }
      if (msg.type === 'assistant') {
        if (!currentTurn) startTurn();
        if (msg.content) currentTurn.textContent += msg.content;
        currentTurn.messages.push(msg);
        continue;
      }
      if (msg.type === 'chat-image') {
        if (!currentTurn) startTurn();
        currentTurn.imageMsgs.push(msg);
        currentTurn.messages.push(msg);
        continue;
      }
      finishTurn();
      result.push({ type: msg.type || 'unknown', id: msg.id || 'x_' + i, message: msg });
    }
    finishTurn();
    return result;
  }

  it('groups chat-image with preceding assistant text in same turn', () => {
    const msgs = [
      { type: 'assistant', content: 'Here is a screenshot:' },
      { type: 'chat-image', fileId: 'f1', previewToken: 't1', mimeType: 'image/png' }
    ];
    const turns = aggregateTurns(msgs);
    expect(turns).toHaveLength(1);
    expect(turns[0].type).toBe('assistant-turn');
    expect(turns[0].textContent).toBe('Here is a screenshot:');
    expect(turns[0].imageMsgs).toHaveLength(1);
    expect(turns[0].imageMsgs[0].fileId).toBe('f1');
  });

  it('creates a turn for standalone chat-image (no preceding text)', () => {
    const msgs = [
      { type: 'chat-image', fileId: 'f1', previewToken: 't1', mimeType: 'image/png' }
    ];
    const turns = aggregateTurns(msgs);
    expect(turns).toHaveLength(1);
    expect(turns[0].type).toBe('assistant-turn');
    expect(turns[0].textContent).toBe('');
    expect(turns[0].imageMsgs).toHaveLength(1);
  });

  it('supports multiple images in one turn', () => {
    const msgs = [
      { type: 'assistant', content: 'Two screenshots:' },
      { type: 'chat-image', fileId: 'f1', previewToken: 't1', mimeType: 'image/png' },
      { type: 'chat-image', fileId: 'f2', previewToken: 't2', mimeType: 'image/jpeg' }
    ];
    const turns = aggregateTurns(msgs);
    expect(turns).toHaveLength(1);
    expect(turns[0].imageMsgs).toHaveLength(2);
    expect(turns[0].imageMsgs[0].fileId).toBe('f1');
    expect(turns[0].imageMsgs[1].fileId).toBe('f2');
  });

  it('does NOT skip image-only turns (no text, no tools)', () => {
    const msgs = [
      { type: 'chat-image', fileId: 'f1', previewToken: 't1', mimeType: 'image/png' }
    ];
    const turns = aggregateTurns(msgs);
    // finishTurn condition includes imageMsgs.length > 0
    expect(turns).toHaveLength(1);
    expect(turns[0].imageMsgs).toHaveLength(1);
  });

  it('separates images across user messages into different turns', () => {
    const msgs = [
      { type: 'assistant', content: 'First' },
      { type: 'chat-image', fileId: 'f1', previewToken: 't1', mimeType: 'image/png' },
      { type: 'user', content: 'Thanks', id: 'u1' },
      { type: 'assistant', content: 'Second' },
      { type: 'chat-image', fileId: 'f2', previewToken: 't2', mimeType: 'image/png' }
    ];
    const turns = aggregateTurns(msgs);
    // Result: assistant-turn (First + f1), user (Thanks), assistant-turn (Second + f2)
    expect(turns).toHaveLength(3);
    const assistantTurns = turns.filter(t => t.type === 'assistant-turn');
    expect(assistantTurns).toHaveLength(2);
    expect(assistantTurns[0].imageMsgs[0].fileId).toBe('f1');
    expect(assistantTurns[1].imageMsgs[0].fileId).toBe('f2');
  });

  it('tracks images in both imageMsgs and messages arrays', () => {
    const msgs = [
      { type: 'chat-image', fileId: 'f1', previewToken: 't1', mimeType: 'image/png' }
    ];
    const turns = aggregateTurns(msgs);
    expect(turns[0].imageMsgs).toHaveLength(1);
    expect(turns[0].messages).toHaveLength(1);
    expect(turns[0].messages[0]).toBe(turns[0].imageMsgs[0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. web/components/AssistantTurn.js — image rendering template + helpers
// ─────────────────────────────────────────────────────────────────────────
describe('web/components/AssistantTurn.js — image rendering', () => {
  describe('template', () => {
    it('has turn-images container with v-if on imageMsgs', () => {
      expect(assistantTurnSource).toContain('class="turn-images"');
      expect(assistantTurnSource).toMatch(/v-if="turn\.imageMsgs\s*&&\s*turn\.imageMsgs\.length\s*>\s*0"/);
    });

    it('iterates over turn.imageMsgs with v-for', () => {
      expect(assistantTurnSource).toMatch(/v-for="img\s+in\s+turn\.imageMsgs"/);
    });

    it('renders img tag with chat-screenshot class', () => {
      expect(assistantTurnSource).toContain('class="chat-screenshot"');
    });

    it('uses getImageUrl for img src', () => {
      expect(assistantTurnSource).toContain(':src="getImageUrl(img)"');
    });

    it('has v-if on img.fileId (only render when fileId exists)', () => {
      expect(assistantTurnSource).toContain('v-if="img.fileId"');
    });

    it('handles image error with handleImageError', () => {
      expect(assistantTurnSource).toContain('@error="handleImageError($event)"');
    });

    it('opens preview on click', () => {
      expect(assistantTurnSource).toContain('@click="openImagePreview(getImageUrl(img))"');
    });

    it('image section appears before AskUserQuestion card (correct order)', () => {
      const turnImagesIdx = assistantTurnSource.indexOf('class="turn-images"');
      const turnAskIdx = assistantTurnSource.indexOf('class="turn-ask"');
      expect(turnImagesIdx).toBeLessThan(turnAskIdx);
    });
  });

  describe('helper functions', () => {
    it('defines getImageUrl function', () => {
      expect(assistantTurnSource).toContain('const getImageUrl = (msg)');
    });

    it('getImageUrl constructs /api/preview/:fileId?token= URL', () => {
      expect(assistantTurnSource).toContain('/api/preview/${msg.fileId}?token=${token}');
    });

    it('getImageUrl returns empty string when fileId is missing', () => {
      expect(assistantTurnSource).toContain("if (!msg.fileId) return ''");
    });

    it('getImageUrl uses previewToken with empty string fallback', () => {
      expect(assistantTurnSource).toContain("msg.previewToken || ''");
    });

    it('defines handleImageError that hides broken images', () => {
      expect(assistantTurnSource).toContain('const handleImageError = (event)');
      expect(assistantTurnSource).toContain("event.target.style.display = 'none'");
    });

    it('defines openImagePreview that opens in new tab', () => {
      expect(assistantTurnSource).toContain('const openImagePreview = (url)');
      expect(assistantTurnSource).toContain("window.open(url, '_blank')");
    });

    it('exports getImageUrl, handleImageError, openImagePreview in return', () => {
      // Must be in the return block
      const returnBlock = assistantTurnSource.substring(
        assistantTurnSource.lastIndexOf('return {'),
        assistantTurnSource.lastIndexOf('return {') + 500
      );
      expect(returnBlock).toContain('getImageUrl');
      expect(returnBlock).toContain('handleImageError');
      expect(returnBlock).toContain('openImagePreview');
    });
  });
});

// ─── Pure function test: getImageUrl ────────────────────────────────────
describe('getImageUrl — pure function behavior', () => {
  // Extract the logic from AssistantTurn.js
  const getImageUrl = (msg) => {
    if (!msg.fileId) return '';
    const token = msg.previewToken || '';
    return `/api/preview/${msg.fileId}?token=${token}`;
  };

  it('constructs correct URL with fileId and token', () => {
    const url = getImageUrl({ fileId: 'abc-123', previewToken: 'tok-456' });
    expect(url).toBe('/api/preview/abc-123?token=tok-456');
  });

  it('returns empty string when fileId is missing', () => {
    expect(getImageUrl({})).toBe('');
    expect(getImageUrl({ previewToken: 'tok' })).toBe('');
  });

  it('uses empty string for missing previewToken', () => {
    const url = getImageUrl({ fileId: 'abc-123' });
    expect(url).toBe('/api/preview/abc-123?token=');
  });

  it('handles null/undefined fileId', () => {
    expect(getImageUrl({ fileId: null })).toBe('');
    expect(getImageUrl({ fileId: undefined })).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. web/styles/chat-messages.css — image CSS styles
// ─────────────────────────────────────────────────────────────────────────
describe('web/styles/chat-messages.css — image styles', () => {
  it('has .turn-images class with padding', () => {
    expect(chatMessagesCss).toContain('.turn-images');
    expect(chatMessagesCss).toMatch(/\.turn-images\s*\{[^}]*padding:\s*8px\s+12px/);
  });

  it('has .turn-image-item class with vertical margin', () => {
    expect(chatMessagesCss).toContain('.turn-image-item');
    expect(chatMessagesCss).toMatch(/\.turn-image-item\s*\{[^}]*margin:\s*4px\s+0/);
  });

  it('has .chat-screenshot class with max-width: 100%', () => {
    expect(chatMessagesCss).toContain('.chat-screenshot');
    expect(chatMessagesCss).toMatch(/\.chat-screenshot\s*\{[^}]*max-width:\s*100%/);
  });

  it('limits image height to 400px', () => {
    expect(chatMessagesCss).toMatch(/\.chat-screenshot\s*\{[^}]*max-height:\s*400px/);
  });

  it('has border-radius for rounded corners', () => {
    expect(chatMessagesCss).toMatch(/\.chat-screenshot\s*\{[^}]*border-radius:\s*6px/);
  });

  it('has pointer cursor for clickable images', () => {
    expect(chatMessagesCss).toMatch(/\.chat-screenshot\s*\{[^}]*cursor:\s*pointer/);
  });

  it('has border using CSS variable', () => {
    expect(chatMessagesCss).toMatch(/\.chat-screenshot\s*\{[^}]*border:\s*1px\s+solid\s+var\(--border-color\)/);
  });

  it('has opacity transition for hover effect', () => {
    expect(chatMessagesCss).toMatch(/\.chat-screenshot\s*\{[^}]*transition:\s*opacity\s+0\.2s/);
  });

  it('has hover state with reduced opacity', () => {
    expect(chatMessagesCss).toContain('.chat-screenshot:hover');
    expect(chatMessagesCss).toMatch(/\.chat-screenshot:hover\s*\{[^}]*opacity:\s*0\.9/);
  });

  it('image styles are placed before .turn-ask styles (correct CSS order)', () => {
    const imageIdx = chatMessagesCss.indexOf('.turn-images');
    const askIdx = chatMessagesCss.indexOf('.turn-ask');
    expect(imageIdx).toBeLessThan(askIdx);
  });

  it('does not hardcode colors (uses CSS variables)', () => {
    // .chat-screenshot should use var(--border-color), not hardcoded colors
    const screenshotBlock = chatMessagesCss.substring(
      chatMessagesCss.indexOf('.chat-screenshot {'),
      chatMessagesCss.indexOf('.chat-screenshot {') + 300
    );
    expect(screenshotBlock).toContain('var(--border-color)');
    expect(screenshotBlock).not.toMatch(/#[0-9a-fA-F]{3,6}/); // No hardcoded hex colors
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Cross-file integration checks
// ─────────────────────────────────────────────────────────────────────────
describe('Cross-file integration checks', () => {
  it('message type is consistent: agent sends chat_image, messageHandler converts to chat-image', () => {
    // Agent → server: chat_image (underscore)
    expect(agentClaudeSource).toContain("type: 'chat_image'");
    // Server → web client: chat_image (underscore)
    expect(agentOutputSource).toMatch(/type:\s*'chat_image'/);
    // WebSocket handler: case 'chat_image'
    expect(messageHandlerSource).toContain("case 'chat_image':");
    // Store message: type: 'chat-image' (hyphen)
    expect(messageHandlerSource).toContain("type: 'chat-image'");
    // MessageList aggregation: msg.type === 'chat-image' (hyphen)
    expect(messageListSource).toContain("msg.type === 'chat-image'");
  });

  it('fileId flows from server through to AssistantTurn rendering', () => {
    // Server generates fileId
    expect(agentOutputSource).toContain('const fileId = randomUUID()');
    // Server forwards fileId to clients
    expect(agentOutputSource).toMatch(/fileId[,\s]/);
    // messageHandler passes fileId to store
    expect(messageHandlerSource).toContain('fileId: msg.fileId');
    // AssistantTurn uses fileId for URL
    expect(assistantTurnSource).toContain('msg.fileId');
  });

  it('previewToken flows from server through to URL construction', () => {
    // Server generates token
    expect(agentOutputSource).toContain('const token = randomUUID()');
    // Server forwards as previewToken
    expect(agentOutputSource).toContain('previewToken: token');
    // messageHandler passes to store
    expect(messageHandlerSource).toContain('previewToken: msg.previewToken');
    // AssistantTurn uses for URL
    expect(assistantTurnSource).toContain('msg.previewToken');
  });

  it('10MB limit is enforced on both agent and server sides', () => {
    expect(agentClaudeSource).toContain('10 * 1024 * 1024');
    expect(agentOutputSource).toContain('10 * 1024 * 1024');
  });

  it('broken image gracefully hidden (handleImageError hides element)', () => {
    // When previewFiles expire (10 min), /api/preview will 404
    // The @error handler hides the img
    expect(assistantTurnSource).toContain("event.target.style.display = 'none'");
    expect(assistantTurnSource).toContain('@error="handleImageError($event)"');
  });

  it('crew image support is NOT affected (no changes to crew patterns)', () => {
    // CrewTurnRenderer (not in changed files) should still work independently
    // messageHandler only adds a NEW case, doesn't modify existing crew_image case
    expect(messageHandlerSource).not.toMatch(/case\s*'crew_image'.*chat/s);
    // chat-image is a separate type from crew image messages
    expect(messageListSource).toContain("msg.type === 'chat-image'");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Edge cases and robustness
// ─────────────────────────────────────────────────────────────────────────
describe('Edge cases and robustness', () => {
  it('agent handles non-array content gracefully (returns early)', () => {
    // If message.message.content is not an array, contentBlocks stays null
    expect(agentClaudeSource).toContain('Array.isArray(message.message?.content)');
    expect(agentClaudeSource).toContain('if (!contentBlocks) return');
  });

  it('agent skips blocks without source.data', () => {
    expect(agentClaudeSource).toContain("block.source?.data");
  });

  it('server handles missing msg.data gracefully', () => {
    // dataSize calculation: msg.data ? ... : 0
    expect(agentOutputSource).toMatch(/msg\.data\s*\?\s*Buffer\.byteLength/);
  });

  it('messageHandler skips when conversationId is missing', () => {
    expect(messageHandlerSource).toContain('msg.conversationId && msg.fileId');
  });

  it('messageHandler skips when fileId is missing', () => {
    expect(messageHandlerSource).toContain('msg.conversationId && msg.fileId');
  });

  it('AssistantTurn only renders img when fileId exists (v-if guard)', () => {
    expect(assistantTurnSource).toContain('v-if="img.fileId"');
  });

  it('CSS images do not overflow container (max-width: 100%)', () => {
    expect(chatMessagesCss).toMatch(/\.chat-screenshot\s*\{[^}]*max-width:\s*100%/);
  });
});
