/**
 * check-node-version.js — Runtime guard for Node.js minimum version.
 *
 * The agent and server use `node:sqlite` (DatabaseSync) which is built-in
 * to Node ≥ 22.5.0. On older Node the import fails with the cryptic
 * `No such built-in module: node:sqlite`. We replace that with a clear
 * actionable message and exit early.
 *
 * Why this exists even though `package.json` has `"engines": { "node": ">=22.5.0" }`:
 *   - npm only WARNS on engines mismatch by default (not strict).
 *   - `nvm use 22` selects whichever 22.x is already installed; if the
 *     user has 22.0–22.4, they pass the major check but fail node:sqlite.
 *   - Globally-installed CLIs (`@yeaft/webchat-agent`) bypass package.json
 *     engines entirely on the user's system.
 *
 * Call `assertNodeVersion()` at the very top of every entry point (before
 * any import that transitively touches `node:sqlite`).
 */

const MIN_MAJOR = 22;
const MIN_MINOR = 5;

/**
 * Parse `process.version` ("v22.5.1") into [major, minor, patch].
 * Returns null on unrecognized input rather than throwing — we never
 * want this guard to break startup itself.
 */
function parseNodeVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * @returns {boolean} true if current Node satisfies the minimum.
 */
export function isSupportedNodeVersion(versionString = process.version) {
  const parsed = parseNodeVersion(versionString);
  if (!parsed) return true; // unknown — don't block
  const [major, minor] = parsed;
  if (major > MIN_MAJOR) return true;
  if (major < MIN_MAJOR) return false;
  return minor >= MIN_MINOR;
}

/**
 * Print a clear error and exit(1) if Node is too old.
 *
 * @param {{ component?: string }} [opts]
 */
export function assertNodeVersion(opts = {}) {
  if (isSupportedNodeVersion()) return;
  const component = opts.component || 'yeaft';
  const required = `${MIN_MAJOR}.${MIN_MINOR}.0`;
  const lines = [
    '',
    `✖  ${component} requires Node.js ≥ ${required}`,
    `   Current: ${process.version}`,
    '',
    '   This project uses the built-in `node:sqlite` module which was',
    `   added in Node ${required}.`,
    '',
    '   Fix:',
    '     # if you use nvm:',
    '     nvm install 22       # installs the latest 22.x (currently > 22.5)',
    '     nvm use 22',
    '',
    '     # or upgrade Node from https://nodejs.org/',
    '',
  ];
  process.stderr.write(lines.join('\n'));
  process.exit(1);
}
