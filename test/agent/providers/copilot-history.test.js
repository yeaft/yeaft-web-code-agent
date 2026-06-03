import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { listFolders, listSessions, loadHistory, _resetCopilotDbHandle } from '../../../agent/providers/copilot.js';

let tmpDir;
let dbPath;

function seedDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT,
      summary TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER,
      user_message TEXT, assistant_response TEXT, timestamp TEXT
    );
    CREATE TABLE forge_trajectory_events (
      id INTEGER PRIMARY KEY, session_id TEXT, tool_call_id TEXT,
      turn_index INTEGER, event_type TEXT, command TEXT, output TEXT,
      exit_code INTEGER, event_key TEXT, event_value TEXT, created_at TEXT
    );
  `);
  db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'sess-a', '/repo/foo', 'org/foo', 'github', 'main',
    'Greeting session', '2026-06-01T10:00:00Z', '2026-06-01T10:05:00Z'
  );
  db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'sess-b', '/repo/foo', 'org/foo', 'github', 'main',
    null, '2026-06-02T09:00:00Z', '2026-06-02T09:30:00Z'
  );
  db.prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'sess-c', '/repo/bar', 'org/bar', 'github', 'main',
    'Bar work', '2026-05-30T00:00:00Z', '2026-05-30T01:00:00Z'
  );
  db.prepare(`INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, ?, ?, ?, ?)`).run(
    'sess-a', 0, 'hello there', 'hi back', '2026-06-01T10:00:01Z'
  );
  db.prepare(`INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, ?, ?, ?, ?)`).run(
    'sess-a', 1, 'run ls', 'done', '2026-06-01T10:01:00Z'
  );
  db.prepare(`INSERT INTO forge_trajectory_events (session_id, tool_call_id, turn_index, event_type, command, output, exit_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'sess-a', 'call-1', 1, 'BashTool', 'ls', 'file.txt', 0, '2026-06-01T10:00:30Z'
  );
  db.prepare(`INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, ?, ?, ?, ?)`).run(
    'sess-b', 0, 'another conversation start', '', '2026-06-02T09:00:01Z'
  );
  db.close();
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'copilot-test-'));
  dbPath = join(tmpDir, 'session-store.db');
  seedDb(dbPath);
  process.env.COPILOT_DB_PATH = dbPath;
});

afterAll(() => {
  delete process.env.COPILOT_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('copilot history surface', () => {
  it('listFolders groups by cwd with counts and lastModified', async () => {
    const folders = await listFolders();
    expect(folders).toHaveLength(2);
    expect(folders[0].path).toBe('/repo/foo'); // more recent
    expect(folders[0].sessionCount).toBe(2);
    expect(folders[0].lastModified).toBeGreaterThan(folders[1].lastModified);
    expect(folders[1].path).toBe('/repo/bar');
    expect(folders[1].sessionCount).toBe(1);
  });

  it('listSessions returns sessions for a cwd, summary > preview > id for title', async () => {
    const sessions = await listSessions('/repo/foo');
    expect(sessions).toHaveLength(2);
    // sess-b is more recent (updated_at 09:30 vs 10:05 — but 06-02 > 06-01)
    expect(sessions[0].sessionId).toBe('sess-b');
    // sess-b has null summary, uses first user_message as title
    expect(sessions[0].title).toBe('another conversation start');
    expect(sessions[1].sessionId).toBe('sess-a');
    expect(sessions[1].title).toBe('Greeting session');
  });

  it('loadHistory emits user/assistant/tool_use/tool_result envelopes in turn order', async () => {
    const msgs = await loadHistory('/repo/foo', 'sess-a');
    // Turn 0: user "hello there", assistant "hi back"
    // Turn 1: user "run ls", tool_use BashTool, tool_result, assistant "done"
    expect(msgs.length).toBe(6);
    expect(msgs[0].type).toBe('user');
    expect(msgs[0].message.content[0].text).toBe('hello there');
    expect(msgs[1].type).toBe('assistant');
    expect(msgs[1].message.content[0].text).toBe('hi back');
    expect(msgs[2].type).toBe('user');
    expect(msgs[2].message.content[0].text).toBe('run ls');
    expect(msgs[3].type).toBe('assistant');
    expect(msgs[3].message.content[0].type).toBe('tool_use');
    expect(msgs[3].message.content[0].name).toBe('BashTool');
    expect(msgs[3].message.content[0].id).toBe('call-1');
    expect(msgs[4].type).toBe('user');
    expect(msgs[4].message.content[0].type).toBe('tool_result');
    expect(msgs[4].message.content[0].tool_use_id).toBe('call-1');
    expect(msgs[4].message.content[0].content).toBe('file.txt');
    expect(msgs[5].type).toBe('assistant');
    expect(msgs[5].message.content[0].text).toBe('done');
  });

  it('loadHistory returns [] for unknown session', async () => {
    const msgs = await loadHistory('/repo/foo', 'does-not-exist');
    expect(msgs).toEqual([]);
  });
});
