import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { sortSessionsByActivity } from '../../../web/stores/helpers/session-order.js';

const CHAT_PAGE_SOURCE = readFileSync(
  new URL('../../../web/components/ChatPage.js', import.meta.url),
  'utf8',
);

function ids(rows) {
  return rows.map(row => row.id);
}

describe('stable Session list ordering', () => {
  it('sorts by real activity timestamps descending with deterministic ties', () => {
    const rows = sortSessionsByActivity([
      { id: 's-created', createdAt: '2026-06-01T10:00:00Z' },
      { id: 's-updated', updatedAt: '2026-06-01T12:00:00Z' },
      { id: 's-message', lastMessageAt: '2026-06-01T11:00:00Z' },
      { id: 's-a', updatedAt: 1 },
      { id: 's-b', updatedAt: 1 },
    ]);

    expect(ids(rows)).toEqual(['s-updated', 's-message', 's-created', 's-a', 's-b']);
  });

  it('keeps Chat pinned and non-pinned rows on activity sorting, not pin click order', () => {
    expect(CHAT_PAGE_SOURCE).toContain("import { sortSessionsByActivity } from '../stores/helpers/session-order.js';");
    expect(CHAT_PAGE_SOURCE).toContain('pinnedChatConversations()');
    expect(CHAT_PAGE_SOURCE).toContain('return this.sortByActivity(pinned);');
    expect(CHAT_PAGE_SOURCE).not.toContain('this.store.pinnedSessions.indexOf(a.id) - this.store.pinnedSessions.indexOf(b.id)');
  });
});
