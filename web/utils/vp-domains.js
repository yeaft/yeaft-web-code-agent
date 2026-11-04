/** Stable identities, not a whitelist for storage, execution, or Session members. */
export const RECOMMENDED_VP_IDS = Object.freeze([
  'omni', 'software-omni', 'writing-omni', 'short-video-omni', 'quant-omni',
]);

const DOMAIN_DEFINITIONS = [
  { id: 'assistants', labelKey: 'yeaft.vp.domain.assistants', vpIds: RECOMMENDED_VP_IDS },
  { id: 'productDesign', labelKey: 'yeaft.vp.domain.productDesign', vpIds: ['steve', 'dieter', 'norman'] },
  {
    id: 'softwareSystems',
    labelKey: 'yeaft.vp.domain.softwareSystems',
    vpIds: ['linus', 'martin', 'anders', 'ada', 'grace', 'ken', 'alan'],
  },
  {
    id: 'securityReliability',
    labelKey: 'yeaft.vp.domain.securityReliability',
    vpIds: ['alice', 'margaret'],
  },
  { id: 'scienceAnalysis', labelKey: 'yeaft.vp.domain.scienceAnalysis', vpIds: ['shannon', 'einstein'] },
  {
    id: 'philosophyPsychology',
    labelKey: 'yeaft.vp.domain.philosophyPsychology',
    vpIds: ['kongzi', 'socrates', 'nietzsche', 'kahneman', 'jung'],
  },
  {
    id: 'strategyHistory',
    labelKey: 'yeaft.vp.domain.strategyHistory',
    vpIds: ['sunzi', 'clausewitz', 'simaqian', 'harari'],
  },
  {
    id: 'businessManagement',
    labelKey: 'yeaft.vp.domain.businessManagement',
    vpIds: ['buffett', 'munger', 'dalio', 'bezos', 'drucker'],
  },
  {
    id: 'artsCulture',
    labelKey: 'yeaft.vp.domain.artsCulture',
    vpIds: ['luxun', 'sudongpo', 'borges', 'haiyan', 'liufang', 'zhaona', 'kubrick', 'miyazaki'],
  },
  { id: 'other', labelKey: 'yeaft.vp.domain.other', vpIds: [] },
  { id: 'custom', labelKey: 'yeaft.vp.domain.custom', vpIds: [] },
];

export const VP_DOMAIN_DEFINITIONS = Object.freeze(DOMAIN_DEFINITIONS.map(domain => Object.freeze({
  id: domain.id,
  labelKey: domain.labelKey,
  vpIds: Object.freeze([...domain.vpIds]),
})));

const VP_DOMAIN_BY_ID = new Map();
for (const domain of VP_DOMAIN_DEFINITIONS) {
  for (const vpId of domain.vpIds) VP_DOMAIN_BY_ID.set(vpId, domain.id);
}

/** Older Agents omit isStock, so known shipped identities remain compatible. */
export function isLegacyVp(vp) {
  return !!(vp?.vpId && !RECOMMENDED_VP_IDS.includes(vp.vpId)
    && (vp.isStock === true || VP_DOMAIN_BY_ID.has(vp.vpId)));
}

/**
 * Select only presentation candidates. Never use this to rebuild a saved roster.
 * Existing members are pinned even when metadata is missing; hiding a library
 * entry must not silently remove it from an old Session or an in-progress draft.
 *
 * @param {object[]} vps complete library for the target Agent
 * @param {{includeIds?: string[], showLegacy?: boolean}} [options]
 * @returns {object[]}
 */
export function selectVpCatalog(vps, { includeIds = [], showLegacy = false } = {}) {
  const pinned = new Set((Array.isArray(includeIds) ? includeIds : []).filter(id => typeof id === 'string' && id));
  const byId = new Map();
  for (const vp of Array.isArray(vps) ? vps : []) {
    if (!vp?.vpId || vp.vpId === 'user' || byId.has(vp.vpId)) continue;
    if (showLegacy || pinned.has(vp.vpId) || !isLegacyVp(vp)) byId.set(vp.vpId, vp);
  }
  for (const vpId of pinned) {
    if (vpId !== 'user' && !byId.has(vpId)) byId.set(vpId, { vpId });
  }
  return [
    ...RECOMMENDED_VP_IDS.map(id => byId.get(id)).filter(Boolean),
    ...[...byId.values()].filter(vp => !RECOMMENDED_VP_IDS.includes(vp.vpId)),
  ];
}

/**
 * Resolve the stable presentation domain for a VP record.
 *
 * Known stock ids work with older agents that do not send `isStock`. A future
 * stock VP that has not been classified yet remains visible under "Other";
 * user-created VPs remain visible under "Custom" without requiring a storage
 * schema migration.
 *
 * @param {{vpId?: string, isStock?: boolean}|null|undefined} vp
 * @returns {string}
 */
export function vpDomainId(vp) {
  const vpId = typeof vp?.vpId === 'string' ? vp.vpId : '';
  if (VP_DOMAIN_BY_ID.has(vpId)) return VP_DOMAIN_BY_ID.get(vpId);
  return vp?.isStock === true ? 'other' : 'custom';
}

/**
 * Arrange renderable VP records into the product's stable domain sections
 * while preserving the incoming order inside each domain.
 *
 * @param {object[]|null|undefined} vps
 * @returns {Array<{id: string, labelKey: string, vps: object[]}>}
 */
export function buildVpDomainSections(vps) {
  const buckets = new Map(VP_DOMAIN_DEFINITIONS.map(domain => [domain.id, []]));
  for (const vp of Array.isArray(vps) ? vps : []) {
    if (!vp || typeof vp.vpId !== 'string' || !vp.vpId) continue;
    buckets.get(vpDomainId(vp)).push(vp);
  }

  return VP_DOMAIN_DEFINITIONS
    .map(domain => ({ id: domain.id, labelKey: domain.labelKey, vps: buckets.get(domain.id) }))
    .filter(domain => domain.vps.length > 0);
}

/**
 * Return the same records in the exact order produced by buildVpDomainSections().
 * Autocomplete keyboard navigation uses this helper so its flat cursor order
 * cannot diverge from the visually grouped list.
 *
 * @param {object[]|null|undefined} vps
 * @returns {object[]}
 */
export function orderVpsByDomain(vps) {
  return buildVpDomainSections(vps).flatMap(domain => domain.vps);
}

/**
 * Split an already-ranked list into consecutive domain segments without
 * reordering any record. Search results use this instead of buildVpDomainSections()
 * so an exact id hit stays ahead of alias and description matches. A domain
 * may appear more than once when relevance tiers interleave; the occurrence
 * suffix gives Vue a stable unique key for each visual segment.
 *
 * @param {object[]|null|undefined} vps
 * @returns {Array<{id: string, key: string, labelKey: string, vps: object[]}>}
 */
export function segmentVpsByDomain(vps) {
  const definitions = new Map(VP_DOMAIN_DEFINITIONS.map(domain => [domain.id, domain]));
  const occurrences = new Map();
  const segments = [];

  for (const vp of Array.isArray(vps) ? vps : []) {
    if (!vp || typeof vp.vpId !== 'string' || !vp.vpId) continue;
    const id = vpDomainId(vp);
    const previous = segments[segments.length - 1];
    if (previous && previous.id === id) {
      previous.vps.push(vp);
      continue;
    }

    const occurrence = (occurrences.get(id) || 0) + 1;
    occurrences.set(id, occurrence);
    segments.push({
      id,
      key: `${id}-${occurrence}`,
      labelKey: definitions.get(id).labelKey,
      vps: [vp],
    });
  }

  return segments;
}
