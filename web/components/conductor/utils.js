/**
 * Conductor shared utilities.
 * Extracted to avoid duplication across ConductorChatView and ConductorTaskPanel.
 */

/**
 * Minimal markdown → HTML renderer for conductor messages.
 * Handles: bold, inline code, HTML entity escaping, newlines.
 */
export function renderMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}
