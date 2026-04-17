/**
 * unify-web-bridge-fork.test.js — task-314
 *
 * Structural checks that the fork-from-message wiring is in place:
 *   - handler is exported from web-bridge
 *   - message-router imports & dispatches `unify_fork_thread`
 *   - server forwarder recognises `unify_fork_thread`
 *   - handler calls forkThread BEFORE copyThreadUpTo (new thread must
 *     exist before messages are copied into it)
 *   - handler emits both thread_forked (success) and thread_fork_failed
 *     (error) events, and re-broadcasts the thread list.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '..', '..');
const bridgeSrc = readFileSync(join(root, 'agent/unify/web-bridge.js'), 'utf8');
const routerSrc = readFileSync(join(root, 'agent/connection/message-router.js'), 'utf8');
const serverSrc = readFileSync(join(root, 'server/handlers/client-conversation.js'), 'utf8');

describe('web-bridge fork handler wiring (task-314)', () => {
  it('exports handleUnifyForkThread', () => {
    expect(bridgeSrc).toMatch(/export function handleUnifyForkThread/);
  });

  it('message-router imports and dispatches unify_fork_thread', () => {
    expect(routerSrc).toMatch(/handleUnifyForkThread/);
    expect(routerSrc).toMatch(/case 'unify_fork_thread'/);
  });

  it('server forwarder recognises unify_fork_thread', () => {
    expect(serverSrc).toMatch(/unify_fork_thread/);
  });

  it('handler calls forkThread BEFORE copyThreadUpTo (thread must exist first)', () => {
    const start = bridgeSrc.indexOf('export function handleUnifyForkThread');
    expect(start).toBeGreaterThan(-1);
    const body = bridgeSrc.slice(start, start + 2500);
    const forkAt = body.indexOf('forkThread(');
    const copyAt = body.indexOf('copyThreadUpTo(');
    expect(forkAt).toBeGreaterThan(-1);
    expect(copyAt).toBeGreaterThan(-1);
    expect(forkAt).toBeLessThan(copyAt);
  });

  it('handler emits thread_forked on success and thread_fork_failed on error', () => {
    expect(bridgeSrc).toMatch(/type:\s*'thread_forked'/);
    expect(bridgeSrc).toMatch(/type:\s*'thread_fork_failed'/);
  });

  it('handler broadcasts thread list after forking', () => {
    const start = bridgeSrc.indexOf('export function handleUnifyForkThread');
    const body = bridgeSrc.slice(start, start + 3000);
    expect(body).toMatch(/sendThreadListUpdate\(\)/);
  });
});
