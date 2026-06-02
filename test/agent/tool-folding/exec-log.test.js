/**
 * exec-log.test.js — PR-L V7 reflection persistent log.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ExecLog, buildEntry, argsHashOf } from '../../../agent/yeaft/tool-folding/exec-log.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exec-log-'));
}

describe('argsHashOf', () => {
  it('returns the same 16-hex hash regardless of key order', () => {
    const a = argsHashOf({ foo: 1, bar: [2, 3], nested: { x: 'y' } });
    const b = argsHashOf({ nested: { x: 'y' }, bar: [2, 3], foo: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('ExecLog append + readTurn', () => {
  it('round-trips an entry through memory and persists to jsonl', () => {
    const dir = tmpDir();
    const log = new ExecLog({ yeaftDir: dir, conversationId: 'conv1' });
    const e = buildEntry({ loopIdx: 0, toolName: 'bash', args: { cmd: 'ls' }, output: 'a\nb', isError: false });
    log.append(3, e);

    const back = log.readTurn(3);
    expect(back).toHaveLength(1);
    expect(back[0].toolName).toBe('bash');
    expect(back[0].argsHash).toMatch(/^[0-9a-f]{16}$/);
    expect(back[0].resultStatus).toBe('ok');

    // jsonl file exists
    const p = path.join(dir, 'tool-log', 'conv1', '3.jsonl');
    expect(fs.existsSync(p)).toBe(true);
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).toolName).toBe('bash');
  });

  it('works without yeaftDir (memory only)', () => {
    const log = new ExecLog({});
    log.append(0, buildEntry({ loopIdx: 0, toolName: 't', args: {}, output: 'ok', isError: false }));
    expect(log.readTurn(0)).toHaveLength(1);
    expect(log.pathFor(0)).toBeNull();
  });
});

describe('ExecLog dupCount / dupInfo', () => {
  it('counts identical (toolName, argsHash) calls across last 2 turns + current', () => {
    const log = new ExecLog({});
    const args = { path: '/etc/hosts' };
    for (const turn of [1, 2, 3]) {
      log.append(turn, buildEntry({ loopIdx: 0, toolName: 'read', args, output: 'X', isError: false }));
    }
    const info = log.dupInfo({
      toolName: 'read', argsHash: argsHashOf(args), currentTurn: 3, lookbackTurns: 2,
    });
    expect(info.count).toBe(3);
    expect(info.lastResultBrief).toBe('X');
  });

  it('does not count older turns outside the lookback window', () => {
    const log = new ExecLog({});
    const args = { x: 1 };
    log.append(0, buildEntry({ loopIdx: 0, toolName: 'r', args, output: 'a', isError: false }));
    log.append(1, buildEntry({ loopIdx: 0, toolName: 'r', args, output: 'b', isError: false }));
    log.append(5, buildEntry({ loopIdx: 0, toolName: 'r', args, output: 'c', isError: false }));
    const info = log.dupInfo({
      toolName: 'r', argsHash: argsHashOf(args), currentTurn: 5, lookbackTurns: 2,
    });
    expect(info.count).toBe(1);
  });
});
