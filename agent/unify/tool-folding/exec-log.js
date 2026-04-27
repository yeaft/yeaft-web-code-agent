/**
 * exec-log.js — Persistent tool execution log used by the reflection
 * subsystem (PR-L).
 *
 * Two purposes:
 *   1. Source of fallback-stub when T2 reflection isn't ready in time.
 *   2. Duplicate-call detection — count how many times the SAME
 *      (toolName, argsHash) pair has been executed in the current turn
 *      plus the last two turns, so the engine can inject a reminder when
 *      the model is stuck in a loop.
 *
 * Storage layout (only when yeaftDir is configured):
 *   <yeaftDir>/tool-log/<conversationId>/<turnIdx>.jsonl
 *
 * One JSON object per line:
 *   { loopIdx, toolName, argsHash, argsBrief, resultBrief,
 *     resultBytes, resultStatus, timestamp }
 *
 * If yeaftDir is absent, the log is held in memory only.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const ARGS_BRIEF_CAP = 200;
const RESULT_BRIEF_CAP = 500;

/**
 * Canonical-JSON-stringify and hash. Stable across key ordering so identical
 * args produce identical hashes regardless of how the LLM serialised them.
 *
 * @param {any} args
 * @returns {string} 16 hex chars
 */
export function argsHashOf(args) {
  let canon;
  try {
    canon = canonicalStringify(args);
  } catch {
    canon = String(args);
  }
  return createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

function brief(value, cap) {
  let s;
  if (typeof value === 'string') s = value;
  else {
    try { s = JSON.stringify(value); } catch { s = String(value); }
  }
  if (s == null) s = '';
  if (s.length <= cap) return s;
  return s.slice(0, cap) + '…';
}

/**
 * Build a single exec-log entry from a tool execution result.
 *
 * @param {{ loopIdx: number, toolName: string, args: any, output: any, isError: boolean }} p
 * @returns {object}
 */
export function buildEntry({ loopIdx, toolName, args, output, isError }) {
  const argsBrief = brief(args, ARGS_BRIEF_CAP);
  const resultBrief = brief(output, RESULT_BRIEF_CAP);
  const resultBytes = typeof output === 'string'
    ? Buffer.byteLength(output, 'utf8')
    : Buffer.byteLength(brief(output, 1_000_000), 'utf8');
  return {
    loopIdx,
    toolName,
    argsHash: argsHashOf(args),
    argsBrief,
    resultBrief,
    resultBytes,
    resultStatus: isError ? 'error' : 'ok',
    timestamp: Date.now(),
  };
}

/**
 * ExecLog — manages append + read for one Engine instance. Tracks turns in
 * memory and (if yeaftDir is configured) mirrors them to disk as JSONL.
 */
export class ExecLog {
  /**
   * @param {{ yeaftDir?: string|null, conversationId?: string|null }} opts
   */
  constructor({ yeaftDir = null, conversationId = null } = {}) {
    this.yeaftDir = yeaftDir || null;
    this.conversationId = conversationId || 'default';
    /** @type {Map<number, object[]>} */
    this.turns = new Map();
  }

  /** Path for a turn's jsonl file (or null if persistence is disabled). */
  pathFor(turnIdx) {
    if (!this.yeaftDir) return null;
    return path.join(this.yeaftDir, 'tool-log', this.conversationId, `${turnIdx}.jsonl`);
  }

  /** Append an entry to a given turn's log. */
  append(turnIdx, entry) {
    let arr = this.turns.get(turnIdx);
    if (!arr) { arr = []; this.turns.set(turnIdx, arr); }
    arr.push(entry);
    const p = this.pathFor(turnIdx);
    if (p) {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8');
      } catch {
        // Best-effort persistence — never break the engine on disk failure.
      }
    }
  }

  /** Read all entries for a turn (memory first; disk on cold-start). */
  readTurn(turnIdx) {
    const mem = this.turns.get(turnIdx);
    if (mem) return mem.slice();
    const p = this.pathFor(turnIdx);
    if (!p) return [];
    try {
      const txt = fs.readFileSync(p, 'utf8');
      const out = [];
      for (const line of txt.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { out.push(JSON.parse(t)); } catch { /* skip bad line */ }
      }
      this.turns.set(turnIdx, out.slice());
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Count exact duplicates of (toolName, argsHash) across the current turn
   * plus the previous N turns.
   *
   * @param {{ toolName: string, argsHash: string, currentTurn: number, lookbackTurns?: number }} q
   * @returns {number}
   */
  dupCount({ toolName, argsHash, currentTurn, lookbackTurns = 2 }) {
    let count = 0;
    let lastBrief = '';
    for (let t = Math.max(0, currentTurn - lookbackTurns); t <= currentTurn; t += 1) {
      for (const e of this.readTurn(t)) {
        if (e.toolName === toolName && e.argsHash === argsHash) {
          count += 1;
          lastBrief = e.resultBrief || lastBrief;
        }
      }
    }
    return count;
  }

  /**
   * Like dupCount but also returns the most-recent matching resultBrief
   * (used to compose the duplicate reminder).
   *
   * @returns {{ count: number, lastResultBrief: string }}
   */
  dupInfo({ toolName, argsHash, currentTurn, lookbackTurns = 2 }) {
    let count = 0;
    let lastBrief = '';
    for (let t = Math.max(0, currentTurn - lookbackTurns); t <= currentTurn; t += 1) {
      for (const e of this.readTurn(t)) {
        if (e.toolName === toolName && e.argsHash === argsHash) {
          count += 1;
          lastBrief = e.resultBrief || lastBrief;
        }
      }
    }
    return { count, lastResultBrief: lastBrief };
  }
}
