import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const read = p => readFile(path.join(root, p), 'utf8');
const styles = await Promise.all(['web/styles/variables.css', 'web/styles/sidebar.css', 'web/styles/yeaft-sidebar.css'].map(read));
// Keep the preview self-contained and prevent the unused Nerd Font downloading.
styles[0] = styles[0].replace(/@font-face\s*\{[^}]*\}/g, '');
styles.push(await readFile(path.join(dir, 'prototype.css'), 'utf8'));
const vue = await read('web/vendor/vue.global.prod.js');
const output = await build({ entryPoints: [path.join(dir, 'prototype.js')], bundle: true, write: false, format: 'iife', minify: true });
const script = output.outputFiles[0].text.replaceAll('</script', '<\\/script');
const icons = {
  person: '<circle cx="12" cy="7" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  work: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  settings: '<path d="m9 3-.8 3-2.8 1.6L2.5 7l-1 3 2.2 2-1 3 2 2.4 3-.5 2.3 2.3.5 2.8h3l.7-2.8 2.6-1.6 2.7.6 1.5-2.6-2-2.3.3-3 2.2-1.8-1.3-2.8-2.9.4-2.2-2.1-.6-2.8z" transform="translate(1 1) scale(.9)"/><circle cx="12" cy="12" r="3"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r=".8" fill="currentColor"/><circle cx="12" cy="12" r=".8" fill="currentColor"/><circle cx="19" cy="12" r=".8" fill="currentColor"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  review: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6m-7 6 2 2 5-5"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/>',
  layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M10 9v11"/>',
  browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18m5 6 3 3 5-5M7 6.5h.1m3 0h.1"/>',
  release: '<path d="m7 10 5-6 5 6M12 4v12M4 16v4h16v-4"/>',
  plugin: '<path d="M14 3.5a3 3 0 0 0-4.24 4.24L3.5 14l6.5 6.5 6.26-6.26A3 3 0 0 0 20.5 10L17 13.5l-2.5-2.5L18 7.5A3 3 0 0 0 14 3.5z"/>',
  file: '<path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
};
const symbols = Object.entries(icons).map(([name, paths]) => `<symbol id="p-${name}" viewBox="0 0 24 24">${paths}</symbol>`).join('');
const html = `<!doctype html>
<html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Yeaft 插件页第二轮设计提案，示例数据，不连接真实 Agent。"><title>Yeaft · 插件交互设计（待确认）</title><style>${styles.join('\n')}</style></head><body><svg style="display:none" aria-hidden="true"><defs>${symbols}</defs></svg><div id="app"></div><script>${vue}</script><script>${script}</script></body></html>`;
await writeFile(path.join(dir, 'index.html'), html);
console.log('Built self-contained design preview:', path.join(dir, 'index.html'));
