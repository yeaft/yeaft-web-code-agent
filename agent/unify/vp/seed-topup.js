/**
 * seed-topup.js — keep the default-VP roster in sync with an EXISTING library.
 *
 * Problem: `seedDefaultVps` is first-run-only — once the library has any VP
 * in it, that function never runs again. When we expanded the default roster
 * from 12 to 32 (philosophy, psychology, strategy, history, investing,
 * business, writing, science, arts), existing installs would never see the
 * 20 new VPs without either (a) the user manually deleting their library or
 * (b) a forced overwrite that would clobber their hand edits.
 *
 * This module runs on every agent start alongside `seedDefaultVps` and does
 * two minimal, additive things:
 *
 *   1. **Top-up missing default VPs**. If a vpId from `DEFAULT_VPS` is not
 *      on disk AND the user has not explicitly deleted it before (tracked
 *      via `<libDir>/.seeded-versions.json`), `createVp()` it.
 *
 *   2. **Backfill the `area` frontmatter line** on existing seeded VPs whose
 *      role.md predates the area field. The body is left BYTE-IDENTICAL —
 *      we splice a single `area: <bucket>` line into the YAML frontmatter
 *      and write nothing else. If the user has authored their own `area`,
 *      we keep theirs.
 *
 * Hard rules:
 *   - **Never** overwrite a VP that is on disk. The user might have edited
 *     persona/role/traits; that is their truth, not ours.
 *   - **Never** recreate a VP the user has deleted. The seed-versions file
 *     remembers "we have seeded this before" — if it's gone now, the user
 *     wants it gone.
 *   - Best-effort: any failure is logged, never thrown.
 *
 * Pre-ledger deletion caveat: on the very first top-up against an existing
 * library (no `.seeded-versions.json` yet), we cannot distinguish "user
 * deleted VP X before the expansion landed" from "X was never seeded." The
 * bootstrap records only on-disk ids as `legacy`; an id the user had deleted
 * BEFORE this code shipped looks identical to a brand-new default and will
 * be recreated once. After that single bootstrap event the ledger is
 * authoritative — any subsequent delete is permanent.
 *
 * Sidecar file: `<libDir>/.seeded-versions.json`
 *
 *   {
 *     "version": 1,
 *     "seeded": {
 *       "steve": "legacy",         // pre-existing on first top-up
 *       "kongzi": "<personaHash8>" // created by us, with hash
 *     }
 *   }
 *
 * The hash is reserved for future "the default persona changed; offer the
 * user a migration" semantics. We do not auto-upgrade today.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createVp, VpCrudError } from './vp-crud.js';
import { DEFAULT_VP_LIB_DIR, personaHash } from './vp-store.js';
import { DEFAULT_VPS } from './seed-defaults.js';

const SEEDED_VERSIONS_FILE = '.seeded-versions.json';
const SEEDED_VERSIONS_VERSION = 1;

/**
 * Read the seed-versions sidecar. Returns `{ seeded: {} }` on any failure.
 *
 * @param {string} libDir
 * @returns {{ version: number, seeded: Record<string,string> }}
 */
export function readSeedVersions(libDir) {
  const path = join(libDir, SEEDED_VERSIONS_FILE);
  if (!existsSync(path)) return { version: SEEDED_VERSIONS_VERSION, seeded: {} };
  try {
    const raw = readFileSync(path, 'utf-8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && obj.seeded && typeof obj.seeded === 'object') {
      return { version: SEEDED_VERSIONS_VERSION, seeded: { ...obj.seeded } };
    }
  } catch { /* fall through */ }
  return { version: SEEDED_VERSIONS_VERSION, seeded: {} };
}

/**
 * Write the seed-versions sidecar atomically (write-then-rename) so a crash
 * mid-write can never replace a healthy ledger with a partial one. Best-effort
 * — failures log a warning and do not throw.
 *
 * @param {string} libDir
 * @param {{seeded: Record<string,string>}} data
 */
export function writeSeedVersions(libDir, data) {
  const path = join(libDir, SEEDED_VERSIONS_FILE);
  const tmpPath = path + '.tmp';
  try {
    mkdirSync(libDir, { recursive: true });
    writeFileSync(
      tmpPath,
      JSON.stringify({ version: SEEDED_VERSIONS_VERSION, seeded: data.seeded }, null, 2),
      'utf-8',
    );
    renameSync(tmpPath, path);
  } catch (err) {
    console.warn(`[vp-topup] failed to write ${SEEDED_VERSIONS_FILE}: ${err?.message || err}`);
  }
}

/**
 * Is `<libDir>/<vpId>/role.md` present?
 */
function vpExistsOnDisk(libDir, vpId) {
  try {
    const st = statSync(join(libDir, vpId, 'role.md'));
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * List vpIds currently on disk (have role.md). Used to bootstrap the seed-
 * versions sidecar on first top-up: anything present is recorded as `legacy`
 * so we never try to "create" it again, AND we never assume the user wants
 * us to delete it.
 *
 * @param {string} libDir
 * @returns {string[]}
 */
function listExistingVpIds(libDir) {
  if (!existsSync(libDir)) return [];
  let entries;
  try {
    entries = readdirSync(libDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    if (vpExistsOnDisk(libDir, e.name)) out.push(e.name);
  }
  return out;
}

/**
 * Splice a single `<key>: <value>` line into an existing role.md's YAML
 * frontmatter, immediately after the `role:` line if one is present (else
 * before the closing `---`). All other bytes are preserved.
 *
 * Returns `null` if the file already has the key, has no frontmatter, or
 * any other parse anomaly — caller treats null as "don't touch this file."
 *
 * @param {string} source
 * @param {string} key   YAML key to insert (e.g. 'area', 'nameZh')
 * @param {string} value Scalar value (will be YAML-escaped only if it
 *                       contains characters that need quoting)
 * @returns {string|null}
 */
function insertFrontmatterLine(source, key, value) {
  const valTrim = String(value || '').trim();
  if (!valTrim) return null;
  const fmMatch = source.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/);
  if (!fmMatch) return null;
  const [full, open, yaml, close] = fmMatch;
  // Anchored at start-of-line so `nameZh` is never mistaken for `name`.
  const keyPattern = new RegExp(`^${key}:\\s*`, 'm');
  if (keyPattern.test(yaml)) return null; // user already set this key
  const nl = yaml.includes('\r\n') ? '\r\n' : '\n';
  const lines = yaml.split(/\r?\n/);
  const roleIdx = lines.findIndex(l => /^role:\s*/.test(l));
  // Quote the value when it contains characters YAML treats specially or
  // non-ASCII bytes — the existing vp-crud writer does the same dance.
  const needsQuote = /[:#"'\\\n]/.test(valTrim) || /[^\x20-\x7e]/.test(valTrim);
  const yamlVal = needsQuote
    ? `"${valTrim.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : valTrim;
  const newLine = `${key}: ${yamlVal}`;
  if (roleIdx >= 0) {
    lines.splice(roleIdx + 1, 0, newLine);
  } else {
    lines.push(newLine);
  }
  const newYaml = lines.join(nl);
  const rest = source.slice(full.length);
  return open + newYaml + close + rest;
}

/**
 * Backward-compatible wrapper kept for tests that pin the `area` shape.
 * Equivalent to `insertFrontmatterLine(source, 'area', bucket)`.
 *
 * @param {string} source
 * @param {string} bucket
 * @returns {string|null}
 */
export function insertAreaLine(source, bucket) {
  return insertFrontmatterLine(source, 'area', bucket);
}

/**
 * v0.1.768 — backfill `nameZh:` into a role.md frontmatter that predates
 * the bilingual seed. Same byte-preserving semantics as insertAreaLine.
 *
 * @param {string} source
 * @param {string} nameZh
 * @returns {string|null}
 */
export function insertNameZhLine(source, nameZh) {
  return insertFrontmatterLine(source, 'nameZh', nameZh);
}

/**
 * Top-up the default VPs into an existing `libDir`.
 *
 * @param {string} [libDir=DEFAULT_VP_LIB_DIR]
 * @returns {{
 *   added: string[],
 *   areaBackfilled: string[],
 *   nameZhBackfilled: string[],
 *   respectedDeletes: string[],
 *   skippedExisting: string[],
 *   errors: Array<{vpId:string, code:string, message:string}>,
 * }}
 */
export function topUpDefaultVps(libDir = DEFAULT_VP_LIB_DIR) {
  const added = [];
  const areaBackfilled = [];
  const nameZhBackfilled = [];
  const respectedDeletes = [];
  const skippedExisting = [];
  /** @type {Array<{vpId:string,code:string,message:string}>} */
  const errors = [];

  // libDir might not exist if `seedDefaultVps` is about to create it. In
  // that case there's nothing to top up — seedDefaultVps will populate
  // everything. We still return cleanly.
  if (!existsSync(libDir)) {
    return { added, areaBackfilled, nameZhBackfilled, respectedDeletes, skippedExisting, errors };
  }

  let versions = readSeedVersions(libDir);
  const versionsFilePresent = existsSync(join(libDir, SEEDED_VERSIONS_FILE));

  // Bootstrap: if the versions file is missing but the library is populated,
  // assume every disk VP was seeded by an older agent build and record them
  // as `legacy`. This is the critical step that prevents us from treating a
  // pre-expansion install as "user deleted everything and only kept 12."
  if (!versionsFilePresent) {
    for (const existingId of listExistingVpIds(libDir)) {
      if (!versions.seeded[existingId]) versions.seeded[existingId] = 'legacy';
    }
  }

  for (const vp of DEFAULT_VPS) {
    const vpId = vp.vpId;
    const onDisk = vpExistsOnDisk(libDir, vpId);
    const inLedger = Object.prototype.hasOwnProperty.call(versions.seeded, vpId);

    if (onDisk) {
      // Already there — never overwrite. Possibly backfill `area` /
      // `nameZh`. Each backfill is independent: a role.md with `area`
      // already set but no `nameZh` should still get `nameZh`.
      skippedExisting.push(vpId);
      let currentSrc = null;
      const rolePath = join(libDir, vpId, 'role.md');
      const readRole = () => {
        if (currentSrc == null) {
          try { currentSrc = readFileSync(rolePath, 'utf-8'); } catch { currentSrc = null; }
        }
        return currentSrc;
      };
      if (vp.area) {
        try {
          const src = readRole();
          if (src != null) {
            const patched = insertAreaLine(src, vp.area);
            if (patched != null && patched !== src) {
              writeFileSync(rolePath, patched, 'utf-8');
              currentSrc = patched;
              areaBackfilled.push(vpId);
            }
          }
        } catch (err) {
          errors.push({
            vpId,
            code: 'area_backfill_failed',
            message: String(err?.message || err),
          });
        }
      }
      // v0.1.768 — bilingual top-up. Existing VPs created from a
      // pre-bilingual seed lack `nameZh:` in their role.md, which means
      // serializeVpForWire ships `displayNameZh: ''` and the web
      // `vpLabel` falls through to English even under zh locale. Splice
      // the canonical Chinese display name into frontmatter without
      // touching anything else — the user's persona body stays
      // byte-identical.
      if (vp.displayNameZh) {
        try {
          const src = readRole();
          if (src != null) {
            const patched = insertNameZhLine(src, vp.displayNameZh);
            if (patched != null && patched !== src) {
              writeFileSync(rolePath, patched, 'utf-8');
              currentSrc = patched;
              nameZhBackfilled.push(vpId);
            }
          }
        } catch (err) {
          errors.push({
            vpId,
            code: 'namezh_backfill_failed',
            message: String(err?.message || err),
          });
        }
      }
      // Make sure the ledger records it (e.g. user-authored VP whose id
      // collides with a default — we still want to skip future creates).
      if (!inLedger) versions.seeded[vpId] = 'legacy';
      continue;
    }

    if (inLedger) {
      // We seeded this before, user has since deleted it — respect that.
      respectedDeletes.push(vpId);
      continue;
    }

    // Missing on disk and never seeded — create it.
    try {
      createVp(vp, { libDir });
      versions.seeded[vpId] = personaHash(vp.persona);
      added.push(vpId);
    } catch (err) {
      if (err instanceof VpCrudError && err.code === 'duplicate') {
        // Race with another seeder — treat as already present.
        versions.seeded[vpId] = 'legacy';
        skippedExisting.push(vpId);
        continue;
      }
      errors.push({
        vpId,
        code: err instanceof VpCrudError ? err.code : 'write_failed',
        message: String(err?.message || err),
      });
    }
  }

  writeSeedVersions(libDir, versions);
  return { added, areaBackfilled, nameZhBackfilled, respectedDeletes, skippedExisting, errors };
}
