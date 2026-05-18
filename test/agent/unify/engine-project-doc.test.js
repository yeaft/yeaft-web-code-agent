/**
 * engine-project-doc.test.js — Engine wires workDir → [Project Doc] block.
 *
 * Drives `engine.query({ workDir })` and inspects the system prompt the
 * Engine pushed to the (mock) adapter. Two scenarios:
 *
 *   1. End-to-end injection: the file at workDir/CLAUDE.md shows up
 *      verbatim inside the system prompt.
 *   2. mtime-driven invalidation: editing the file between turns flips
 *      the system prompt to the new content; an unchanged file reuses
 *      the same text (proxy for "the cache is doing its job").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Engine } from '../../../agent/unify/engine.js';
import { NullTrace } from '../../../agent/unify/debug-trace.js';

class MockAdapter {
  constructor() {
    this.callLog = [];
    this.responses = [];
  }
  pushResponse(events) { this.responses.push(events); }
  async *stream(params) {
    this.callLog.push(params);
    const events = this.responses.shift() || [
      { type: 'text_delta', text: 'ok' },
      { type: 'stop', stopReason: 'end_turn' },
    ];
    for (const ev of events) yield ev;
  }
  async call() { return { text: '', usage: { inputTokens: 0, outputTokens: 0 } }; }
}

describe('Engine — project-doc injection via workDir', () => {
  let workDir;
  let engine;
  let adapter;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'engine-pdoc-'));
    adapter = new MockAdapter();
    engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 256, projectDocMaxBytes: 32 * 1024 },
    });
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  async function runTurn(prompt, workDirArg) {
    adapter.pushResponse([
      { type: 'text_delta', text: 'fine' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);
    const events = [];
    for await (const ev of engine.query({ prompt, workDir: workDirArg })) {
      events.push(ev);
    }
    return events;
  }

  it('injects CLAUDE.md text into the system prompt when workDir is set', async () => {
    writeFileSync(join(workDir, 'CLAUDE.md'), '# Conventions\n\nUse pnpm.');
    await runTurn('hello', workDir);

    expect(adapter.callLog).toHaveLength(1);
    const sysPrompt = adapter.callLog[0].system;
    expect(sysPrompt).toMatch(/\[Project Doc\]/);
    expect(sysPrompt).toMatch(/Use pnpm\./);
  });

  it('does NOT inject when workDir is empty / undefined', async () => {
    writeFileSync(join(workDir, 'CLAUDE.md'), 'PROJECT_DOC_BODY');
    await runTurn('hello', undefined);

    const sysPrompt = adapter.callLog[0].system;
    expect(sysPrompt).not.toMatch(/Project Doc/);
    expect(sysPrompt).not.toMatch(/PROJECT_DOC_BODY/);
  });

  it('does NOT inject when workDir has neither file', async () => {
    // workDir exists but is empty
    await runTurn('hello', workDir);
    const sysPrompt = adapter.callLog[0].system;
    expect(sysPrompt).not.toMatch(/Project Doc/);
  });

  it('skips block when projectDocMaxBytes === 0 (feature disabled)', async () => {
    engine = new Engine({
      adapter,
      trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 256, projectDocMaxBytes: 0 },
    });
    writeFileSync(join(workDir, 'CLAUDE.md'), 'should-not-appear');
    await runTurn('hello', workDir);
    const sysPrompt = adapter.callLog[0].system;
    expect(sysPrompt).not.toMatch(/Project Doc/);
    expect(sysPrompt).not.toMatch(/should-not-appear/);
  });

  it('picks up new content when the file is edited between turns (mtime invalidation)', async () => {
    const docPath = join(workDir, 'CLAUDE.md');
    writeFileSync(docPath, 'OLD_DOC_BODY');
    await runTurn('hello', workDir);
    const firstSys = adapter.callLog[0].system;
    expect(firstSys).toMatch(/OLD_DOC_BODY/);

    // Rewrite the file with a different body AND advance mtime so the
    // engine cache invalidates. (Some filesystems coalesce same-second
    // mtimes for back-to-back writes — utimesSync makes the bump explicit.)
    writeFileSync(docPath, 'NEW_DOC_BODY');
    const futureTime = new Date(Date.now() + 60_000);
    utimesSync(docPath, futureTime, futureTime);

    await runTurn('hello again', workDir);
    const secondSys = adapter.callLog[1].system;
    expect(secondSys).toMatch(/NEW_DOC_BODY/);
    expect(secondSys).not.toMatch(/OLD_DOC_BODY/);
  });

  it('picks the newer file when both CLAUDE.md and AGENTS.md exist', async () => {
    const claudePath = join(workDir, 'CLAUDE.md');
    const agentsPath = join(workDir, 'AGENTS.md');
    writeFileSync(claudePath, 'CLAUDE_BODY');
    writeFileSync(agentsPath, 'AGENTS_BODY');
    // AGENTS.md becomes newer.
    utimesSync(claudePath, new Date(1700000000000), new Date(1700000000000));
    utimesSync(agentsPath, new Date(1800000000000), new Date(1800000000000));

    await runTurn('hello', workDir);
    const sysPrompt = adapter.callLog[0].system;
    expect(sysPrompt).toMatch(/AGENTS_BODY/);
    expect(sysPrompt).not.toMatch(/CLAUDE_BODY/);
  });
});
