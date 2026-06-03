/**
 * feature-flag.js — Reads `config.yeaft.multiVp.enabled` from ~/.yeaft/config.json.
 *
 * Per architecture §11: multi-VP group mode is opt-in for MVP. The flag
 * gates UI entry points and (later) migration. This module returns a plain
 * boolean and never throws — missing/corrupt config falls back to `false`.
 *
 * A second helper `setMultiVpEnabled(dir, enabled)` writes through via
 * writeAtomic so tests and future settings UI can toggle it.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { writeAtomic } from '../storage/index.js';

const CONFIG_FILE = 'config.json';
const FLAG_PATH = ['yeaft', 'multiVp', 'enabled'];

function readConfig(yeaftDir) {
  const path = join(yeaftDir, CONFIG_FILE);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function isMultiVpEnabled(yeaftDir) {
  const cfg = readConfig(yeaftDir);
  let cur = cfg;
  for (const seg of FLAG_PATH) {
    if (!cur || typeof cur !== 'object') return false;
    cur = cur[seg];
  }
  return Boolean(cur);
}

export function setMultiVpEnabled(yeaftDir, enabled) {
  const cfg = readConfig(yeaftDir);
  let cur = cfg;
  for (let i = 0; i < FLAG_PATH.length - 1; i++) {
    const seg = FLAG_PATH[i];
    if (!cur[seg] || typeof cur[seg] !== 'object') cur[seg] = {};
    cur = cur[seg];
  }
  cur[FLAG_PATH[FLAG_PATH.length - 1]] = Boolean(enabled);
  writeAtomic(join(yeaftDir, CONFIG_FILE), JSON.stringify(cfg, null, 2));
}
