/**
 * vp-crud.js — filesystem CRUD for VP library (task-334-ui-g).
 *
 * Writes / updates / deletes `<lib>/<vpId>/role.md`. VpLoader's hot-reload
 * picks up the change on its next debounced rescan and fans out
 * vp_updated / vp_removed WS events to subscribers (334h).
 *
 * Hard constraints:
 *   (a) zero touch on ids.js contract — we only *read* validateVpId;
 *   (b) zero modification to registry.js / roster.js internals — the
 *       entity layer sees changes only via VpLoader rescan;
 *   (c) no Storage-Layer (334o) imports — stays on the entity side.
 *
 * Error codes returned to the caller (wire-visible):
 *   'duplicate'      — vpId already exists (on create)
 *   'not_found'      — vpId does not exist on disk (on update/delete)
 *   'stock_readonly' — vpId is one of the seed/stock VPs (mutation refused)
 *   <reason from validateVpId> — invalid shape
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { validateVpId } from '../groups/ids.js';
import { DEFAULT_VP_LIB_DIR, parseRoleMd } from './vp-store.js';
import { seedSummaryIfMissingSync, removeScopeDirSync } from '../memory/store-v2.js';
import { VP_STUB_MARKER } from '../memory/seed-backfill.js';
import { STOCK_VP_IDS } from './stock-ids.js';

/**
 * Default memory root used when callers don't pass `options.memoryRoot`.
 * Memory lives at `<root>/vp/<id>/{summary.md,memory.md,segments/…}` —
 * see `store-v2.scopeDir`. Production sites should thread the configured
 * `<yeaftDir>/memory` through `options.memoryRoot` so a non-default yeaft
 * directory (e.g. tests, sandboxed CI) doesn't write under `~/.yeaft/`.
 */
const DEFAULT_MEMORY_ROOT = join(homedir(), '.yeaft', 'memory');

/**
 * Build the seed body for a freshly-created VP's `<root>/vp/<id>/summary.md`.
 *
 * IMPORTANT — this is a STUB that mirrors `seed-backfill.js#readVpRoleSummary`.
 * Earlier versions of both writers embedded up to 800 chars of `persona`
 * here. That body is *also* rendered as Section 1 of the system prompt by
 * `renderVpPersona`, so the same persona text reappeared in the AMS
 * Resident block — the user-visible "persona defined twice" bug. PR #722
 * fixed `seed-backfill.js`; this writer is the create-time twin.
 *
 * The seed is therefore deliberately minimal (name + role + traits) and
 * stamped with `VP_STUB_MARKER` so `engine.buildResidentEntries` knows to
 * skip the own-VP Resident push (Section 1 is already the source of truth
 * for own-VP identity). Once Dream-v2 writes a real summary it overwrites
 * this stub and lacks the marker, so it surfaces normally.
 *
 * @param {object} payload  same shape as createVp
 * @returns {string}
 */
export function buildVpSeedSummary(payload) {
  const id = String(payload?.vpId || '').trim();
  const name = (payload?.displayName != null ? String(payload.displayName) : id).trim();
  const role = (payload?.role != null ? String(payload.role) : '').trim();
  const traits = Array.isArray(payload?.traits)
    ? payload.traits.map(t => String(t)).filter(Boolean)
    : [];

  const lines = [VP_STUB_MARKER, '', `# ${name}`];
  if (role) lines.push('', `**Role:** ${role}`);
  if (traits.length > 0) lines.push('', `**Traits:** ${traits.join(', ')}`);
  return lines.join('\n').trim();
}

/**
 * Error thrown by CRUD entry points. Has stable `.code` so callers can map
 * to i18n / WS payload without string-parsing the message.
 */
export class VpCrudError extends Error {
  constructor(code, vpId, message) {
    super(message || `${code}: ${vpId}`);
    this.name = 'VpCrudError';
    this.code = code;
    this.vpId = vpId;
  }
}

function ensureLibDir(libDir) {
  if (!existsSync(libDir)) mkdirSync(libDir, { recursive: true });
}

function vpDirFor(libDir, vpId) {
  return join(libDir, vpId);
}

function vpRolePathFor(libDir, vpId) {
  return join(vpDirFor(libDir, vpId), 'role.md');
}

/**
 * Serialise a VP payload into role.md text with YAML frontmatter matching
 * the parser in vp-store.js.
 *
 * @param {{vpId:string, displayName?:string, role?:string, traits?:string[], modelHint?:string, persona?:string}} p
 * @returns {string}
 */
export function buildRoleMd(p) {
  const id = String(p.vpId);
  const name = p.displayName != null ? String(p.displayName) : id;
  const nameZh = p.displayNameZh != null ? String(p.displayNameZh) : '';
  const aliases = Array.isArray(p.aliases) ? p.aliases.map(a => String(a)).filter(Boolean) : [];
  const role = p.role != null ? String(p.role) : '';
  const roleZh = p.roleZh != null ? String(p.roleZh) : '';
  // Taxonomy bucket. Optional + additive — written only when present so
  // legacy VPs serialised without an `area` field stay byte-identical.
  const area = p.area != null ? String(p.area).trim() : '';
  const traits = Array.isArray(p.traits) ? p.traits.map(t => String(t)).filter(Boolean) : [];
  const modelHint = p.modelHint === 'primary' || p.modelHint === 'fast' ? p.modelHint : null;
  const body = typeof p.persona === 'string' ? p.persona : '';

  const lines = ['---', `id: ${id}`, `name: ${yamlScalar(name)}`];
  if (nameZh) lines.push(`nameZh: ${yamlScalar(nameZh)}`);
  lines.push(`role: ${yamlScalar(role)}`);
  if (roleZh) lines.push(`roleZh: ${yamlScalar(roleZh)}`);
  if (area) lines.push(`area: ${yamlScalar(area)}`);
  if (modelHint) lines.push(`modelHint: ${modelHint}`);
  if (traits.length > 0) {
    lines.push('traits:');
    for (const t of traits) lines.push(`  - ${yamlScalar(t)}`);
  }
  if (aliases.length > 0) {
    lines.push('aliases:');
    for (const a of aliases) lines.push(`  - ${yamlScalar(a)}`);
  }
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}

function yamlScalar(v) {
  const s = String(v);
  // Quote anything that the minimal parser might mis-read: colons, leading
  // dashes, or surrounding whitespace. Plain text passes through unquoted.
  if (/^[\s]|[\s]$|^[-:]|[:#]/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

/**
 * Create a new VP. Writes `<lib>/<vpId>/role.md` and ensures `memory/` dir.
 *
 * @param {object} payload
 * @param {string} payload.vpId
 * @param {string} [payload.displayName]
 * @param {string} [payload.role]
 * @param {string[]} [payload.traits]
 * @param {'primary'|'fast'} [payload.modelHint]
 * @param {string} [payload.persona]
 * @param {object} [options]
 * @param {string} [options.libDir]
 * @returns {{vpId:string, dir:string}}
 */
export function createVp(payload, options = {}) {
  const libDir = options.libDir || DEFAULT_VP_LIB_DIR;
  const memoryRoot = options.memoryRoot || DEFAULT_MEMORY_ROOT;
  const vpId = payload && payload.vpId;

  const v = validateVpId(vpId);
  if (!v.ok) throw new VpCrudError(v.reason, vpId);

  ensureLibDir(libDir);
  const dir = vpDirFor(libDir, vpId);
  if (existsSync(dir)) {
    // Directory already present. Treat as duplicate regardless of whether
    // role.md is inside — prevents CRUD stomping on a half-created entry
    // or a user-authored dir with no frontmatter yet.
    throw new VpCrudError('duplicate', vpId);
  }

  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(vpRolePathFor(libDir, vpId), buildRoleMd({ ...payload, vpId }), 'utf-8');

  // Seed the VP's Layer-A resident summary so the first session has SOMETHING
  // for engine.#loadLayerASummaries to read. Without this, fresh VPs have
  // an empty memory section in the system prompt until Dream-v2 runs (which
  // requires a non-empty diff stream — i.e. several turns of activity).
  // We only seed when the file is missing/empty: this is safe to re-run and
  // never clobbers Dream-v2 writes. Failures are best-effort: a memory-root
  // permission failure must NOT break VP creation.
  try {
    seedSummaryIfMissingSync(
      { kind: 'vp', id: vpId },
      buildVpSeedSummary({ ...payload, vpId }),
      { root: memoryRoot },
    );
  } catch (err) {
    console.warn(`[vp-crud] failed to seed summary.md for ${vpId}:`, err?.message || err);
  }

  return { vpId, dir };
}

/**
 * Update an existing VP. vpId is immutable — the dir is keyed by it; if the
 * user wants a rename they must delete + create.
 *
 * @param {object} payload  same shape as createVp, vpId must match existing dir
 * @param {object} [options]
 * @returns {{vpId:string, dir:string}}
 */
export function updateVp(payload, options = {}) {
  const libDir = options.libDir || DEFAULT_VP_LIB_DIR;
  const vpId = payload && payload.vpId;

  const v = validateVpId(vpId);
  if (!v.ok) throw new VpCrudError(v.reason, vpId);

  // Stock VPs ship with the agent and are immutable from the CRUD path.
  // The UI also disables Edit/Delete on these, but a misbehaving WS client
  // could bypass the UI — refuse here so the file on disk stays canonical.
  if (STOCK_VP_IDS.has(vpId)) throw new VpCrudError('stock_readonly', vpId);

  const dir = vpDirFor(libDir, vpId);
  if (!existsSync(dir) || !existsSync(vpRolePathFor(libDir, vpId))) {
    throw new VpCrudError('not_found', vpId);
  }
  writeFileSync(vpRolePathFor(libDir, vpId), buildRoleMd({ ...payload, vpId }), 'utf-8');
  return { vpId, dir };
}

/**
 * Delete a VP — removes the entire VP dir (role.md + memory/) AND the
 * shared memory root's `<root>/vp/<id>/` so a recreate of the same id
 * doesn't see stale `summary.md` / segments / index entries.
 *
 * Hard constraint: `memory/` contents are scoped to this VP; removing them
 * with the role is the intended CRUD semantic (UX rule is the confirm
 * dialog upstream, not here).
 *
 * @param {string} vpId
 * @param {object} [options]
 * @param {string} [options.libDir]
 * @param {string} [options.memoryRoot]
 * @returns {{vpId:string}}
 */
export function deleteVp(vpId, options = {}) {
  const libDir = options.libDir || DEFAULT_VP_LIB_DIR;
  const memoryRoot = options.memoryRoot || DEFAULT_MEMORY_ROOT;
  // We do NOT run validateVpId here — deleting an already-legacy bad id is
  // legitimate cleanup. But we DO refuse obviously unsafe inputs.
  if (!vpId || typeof vpId !== 'string' || vpId.includes('/') || vpId.includes('\\') || vpId === '..' || vpId === '.') {
    throw new VpCrudError('illegal_character', vpId);
  }
  // Stock VPs ship with the agent. Refuse the delete server-side so a
  // misbehaving WS client cannot wipe `~/.yeaft/virtual-persons/steve/`
  // even if the UI's delete button is missing or disabled.
  if (STOCK_VP_IDS.has(vpId)) throw new VpCrudError('stock_readonly', vpId);
  const dir = vpDirFor(libDir, vpId);
  if (!existsSync(dir)) {
    throw new VpCrudError('not_found', vpId);
  }
  rmSync(dir, { recursive: true, force: true });
  // Cascade: drop the VP's memory scope so a recreate with the same id
  // starts clean. Best-effort — never let memory cleanup fail the CRUD op.
  try {
    removeScopeDirSync({ kind: 'vp', id: vpId }, { root: memoryRoot });
  } catch (err) {
    console.warn(`[vp-crud] failed to remove memory dir for ${vpId}:`, err?.message || err);
  }
  return { vpId };
}

/**
 * Read the full editable shape of an existing VP (for populating the edit
 * form). Parses role.md directly via the same parser vp-store uses, without
 * dragging in the mtime / memoryDir side effects of loadVpFromDir.
 *
 * @param {string} vpId
 * @param {object} [options]
 * @returns {?{vpId:string, displayName:string, role:string, traits:string[], modelHint:?string, persona:string}}
 */
export function readVp(vpId, options = {}) {
  const libDir = options.libDir || DEFAULT_VP_LIB_DIR;
  const rolePath = vpRolePathFor(libDir, vpId);
  if (!existsSync(rolePath)) return null;
  let source;
  try {
    source = readFileSync(rolePath, 'utf-8');
  } catch {
    return null;
  }
  const { meta, body } = parseRoleMd(source);
  const id = String(meta.id || vpId).trim() || vpId;
  const modelHintRaw = typeof meta.modelHint === 'string' ? meta.modelHint : null;
  const modelHint = modelHintRaw === 'primary' || modelHintRaw === 'fast' ? modelHintRaw : null;
  return {
    vpId: id,
    displayName: String(meta.name || id),
    displayNameZh: typeof meta.nameZh === 'string' ? String(meta.nameZh) : '',
    aliases: Array.isArray(meta.aliases) ? meta.aliases.map(String) : [],
    role: String(meta.role || ''),
    roleZh: typeof meta.roleZh === 'string' ? String(meta.roleZh) : '',
    traits: Array.isArray(meta.traits) ? meta.traits.map(String) : [],
    modelHint,
    persona: body,
    planInstruction: typeof meta.planInstruction === 'string' ? String(meta.planInstruction) : '',
    // Echo the authoritative stock flag on the read response so the UI's
    // detail view doesn't have to trust the (potentially stale) list
    // snapshot it was launched from. Defence-in-depth: same Set, two
    // call sites; if either disagrees, the agent guard in updateVp /
    // deleteVp is still the final word.
    isStock: STOCK_VP_IDS.has(id) === true,
  };
}
