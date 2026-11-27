/**
 * Yeaft Cosmos — Data-Driven 3D Semantic Cosmic Web Graph
 *
 * Pure ES module (no DOM/Vue dependency) providing:
 * - `COSMIC_WEB_COLOR_MAP`: semantic color token palette (canvas RGB + CSS var)
 * - `buildSemanticCosmicWebGraph(graphData, prevGraph)`: deterministic 3D constellation
 *   layout for Domain Hubs + Cluster Satellites + cross-domain filaments, with smooth
 *   ambient fallback before first data load and in-place pulse/excitation preservation.
 * - `projectCosmicWeb(webGraph, w, h, anim, opts)`: single source of truth for 3D -> 2D
 *   projection shared by canvas rendering (`particle-hud.js`) and DOM star buttons (`stage-loop.js`).
 * - `triggerCosmicWebPulse(webGraph, { domainId, clusterId, count })`: injects bright burst
 *   pulses radiating along connected filaments.
 */

export const COSMIC_WEB_COLOR_MAP = Object.freeze({
  cyan: Object.freeze({
    rgba: 'rgba(124, 196, 255, 1)',
    rgb: Object.freeze([124, 196, 255]),
    cssVar: 'var(--c-cyan)',
  }),
  mint: Object.freeze({
    rgba: 'rgba(107, 228, 184, 1)',
    rgb: Object.freeze([107, 228, 184]),
    cssVar: 'var(--c-mint)',
  }),
  gold: Object.freeze({
    rgba: 'rgba(244, 194, 122, 1)',
    rgb: Object.freeze([244, 194, 122]),
    cssVar: 'var(--c-gold)',
  }),
  violet: Object.freeze({
    rgba: 'rgba(196, 166, 255, 1)',
    rgb: Object.freeze([196, 166, 255]),
    cssVar: 'var(--accent-purple)',
  }),
  rose: Object.freeze({
    rgba: 'rgba(255, 126, 136, 1)',
    rgb: Object.freeze([255, 126, 136]),
    cssVar: 'var(--c-danger)',
  }),
  amber: Object.freeze({
    rgba: 'rgba(255, 190, 92, 1)',
    rgb: Object.freeze([255, 190, 92]),
    cssVar: 'var(--c-amber)',
  }),
  coral: Object.freeze({
    rgba: 'rgba(255, 142, 102, 1)',
    rgb: Object.freeze([255, 142, 102]),
    cssVar: 'var(--c-coral, #ff8e66)',
  }),
  teal: Object.freeze({
    rgba: 'rgba(76, 215, 208, 1)',
    rgb: Object.freeze([76, 215, 208]),
    cssVar: 'var(--c-teal, #4cd7d0)',
  }),
  indigo: Object.freeze({
    rgba: 'rgba(142, 164, 255, 1)',
    rgb: Object.freeze([142, 164, 255]),
    cssVar: 'var(--c-indigo, #8ea4ff)',
  }),
});

export const WEB_ZOOM_LIMITS = Object.freeze({ min: 1.0, max: 4.5, lod2: 1.55, lod3: 2.75 });

export function getWebLodTier(zoom = 1) {
  return zoom >= WEB_ZOOM_LIMITS.lod3 ? 3 : zoom >= WEB_ZOOM_LIMITS.lod2 ? 2 : 1;
}

const MAX_CLUSTERS = 180;
const WEB_REST_TILT = 0.08;
const WEB_PROJECTION_SPREAD_X = 0.52;
const WEB_PROJECTION_SPREAD_Y = 0.66;
const CLUSTER_SHELL_RADII = [0.22, 0.43, 0.65];
const COLOR_KEYS = Object.keys(COSMIC_WEB_COLOR_MAP);
const MAX_ACTIVE_PULSES = 140;

/**
 * FNV-1a 32-bit deterministic string hash.
 * @param {string} str
 * @returns {number} unsigned 32-bit integer
 */
function hashString(str) {
  const s = String(str ?? '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic PRNG (Mulberry32).
 * @param {number} seed
 * @returns {() => number}
 */
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function resolveColor(colorToken, fallbackIdx = 0) {
  if (colorToken && Object.hasOwn(COSMIC_WEB_COLOR_MAP, colorToken)) {
    return { token: colorToken, ...COSMIC_WEB_COLOR_MAP[colorToken] };
  }
  const key = COLOR_KEYS[Math.abs(fallbackIdx) % COLOR_KEYS.length];
  return { token: key, ...COSMIC_WEB_COLOR_MAP[key] };
}

function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

/**
 * Build a gentle ambient 3D Cosmic Web graph for first-frame rendering before
 * server intelligence data arrives.
 */
function buildAmbientFallbackGraph(prevGraph) {
  if (prevGraph && prevGraph.isAmbient && Array.isArray(prevGraph.nodes) && prevGraph.nodes.length > 0) {
    return prevGraph;
  }
  const rnd = makeRng(88421);
  const nodes = [];
  for (let i = 0; i < 64; i++) {
    const isHub = i < 8;
    const col = resolveColor(null, i);
    nodes.push({
      id: `ambient:${i}`,
      kind: isHub ? 'hub' : 'cluster',
      domainId: null,
      clusterId: null,
      labelZh: '',
      labelEn: '',
      headline: '',
      colorToken: col.token,
      heatScore: isHub ? 80 : 30 + Math.round(rnd() * 40),
      itemCount: 0,
      unread: false,
      bookmarked: false,
      watchHit: false,
      sourceNames: [],
      publishedAt: null,
      baseR: isHub ? (0.95 + rnd() * 0.35) : (0.55 + rnd() * 0.45),
      isHub,
      x: (rnd() - 0.5) * 1.65,
      y: (rnd() - 0.5) * 1.12,
      z: (rnd() - 0.5) * 1.18,
      phase: rnd() * Math.PI * 2,
      excite: 0,
      color: col.rgba,
      rgb: [...col.rgb],
      neighbors: [],
    });
  }

  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    const dists = [];
    for (let j = i + 1; j < nodes.length; j++) {
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y, nodes[i].z - nodes[j].z);
      if (d < 0.62) dists.push({ j, d });
    }
    dists.sort((a, b) => a.d - b.d);
    const take = nodes[i].isHub ? 5 : 3;
    for (let k = 0; k < Math.min(take, dists.length); k++) {
      const j = dists[k].j;
      const edgeIdx = edges.length;
      edges.push({
        a: i,
        b: j,
        curve: (rnd() - 0.5) * 0.16,
        weight: Math.max(0.2, 1 - dists[k].d / 0.62),
        kind: (nodes[i].isHub && nodes[j].isHub) ? 'cross' : 'domain',
      });
      nodes[i].neighbors.push({ edgeIdx, dir: 1 });
      nodes[j].neighbors.push({ edgeIdx, dir: -1 });
    }
  }

  const pulses = [];
  for (let i = 0; i < 48 && edges.length > 0; i++) {
    const col = resolveColor(null, i);
    pulses.push({
      edgeIdx: i % edges.length,
      t: rnd(),
      dir: rnd() > 0.5 ? 1 : -1,
      speed: 0.42 + rnd() * 0.72,
      life: 0.65 + rnd() * 0.35,
      col: [...col.rgb],
      burst: false,
    });
  }

  return {
    isAmbient: true,
    nodes,
    edges,
    pulses,
    nodeIndexById: new Map(nodes.map((n, idx) => [n.id, idx])),
  };
}

/**
 * Compute deterministic 3D position for a Domain Hub on an organic constellation shell.
 * Using `hub.id` as the hash seed guarantees that refreshing never teleports existing hubs.
 *
 * @param {string} hubId
 * @param {number} index
 * @param {number} total
 * @returns {{ x: number, y: number, z: number, phase: number }}
 */
function placeHubDeterministically(hubId, index, total) {
  const seed = hashString(`hub:${hubId}`);
  const rnd = makeRng(seed);
  // Golden-angle spiral biased by hubId hash so adding/removing a domain keeps stability
  const golden = Math.PI * (3 - Math.sqrt(5));
  const u = ((seed % 10007) / 10007);
  const slotAngle = (index + 0.5) * golden + (u - 0.5) * 0.45;
  const bandY = total <= 1
    ? 0
    : clamp(((index / Math.max(1, total - 1)) - 0.5) * 1.45 + (rnd() - 0.5) * 0.24, -0.78, 0.78);
  const ringR = Math.sqrt(Math.max(0.18, 1 - bandY * bandY * 0.72));
  const radiusX = 0.62 + rnd() * 0.18;
  const radiusY = 0.48 + rnd() * 0.14;
  const radiusZ = 0.50 + rnd() * 0.16;

  return {
    x: Math.cos(slotAngle) * ringR * radiusX,
    y: bandY * radiusY,
    z: Math.sin(slotAngle) * ringR * radiusZ,
    phase: rnd() * Math.PI * 2,
  };
}

/** Spread each hub's stories by choosing the freest of several seeded points on their tier shell. */
function placeClusterDeterministically(clusterId, hubPos, heat, lodTier, neighbors) {
  const rnd = makeRng(hashString(`cluster:${clusterId}`));
  const phase = rnd() * Math.PI * 2;
  let best;
  let bestGap = -1;
  for (let i = 0; i < 12; i++) {
    const theta = rnd() * Math.PI * 2;
    const y = 2 * rnd() - 1;
    const ring = Math.sqrt(1 - y * y);
    const dist = CLUSTER_SHELL_RADII[lodTier - 1] * (1.12 - heat * 0.002) + rnd() * 0.075;
    const candidate = {
      x: hubPos.x + ring * Math.cos(theta) * dist,
      y: hubPos.y + y * dist * 0.80,
      z: hubPos.z + ring * Math.sin(theta) * dist * 0.90,
      phase,
    };
    let gap = Infinity;
    for (const other of neighbors) {
      const d2 = (candidate.x - other.x) ** 2 + (candidate.y - other.y) ** 2 + (candidate.z - other.z) ** 2;
      gap = Math.min(gap, d2);
    }
    if (gap > bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Build a semantic 3D Cosmic Web graph from Server `/api/cosmic-web/graph` payload.
 *
 * @param {Object|null} graphData - `{ hubs: [], nodes: [], edges: [] }`
 * @param {Object|null} prevGraph - previous webGraph instance to preserve excitation & pulses
 * @returns {{ isAmbient: boolean, nodes: Array, edges: Array, pulses: Array, nodeIndexById: Map }}
 */
export function buildSemanticCosmicWebGraph(graphData, prevGraph = null) {
  const rawHubs = Array.isArray(graphData?.hubs) ? graphData.hubs : [];
  const rawNodes = Array.isArray(graphData?.nodes) ? graphData.nodes : [];
  const rawEdges = Array.isArray(graphData?.edges) ? graphData.edges : [];

  if (rawHubs.length === 0 && rawNodes.length === 0) {
    return buildAmbientFallbackGraph(prevGraph);
  }

  // Snapshot previous excitation & positions by stable node id
  const prevById = new Map();
  if (prevGraph && !prevGraph.isAmbient && Array.isArray(prevGraph.nodes)) {
    for (const n of prevGraph.nodes) {
      if (n && n.id) prevById.set(n.id, n);
    }
  }

  const nodes = [];
  const nodeIndexById = new Map();
  const hubIndexByDomainId = new Map();

  // Sort hubs deterministically by id for stable shell distribution
  const sortedHubs = rawHubs.slice().sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));

  for (let i = 0; i < sortedHubs.length; i++) {
    const h = sortedHubs[i];
    const domainId = String(h.domainId || h.id || `domain-${i}`);
    const nodeId = `hub:${domainId}`;
    const col = resolveColor(h.colorToken, i);
    const prev = prevById.get(nodeId);
    const pos = prev
      ? { x: prev.x, y: prev.y, z: prev.z, phase: prev.phase }
      : placeHubDeterministically(domainId, i, sortedHubs.length);
    const heat = clamp(Number(h.heatScore ?? h.heat ?? 50), 0, 100);
    const itemCount = Number(h.itemCount ?? h.clusterCount ?? 0);

    const node = {
      id: nodeId,
      kind: 'hub',
      domainId,
      clusterId: null,
      labelZh: String(h.labelZh || h.nameZh || h.name || domainId),
      labelEn: String(h.labelEn || h.nameEn || h.name || domainId),
      headline: String(h.headline || h.labelZh || h.name || ''),
      colorToken: col.token,
      heatScore: heat,
      itemCount,
      unread: Boolean(h.unread ?? (Number(h.unreadCount || 0) > 0)),
      unreadCount: Number(h.unreadCount || 0),
      bookmarked: false,
      watchHit: Boolean(h.watchHit),
      sourceNames: Array.isArray(h.sourceNames) ? h.sourceNames : [],
      publishedAt: h.publishedAt || null,
      baseR: 1.05 + clamp(itemCount / 25, 0, 0.45),
      isHub: true,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      phase: pos.phase,
      excite: prev ? clamp(prev.excite, 0, 1) : 0.15,
      color: col.rgba,
      rgb: [...col.rgb],
      neighbors: [],
    };

    const idx = nodes.length;
    nodes.push(node);
    nodeIndexById.set(nodeId, idx);
    hubIndexByDomainId.set(domainId, idx);
    if (h.id && h.id !== nodeId) nodeIndexById.set(String(h.id), idx);
  }

  // Place Cluster satellite nodes around their primary Hub
  const positionedByDomain = new Map();
  const uniqueClusters = new Map();
  for (let i = 0; i < rawNodes.length && uniqueClusters.size < MAX_CLUSTERS; i++) {
    const c = rawNodes[i];
    if (!c) continue;
    const clusterId = String(c.clusterId || c.id || `cluster-${i}`);
    if (uniqueClusters.has(clusterId)) continue;
    const domainId = String(c.domainId || (Array.isArray(c.domainIds) ? c.domainIds[0] : '') || '') || null;
    const heat = clamp(Number(c.heatScore ?? c.heat ?? 35) || 0, 0, 100);
    const tier = Number(c.lodTier);
    // Untiered payloads keep their original overview behavior.
    const lodTier = tier === 2 || tier === 3 ? tier : 1;
    const prev = prevById.get(`cluster:${clusterId}`);
    const reuse = prev?.domainId === domainId && prev.lodTier === lodTier;
    if (!positionedByDomain.has(domainId)) positionedByDomain.set(domainId, []);
    if (reuse) positionedByDomain.get(domainId).push(prev);
    uniqueClusters.set(clusterId, { c, clusterId, domainId, heat, lodTier, prev, reuse, index: i });
  }
  // Seeded placement is independent of payload order on a cold load.
  const sortedClusters = [...uniqueClusters.values()].sort((a, b) => a.clusterId.localeCompare(b.clusterId));
  for (const { c, clusterId, domainId, heat, lodTier, prev, reuse, index } of sortedClusters) {
    const nodeId = `cluster:${clusterId}`;
    if (nodeIndexById.has(nodeId)) continue;

    const hubIdx = hubIndexByDomainId.get(domainId);
    const hubNode = hubIdx !== undefined ? nodes[hubIdx] : null;
    const hubPos = hubNode
      ? { x: hubNode.x, y: hubNode.y, z: hubNode.z }
      : { x: 0, y: 0, z: 0 };

    const col = resolveColor(c.colorToken || hubNode?.colorToken, index);
    const positioned = positionedByDomain.get(domainId);
    const pos = reuse ? prev : placeClusterDeterministically(clusterId, hubPos, heat, lodTier, positioned);
    if (!reuse) positioned.push(pos);

    const node = {
      id: nodeId,
      kind: 'cluster',
      domainId: domainId || null,
      clusterId,
      labelZh: String(c.labelZh || c.headline || c.title || ''),
      labelEn: String(c.labelEn || c.headline || c.title || ''),
      headline: String(c.headline || c.title || c.labelZh || ''),
      colorToken: col.token,
      heatScore: heat,
      itemCount: Number(c.itemCount ?? c.sourceCount ?? 1),
      unread: c.unread !== undefined ? Boolean(c.unread) : !c.isRead,
      bookmarked: Boolean(c.bookmarked ?? c.isBookmarked),
      watchHit: Boolean(c.watchHit),
      sourceNames: Array.isArray(c.sourceNames) ? c.sourceNames : [],
      publishedAt: c.publishedAt || null,
      lodTier,
      summaryExcerpt: String(c.summaryExcerpt ?? ''),
      mediaPreview: c.mediaPreview?.proxyUrl ? c.mediaPreview : null,
      topCommentPreview: c.topCommentPreview?.quote ? c.topCommentPreview : null,
      relatedClusterIds: Array.isArray(c.relatedClusterIds) ? [...c.relatedClusterIds] : [],
      baseR: (0.62 + heat * 0.0072) * (1 - (lodTier - 1) * 0.13) + (c.watchHit ? 0.18 : 0),
      isHub: false,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      phase: pos.phase,
      excite: prev ? clamp(prev.excite, 0, 1) : (c.watchHit ? 0.45 : 0),
      color: col.rgba,
      rgb: [...col.rgb],
      neighbors: [],
    };

    const idx = nodes.length;
    nodes.push(node);
    nodeIndexById.set(nodeId, idx);
    nodeIndexById.set(clusterId, idx);
  }

  // Build edges (from server edges + guaranteed hub->cluster filaments + hub backbone)
  const edges = [];
  const edgePairSet = new Set();

  const addEdge = (aIdx, bIdx, weight, kind) => {
    if (aIdx === undefined || bIdx === undefined || aIdx === bIdx) return;
    const lo = Math.min(aIdx, bIdx);
    const hi = Math.max(aIdx, bIdx);
    const key = `${lo}:${hi}`;
    if (edgePairSet.has(key)) return;
    edgePairSet.add(key);

    const seed = hashString(`edge:${nodes[lo].id}->${nodes[hi].id}`);
    const rnd = makeRng(seed);
    const edgeIdx = edges.length;
    edges.push({
      a: lo,
      b: hi,
      curve: (rnd() - 0.5) * (kind === 'cross' ? 0.22 : 0.14),
      weight: clamp(Number(weight) || 0.5, 0.15, 1.0),
      kind: kind === 'story' || kind === 'cross' ? kind : 'domain',
    });
    nodes[lo].neighbors.push({ edgeIdx, dir: 1 });
    nodes[hi].neighbors.push({ edgeIdx, dir: -1 });
  };

  // Explicit story relations take precedence over generic filaments for the same pair.
  for (let i = 0; i < nodes.length; i++) {
    for (const id of nodes[i].relatedClusterIds || []) {
      const target = String(id);
      const related = nodeIndexById.get(`cluster:${target}`)
        ?? (target.startsWith('cluster:') ? nodeIndexById.get(target) : undefined);
      addEdge(i, related, 0.34, 'story');
    }
  }

  // 1) Server-provided semantic edges
  for (const e of rawEdges) {
    if (!e) continue;
    const srcKey = String(e.source ?? e.from ?? e.a ?? '');
    const dstKey = String(e.target ?? e.to ?? e.b ?? '');
    const aIdx = nodeIndexById.get(srcKey)
      ?? nodeIndexById.get(`hub:${srcKey}`)
      ?? nodeIndexById.get(`cluster:${srcKey}`);
    const bIdx = nodeIndexById.get(dstKey)
      ?? nodeIndexById.get(`hub:${dstKey}`)
      ?? nodeIndexById.get(`cluster:${dstKey}`);
    if (aIdx !== undefined && bIdx !== undefined) {
      addEdge(aIdx, bIdx, e.weight ?? 0.65, e.kind || 'cross');
    }
  }

  // 2) Ensure every cluster connects to its primary domain hub
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'cluster' && n.domainId) {
      const hIdx = hubIndexByDomainId.get(n.domainId);
      if (hIdx !== undefined) {
        addEdge(hIdx, i, 0.45 + clamp(n.heatScore / 100, 0, 0.5), 'domain');
      }
    }
  }

  // 3) Connect hubs into a subtle inter-domain cosmic web backbone
  const hubIndices = [...hubIndexByDomainId.values()];
  for (let i = 0; i < hubIndices.length; i++) {
    const a = hubIndices[i];
    const dists = [];
    for (let j = 0; j < hubIndices.length; j++) {
      if (i === j) continue;
      const b = hubIndices[j];
      const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y, nodes[a].z - nodes[b].z);
      dists.push({ b, d });
    }
    dists.sort((x, y) => x.d - y.d);
    const take = Math.min(2, dists.length);
    for (let k = 0; k < take; k++) {
      addEdge(a, dists[k].b, Math.max(0.25, 0.72 - dists[k].d * 0.35), 'cross');
    }
  }

  // 4) Lightly connect nearest clusters inside the same domain for constellation filaments
  const clustersByDomain = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind !== 'cluster' || !n.domainId) continue;
    if (!clustersByDomain.has(n.domainId)) clustersByDomain.set(n.domainId, []);
    clustersByDomain.get(n.domainId).push(i);
  }
  for (const list of clustersByDomain.values()) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const b = list[j];
        const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y, nodes[a].z - nodes[b].z);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = b;
        }
      }
      if (bestIdx >= 0 && bestDist < 0.42) {
        addEdge(a, bestIdx, Math.max(0.22, 0.58 - bestDist), 'domain');
      }
    }
  }

  // Preserve active pulses from prevGraph where possible, then fill ambient pulses
  const pulses = [];
  if (prevGraph && !prevGraph.isAmbient && Array.isArray(prevGraph.pulses) && edges.length > 0) {
    const edgeIndexByPairKey = new Map();
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const k1 = `${nodes[e.a].id}|${nodes[e.b].id}`;
      const k2 = `${nodes[e.b].id}|${nodes[e.a].id}`;
      edgeIndexByPairKey.set(k1, i);
      edgeIndexByPairKey.set(k2, i);
    }
    for (const pl of prevGraph.pulses) {
      if (!pl || pulses.length >= MAX_ACTIVE_PULSES) break;
      const oldEdge = prevGraph.edges?.[pl.edgeIdx];
      if (!oldEdge) continue;
      const oldA = prevGraph.nodes?.[oldEdge.a]?.id;
      const oldB = prevGraph.nodes?.[oldEdge.b]?.id;
      if (!oldA || !oldB) continue;
      const mappedIdx = edgeIndexByPairKey.get(`${oldA}|${oldB}`);
      if (mappedIdx !== undefined) {
        pulses.push({
          edgeIdx: mappedIdx,
          t: clamp(pl.t, 0, 1),
          dir: pl.dir >= 0 ? 1 : -1,
          speed: pl.speed || 0.65,
          life: clamp(pl.life ?? 0.85, 0.2, 1.0),
          col: Array.isArray(pl.col) ? [...pl.col] : [124, 196, 255],
          burst: Boolean(pl.burst),
        });
      }
    }
  }

  const targetBaselinePulses = Math.min(56, Math.max(18, Math.floor(edges.length * 0.65)));
  const pulseRnd = makeRng(hashString(`pulses:${nodes.length}:${edges.length}`));
  while (pulses.length < targetBaselinePulses && edges.length > 0) {
    const edgeIdx = pulses.length % edges.length;
    const edge = edges[edgeIdx];
    const srcNode = nodes[edge.a];
    pulses.push({
      edgeIdx,
      t: pulseRnd(),
      dir: pulseRnd() > 0.5 ? 1 : -1,
      speed: 0.38 + pulseRnd() * 0.68,
      life: 0.65 + pulseRnd() * 0.35,
      col: srcNode?.rgb ? [...srcNode.rgb] : [124, 196, 255],
      burst: false,
    });
  }

  return {
    isAmbient: false,
    nodes,
    edges,
    pulses,
    nodeIndexById,
  };
}

/**
 * Single source of truth for 3D -> 2D Cosmic Web projection.
 * Shared by `particle-hud.js` (canvas filaments/stars) and `stage-loop.js` (DOM star buttons).
 *
 * @param {Object} webGraph
 * @param {number} w - viewport CSS width
 * @param {number} h - viewport CSS height
 * @param {Object} anim - Cosmos animation state (`realTime`, `camRot`, `parallax`)
 * @param {Object} [opts]
 * @param {number} [opts.centerShiftX=0] - horizontal screen offset in px (e.g., negative when right drawer open)
 * @param {number} [opts.centerShiftY=0] - vertical screen offset in px
 * @param {number} [opts.scale=1] - projection scale multiplier
 * @param {number} [opts.webZoom=1] - zoom about the shifted viewport center
 * @param {number} [opts.webPanX=0] - translation in normalized zoomed spread units (positive moves stars right)
 * @param {number} [opts.webPanY=0] - translation in normalized zoomed spread units (positive moves stars down)
 * @returns {Array<{ x: number, y: number, z: number, persp: number, visible: boolean, node: Object }>}
 */
export function projectCosmicWeb(webGraph, w, h, anim, opts = {}) {
  if (!webGraph || !Array.isArray(webGraph.nodes) || webGraph.nodes.length === 0) {
    return [];
  }
  const realTime = Number(anim?.realTime || 0);
  const camX = Number(anim?.camRot?.x || 0);
  const camY = Number(anim?.camRot?.y || 0);
  const parX = Number(anim?.parallax?.x || 0);
  const parY = Number(anim?.parallax?.y || 0);

  const centerShiftX = Number(opts.centerShiftX || 0);
  const centerShiftY = Number(opts.centerShiftY || 0);
  const scale = Number(opts.scale || 1);

  const webZoom = clamp(Number.isFinite(opts.webZoom) ? opts.webZoom : 1, 0.85, 5);
  const panX = Number.isFinite(opts.webPanX) ? opts.webPanX : 0;
  const panY = Number.isFinite(opts.webPanY) ? opts.webPanY : 0;
  // Fade pointer/ambient rotation to the reference pose at close range so focus targets stay locked.
  const restTilt = WEB_REST_TILT;
  const drift = webZoom <= 1 ? 1 : clamp((2.15 - webZoom) / 1.15, 0, 1);
  const rotY = (Math.sin(realTime * 0.07) * 0.14 + camX * 0.35 + parX * 0.08) * drift;
  const animatedTilt = Math.cos(realTime * 0.055) * restTilt + camY * 0.28 + parY * 0.06;
  const rotX = drift === 1 ? animatedTilt : restTilt + (animatedTilt - restTilt) * drift;
  const cY = Math.cos(rotY);
  const sY = Math.sin(rotY);
  const cX = Math.cos(rotX);
  const sX = Math.sin(rotX);

  const cx = w * 0.5 + centerShiftX;
  const cy = h * 0.5 + centerShiftY;
  const spreadX = w * WEB_PROJECTION_SPREAD_X * scale;
  const spreadY = h * WEB_PROJECTION_SPREAD_Y * scale;

  const nodes = webGraph.nodes;
  const out = new Array(nodes.length);

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const x1 = n.x * cY - n.z * sY;
    const z1 = n.x * sY + n.z * cY;
    const y2 = n.y * cX - z1 * sX;
    const z2 = n.y * sX + z1 * cX;
    const denom = Math.max(0.22, 1.0 - z2 * 0.34);
    const persp = 1.0 / denom;
    const sx = cx + (x1 * spreadX * persp + panX * spreadX) * webZoom;
    const sy = cy + (y2 * spreadY * persp + panY * spreadY) * webZoom;
    const visible = z2 > -1.8 && sx >= -80 && sx <= w + 80 && sy >= -80 && sy <= h + 80;
    out[i] = { x: sx, y: sy, z: z2, persp, visible, node: n };
  }

  return out;
}

/** Camera target in normalized projection units; null when the requested node is absent. */
export function findWebNodeFocusTarget(webGraph, { domainId, clusterId } = {}) {
  const nodes = webGraph?.nodes;
  const cluster = clusterId == null ? null : nodes?.find((n) => !n.isHub && n.clusterId === String(clusterId));
  const node = cluster || (domainId == null ? null : nodes?.find((n) => n.isHub && n.domainId === String(domainId)));
  if (!node) return null;
  const targetZoom = node.isHub ? 2.15 : 3.35;
  const [point] = projectCosmicWeb({ nodes: [node] }, 1, 1, null, { webZoom: targetZoom });
  return {
    panX: (0.5 - point.x) / (WEB_PROJECTION_SPREAD_X * targetZoom),
    panY: (0.5 - point.y) / (WEB_PROJECTION_SPREAD_Y * targetZoom),
    targetZoom,
  };
}

const LABEL_SIZES = { hub: [155, 28], cluster: [168, 26] };
const SATELLITE_SIZES = { source: [104, 26], excerpt: [154, 30], media: [104, 34], comment: [152, 36] };
const LAYOUT_PADDING = 4;

function oneLine(text, limit) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Pure screen-space layout. Label overrides (`labelX`, `labelY`, `labelMaxWidth`)
 * do not move the underlying projected stars. Satellite IDs identify DOM slots;
 * their keys change if the displayed content changes, never on movement alone.
 */
export function computeWebLodLayout(projected, {
  w = 0, h = 0, webZoom = 1, drawerRightEdge = w, focusedDomainId = null,
  selectedClusterId = null, hoveredClusterId = null, activeClusterDetail = null,
} = {}) {
  const lodTier = getWebLodTier(webZoom);
  const visibleNodeIds = new Set();
  const projectedById = new Map();
  const satellites = [];
  const result = { lodTier, visibleNodeIds, projectedById, focusNode: null, satellites };
  const left = 56, right = Math.min(w, drawerRightEdge) - 24;
  const top = 68, bottom = h - 72;
  const centerX = (left + right) / 2, centerY = (top + bottom) / 2;
  const distance = (p) => (p.x - centerX) ** 2 + (p.y - centerY) ** 2;
  const candidates = [];
  let selected, hovered;

  for (const p of projected || []) {
    if (!p?.node?.id) continue;
    projectedById.set(p.node.id, p);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const n = p.node;
    const isSelected = selectedClusterId != null && n.clusterId === String(selectedClusterId);
    const isHovered = hoveredClusterId != null && n.clusterId === String(hoveredClusterId);
    if (isSelected) selected = p;
    if (isHovered) hovered = p;
    if (!isSelected && !isHovered && !p.visible) continue;
    const tier = n.lodTier || 1;
    if (!isSelected && !isHovered && !n.isHub && !n.watchHit && tier > 1 && lodTier < 2) continue;
    const priority = isSelected ? 0 : isHovered ? 1 : n.isHub ? 2 : n.watchHit ? 3 : 3 + tier;
    candidates.push({ p, priority, focused: n.domainId === focusedDomainId && focusedDomainId != null, d2: distance(p) });
  }
  if (right - left <= LAYOUT_PADDING * 2 || bottom <= top) return result;
  candidates.sort((a, b) => a.priority - b.priority
    || (a.priority === 6 ? a.d2 - b.d2 : Number(b.focused) - Number(a.focused))
    || (b.p.node.heatScore || 0) - (a.p.node.heatScore || 0)
    || a.d2 - b.d2 || a.p.node.id.localeCompare(b.p.node.id));

  const occupied = [];
  const makeBox = (x, y, halfW, halfH) => ({ l: x - halfW, r: x + halfW, t: y - halfH, b: y + halfH });
  const fits = (box) => box.l >= left && box.r <= right && box.t >= top && box.b <= bottom
    && !occupied.some((b) => box.l < b.r && box.r > b.l && box.t < b.b && box.b > b.t);
  const maxStars = [12, 34, 44][lodTier - 1];
  let stars = 0;
  let closest, closestD2 = Infinity;
  for (const { p, priority, d2 } of candidates) {
    const { node: n } = p;
    const pinned = priority <= 1;
    if (!n.isHub && stars >= maxStars) continue;
    const [width, height] = LABEL_SIZES[n.isHub ? 'hub' : 'cluster'];
    const labelMaxWidth = Math.min(width, right - left - LAYOUT_PADDING * 2);
    const hw = labelMaxWidth / 2 + LAYOUT_PADDING;
    const hh = height / 2 + LAYOUT_PADDING;
    let x = p.x, y = p.y;
    if (pinned) {
      x = clamp(x, left + hw, right - hw);
      y = clamp(y, top + hh, bottom - hh);
    }
    let box = makeBox(x, y, hw, hh);
    if (pinned && !fits(box)) {
      // Keep both active stories if possible, without allowing their pills to overlap.
      const alternatives = occupied.flatMap((b) => [
        [x, b.t - hh], [x, b.b + hh], [b.l - hw, y], [b.r + hw, y],
      ]).sort((a, b) => Math.hypot(a[0] - x, a[1] - y) - Math.hypot(b[0] - x, b[1] - y));
      const next = alternatives.find(([ax, ay]) => fits(makeBox(ax, ay, hw, hh)));
      if (next) {
        [x, y] = next;
        box = makeBox(x, y, hw, hh);
      }
    }
    if (!fits(box)) continue;
    occupied.push(box);
    visibleNodeIds.add(n.id);
    projectedById.set(n.id, { ...p, labelX: x, labelY: y, labelMaxWidth });
    if (!n.isHub) {
      stars++;
      if (n.clusterId != null && d2 < closestD2) {
        closest = p;
        closestD2 = d2;
      }
    }
  }

  const focus = selected || hovered || closest;
  result.focusNode = focus || null;
  if (!focus || (lodTier < 3 && !(selected && webZoom >= 2.35))) return result;
  const { x: parentX, y: parentY, node } = focus;
  if (parentX < left || parentX > right || parentY < top || parentY > bottom) return result;
  const rawDetailId = activeClusterDetail?.clusterId ?? activeClusterDetail?.id;
  const detail = rawDetailId != null
    ? (String(rawDetailId) === node.clusterId ? activeClusterDetail : null)
    : (selected === focus || hovered === focus ? activeClusterDetail : null);
  const content = [];
  const sourceNames = [...new Set((node.sourceNames || []).map((name) => oneLine(name, 24)).filter(Boolean))];
  for (const [i, label] of sourceNames.slice(0, 2).entries()) content.push({ kind: 'source', slot: `source:${i}`, label });
  const excerpt = oneLine(node.summaryExcerpt, 68);
  if (excerpt) content.push({ kind: 'excerpt', label: excerpt });
  const mediaPreview = detail?.media?.[0] || (node.mediaPreview?.proxyUrl ? node.mediaPreview : null);
  if (mediaPreview) content.push({ kind: 'media', label: String(mediaPreview.kind || ''), mediaPreview });
  const comment = detail?.communityComments?.[0] || node.topCommentPreview;
  const quote = oneLine(comment?.quote ?? comment?.text, 64);
  if (quote) {
    const rawLikes = comment.likes;
    const likes = typeof rawLikes === 'string' && rawLikes.trim()
      ? rawLikes.trim().slice(0, 24)
      : (Number.isFinite(Number(rawLikes)) && Number(rawLikes) > 0 ? Number(rawLikes) : '');
    const topCommentPreview = { platform: String(comment.platform || ''), quote, likes };
    content.push({ kind: 'comment', label: quote, topCommentPreview });
  }

  const radius = 112;
  const towardCenter = Math.atan2(centerY - parentY, centerX - parentX);
  for (const [i, item] of content.entries()) {
    const [width, height] = SATELLITE_SIZES[item.kind];
    const hw = width / 2 + LAYOUT_PADDING, hh = height / 2 + LAYOUT_PADDING;
    let placement;
    // Prefer a regular orbit; probe adjacent angles and a wider radius if a label is in the way.
    for (const r of [radius, 128, 96]) {
      for (let s = 0; s < 16; s++) {
        const offset = s % 2 ? (s + 1) / 2 : -s / 2;
        const angle = towardCenter + i * Math.PI * 2 / content.length + offset * Math.PI / 8;
        const x = clamp(parentX + Math.cos(angle) * r, left + hw, right - hw);
        const y = clamp(parentY + Math.sin(angle) * r, top + hh, bottom - hh);
        const box = makeBox(x, y, hw, hh);
        if (Math.hypot(x - parentX, y - parentY) < 70 || !fits(box)) continue;
        placement = { x, y, box };
        break;
      }
      if (placement) break;
    }
    if (!placement) continue;
    const { x, y, box } = placement;
    occupied.push(box);
    const id = `${node.id}:${item.slot || item.kind}`;
    const key = JSON.stringify([id, item.label, item.mediaPreview?.proxyUrl, item.topCommentPreview?.platform, item.topCommentPreview?.likes, node.colorToken]);
    satellites.push({ ...item, id, key, x, y, parentX, parentY, radius,
      clusterId: node.clusterId, colorToken: node.colorToken, width, height });
  }
  return result;
}

/**
 * Inject bright burst pulses emanating from a target Hub or Cluster node along its edges,
 * and boost its excitation to 1.0.
 *
 * @param {Object} webGraph
 * @param {Object} [target]
 * @param {string|null} [target.domainId]
 * @param {string|null} [target.clusterId]
 * @param {number} [target.count=8]
 * @returns {number} number of burst pulses injected
 */
export function triggerCosmicWebPulse(webGraph, { domainId = null, clusterId = null, count = 8 } = {}) {
  if (!webGraph || !Array.isArray(webGraph.nodes) || !Array.isArray(webGraph.edges) || webGraph.edges.length === 0) {
    return 0;
  }
  const targetIndices = [];
  if (clusterId) {
    const idx = webGraph.nodeIndexById?.get(`cluster:${clusterId}`) ?? webGraph.nodeIndexById?.get(String(clusterId));
    if (idx !== undefined) targetIndices.push(idx);
  }
  if (targetIndices.length === 0 && domainId) {
    const idx = webGraph.nodeIndexById?.get(`hub:${domainId}`) ?? webGraph.nodeIndexById?.get(String(domainId));
    if (idx !== undefined) targetIndices.push(idx);
  }
  if (targetIndices.length === 0) {
    // Global refresh burst: excite all hubs
    for (let i = 0; i < webGraph.nodes.length; i++) {
      if (webGraph.nodes[i].isHub) targetIndices.push(i);
    }
  }
  if (targetIndices.length === 0) return 0;

  let injected = 0;
  const perTarget = Math.max(1, Math.ceil(count / targetIndices.length));

  for (const idx of targetIndices) {
    const node = webGraph.nodes[idx];
    if (!node) continue;
    node.excite = 1.0;

    const neighbors = Array.isArray(node.neighbors) ? node.neighbors : [];
    if (neighbors.length === 0) continue;

    for (let k = 0; k < perTarget && injected < count; k++) {
      const nb = neighbors[k % neighbors.length];
      if (!nb || webGraph.edges[nb.edgeIdx] === undefined) continue;
      if (webGraph.pulses.length >= MAX_ACTIVE_PULSES) {
        // Evict oldest non-burst pulse or oldest pulse
        const evictIdx = webGraph.pulses.findIndex((p) => !p.burst);
        webGraph.pulses.splice(evictIdx >= 0 ? evictIdx : 0, 1);
      }
      webGraph.pulses.push({
        edgeIdx: nb.edgeIdx,
        t: nb.dir > 0 ? 0.0 : 1.0,
        dir: nb.dir >= 0 ? 1 : -1,
        speed: 1.05 + (k % 3) * 0.22,
        life: 1.0,
        col: Array.isArray(node.rgb) ? [...node.rgb] : [124, 196, 255],
        burst: true,
      });
      injected++;
    }
  }

  return injected;
}
