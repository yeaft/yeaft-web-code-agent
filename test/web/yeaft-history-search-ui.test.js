import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { revealOutlineResult, shouldDismissHistorySearch } from '../../web/utils/message-search-navigation.js';
import { sortHistoryResultsNewest } from '../../web/components/YeaftConversationOutline.js';

const read = path => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');
const page = read('components/YeaftPage.js');
const panel = read('components/YeaftConversationOutline.js');
const actions = read('components/YeaftSessionActions.js');
const list = read('components/MessageList.js');
const virtual = read('components/VirtualTranscript.js');
const navigation = read('utils/message-search-navigation.js');
const store = read('stores/chat.js');
const css = read('styles/yeaft.css');
const modalCss = read('styles/chat-modals.css');
const agent = read('../agent/index.js');
const relay = read('../server/handlers/client-conversation.js');
const agentHandler = read('stores/helpers/handlers/agentHandler.js');
const en = read('i18n/en.js');
const zhCN = read('i18n/zh-CN.js');

const indexOf = (haystack, needle) => haystack.indexOf(needle);

describe('Yeaft conversation outline UI', () => {
  it('uses an explicit search button with a lazy 50-row outline while preserving server search', () => {
    expect(actions).toContain('aria-controls="yeaft-conversation-outline"');
    expect(actions).toContain('<circle cx="11" cy="11" r="7"/>');
    expect(actions).toContain('<path d="m20 20-3.5-3.5"/>');
    expect(actions).toContain(":title=\"$t('yeaft.historySearch.button')\"");
    expect(actions).toContain(":aria-label=\"$t('yeaft.historySearch.button')\"");
    expect(actions).not.toContain('<path d="M4 6h2"/>');
    expect(page).toContain('<YeaftConversationOutline');
    expect(page).toContain("store.searchYeaftHistory('', { senderKey })");
    expect(page).toContain("const DEFAULT_HISTORY_SENDER = 'user'");
    expect(store).toContain("type: 'yeaft_search_history'");
    expect(store).toContain('limit: 20');
    expect(store).toContain('if (!append && previous.loaded && !force) return true');
    expect(page).toContain('historySearchQuery.value = query');
    expect(page).toContain('store.searchYeaftHistory(historySearchQuery.value, { senderKey: store.yeaftHistorySearchState.senderKey })');
    expect(page).toContain('resetHistorySearchState(senderKey)');
    expect(page).toContain('resetHistorySearchState(rememberedHistorySender())');
    expect(store).toContain("type: 'yeaft_search_history'");
  });

  it('keeps a compound-identity page cache and merges live rows without persistent browser storage', () => {
    expect(store).toContain('yeaftHistoryIdentityKey(targetAgentId, targetSessionId)');
    expect(store).toContain('yeaftHistoryOutlineBySession');
    expect(store).toContain('const liveRows = conversationId ? (this.messagesMap[conversationId] || []) : []');
    expect(store).toContain('yeaftHistoryResultIdentity(row)');
    expect(store).not.toContain("localStorage.setItem('yeaft-history-outline");
  });

  it('renders fixed scrollable message history with count, search and bottom paging', () => {
    expect(css).toMatch(/\.yeaft-conversation-outline\s*\{[\s\S]*?position: absolute;[\s\S]*?height: min\(/);
    expect(css).toMatch(/\.yeaft-conversation-outline-list\s*\{[\s\S]*?overflow-y: auto;/);
    expect(panel).toContain("$t('yeaft.outline.title')");
    expect(en).toContain("'yeaft.outline.title': 'Message history'");
    expect(zhCN).toContain("'yeaft.outline.title': '历史消息'");
    expect(panel).toContain('outlineState.totalCount');
    expect(panel).toContain('list.scrollHeight - list.scrollTop - list.clientHeight <= 40');
    expect(indexOf(panel, 'v-for="(result, index) in visibleResults"')).toBeLessThan(indexOf(panel, 'v-if="!isSearching && outlineState.hasMore"'));
    expect(panel).toContain('restoreOlderScroll');
    expect(panel).toContain("$t('yeaft.outline.placeholder')");
    expect(css).toMatch(/\.yeaft-conversation-outline-toolbar\s*\{[\s\S]*?display: flex;[\s\S]*?align-items: center;/);
    expect(panel).not.toContain('ModernSelect');
    expect(panel).not.toContain('sender-options');
    expect(modalCss).toContain('select.modern-select {');
  });

  it('negotiates outline and search support and fails closed for old Agents', () => {
    expect(agent).toContain("'session_history_outline'");
    expect(agent).toContain("'session_history_search'");
    expect(relay).toContain('version: agent.version || null');
    expect(agentHandler).toContain('version: msg.version || null');
    expect(store).toContain("agentHasCapability(this, agentId, 'session_history_outline')");
    expect(store).toContain("error: 'unsupported'");
    expect(panel).toContain("error === 'unsupported'");
  });

  it('supports keyboard discovery and result activation', () => {
    expect(page).toContain("(e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'f'");
    expect(panel).toContain('role="listbox"');
    expect(panel).toContain('role="option"');
    expect(panel).toContain("event.key === 'ArrowDown'");
    expect(panel).toContain("event.key === 'Enter'");
    expect(panel).toContain("event.key === 'Escape'");
  });

  it('dismisses the history dropdown only when a click lands outside the panel, teleported sender menu and trigger', () => {
    const targetIn = selector => ({ closest: vi.fn().mockReturnValue(selector ? {} : null) });

    expect(shouldDismissHistorySearch(targetIn('.yeaft-conversation-outline'))).toBe(false);
    expect(shouldDismissHistorySearch(targetIn('.yeaft-conversation-outline-sender-menu'))).toBe(false);
    expect(shouldDismissHistorySearch(targetIn('.yeaft-search-btn'))).toBe(false);
    expect(shouldDismissHistorySearch(targetIn(''))).toBe(true);
    expect(shouldDismissHistorySearch(null)).toBe(true);
    expect(shouldDismissHistorySearch(targetIn(''), [{ matches: selector => selector.includes('.yeaft-conversation-outline') }])).toBe(false);
    expect(page).toContain("document.addEventListener('click', closeHistorySearchOutside)");
    expect(page).toContain("document.removeEventListener('click', closeHistorySearchOutside)");
  });

  it('uses the existing bounded history window to reveal and flash unloaded messages', () => {
    expect(page).toContain('revealWindow: candidate => store.revealYeaftHistoryResult(candidate, revealLease)');
    expect(page).toContain(".finally(() => store.finishYeaftHistoryReveal?.(revealLease))");
    expect(page).toContain("store.hasCapability('session_history_window_prefetch')");
    expect(panel).toContain("emit('preview', result)");
    expect(store).toContain('_yeaftHistoryWindowPendingByKey');
    expect(store).toContain('if (pendingByKey[pendingKey]?.promise) return pendingByKey[pendingKey].promise');
    expect(store).toContain('buildYeaftMessageTurnSpans(scoped)');
    expect(list).toContain('navigateToPersistedMessage({');
    expect(list).toContain('virtualTranscriptRef.value?.scrollToKey?.(blockId, options)');
    expect(list).toContain('virtualTranscriptRef.value?.anchorTarget?.(blockId, row, options)');
    expect(store).toContain('this.isYeaftMessageCached(pending.sessionId, pending.messageId, conversationId, pending.agentId)');
    expect(store).not.toContain('containsAnchor || revealedInStore');
    expect(virtual).toContain('expose({ scrollToKey, scrollToIndex, anchorTarget, clearTargetAnchor, cancelPendingBottomFollow, setBottomFollowEnabled })');
    expect(css).toContain('@keyframes yeaft-history-search-flash');
  });

  it('closes the full-screen mobile outline only after a successful reveal', async () => {
    const closeOutline = vi.fn();
    const revealMessage = vi.fn().mockResolvedValue(true);

    await expect(revealOutlineResult({
      result: { messageId: 'm42' },
      revealWindow: vi.fn().mockResolvedValue(true),
      nextTick: vi.fn().mockResolvedValue(undefined),
      revealMessage,
      isMobile: true,
      closeOutline,
    })).resolves.toBe(true);

    expect(revealMessage).toHaveBeenCalledWith({ messageId: 'm42' });
    expect(closeOutline).toHaveBeenCalledTimes(1);
  });

  it('keeps the outline open when reveal fails or on desktop', async () => {
    const closeOutline = vi.fn();
    await expect(revealOutlineResult({
      result: { messageId: 'm42' },
      revealWindow: vi.fn().mockResolvedValue(true),
      revealMessage: vi.fn().mockResolvedValue(false),
      isMobile: true,
      closeOutline,
    })).resolves.toBe(false);
    await expect(revealOutlineResult({
      result: { messageId: 'm42' },
      revealWindow: vi.fn().mockResolvedValue(true),
      revealMessage: vi.fn().mockResolvedValue(true),
      isMobile: false,
      closeOutline,
    })).resolves.toBe(true);
    expect(closeOutline).not.toHaveBeenCalled();
  });

  it('orders mixed history rows with one transitive newest-first key', () => {
    const rows = [
      { messageId: 'm1', seq: 1, timestamp: '2026-07-24T10:00:00Z' },
      { messageId: 'm3', seq: 3, timestamp: '2026-07-23T10:00:00Z' },
      { messageId: 'm2', seq: 2 },
    ];
    const permutations = [
      rows,
      [rows[0], rows[2], rows[1]],
      [rows[1], rows[0], rows[2]],
      [rows[1], rows[2], rows[0]],
      [rows[2], rows[0], rows[1]],
      [rows[2], rows[1], rows[0]],
    ];

    for (const input of permutations) {
      expect(sortHistoryResultsNewest(input).map(row => row.messageId)).toEqual(['m3', 'm2', 'm1']);
    }
    expect(panel).toContain('sortHistoryResultsNewest(');
    expect(panel).toContain('isSearching.value ? props.searchState.results : props.outlineState.results');
  });

  it('uses deterministic fallbacks for missing, invalid and tied timestamps', () => {
    const rows = [
      { messageId: 'm4', seq: 4, timestamp: 'invalid' },
      { messageId: 'm5', seq: 5 },
      { messageId: 'm7', seq: 7, timestamp: '2026-07-24T10:00:00Z' },
      { messageId: 'm6', seq: 6, timestamp: '2026-07-24T10:00:00Z' },
      { messageId: 'm8', seq: 8, timestamp: '2026-07-23T10:00:00Z' },
    ];

    expect(sortHistoryResultsNewest(rows).map(row => row.messageId)).toEqual(['m8', 'm7', 'm6', 'm5', 'm4']);
    expect(sortHistoryResultsNewest([
      { messageId: 'm9', seq: 9 },
      { messageId: 'm10', seq: 9 },
    ]).map(row => row.messageId)).toEqual(['m9', 'm10']);
  });

  it('keeps existing rows stable when an older page is appended', () => {
    const recent = [
      { messageId: 'm12', seq: 12, timestamp: '2026-07-24T12:00:00Z' },
      { messageId: 'm11', seq: 11, timestamp: '2026-07-24T11:00:00Z' },
    ];
    const before = sortHistoryResultsNewest(recent).map(row => row.messageId);
    const after = sortHistoryResultsNewest([
      ...recent,
      { messageId: 'm10', seq: 10, timestamp: '2026-07-24T10:00:00Z' },
      { messageId: 'm9', seq: 9, timestamp: 'invalid' },
    ]).map(row => row.messageId);

    expect(before).toEqual(['m12', 'm11']);
    expect(after).toEqual(['m12', 'm11', 'm10', 'm9']);
    expect(after.slice(0, before.length)).toEqual(before);
  });
});
