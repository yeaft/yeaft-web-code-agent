/**
 * Tests for Conductor V5 — client-conductor.js (Server handler)
 *
 * Covers: 5 message types (open_conductor, conductor_user_input,
 *         stop_conductor, clear_conductor, conductor_load_history),
 *         access checks, agent lookup, message forwarding
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let src;
beforeAll(() => {
  src = readFileSync(join(process.cwd(), 'server/handlers/client-conductor.js'), 'utf-8');
});

// ── Handler signature ───────────────────────────────────────────────

describe('handleClientConductor', () => {
  it('should export handleClientConductor function', () => {
    expect(src).toContain('export async function handleClientConductor');
  });

  it('should accept (clientId, client, msg, checkAgentAccess) params', () => {
    expect(src).toContain('handleClientConductor(clientId, client, msg, checkAgentAccess)');
  });

  it('should use switch on msg.type', () => {
    expect(src).toContain('switch (msg.type)');
  });

  it('should return false for unknown types', () => {
    expect(src).toContain('return false');
  });

  it('should return true for handled types', () => {
    expect(src).toContain('return true');
  });
});

// ── open_conductor ──────────────────────────────────────────────────

describe('open_conductor', () => {
  it('should handle open_conductor case', () => {
    expect(src).toContain("case 'open_conductor'");
  });

  it('should get agentId from msg or client.currentAgent', () => {
    expect(src).toContain('msg.agentId || client.currentAgent');
  });

  it('should check agent access', () => {
    expect(src).toContain('checkAgentAccess(agentId)');
  });

  it('should look up agent from agents map', () => {
    expect(src).toContain('agents.get(agentId)');
  });

  it('should send error when agent not found', () => {
    expect(src).toContain('Agent not found');
  });

  it('should set client.currentAgent', () => {
    expect(src).toContain('client.currentAgent = agentId');
  });

  it('should forward open_conductor to agent with userId/username', () => {
    expect(src).toContain("type: 'open_conductor'");
    expect(src).toContain('userId: client.userId');
    expect(src).toContain('username: client.username');
  });
});

// ── conductor_user_input ────────────────────────────────────────────

describe('conductor_user_input', () => {
  it('should handle conductor_user_input case', () => {
    expect(src).toContain("case 'conductor_user_input'");
  });

  it('should forward content to agent', () => {
    expect(src).toContain("type: 'conductor_user_input'");
    expect(src).toContain('content: msg.content');
  });
});

// ── stop_conductor ──────────────────────────────────────────────────

describe('stop_conductor', () => {
  it('should handle stop_conductor case', () => {
    expect(src).toContain("case 'stop_conductor'");
  });

  it('should forward stop message to agent', () => {
    expect(src).toContain("type: 'stop_conductor'");
  });
});

// ── clear_conductor ─────────────────────────────────────────────────

describe('clear_conductor', () => {
  it('should handle clear_conductor case', () => {
    expect(src).toContain("case 'clear_conductor'");
  });

  it('should forward clear message to agent', () => {
    expect(src).toContain("type: 'clear_conductor'");
  });
});

// ── conductor_load_history ──────────────────────────────────────────

describe('conductor_load_history', () => {
  it('should handle conductor_load_history case', () => {
    expect(src).toContain("case 'conductor_load_history'");
  });

  it('should forward shardIndex and requestId', () => {
    expect(src).toContain('shardIndex: msg.shardIndex');
    expect(src).toContain('requestId: msg.requestId');
  });
});

// ── V5: removed old multi-session cases ─────────────────────────────

describe('V5: no old multi-session cases', () => {
  it('should NOT handle create_conductor_session', () => {
    expect(src).not.toContain('create_conductor_session');
  });

  it('should NOT handle list_conductor_sessions', () => {
    expect(src).not.toContain('list_conductor_sessions');
  });

  it('should NOT handle resume_conductor_session', () => {
    expect(src).not.toContain('resume_conductor_session');
  });

  it('should NOT handle update_conductor_workdir', () => {
    expect(src).not.toContain('update_conductor_workdir');
  });

  it('should NOT reference sessionId in handler logic', () => {
    expect(src).not.toContain('sessionId');
  });
});
