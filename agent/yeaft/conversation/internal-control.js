/**
 * Internal-control conversation row helpers.
 *
 * Some older transcripts persisted VP-only control prompts without reliable
 * `internal: true` metadata. Treat those legacy content signatures as hidden
 * conversation rows so they never replay into user-visible history or future
 * model context.
 */

export function isInternalControlContent(content) {
  if (typeof content !== 'string') return false;
  const text = content.trimStart();
  return text.startsWith('<task-result ')
    || /^\[system note\] You have called \S+ with the same arguments \d+ times\./.test(text);
}

export function isHiddenConversationRow(row) {
  if (!row) return true;
  if (row._reflection || row.internal || row.systemOnly || row.systemOnlyMessage) return true;
  if (row.kind === 'compact_summary' || row._compactSummary) return true;
  return isInternalControlContent(row.content);
}
