const helpers = import('./utils/spreadsheet-preview.js');

// The same pinned vendor used by the app; bundled worker uses the dist copy.
importScripts(new URL(typeof SPREADSHEET_VENDOR_URL === 'undefined' ? './vendor/xlsx.min.js' : SPREADSHEET_VENDOR_URL, self.location.href).href);
let buffer;
self.onmessage = async ({ data }) => {
  try {
    const { readSpreadsheetNames, readSpreadsheetSheet } = await helpers;
    if (data.buffer) buffer = data.buffer;
    const result = data.name == null ? readSpreadsheetNames(self.XLSX, buffer) : readSpreadsheetSheet(self.XLSX, buffer, data.name);
    self.postMessage({ id: data.id, result });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
