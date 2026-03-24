import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { buildTurns } from '../../web/components/crew/crewMessageGrouping.js';

/**
 * Tests for PR #316 — Fix XML/HTML tags being swallowed in Crew user messages.
 *
 * Bug: In Crew chat, user (human) messages containing XML/HTML tags like
 * `<key>Label</key>` were rendered via `v-html="mdRender(...)"`, causing
 * browsers to parse `<key>` as an unknown HTML element and hide it.
 *
 * Fix: Human messages now use Vue `{{ }}` text interpolation (auto-escapes HTML),
 * while AI/role messages continue using markdown rendering via `v-html`.
 *
 * Validates:
 * 1. CrewTurnRenderer template has a separate branch for human text messages
 *    using `{{ }}` instead of `v-html`
 * 2. AI/role text messages still use `v-html="mdRender(...)"`
 * 3. CSS `.user-text-content` class exists with correct properties
 * 4. The human branch appears BEFORE the general text branch (Vue v-else-if order matters)
 * 5. buildTurns correctly separates human messages from role turn groups
 * 6. MessageItem.js (normal chat) remains unaffected — uses `{{ }}` for content
 */

const base = resolve(__dirname, '../..');

// =====================================================================
// 1. CrewTurnRenderer template: human messages use {{ }} text interpolation
// =====================================================================

describe('CrewTurnRenderer: human message rendering branch', () => {
  const src = readFileSync(
    resolve(base, 'web/components/crew/CrewTurnRenderer.js'),
    'utf-8'
  );

  it('has a v-else-if branch for human text messages with {{ }} interpolation', () => {
    // The fix adds: <div v-else-if="turn.message.type === 'text' && turn.message.role === 'human'" class="crew-msg-content user-text-content">{{ turn.message.content }}</div>
    expect(src).toContain("turn.message.type === 'text' && turn.message.role === 'human'");
    expect(src).toContain('user-text-content');
    // Must use {{ }} text interpolation, NOT v-html
    expect(src).toMatch(/user-text-content[^>]*>\{\{\s*turn\.message\.content\s*\}\}/);
  });

  it('human branch does NOT use v-html', () => {
    // Extract the line with user-text-content
    const lines = src.split('\n');
    const humanLine = lines.find(l => l.includes('user-text-content'));
    expect(humanLine).toBeDefined();
    expect(humanLine).not.toContain('v-html');
  });

  it('AI/role text messages still use v-html with mdRender', () => {
    // The original line should still exist for non-human text messages
    expect(src).toMatch(
      /v-else-if="turn\.message\.type === 'text'"[^>]*v-html="mdRender\(turn\.message\.content\)"/
    );
  });

  it('human branch appears BEFORE general text branch (v-else-if order)', () => {
    const humanIdx = src.indexOf("turn.message.type === 'text' && turn.message.role === 'human'");
    const generalIdx = src.indexOf('v-else-if="turn.message.type === \'text\'"');
    expect(humanIdx).toBeGreaterThan(-1);
    expect(generalIdx).toBeGreaterThan(-1);
    // Human-specific branch must come first so Vue evaluates it before the catch-all
    expect(humanIdx).toBeLessThan(generalIdx);
  });
});

// =====================================================================
// 2. CSS: .user-text-content class
// =====================================================================

describe('CSS: .user-text-content styling', () => {
  const css = readFileSync(
    resolve(base, 'web/styles/crew-workspace.css'),
    'utf-8'
  );

  it('.user-text-content class exists', () => {
    expect(css).toContain('.user-text-content');
  });

  it('.user-text-content has white-space: pre-wrap', () => {
    // Extract the rule block
    const match = css.match(/\.crew-msg-content\.user-text-content\s*\{([^}]+)\}/);
    expect(match).toBeTruthy();
    const ruleBody = match[1];
    expect(ruleBody).toContain('white-space: pre-wrap');
  });

  it('.user-text-content has word-break: break-word', () => {
    const match = css.match(/\.crew-msg-content\.user-text-content\s*\{([^}]+)\}/);
    expect(match).toBeTruthy();
    const ruleBody = match[1];
    expect(ruleBody).toContain('word-break: break-word');
  });
});

// =====================================================================
// 3. buildTurns: human messages are standalone, not in turn groups
// =====================================================================

describe('buildTurns: human message isolation', () => {

  it('human messages produce standalone turn with type "text", not "turn"', () => {
    const messages = [
      { id: 1, role: 'human', type: 'text', content: '<key>Label</key>' }
    ];
    const turns = buildTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].type).toBe('text');
    expect(turns[0].message.role).toBe('human');
    expect(turns[0].message.content).toBe('<key>Label</key>');
  });

  it('human messages are NOT grouped with adjacent role messages', () => {
    const messages = [
      { id: 1, role: 'assistant', type: 'text', content: 'Hello' },
      { id: 2, role: 'human', type: 'text', content: '<dict><key>Name</key></dict>' },
      { id: 3, role: 'assistant', type: 'text', content: 'Got it' }
    ];
    const turns = buildTurns(messages);
    // Should be 3 separate turns: role turn-group, human standalone, role turn-group
    expect(turns).toHaveLength(3);
    expect(turns[0].type).toBe('turn');       // assistant grouped turn
    expect(turns[1].type).toBe('text');        // human standalone
    expect(turns[1].message.role).toBe('human');
    expect(turns[2].type).toBe('turn');       // assistant grouped turn
  });

  it('human message content preserves XML tags verbatim', () => {
    const xmlContent = `<?xml version="1.0"?>
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.example.agent</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/node</string>
    </array>
  </dict>
</plist>`;
    const messages = [
      { id: 1, role: 'human', type: 'text', content: xmlContent }
    ];
    const turns = buildTurns(messages);
    // Content should be preserved exactly as-is (no transformation)
    expect(turns[0].message.content).toBe(xmlContent);
  });
});

// =====================================================================
// 4. MessageItem.js (normal chat): unaffected by this change
// =====================================================================

describe('MessageItem.js: normal chat uses {{ }} for user content (unaffected)', () => {
  const src = readFileSync(
    resolve(base, 'web/components/MessageItem.js'),
    'utf-8'
  );

  it('user message content uses {{ }} text interpolation', () => {
    // MessageItem uses: <div class="message-content">{{ message.content }}</div>
    expect(src).toMatch(/class="message-content"[^>]*>\{\{\s*message\.content\s*\}\}/);
  });

  it('does NOT use v-html for user message content', () => {
    // Ensure MessageItem never uses v-html for the primary content display
    const userTemplate = src.match(
      /v-if="message\.type === 'user'"[\s\S]*?<\/template>/
    );
    if (userTemplate) {
      expect(userTemplate[0]).not.toContain('v-html');
    }
  });
});

// =====================================================================
// 5. Turn-group (type === 'turn') does not include human messages
// =====================================================================

describe('turn-group template: only renders AI/role messages via v-html', () => {
  const src = readFileSync(
    resolve(base, 'web/components/crew/CrewTurnRenderer.js'),
    'utf-8'
  );

  it('turn-group textMsg uses v-html for markdown rendering', () => {
    // In the v-else (turn.type === 'turn') branch, textMsg is rendered with v-html
    expect(src).toMatch(/turn\.textMsg[\s\S]*?v-html="mdRender\(turn\.textMsg\.content\)"/);
  });

  it('turn-group only contains non-human roles (verified by buildTurns logic)', () => {
    const messages = [
      { id: 1, role: 'human', type: 'text', content: '<key>val</key>' },
      { id: 2, role: 'pm', type: 'text', content: 'Reviewing...' },
      { id: 3, role: 'pm', type: 'tool', content: 'tool output', toolName: 'Read' },
      { id: 4, role: 'human', type: 'text', content: '<string>test</string>' }
    ];
    const turns = buildTurns(messages);
    // Human messages should never be in a 'turn' type group
    const turnGroups = turns.filter(t => t.type === 'turn');
    for (const tg of turnGroups) {
      const msgs = tg.messages || [];
      for (const m of msgs) {
        expect(m.role).not.toBe('human');
      }
    }
  });
});
