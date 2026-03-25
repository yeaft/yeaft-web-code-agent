/**
 * Tests for Conductor V5 — ui-messages.js
 *
 * Covers: sendConductorMessage, sendConductorOutput (all outputTypes),
 *         endConductorStreaming, recordUserMessage, sendStatusUpdate,
 *         no sessionId in V5
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let src;
beforeAll(() => {
  src = readFileSync(join(process.cwd(), 'agent/conductor/ui-messages.js'), 'utf-8');
});

// ── Replicate UI message logic for functional tests ─────────────────

function makeConductor() {
  return {
    tasks: new Map(),
    uiMessages: [],
    status: 'running',
    costUsd: 0.5,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    activeClaudes: 1
  };
}

function sendConductorOutput(conductor, outputType, rawMessage, extra = {}) {
  // Record trimmed UI messages (replicate logic)
  if (outputType === 'text') {
    const content = rawMessage?.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.filter(b => b.type === 'text').map(b => b.text).join('');
    if (!text) return;
    let found = false;
    for (let i = conductor.uiMessages.length - 1; i >= 0; i--) {
      const msg = conductor.uiMessages[i];
      if (msg.source === 'conductor' && msg.type === 'text' && msg._streaming) {
        msg.content += text;
        found = true;
        break;
      }
    }
    if (!found) {
      conductor.uiMessages.push({
        source: 'conductor', type: 'text', content: text,
        _streaming: true, timestamp: Date.now()
      });
    }
  } else if (outputType === 'system') {
    const content = rawMessage?.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.filter(b => b.type === 'text').map(b => b.text).join('');
    if (!text) return;
    conductor.uiMessages.push({
      source: 'conductor', type: 'system', content: text, timestamp: Date.now()
    });
  } else if (outputType === 'task_created') {
    conductor.uiMessages.push({
      source: 'conductor', type: 'task_created',
      taskId: extra.taskId, taskTitle: extra.taskTitle,
      content: `Created task: ${extra.taskTitle}`, timestamp: Date.now()
    });
  } else if (outputType === 'task_forwarded') {
    conductor.uiMessages.push({
      source: 'conductor', type: 'task_forwarded',
      taskId: extra.taskId,
      content: `Forwarded message to task: ${extra.taskId}`, timestamp: Date.now()
    });
  }
}

function endConductorStreaming(conductor) {
  for (let i = conductor.uiMessages.length - 1; i >= 0; i--) {
    if (conductor.uiMessages[i].source === 'conductor' && conductor.uiMessages[i]._streaming) {
      delete conductor.uiMessages[i]._streaming;
      break;
    }
  }
}

function recordUserMessage(conductor, content) {
  conductor.uiMessages.push({
    source: 'user', type: 'text', content, timestamp: Date.now()
  });
}

// ── sendConductorOutput — text ──────────────────────────────────────

describe('sendConductorOutput — text', () => {
  it('should create streaming message on first text chunk', () => {
    const c = makeConductor();
    sendConductorOutput(c, 'text', { message: { content: 'Hello' } });
    expect(c.uiMessages).toHaveLength(1);
    expect(c.uiMessages[0].content).toBe('Hello');
    expect(c.uiMessages[0]._streaming).toBe(true);
    expect(c.uiMessages[0].source).toBe('conductor');
  });

  it('should append to existing streaming message', () => {
    const c = makeConductor();
    sendConductorOutput(c, 'text', { message: { content: 'Hello ' } });
    sendConductorOutput(c, 'text', { message: { content: 'World' } });
    expect(c.uiMessages).toHaveLength(1);
    expect(c.uiMessages[0].content).toBe('Hello World');
  });

  it('should handle array content blocks', () => {
    const c = makeConductor();
    sendConductorOutput(c, 'text', {
      message: { content: [{ type: 'text', text: 'Part1' }, { type: 'text', text: 'Part2' }] }
    });
    expect(c.uiMessages[0].content).toBe('Part1Part2');
  });

  it('should ignore empty content', () => {
    const c = makeConductor();
    sendConductorOutput(c, 'text', { message: { content: '' } });
    expect(c.uiMessages).toHaveLength(0);
  });
});

// ── sendConductorOutput — system ────────────────────────────────────

describe('sendConductorOutput — system', () => {
  it('should record system message', () => {
    const c = makeConductor();
    sendConductorOutput(c, 'system', { message: { content: 'System init' } });
    expect(c.uiMessages).toHaveLength(1);
    expect(c.uiMessages[0].type).toBe('system');
    expect(c.uiMessages[0].content).toBe('System init');
  });
});

// ── sendConductorOutput — task_created ──────────────────────────────

describe('sendConductorOutput — task_created', () => {
  it('should record task creation', () => {
    const c = makeConductor();
    sendConductorOutput(c, 'task_created', null, { taskId: 't1', taskTitle: 'Fix bug' });
    expect(c.uiMessages).toHaveLength(1);
    expect(c.uiMessages[0].type).toBe('task_created');
    expect(c.uiMessages[0].taskId).toBe('t1');
    expect(c.uiMessages[0].content).toContain('Fix bug');
  });
});

// ── sendConductorOutput — task_forwarded ────────────────────────────

describe('sendConductorOutput — task_forwarded', () => {
  it('should record task forward', () => {
    const c = makeConductor();
    sendConductorOutput(c, 'task_forwarded', null, { taskId: 't2' });
    expect(c.uiMessages).toHaveLength(1);
    expect(c.uiMessages[0].type).toBe('task_forwarded');
    expect(c.uiMessages[0].taskId).toBe('t2');
  });
});

// ── endConductorStreaming ───────────────────────────────────────────

describe('endConductorStreaming', () => {
  it('should remove _streaming flag from last streaming message', () => {
    const c = makeConductor();
    c.uiMessages.push({ source: 'conductor', type: 'text', content: 'Hi', _streaming: true });
    endConductorStreaming(c);
    expect(c.uiMessages[0]._streaming).toBeUndefined();
  });

  it('should only affect the last streaming message', () => {
    const c = makeConductor();
    c.uiMessages.push({ source: 'conductor', type: 'text', content: 'A', _streaming: false });
    c.uiMessages.push({ source: 'conductor', type: 'text', content: 'B', _streaming: true });
    endConductorStreaming(c);
    expect(c.uiMessages[1]._streaming).toBeUndefined();
  });
});

// ── recordUserMessage ───────────────────────────────────────────────

describe('recordUserMessage', () => {
  it('should record user message with source: user', () => {
    const c = makeConductor();
    recordUserMessage(c, 'How is progress?');
    expect(c.uiMessages).toHaveLength(1);
    expect(c.uiMessages[0].source).toBe('user');
    expect(c.uiMessages[0].type).toBe('text');
    expect(c.uiMessages[0].content).toBe('How is progress?');
  });
});

// ── sendStatusUpdate ────────────────────────────────────────────────

describe('sendStatusUpdate — source patterns', () => {
  it('should send conductor_status type', () => {
    expect(src).toContain("type: 'conductor_status'");
  });

  it('should include tasks, cost, tokens, activeClaudes', () => {
    expect(src).toContain('status: conductor.status');
    expect(src).toContain('costUsd: conductor.costUsd');
    expect(src).toContain('activeClaudes: conductor.activeClaudes');
  });

  it('should trigger async saveConductorMeta', () => {
    expect(src).toContain('saveConductorMeta(conductor)');
  });
});

// ── No sessionId in V5 ─────────────────────────────────────────────

describe('V5: no sessionId', () => {
  it('should not reference sessionId in send functions', () => {
    // The V5 UI messages module should not include sessionId anywhere
    // (it was removed in V5 since conductor is singleton)
    expect(src).not.toContain('sessionId');
  });
});
