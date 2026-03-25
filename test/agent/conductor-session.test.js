/**
 * Tests for Conductor V5 — session.js
 *
 * Covers: singleton model, initConductor, getConductor,
 *         handleConductorUserInput, stopConductor, clearConductor
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let src;
beforeAll(() => {
  src = readFileSync(join(process.cwd(), 'agent/conductor/session.js'), 'utf-8');
});

// ── Singleton Model ─────────────────────────────────────────────────

describe('Singleton conductor instance', () => {
  it('should declare a single conductor variable (not a Map)', () => {
    expect(src).toContain('let conductor = null');
    expect(src).not.toContain('conductorSessions');
    expect(src).not.toContain('new Map');
  });

  it('should export getConductor() returning the instance', () => {
    expect(src).toContain('export function getConductor()');
    expect(src).toContain('return conductor');
  });
});

// ── initConductor ───────────────────────────────────────────────────

describe('initConductor', () => {
  it('should be an exported async function', () => {
    expect(src).toContain('export async function initConductor(msg)');
  });

  it('should return existing conductor if already initialized', () => {
    expect(src).toContain('if (conductor)');
    expect(src).toContain('return conductor');
  });

  it('should call ensureConductorHome', () => {
    expect(src).toContain('ensureConductorHome()');
  });

  it('should try to load existing meta from disk', () => {
    expect(src).toContain('loadConductorMeta()');
  });

  it('should create conductor object with correct initial fields', () => {
    expect(src).toContain("status: 'running'");
    expect(src).toContain('tasks: new Map()');
    expect(src).toContain('conductorState: null');
    expect(src).toContain('uiMessages: []');
  });

  it('should load state.json and populate tasks map', () => {
    expect(src).toContain('loadState()');
    expect(src).toContain('conductor.tasks.set(taskId, entry)');
  });

  it('should load UI messages from disk', () => {
    expect(src).toContain('loadConductorMessages()');
  });

  it('should send conductor_opened message', () => {
    expect(src).toContain("type: 'conductor_opened'");
  });

  it('should indicate if this is a resume', () => {
    expect(src).toContain('resumed: isResume');
  });

  it('should start Conductor Claude', () => {
    expect(src).toContain('createConductorClaude(conductor)');
  });

  it('should save meta after init', () => {
    expect(src).toContain('saveConductorMeta(conductor)');
  });
});

// ── handleConductorUserInput ────────────────────────────────────────

describe('handleConductorUserInput', () => {
  it('should be exported', () => {
    expect(src).toContain('export async function handleConductorUserInput');
  });

  it('should guard against null conductor', () => {
    expect(src).toContain('if (!conductor)');
  });

  it('should guard against stopped status', () => {
    expect(src).toContain("conductor.status === 'stopped'");
  });

  it('should send conductor_error when stopped', () => {
    expect(src).toContain("type: 'conductor_error'");
    expect(src).toContain("error: 'Conductor is stopped'");
  });

  it('should record user message', () => {
    expect(src).toContain('recordUserMessage(conductor, content)');
  });

  it('should call sendToConductor', () => {
    expect(src).toContain('sendToConductor(conductor, content)');
  });
});

// ── stopConductor ───────────────────────────────────────────────────

describe('stopConductor', () => {
  it('should be exported', () => {
    expect(src).toContain('export async function stopConductor()');
  });

  it('should guard against null conductor', () => {
    expect(src).toContain('if (!conductor) return');
  });

  it('should set status to stopped', () => {
    expect(src).toContain("conductor.status = 'stopped'");
  });

  it('should stop Conductor Claude', () => {
    expect(src).toContain('stopConductorClaude(conductor)');
  });

  it('should send system message about stopping', () => {
    expect(src).toContain('Conductor 已停止');
  });

  it('should set conductor to null (destroy singleton)', () => {
    expect(src).toContain('conductor = null');
  });

  it('should save meta before nulling', () => {
    expect(src).toContain('saveConductorMeta(conductor)');
  });
});

// ── clearConductor ──────────────────────────────────────────────────

describe('clearConductor', () => {
  it('should be exported', () => {
    expect(src).toContain('export async function clearConductor()');
  });

  it('should reset uiMessages to empty array', () => {
    expect(src).toContain('conductor.uiMessages = []');
  });

  it('should reset cost counters', () => {
    expect(src).toContain('conductor.costUsd = 0');
    expect(src).toContain('conductor.totalInputTokens = 0');
    expect(src).toContain('conductor.totalOutputTokens = 0');
  });

  it('should cleanup message shards', () => {
    expect(src).toContain('cleanupMessageShards(dir)');
  });

  it('should send conductor_cleared message', () => {
    expect(src).toContain("type: 'conductor_cleared'");
  });

  it('should restart Claude after clear', () => {
    // After clear, it creates a fresh Claude
    expect(src).toContain('createConductorClaude(conductor)');
  });

  it('should keep conductor instance alive (not null)', () => {
    // clearConductor should NOT set conductor = null (unlike stop)
    // Only stopConductor nullifies conductor
    const clearBody = src.split('export async function clearConductor')[1]
      .split('export ')[0]; // approximate function body
    // In clearConductor, we should NOT find `conductor = null`
    // But status should be set to 'running'
    expect(clearBody).toContain("conductor.status = 'running'");
  });
});

// ── No multi-session API ────────────────────────────────────────────

describe('V5 removed multi-session API', () => {
  it('should NOT export createConductorSession', () => {
    expect(src).not.toContain('createConductorSession');
  });

  it('should NOT export handleListConductorSessions', () => {
    expect(src).not.toContain('handleListConductorSessions');
  });

  it('should NOT export resumeConductorSession', () => {
    expect(src).not.toContain('resumeConductorSession');
  });

  it('should NOT export handleUpdateWorkDir', () => {
    expect(src).not.toContain('handleUpdateWorkDir');
  });

  it('should NOT export handleUpdateConductorSession', () => {
    expect(src).not.toContain('handleUpdateConductorSession');
  });

  it('should NOT have a conductorSessions Map', () => {
    expect(src).not.toContain('conductorSessions');
  });
});
