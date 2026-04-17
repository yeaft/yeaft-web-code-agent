/**
 * unify-web-bridge-merge.test.js — task-313
 *
 * Structural checks that the web-bridge merge handler does the right
 * things in the right order. We inspect the module source rather than
 * running it live because `handleUnifyMergeThread` touches the
 * module-level `session` state (which requires an initialised engine
 * stack). The assertions cover:
 *   - handler is exported and declared
 *   - router forwards `unify_merge_thread` to the handler
 *   - server forwarder case handles `unify_merge_thread`
 *   - handler calls reassignThread before mergeThread (ordering)
 *   - handler terminates the source engine instance via registry.delete
 *   - both success (`thread_merged`) and failure (`thread_merge_failed`)
 *     events are emitted
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '..', '..');
const bridgeSrc   = readFileSync(join(root, 'agent/unify/web-bridge.js'), 'utf8');
const routerSrc   = readFileSync(join(root, 'agent/connection/message-router.js'), 'utf8');
const serverSrc   = readFileSync(join(root, 'server/handlers/client-conversation.js'), 'utf8');

describe('web-bridge merge handler wiring (task-313)', () => {
  it('exports handleUnifyMergeThread', () => {
    expect(bridgeSrc).toMatch(/export function handleUnifyMergeThread/);
  });

  it('message-router imports and dispatches unify_merge_thread', () => {
    expect(routerSrc).toMatch(/handleUnifyMergeThread/);
    expect(routerSrc).toMatch(/case 'unify_merge_thread'/);
  });

  it('server forwarder recognises unify_merge_thread', () => {
    expect(serverSrc).toMatch(/unify_merge_thread/);
  });

  it('handler reassigns messages BEFORE mutating ThreadStore', () => {
    const body = bridgeSrc.slice(
      bridgeSrc.indexOf('export function handleUnifyMergeThread'),
      bridgeSrc.indexOf('export function handleUnifyMergeThread') + 1500,
    );
    const reassignAt = body.indexOf('reassignThread(');
    const mergeAt    = body.indexOf('mergeThread(');
    expect(reassignAt).toBeGreaterThan(-1);
    expect(mergeAt).toBeGreaterThan(-1);
    expect(reassignAt).toBeLessThan(mergeAt);
  });

  it('handler terminates the source engine via registry.delete', () => {
    const body = bridgeSrc.slice(
      bridgeSrc.indexOf('export function handleUnifyMergeThread'),
      bridgeSrc.indexOf('export function handleUnifyMergeThread') + 1500,
    );
    expect(body).toMatch(/engineRegistry\.delete\(sourceId\)/);
  });

  it('handler broadcasts thread_merged on success and thread_merge_failed on error', () => {
    expect(bridgeSrc).toMatch(/type:\s*'thread_merged'/);
    expect(bridgeSrc).toMatch(/type:\s*'thread_merge_failed'/);
  });

  it('handler calls sendThreadListUpdate after merge', () => {
    const body = bridgeSrc.slice(
      bridgeSrc.indexOf('export function handleUnifyMergeThread'),
      bridgeSrc.indexOf('export function handleUnifyMergeThread') + 3000,
    );
    expect(body).toMatch(/sendThreadListUpdate\(\)/);
  });
});
