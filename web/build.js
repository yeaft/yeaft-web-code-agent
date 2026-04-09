/**
 * Build script for production
 * Bundles all JS/CSS into single files with maximum compression
 */
const esbuild = require('esbuild');
const { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync, rmSync } = require('fs');
const { join } = require('path');
const { gzipSync } = require('zlib');
const crypto = require('crypto');

function contentHash(filePath) {
  return crypto.createHash('md5').update(readFileSync(filePath)).digest('hex').slice(0, 8);
}

const distDir = join(__dirname, 'dist');
const vendorDir = join(__dirname, 'vendor');

// Clean and create dist directory
if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true });
}
mkdirSync(distDir, { recursive: true });

console.log('Building production bundle...\n');

// Step 1: Bundle all vendor JS into one file
console.log('1. Bundling vendor libraries...');
const vendorJs = [
  'tweetnacl.min.js',
  'tweetnacl-util.min.js',
  'pako.min.js',
  'marked.min.js',
  'highlight.min.js',
  'vue.global.prod.js',
  'vue-demi.iife.js',
  'pinia.iife.prod.js',
  'xterm.min.js',
  'xterm-addon-fit.min.js',
  'codemirror.min.js',
  'cm-mode-javascript.js',
  'cm-mode-python.js',
  'cm-mode-htmlmixed.js',
  'cm-mode-xml.js',
  'cm-mode-css.js',
  'cm-mode-shell.js',
  'cm-mode-clike.js',
  'cm-mode-markdown.js'
];

let vendorBundle = '';
for (const file of vendorJs) {
  const content = readFileSync(join(vendorDir, file), 'utf-8');
  vendorBundle += content + '\n';
}
writeFileSync(join(distDir, 'vendor.bundle.js'), vendorBundle);
console.log(`   Vendor bundle: ${(vendorBundle.length / 1024).toFixed(1)} KB`);

// Step 1b: Copy large vendor files separately (too big for bundle)
console.log('1b. Copying large vendor files...');
const separateVendorJs = [
  'jszip.min.js',
  'docx-preview.min.js',
  'xlsx.min.js',
  'mermaid.min.js',
  'html-to-image.min.js',
  'msal-browser.min.js'
];
for (const file of separateVendorJs) {
  const src = join(vendorDir, file);
  if (existsSync(src)) {
    copyFileSync(src, join(distDir, file));
    console.log(`   ${file}: ${(statSync(src).size / 1024).toFixed(1)} KB`);
  }
}

// Step 2: Bundle app code with esbuild
console.log('2. Bundling application code...');

// Create a temporary entry file that exports everything
const entryContent = `
// Re-export all stores and components for the app
export * from './stores/chat.js';
export * from './stores/auth.js';
export * from './components/ChatPage.js';
export * from './components/LoginPage.js';
export * from './components/ChatHeader.js';
export * from './components/ChatInput.js';
export * from './components/MessageList.js';
export * from './components/MessageItem.js';
export * from './components/ThemeToggle.js';
export * from './utils/encryption.js';
`;
writeFileSync(join(__dirname, '_entry.tmp.js'), entryContent);

// Bundle with esbuild
esbuild.buildSync({
  entryPoints: [join(__dirname, 'app.js')],
  bundle: true,
  minify: true,
  treeShaking: true,
  format: 'esm',
  target: ['es2020'],
  outfile: join(distDir, 'app.bundle.js'),
  external: [], // Bundle everything
  define: {
    'process.env.NODE_ENV': '"production"'
  },
  legalComments: 'none',
  drop: ['console', 'debugger'], // Remove console.log in production
});

// Clean up temp file
rmSync(join(__dirname, '_entry.tmp.js'), { force: true });

const appBundleSize = statSync(join(distDir, 'app.bundle.js')).size;
console.log(`   App bundle: ${(appBundleSize / 1024).toFixed(1)} KB`);

// Step 3: Bundle CSS
console.log('3. Bundling CSS...');
const highlightCss = readFileSync(join(vendorDir, 'highlight.min.css'), 'utf-8');
const xtermCss = readFileSync(join(vendorDir, 'xterm.min.css'), 'utf-8');
const codemirrorCss = readFileSync(join(vendorDir, 'codemirror.min.css'), 'utf-8');
const codemirrorThemeCss = readFileSync(join(vendorDir, 'codemirror-material-darker.css'), 'utf-8');
// Parse CSS file list from index.css @import directives (single source of truth)
const appCssCollected = [];
function readCssRecursive(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const importRegex = /@import\s+(?:url\()?['"]\.\/(.+?)['"]\)?;/g;
  let match;
  let hasImports = false;
  while ((match = importRegex.exec(content)) !== null) {
    hasImports = true;
    readCssRecursive(join(filePath, '..', match[1]));
  }
  if (!hasImports) {
    appCssCollected.push(filePath);
  }
}
readCssRecursive(join(__dirname, 'styles', 'index.css'));
const appCss = appCssCollected.map(f => readFileSync(f, 'utf-8')).join('\n');

// Minify combined CSS with esbuild
const cssResult = esbuild.transformSync(highlightCss + '\n' + xtermCss + '\n' + codemirrorCss + '\n' + codemirrorThemeCss + '\n' + appCss, {
  loader: 'css',
  minify: true,
});
writeFileSync(join(distDir, 'style.bundle.css'), cssResult.code);
console.log(`   CSS bundle: ${(cssResult.code.length / 1024).toFixed(1)} KB`);

// Step 4: Generate optimized index.html
console.log('4. Generating index.html...');
const appHash = contentHash(join(distDir, 'app.bundle.js'));
const cssHash = contentHash(join(distDir, 'style.bundle.css'));
const vendorHash = contentHash(join(distDir, 'vendor.bundle.js'));
const indexHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Claude Web Chat</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%23d97706'/><path d='M8 11l4 4-4 4' stroke='white' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round' fill='none'/><path d='M14 19h10' stroke='white' stroke-width='2.5' stroke-linecap='round'/></svg>">
  <link rel="stylesheet" href="style.bundle.css?v=${cssHash}">
  <script src="vendor.bundle.js?v=${vendorHash}"></script>
  <script defer src="jszip.min.js"></script>
  <script defer src="docx-preview.min.js"></script>
  <script defer src="xlsx.min.js"></script>
  <script defer src="mermaid.min.js"></script>
  <script defer src="html-to-image.min.js"></script>
  <script defer src="msal-browser.min.js"></script>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="app.bundle.js?v=${appHash}"></script>
</body>
</html>`;
writeFileSync(join(distDir, 'index.html'), indexHtml);

// Step 5: Create gzip versions for servers that support pre-compressed files
console.log('5. Creating gzip versions...');
const filesToGzip = ['vendor.bundle.js', 'app.bundle.js', 'style.bundle.css', ...separateVendorJs];
for (const file of filesToGzip) {
  const content = readFileSync(join(distDir, file));
  const gzipped = gzipSync(content, { level: 9 });
  writeFileSync(join(distDir, file + '.gz'), gzipped);
}

// Calculate sizes
const vendorSize = statSync(join(distDir, 'vendor.bundle.js')).size;
const vendorGzSize = statSync(join(distDir, 'vendor.bundle.js.gz')).size;
const appSize = statSync(join(distDir, 'app.bundle.js')).size;
const appGzSize = statSync(join(distDir, 'app.bundle.js.gz')).size;
const cssSize = statSync(join(distDir, 'style.bundle.css')).size;
const cssGzSize = statSync(join(distDir, 'style.bundle.css.gz')).size;

// Original size calculation
const originalFiles = [
  'app.js',
  'components/ChatHeader.js', 'components/ChatInput.js', 'components/ChatPage.js',
  'components/LoginPage.js', 'components/MessageItem.js', 'components/MessageList.js',
  'components/ThemeToggle.js', 'stores/auth.js', 'stores/chat.js', 'utils/encryption.js'
];
const originalCodeSize = originalFiles.reduce((sum, f) => sum + statSync(join(__dirname, f)).size, 0);
const originalVendorSize = vendorJs.reduce((sum, f) => sum + statSync(join(vendorDir, f)).size, 0);
const originalCssSize = appCssCollected.reduce((sum, f) => sum + statSync(f).size, 0) + statSync(join(vendorDir, 'highlight.min.css')).size + statSync(join(vendorDir, 'xterm.min.css')).size + statSync(join(vendorDir, 'codemirror.min.css')).size + statSync(join(vendorDir, 'codemirror-material-darker.css')).size;

console.log('\n========================================');
console.log('Build complete!');
console.log('========================================');
console.log('\nFile sizes:');
console.log('                    Original    Minified    Gzipped');
console.log(`  vendor.bundle.js  ${(originalVendorSize/1024).toFixed(1).padStart(7)} KB  ${(vendorSize/1024).toFixed(1).padStart(7)} KB  ${(vendorGzSize/1024).toFixed(1).padStart(6)} KB`);
console.log(`  app.bundle.js     ${(originalCodeSize/1024).toFixed(1).padStart(7)} KB  ${(appSize/1024).toFixed(1).padStart(7)} KB  ${(appGzSize/1024).toFixed(1).padStart(6)} KB`);
console.log(`  style.bundle.css  ${(originalCssSize/1024).toFixed(1).padStart(7)} KB  ${(cssSize/1024).toFixed(1).padStart(7)} KB  ${(cssGzSize/1024).toFixed(1).padStart(6)} KB`);
console.log('  ─────────────────────────────────────────────────');
const totalOriginal = originalVendorSize + originalCodeSize + originalCssSize;
const totalMinified = vendorSize + appSize + cssSize;
const totalGzipped = vendorGzSize + appGzSize + cssGzSize;
console.log(`  Total             ${(totalOriginal/1024).toFixed(1).padStart(7)} KB  ${(totalMinified/1024).toFixed(1).padStart(7)} KB  ${(totalGzipped/1024).toFixed(1).padStart(6)} KB`);
console.log(`\nReduction: ${((1 - totalMinified/totalOriginal) * 100).toFixed(1)}% (minified), ${((1 - totalGzipped/totalOriginal) * 100).toFixed(1)}% (gzipped)`);
console.log(`\nOutput: ${distDir}`);
console.log('\nTo serve production build:');
console.log('  SERVE_DIST=true npm start');
console.log('\nFor gzip support, configure your web server to serve .gz files');
