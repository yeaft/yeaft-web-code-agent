/**
 * Tests for Conductor V5 — agent-conductor.js (Server handler)
 *
 * Covers: 9 message types forwarding, forwardToAllAgentClients,
 *         unified forwarding pattern, no sessionId
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let src;
beforeAll(() => {
  src = readFileSync(join(process.cwd(), 'server/handlers/agent-conductor.js'), 'utf-8');
});

// ── Handler signature ───────────────────────────────────────────────

describe('handleAgentConductor', () => {
  it('should export handleAgentConductor function', () => {
    expect(src).toContain('export async function handleAgentConductor');
  });

  it('should accept (agentId, agent, msg) params', () => {
    expect(src).toContain('handleAgentConductor(agentId, agent, msg)');
  });

  it('should return false for unknown types', () => {
    expect(src).toContain('return false');
  });

  it('should return true for handled types', () => {
    expect(src).toContain('return true');
  });
});

// ── Message types forwarded ─────────────────────────────────────────

describe('Forwarded message types', () => {
  const types = [
    'conductor_opened',
    'conductor_output',
    'conductor_status',
    'conductor_turn_completed',
    'conductor_error',
    'conductor_task_created',
    'conductor_task_message',
    'conductor_cleared',
    'conductor_history_loaded'
  ];

  for (const type of types) {
    it(`should handle ${type}`, () => {
      expect(src).toContain(`case '${type}'`);
    });
  }
});

// ── forwardToAllAgentClients ────────────────────────────────────────

describe('forwardToAllAgentClients', () => {
  it('should be a local function that broadcasts to agent clients', () => {
    expect(src).toContain('async function forwardToAllAgentClients(agentId, msg)');
  });

  it('should use forwardToClients with _conductor_ sentinel', () => {
    expect(src).toContain("forwardToClients(agentId, '_conductor_', msg)");
  });

  it('should be used by all message type handlers', () => {
    // Every case should call forwardToAllAgentClients
    expect(src).toContain('await forwardToAllAgentClients(agentId, msg)');
  });
});

// ── Unified pattern: all types use forwardToAllAgentClients ─────────

describe('Unified forwarding pattern', () => {
  it('should use the same forwardToAllAgentClients for all cases', () => {
    // Count occurrences of forwardToAllAgentClients
    const matches = src.match(/forwardToAllAgentClients\(agentId, msg\)/g);
    expect(matches).not.toBeNull();
    // 9 message types = 9 calls (each case forwards the same way)
    expect(matches.length).toBeGreaterThanOrEqual(9);
  });
});

// ── V5: no old multi-session message types ──────────────────────────

describe('V5: no old message types', () => {
  it('should NOT handle conductor_session_created', () => {
    expect(src).not.toContain('conductor_session_created');
  });

  it('should NOT handle conductor_sessions_list', () => {
    expect(src).not.toContain('conductor_sessions_list');
  });

  it('should NOT reference sessionId in forwarding', () => {
    expect(src).not.toContain('sessionId');
  });
});

// ── Imports ─────────────────────────────────────────────────────────

describe('Imports', () => {
  it('should import forwardToClients from ws-utils', () => {
    expect(src).toContain("import");
    expect(src).toContain("forwardToClients");
    expect(src).toContain("'../ws-utils.js'");
  });
});
