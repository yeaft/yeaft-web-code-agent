import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_FILES = ['variables', 'login', 'sidebar', 'chat-messages', 'chat-input', 'chat-modals', 'workbench', 'files', 'terminal', 'git', 'settings', 'dashboard'];
const STYLES_DIR = join(__dirname, '../../web/styles');

export function loadAllCss() {
  return CSS_FILES.map(f => readFileSync(join(STYLES_DIR, f + '.css'), 'utf-8')).join('\n');
}
