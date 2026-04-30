#!/usr/bin/env node
/**
 * agent/scripts/check-pty.js — postinstall sanity check for node-pty.
 *
 * Why this exists:
 *   `node-pty` is an optionalDependency. npm install swallows install
 *   failures silently — when the native module fails to build (e.g.
 *   Linux x64, where node-pty's tarball ships no prebuilds and the
 *   host g++ is too old to compile C++20), the agent loses its
 *   `terminal` capability with zero user-facing signal. The web UI's
 *   Terminal tab silently disappears.
 *
 *   This postinstall script makes that failure visible: if we're on a
 *   platform where node-pty was supposed to install but didn't, print
 *   a clear warning with the recovery command. We never fail the
 *   install — pty is genuinely optional, and required-feature mode
 *   would block users who don't need a Terminal tab.
 *
 * Exit code is always 0 — we only print, never abort.
 */

import { existsSync } from 'fs';
import { createRequire } from 'module';
import { platform } from 'os';

const require = createRequire(import.meta.url);

function tryResolveNodePty() {
  try {
    return require.resolve('node-pty');
  } catch {
    return null;
  }
}

function tryLoadBinary() {
  // node-pty's lib/index.js does `require('../build/Release/pty.node')`
  // — if the binary is missing or ABI-incompatible, that throws. We
  // mimic the load eagerly so the warning fires at install time, not
  // at agent startup.
  try {
    require('node-pty');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const resolved = tryResolveNodePty();
if (!resolved) {
  // node-pty was never installed at all — npm skipped it for the
  // current platform/engine combination.
  const plat = platform();
  if (plat === 'linux' || plat === 'darwin' || plat === 'win32') {
    console.warn('');
    console.warn('  ⚠  node-pty was not installed on this host.');
    console.warn('     The agent will run, but the web UI Terminal tab');
    console.warn('     will be hidden (terminal capability missing).');
    if (plat === 'linux') {
      console.warn('');
      console.warn('     Linux fix: install a C++20-capable compiler');
      console.warn('     (g++-10 or newer) and rebuild:');
      console.warn('');
      console.warn('       sudo apt-get install -y g++-10');
      console.warn('       CXX=g++-10 npm install node-pty --include=optional');
    } else {
      console.warn('');
      console.warn('     Reinstall to retry:  npm install node-pty');
    }
    console.warn('');
  }
  process.exit(0);
}

const loaded = tryLoadBinary();
if (!loaded.ok) {
  console.warn('');
  console.warn('  ⚠  node-pty resolved but failed to load native binary.');
  console.warn(`     Error: ${loaded.error}`);
  console.warn('     The agent will run without Terminal tab support.');
  console.warn('     Recover: npm rebuild node-pty');
  console.warn('');
  process.exit(0);
}

// Silent on success — clean install output.
process.exit(0);
