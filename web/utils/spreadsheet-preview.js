/** Bounded, text-only Excel projection. Runs in a disposable worker, never evaluates formulas. */
export const SPREADSHEET_PREVIEW_LIMITS = Object.freeze({
  bytes: 20 * 1024 * 1024, sheets: 100, rows: 1000, columns: 100,
  cellCharacters: 10000, characters: 1000000, timeoutMs: 15000,
});

export function spreadsheetColumn(index) {
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label;
  return label;
}

export function readSpreadsheetNames(XLSX, buffer) {
  if (!buffer?.byteLength || buffer.byteLength > SPREADSHEET_PREVIEW_LIMITS.bytes) throw new Error('size');
  const signature = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  const matches = bytes => bytes.every((value, i) => signature[i] === value);
  // SheetJS otherwise auto-detects arbitrary text (even corrupt binary) as CSV.
  const isBiff = signature[0] === 0x09 && [0x00, 0x02, 0x04, 0x08].includes(signature[1]);
  if (!matches([0x50, 0x4b, 0x03, 0x04]) && !matches([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) && !isBiff) throw new Error('invalid');
  const book = XLSX.read(buffer, { type: 'array', bookSheets: true, bookProps: true });
  const names = book.SheetNames || [];
  if (!names.length) throw new Error('emptyWorkbook');
  return { names: names.slice(0, SPREADSHEET_PREVIEW_LIMITS.sheets), sheetsLimited: names.length > SPREADSHEET_PREVIEW_LIMITS.sheets };
}

export function readSpreadsheetSheet(XLSX, buffer, name) {
  const limits = SPREADSHEET_PREVIEW_LIMITS;
  // Parse only the selected sheet and a row prefix. No HTML, rich text, styles,
  // formulas, macros or links are projected into the app. A worker deadline also
  // bounds time spent decompressing/parsing hostile or very large input.
  const book = XLSX.read(buffer, {
    type: 'array', sheets: [name], sheetRows: limits.rows, cellHTML: false,
    cellFormula: false, cellStyles: false, bookVBA: false,
  });
  const sheet = book.Sheets?.[name];
  if (!sheet) throw new Error('invalid');
  const limited = { rows: false, columns: false, cell: false, characters: false };
  // A bounded SheetJS read can omit both !ref and !fullref when all values
  // are below the row prefix. This is no data in the preview, not proof the
  // complete worksheet is empty; the viewer must preserve that distinction.
  if (!sheet['!ref']) return { rows: [], columnCount: 0, limited };
  const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref']);
  if (![range.e.r, range.e.c].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('invalid');
  limited.rows = range.e.r >= limits.rows;
  limited.columns = range.e.c >= limits.columns;
  const columnCount = Math.min(range.e.c + 1, limits.columns);
  const rows = [];
  let characters = 0;
  for (let r = 0; r <= Math.min(range.e.r, limits.rows - 1); r++) {
    const row = [];
    for (let c = 0; c < columnCount; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      // Cached/formatted values only. A formula without a cached value is blank.
      let text = cell?.v == null ? '' : String(cell.w ?? XLSX.utils.format_cell(cell));
      if (text.length > limits.cellCharacters) { text = text.slice(0, limits.cellCharacters) + '…'; limited.cell = true; }
      if (characters + text.length > limits.characters) { limited.characters = true; break; }
      characters += text.length;
      row.push(text);
    }
    if (limited.characters) break; // Do not display a partial row.
    rows.push(row);
  }
  // BIFF can give a completely empty worksheet a synthetic A1 range.
  if (!Object.values(limited).some(Boolean) && rows.every(row => row.every(value => value === ''))) return { rows: [], columnCount: 0, limited };
  return { rows, columnCount, limited };
}

/** Stable view operations on the bounded projection; source rows are never reordered. */
export function spreadsheetViewRows(rows, { firstRowHeader = false, query = '', filterColumn = -1, sortColumn = -1, sortDirection = 0 } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  const projected = rows.map((values, index) => ({ values, number: index + 1 })).slice(firstRowHeader ? 1 : 0)
    .filter(row => !needle || (filterColumn < 0 ? row.values : [row.values[filterColumn] ?? ''])
      .some(value => String(value).toLocaleLowerCase().includes(needle)));
  if (sortColumn >= 0 && sortDirection) {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    projected.sort((a, b) => collator.compare(String(a.values[sortColumn] ?? ''), String(b.values[sortColumn] ?? '')) * sortDirection || a.number - b.number);
  }
  return projected;
}

/** TSV quoting preserves embedded tabs/newlines. Clipboard content is plain text. */
export function spreadsheetSelectionText(rows, selection) {
  if (!selection) return '';
  const [r1, r2] = [selection.anchor.row, selection.focus.row].sort((a, b) => a - b);
  const [c1, c2] = [selection.anchor.column, selection.focus.column].sort((a, b) => a - b);
  const quote = value => /[\t\r\n"]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
  return rows.slice(r1, r2 + 1).map(row => Array.from({ length: c2 - c1 + 1 }, (_, c) => quote(String(row.values[c1 + c] ?? ''))).join('\t')).join('\n');
}
