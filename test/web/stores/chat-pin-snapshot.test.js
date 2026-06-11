/**
 * chat-pin-snapshot.test.js — coverage for chatStore.applyServerPinSnapshot
 * (fix-yeaft-session-list-and-menu, Fix 3e).
 *
 * `applyServerPinSnapshot` is the single owner of `pinnedSessions`
 * mutation when a server-decorated session snapshot arrives. The
 * yeaft sessions store delegates to this method; the test exercises
 * the canonical method body extracted from `web/stores/chat.js` so
 * the contract stays honest to production source.
 *
 * Why source extraction over a full Pinia mount: `chat.js` pulls in
 * a large helper graph (websocket, watchdog, message handlers...)
 * that drags too much surface area into a unit test. The method body
 * we care about is ~25 lines of pure logic against `this.pinnedSessions`,
 * easy to bind to a mock `this`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const chatPath = resolve(__dirname, '../../../web/stores/chat.js');
const chatSrc = readFileSync(chatPath, 'utf-8');

// Brace-counting method extractor (same approach as the YeaftSidebar
// test) — robust to reformatting as long as the body's braces balance.
function extractMethod(name) {
  const sigRe = new RegExp(`(?:^|[\\s,])${name}\\(([^)]*)\\)\\s*\\{`, 'm');
  const sigMatch = chatSrc.match(sigRe);
  if (!sigMatch) throw new Error(`method ${name} not found in chat.js`);
  const params = sigMatch[1];
  const bodyStart = sigMatch.index + sigMatch[0].length;
  let depth = 1;
  let i = bodyStart;
  while (i < chatSrc.length && depth > 0) {
    const ch = chatSrc[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < chatSrc.length && chatSrc[i] !== quote) {
        if (chatSrc[i] === '\\') i += 2;
        else i++;
      }
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error(`method ${name}: unbalanced braces in chat.js`);
  const body = chatSrc.slice(bodyStart, i - 1);
  // eslint-disable-next-line no-new-func
  return new Function(params, body);
}

// Stand-in for window.localStorage so the body's setItem call works.
let lastWritten;
beforeEach(() => {
  lastWritten = null;
  globalThis.localStorage = {
    setItem: (k, v) => { lastWritten = { k, v }; },
    getItem: () => null,
    removeItem: () => {},
  };
});

describe('chatStore.applyServerPinSnapshot', () => {
  const fn = extractMethod('applyServerPinSnapshot');

  it('adds snapshot pinned ids that the store hasn\'t recorded yet (unshift order)', () => {
    const ctx = { pinnedSessions: ['existing'] };
    fn.call(ctx, 'agent_a', new Set(['s1', 's2']), () => false);
    expect(ctx.pinnedSessions).toEqual(['s1', 's2', 'existing']);
  });

  it('removes ids owned by this agent that are no longer pinned in the snapshot', () => {
    const ownership = new Set(['s1', 's2']);
    const ctx = { pinnedSessions: ['s1', 's2', 'foreign'] };
    // s1 still pinned, s2 unpinned by server, "foreign" not owned → kept
    fn.call(ctx, 'agent_a', new Set(['s1']), (id) => ownership.has(id));
    expect(ctx.pinnedSessions).toEqual(['s1', 'foreign']);
  });

  it('does NOT remove cross-agent pins when isOwnedByAgent returns false', () => {
    const ctx = { pinnedSessions: ['agent_b_pin'] };
    fn.call(ctx, 'agent_a', new Set(), () => false); // never owned by us
    expect(ctx.pinnedSessions).toEqual(['agent_b_pin']);
  });

  it('persists the updated array to localStorage', () => {
    const ctx = { pinnedSessions: [] };
    fn.call(ctx, 'agent_a', new Set(['s1']), () => true);
    expect(lastWritten).toEqual({ k: 'pinned-sessions', v: JSON.stringify(['s1']) });
  });

  it('no-ops on missing pinnedSessions array', () => {
    const ctx = { pinnedSessions: null };
    expect(() => fn.call(ctx, 'agent_a', new Set(['s1']), () => true)).not.toThrow();
    expect(ctx.pinnedSessions).toBe(null);
  });

  it('no-op (no removal pass) when agentId is null — falsy guard', () => {
    const ctx = { pinnedSessions: ['stale_agent_pin'] };
    // Even though the snapshot is empty, the lack of agentId means we
    // can't decide which ids the snapshot is authoritative over.
    fn.call(ctx, null, new Set(), () => true);
    expect(ctx.pinnedSessions).toEqual(['stale_agent_pin']);
  });

  it('idempotent: same snapshot twice = same array', () => {
    const ctx = { pinnedSessions: [] };
    const ownership = new Set(['s1']);
    fn.call(ctx, 'agent_a', new Set(['s1']), (id) => ownership.has(id));
    const after1 = [...ctx.pinnedSessions];
    fn.call(ctx, 'agent_a', new Set(['s1']), (id) => ownership.has(id));
    expect(ctx.pinnedSessions).toEqual(after1);
  });
});
