/**
 * VS Code Material Icon Theme style file icons (SVG)
 * Returns inline SVG string for a given file name or extension
 */

// Color constants matching VS Code Material Icon Theme
const C = {
  js:       '#F1C40F',
  ts:       '#3178C6',
  jsx:      '#61DAFB',
  tsx:      '#3178C6',
  py:       '#3776AB',
  rb:       '#CC342D',
  go:       '#00ADD8',
  rs:       '#DEA584',
  java:     '#E76F00',
  cs:       '#68217A',
  cpp:      '#00599C',
  c:        '#A8B9CC',
  html:     '#E44D26',
  css:      '#1572B6',
  scss:     '#CF649A',
  less:     '#1D365D',
  json:     '#F1C40F',
  yaml:     '#CB171E',
  xml:      '#E44D26',
  md:       '#519ABA',
  txt:      '#8E8E8E',
  log:      '#8E8E8E',
  sh:       '#4EAA25',
  ps1:      '#012456',
  sql:      '#E38C00',
  svg:      '#FFB13B',
  img:      '#26A69A',
  video:    '#7E57C2',
  git:      '#F05032',
  docker:   '#2496ED',
  config:   '#6D8086',
  lock:     '#8E8E8E',
  env:      '#ECD53F',
  vue:      '#41B883',
  react:    '#61DAFB',
  angular:  '#DD0031',
  svelte:   '#FF3E00',
  php:      '#777BB4',
  swift:    '#FA7343',
  kt:       '#7F52FF',
  lua:      '#000080',
  r:        '#276DC3',
  dart:     '#00B4AB',
  liquid:   '#67B6E4',
  folder:   '#90A4AE',
  folderOpen:'#90A4AE',
  default:  '#8E8E8E',
};

// SVG templates — all are 16x16
const fileSvg = (color) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M14 2H6C4.9 2 4 2.9 4 4v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6z" fill="${color}" opacity="0.85"/><path d="M14 2v6h6" fill="${color}" opacity="0.5"/></svg>`;

const folderSvg = (color, open) => open
  ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" fill="${color}" opacity="0.9"/></svg>`
  : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" fill="${color}" opacity="0.9"/></svg>`;

// Extension text overlay on file icon
const fileWithText = (color, text) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M14 2H6C4.9 2 4 2.9 4 4v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6z" fill="${color}" opacity="0.2"/><path d="M14 2v6h6" fill="${color}" opacity="0.15"/><path d="M14 2H6C4.9 2 4 2.9 4 4v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6z" stroke="${color}" stroke-width="1.2" fill="none"/><text x="12" y="17" text-anchor="middle" font-size="7" font-weight="700" font-family="system-ui,sans-serif" fill="${color}">${text}</text></svg>`;

// Specific icons for popular file types
const icons = {
  // JavaScript / TypeScript
  js:   () => fileWithText(C.js, 'JS'),
  mjs:  () => fileWithText(C.js, 'JS'),
  cjs:  () => fileWithText(C.js, 'JS'),
  ts:   () => fileWithText(C.ts, 'TS'),
  mts:  () => fileWithText(C.ts, 'TS'),
  jsx:  () => fileWithText(C.jsx, 'JSX'),
  tsx:  () => fileWithText(C.tsx, 'TSX'),

  // Web
  html: () => fileWithText(C.html, '</>'),
  htm:  () => fileWithText(C.html, '</>'),
  css:  () => fileWithText(C.css, 'CSS'),
  scss: () => fileWithText(C.scss, 'SC'),
  sass: () => fileWithText(C.scss, 'SA'),
  less: () => fileWithText(C.less, 'LS'),
  vue:  () => fileWithText(C.vue, 'V'),
  svelte: () => fileWithText(C.svelte, 'SV'),

  // Data
  json: () => fileWithText(C.json, '{ }'),
  yaml: () => fileWithText(C.yaml, 'YML'),
  yml:  () => fileWithText(C.yaml, 'YML'),
  toml: () => fileWithText(C.config, 'TML'),
  xml:  () => fileWithText(C.xml, '</>'),
  csv:  () => fileWithText(C.config, 'CSV'),

  // Docs
  md:       () => fileWithText(C.md, 'MD'),
  markdown: () => fileWithText(C.md, 'MD'),
  txt:      () => fileSvg(C.txt),
  log:      () => fileSvg(C.log),
  pdf:      () => fileWithText('#E53935', 'PDF'),

  // Languages
  py:   () => fileWithText(C.py, 'PY'),
  rb:   () => fileWithText(C.rb, 'RB'),
  go:   () => fileWithText(C.go, 'GO'),
  rs:   () => fileWithText(C.rs, 'RS'),
  java: () => fileWithText(C.java, 'JA'),
  cs:   () => fileWithText(C.cs, 'C#'),
  cpp:  () => fileWithText(C.cpp, 'C+'),
  cc:   () => fileWithText(C.cpp, 'C+'),
  c:    () => fileWithText(C.c, 'C'),
  h:    () => fileWithText(C.c, 'H'),
  hpp:  () => fileWithText(C.cpp, 'H+'),
  swift:() => fileWithText(C.swift, 'SW'),
  kt:   () => fileWithText(C.kt, 'KT'),
  php:  () => fileWithText(C.php, 'PHP'),
  lua:  () => fileWithText(C.lua, 'LUA'),
  r:    () => fileWithText(C.r, 'R'),
  dart: () => fileWithText(C.dart, 'DA'),

  // Shell
  sh:   () => fileWithText(C.sh, '>_'),
  bash: () => fileWithText(C.sh, '>_'),
  zsh:  () => fileWithText(C.sh, '>_'),
  fish: () => fileWithText(C.sh, '>_'),
  ps1:  () => fileWithText(C.ps1, 'PS'),
  bat:  () => fileWithText(C.ps1, 'BAT'),
  cmd:  () => fileWithText(C.ps1, 'CMD'),

  // Database
  sql:  () => fileWithText(C.sql, 'SQL'),
  db:   () => fileWithText(C.sql, 'DB'),
  sqlite: () => fileWithText(C.sql, 'DB'),

  // Images
  svg:  () => fileWithText(C.svg, 'SVG'),
  png:  () => fileWithText(C.img, 'PNG'),
  jpg:  () => fileWithText(C.img, 'JPG'),
  jpeg: () => fileWithText(C.img, 'JPG'),
  gif:  () => fileWithText(C.img, 'GIF'),
  ico:  () => fileWithText(C.img, 'ICO'),
  webp: () => fileWithText(C.img, 'WP'),

  // Video
  mp4:  () => fileWithText(C.video, 'MP4'),
  m4v:  () => fileWithText(C.video, 'M4V'),
  webm: () => fileWithText(C.video, 'WEB'),
  ogv:  () => fileWithText(C.video, 'OGV'),
  ogg:  () => fileWithText(C.video, 'OGG'),
  mov:  () => fileWithText(C.video, 'MOV'),

  // Config
  lock: () => fileSvg(C.lock),
  env:  () => fileWithText(C.env, 'ENV'),
  ini:  () => fileWithText(C.config, 'INI'),
  cfg:  () => fileWithText(C.config, 'CFG'),
  conf: () => fileWithText(C.config, 'CNF'),

  // Templates
  liquid: () => fileWithText(C.liquid, 'LQ'),
  ejs:    () => fileWithText(C.html, 'EJS'),
  hbs:    () => fileWithText(C.html, 'HBS'),
  pug:    () => fileWithText(C.html, 'PUG'),

  // Other
  wasm: () => fileWithText('#654FF0', 'WA'),
  proto:() => fileWithText(C.config, 'PB'),
  graphql: () => fileWithText('#E535AB', 'GQL'),
  gql:  () => fileWithText('#E535AB', 'GQL'),
};

// Special filenames
const specialFiles = {
  'dockerfile':     () => fileWithText(C.docker, 'DK'),
  'docker-compose.yml': () => fileWithText(C.docker, 'DC'),
  'docker-compose.yaml': () => fileWithText(C.docker, 'DC'),
  '.gitignore':     () => fileWithText(C.git, 'GI'),
  '.gitattributes': () => fileWithText(C.git, 'GA'),
  '.gitmodules':    () => fileWithText(C.git, 'GM'),
  '.env':           () => fileWithText(C.env, 'ENV'),
  '.env.local':     () => fileWithText(C.env, 'ENV'),
  '.env.development': () => fileWithText(C.env, 'ENV'),
  '.env.production':  () => fileWithText(C.env, 'ENV'),
  'package.json':   () => fileWithText('#CB3837', 'NPM'),
  'package-lock.json': () => fileWithText('#CB3837', 'NPM'),
  'tsconfig.json':  () => fileWithText(C.ts, 'TSC'),
  'eslintrc':       () => fileWithText('#4B32C3', 'ESL'),
  '.eslintrc.js':   () => fileWithText('#4B32C3', 'ESL'),
  '.eslintrc.json': () => fileWithText('#4B32C3', 'ESL'),
  '.prettierrc':    () => fileWithText('#F7B93E', 'PR'),
  'makefile':       () => fileWithText(C.config, 'MK'),
  'cmakelists.txt': () => fileWithText('#064F8C', 'CM'),
  'readme.md':      () => fileWithText(C.md, 'RM'),
  'license':        () => fileWithText('#F5C518', 'LIC'),
  'license.md':     () => fileWithText('#F5C518', 'LIC'),
  'cargo.toml':     () => fileWithText(C.rs, 'CG'),
  'go.mod':         () => fileWithText(C.go, 'MOD'),
  'go.sum':         () => fileWithText(C.go, 'SUM'),
  'gemfile':        () => fileWithText(C.rb, 'GEM'),
  'rakefile':       () => fileWithText(C.rb, 'RK'),
  'requirements.txt': () => fileWithText(C.py, 'REQ'),
  'pipfile':        () => fileWithText(C.py, 'PIP'),
  'csproj':         () => fileWithText(C.cs, 'CSP'),
  '.sln':           () => fileWithText(C.cs, 'SLN'),
  'slnx':           () => fileWithText(C.cs, 'SLN'),
};

/**
 * Get SVG icon HTML for a file name
 * @param {string} fileName - file name (e.g. "index.js", "package.json")
 * @returns {string} SVG HTML string
 */
export function getFileIconSvg(fileName) {
  if (!fileName) return fileSvg(C.default);

  const lower = fileName.toLowerCase();

  // Check special file names first
  if (specialFiles[lower]) return specialFiles[lower]();

  // Check extension
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx >= 0) {
    const ext = lower.slice(dotIdx + 1);
    if (icons[ext]) return icons[ext]();

    // Check full filename with extension for special files
    const baseName = lower;
    for (const [key, fn] of Object.entries(specialFiles)) {
      if (baseName === key || baseName.endsWith('/' + key)) return fn();
    }
  }

  return fileSvg(C.default);
}

/**
 * Get SVG icon HTML for a folder
 * @param {boolean} isOpen - whether the folder is expanded
 * @returns {string} SVG HTML string
 */
export function getFolderIconSvg(isOpen = false) {
  return folderSvg(C.folder, isOpen);
}
