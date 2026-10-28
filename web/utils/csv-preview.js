/** Bounded, read-only CSV projection. Never changes the source or evaluates cells. */
export const CSV_PREVIEW_LIMITS = Object.freeze({ rows: 1000, columns: 100, cellCharacters: 10000, sourceCharacters: 1000000 });

/**
 * Parse comma-separated UTF-8 text with RFC-style quoted fields, escaped quotes,
 * CR/LF/CRLF records, and an optional BOM. Keep only a bounded prefix for display;
 * an incomplete record at the scan boundary is omitted, not reported as malformed.
 * `rows` contains records (including any header); counts never imply the full file.
 */
export function parseCsvPreview(source) {
  const rows = [];
  const limited = { rows: false, columns: false, cell: false, source: false };
  const end = Math.min(source.length, CSV_PREVIEW_LIMITS.sourceCharacters);
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let row = [];
  let cell = '';
  let column = 0;
  let columnCount = 0;
  let quoted = false;
  let afterQuote = false;
  let started = false;
  let fieldStarted = false;
  let cellClipped = false;
  let error = null;

  const append = character => {
    if (column >= CSV_PREVIEW_LIMITS.columns) return;
    if (cell.length < CSV_PREVIEW_LIMITS.cellCharacters) cell += character;
    else { limited.cell = true; cellClipped = true; }
  };
  const finishCell = () => {
    if (column < CSV_PREVIEW_LIMITS.columns) row.push(cell + (cellClipped ? '…' : ''));
    else limited.columns = true;
    column++;
    cell = '';
    cellClipped = false;
    fieldStarted = false;
    afterQuote = false;
  };
  const finishRow = () => {
    finishCell();
    columnCount = Math.max(columnCount, row.length);
    rows.push(row);
    row = [];
    column = 0;
    started = false;
  };

  while (index < end) {
    if (rows.length === CSV_PREVIEW_LIMITS.rows) { limited.rows = true; break; }
    const character = source[index];
    started = true;
    if (quoted) {
      if (character === '"') {
        if (index + 1 < end && source[index + 1] === '"') { append('"'); index += 2; continue; }
        quoted = false;
        afterQuote = true;
      } else append(character);
    } else if (character === ',') {
      finishCell();
    } else if (character === '\r' || character === '\n') {
      finishRow();
      if (character === '\r' && index + 1 < end && source[index + 1] === '\n') index++;
    } else if (character === '"' && !fieldStarted && !afterQuote) {
      quoted = true;
      fieldStarted = true;
    } else if (character === '"' || afterQuote) {
      error = { record: rows.length + 1 };
      break;
    } else {
      append(character);
      fieldStarted = true;
    }
    index++;
  }
  if (!error && !limited.rows) {
    if (end < source.length) limited.source = true;
    else if (quoted) error = { record: rows.length + 1 };
    else if (started) finishRow();
  }
  return { rows, columnCount, limited, error };
}
