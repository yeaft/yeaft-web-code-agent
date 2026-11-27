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
});

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
  if (colorToken && COSMIC_WEB_COLOR_MAP[colorToken]) {
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

/**
 * Compute deterministic 3D satellite position in an orbital filament around its primary Hub.
 *
 * @param {string} clusterId
 * @param {{ x: number, y: number, z: number }} hubPos
 * @param {number} heatScore
 * @returns {{ x: number, y: number, z: number, phase: number }}
 */
function placeClusterDeterministically(clusterId, hubPos, heatScore) {
  const seed = hashString(`cluster:${clusterId}`);
  const rnd = makeRng(seed);
  const theta = rnd() * Math.PI * 2;
  const phi = Math.acos(2 * rnd() - 1);
  // Hotter stories orbit slightly closer and more prominently to their hub
  const normHeat = clamp((Number(heatScore) || 20) / 100, 0, 1);
  const dist = 0.15 + (1 - normHeat * 0.42) * 0.26 + rnd() * 0.14;

  const dx = Math.sin(phi) * Math.cos(theta) * dist;
  const dy = Math.cos(phi) * dist * 0.76;
  const dz = Math.sin(phi) * Math.sin(theta) * dist * 0.88;

  return {
    x: clamp(hubPos.x + dx, -0.95, 0.95),
    y: clamp(hubPos.y + dy, -0.66, 0.66),
    z: clamp(hubPos.z + dz, -0.72, 0.72),
    phase: rnd() * Math.PI * 2,
  };
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
  for (let i = 0; i < rawNodes.length; i++) {
    const c = rawNodes[i];
    const clusterId = String(c.clusterId || c.id || `cluster-${i}`);
    const nodeId = `cluster:${clusterId}`;
    if (nodeIndexById.has(nodeId)) continue;

    const domainId = String(c.domainId || (Array.isArray(c.domainIds) ? c.domainIds[0] : '') || '');
    const hubIdx = hubIndexByDomainId.get(domainId);
    const hubNode = hubIdx !== undefined ? nodes[hubIdx] : null;
    const hubPos = hubNode
      ? { x: hubNode.x, y: hubNode.y, z: hubNode.z }
      : { x: 0, y: 0, z: 0 };

    const col = resolveColor(c.colorToken || hubNode?.colorToken, i);
    const prev = prevById.get(nodeId);
    const heat = clamp(Number(c.heatScore ?? c.heat ?? 35), 0, 100);
    const pos = prev
      ? { x: prev.x, y: prev.y, z: prev.z, phase: prev.phase }
      : placeClusterDeterministically(clusterId, hubPos, heat);

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
      baseR: 0.62 + clamp(heat / 100, 0, 1) * 0.72 + (c.watchHit ? 0.18 : 0),
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
      kind: kind === 'cross' ? 'cross' : 'domain',
    });
    nodes[lo].neighbors.push({ edgeIdx, dir: 1 });
    nodes[hi].neighbors.push({ edgeIdx, dir: -1 });
  };

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

  const rotY = Math.sin(realTime * 0.07) * 0.14 + camX * 0.35 + parX * 0.08;
  const rotX = Math.cos(realTime * 0.055) * 0.08 + camY * 0.28 + parY * 0.06;
  const cY = Math.cos(rotY);
  const sY = Math.sin(rotY);
  const cX = Math.cos(rotX);
  const sX = Math.sin(rotX);

  const cx = w * 0.5 + centerShiftX;
  const cy = h * 0.5 + centerShiftY;
  const spreadX = w * 0.52 * scale;
  const spreadY = h * 0.66 * scale;

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
    const sx = cx + x1 * spreadX * persp;
    const sy = cy + y2 * spreadY * persp;
    const visible = z2 > -1.8 && sx >= -80 && sx <= w + 80 && sy >= -80 && sy <= h + 80;
    out[i] = { x: sx, y: sy, z: z2, persp, visible, node: n };
  }

  return out;
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
