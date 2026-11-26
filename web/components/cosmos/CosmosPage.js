/**
 * Yeaft Cosmos — Main 4-Scale Living Universe Workspace
 *
 * Scales: Cosmic Web (10^24) · Galaxy Library (10^21) · Solar System (10^13) · Event Horizon (10^7)
 * Interactions:
 * - Click planet -> Quick Auto-Route Composer (`yeaft_auto_route_send`) with direct "Open Chat" button
 * - Hover planet -> Session preview card -> Click session -> Right Planetary Conversation Drawer
 * - Click active session in orbit micro-list -> Right Planetary Conversation Drawer
 * - Drag planet onto another planet -> Move or swap Agent orbits (persisted)
 * - Scroll wheel / deep-sky portals / left ruler -> Smooth multi-scale zoom transition
 * - Top-right micro-icons -> Cosmic Constants (+ authentic Yeaft Settings) & Abandon Cosmos (-> classic UI)
 */
import {
  PLANETS,
  BOOK_DOMAINS,
  loadCosmosConstants,
  saveCosmosConstants,
  loadPlanetBindings,
  savePlanetBindings,
  resolvePlanetAssignments,
  moveOrSwapPlanetBinding,
  scaleBand,
  loadGalaxyBooks,
  saveGalaxyBooks,
} from '../../cosmos/constants.js';
import { createCosmosEngine } from '../../cosmos/gl-engine.js';
import { createParticlePools, createCosmicWebGraph } from '../../cosmos/particle-hud.js';
import {
  COSMIC_EVENTS,
  createCosmicEventState,
  startCosmicEvent,
  stopCosmicEvent,
  setCosmicEventZoom,
  pickRandomEventIndex,
} from '../../cosmos/events-controller.js';
import { stepCosmosFrame } from '../../cosmos/stage-loop.js';
import { projectAgentsForCosmos } from '../../cosmos/agent-projection.js';
import { getLocale } from '../../utils/i18n.js';

import CosmosQuickComposer from './CosmosQuickComposer.js';
import CosmosConversationDrawer from './CosmosConversationDrawer.js';
import CosmosConstantsPopover from './CosmosConstantsPopover.js';
import CosmosEventsOverlay from './CosmosEventsOverlay.js';
import SettingsPanel from '../SettingsPanel.js';
import AgentSettingsPanel from '../AgentSettingsPanel.js';
import SessionCreateModal from '../SessionCreateModal.js';

export default {
  name: 'CosmosPage',
  components: {
    CosmosQuickComposer,
    CosmosConversationDrawer,
    CosmosConstantsPopover,
    CosmosEventsOverlay,
    SettingsPanel,
    AgentSettingsPanel,
    SessionCreateModal,
  },
  template: `
    <div
      class="cosmos-page"
      :class="{
        'is-drawer-open': drawerOpen,
        'is-workbench-widened': workbenchWidened,
        'is-drag-mode': dragActive,
      }"
      @wheel="onStageWheel"
    >
      <canvas ref="glCanvasRef" :key="canvasEpoch" class="cosmos-gl-canvas" :class="{ 'is-orbiting': camOrbiting }" @pointerdown="onCanvasPointerDown" @dblclick="resetCamera"></canvas>
      <canvas ref="hudCanvasRef" class="cosmos-hud-canvas"></canvas>

      <!-- Spatial Interactive Layer (Zero-VDOM-diff direct transform updates via refs) -->
      <div class="cosmos-spatial-layer">
        <div
          v-for="p in planets"
          :key="p.id"
          :ref="(el) => setMapRef(domRefs.planets, p.id, el)"
          class="cosmos-planet-node"
          :class="{
            'has-agent': Boolean(agentsByPlanet[p.id]),
            'is-uninhabited': !agentsByPlanet[p.id],
            'is-selected': focusedPlanetId === p.id,
            'is-dragging': dragFromPlanetId === p.id,
            'is-drop-target': dragOverPlanetId === p.id,
          }"
          :data-planet-id="p.id"
          style="display:none"
          @pointerenter="onPlanetEnter(p.id, $event)"
          @pointerleave="onPlanetLeave(p.id, $event)"
        >
          <div
            :ref="(el) => setMapRef(domRefs.hits, p.id, el)"
            class="cosmos-planet-hit"
            @pointerdown.stop="onPlanetPointerDown(p.id, $event)"
          ></div>

          <button
            type="button"
            :ref="(el) => setMapRef(domRefs.tags, p.id, el)"
            class="cosmos-planet-tag"
            :class="planetTagClass(p.id)"
            @pointerdown.stop="onPlanetPointerDown(p.id, $event)"
          >
            <template v-if="agentsByPlanet[p.id]">
              <span class="cosmos-status-pip" :class="planetPipClass(agentsByPlanet[p.id])"></span>
              <span>{{ agentsByPlanet[p.id].name }}</span>
              <span
                v-if="agentsByPlanet[p.id].liveSessions.length > 0"
                class="cosmos-planet-count"
                :class="{ 'is-waiting': agentsByPlanet[p.id].status === 'waiting' }"
              >{{ agentsByPlanet[p.id].liveSessions.length }}</span>
            </template>
            <template v-else>
              {{ $t('cosmos.planets.' + p.id + '.name') }}
            </template>
          </button>

          <!-- Compact 2~3 line active session micro-list directly below active planets -->
          <div
            v-if="agentsByPlanet[p.id] && agentsByPlanet[p.id].liveSessions.length > 0 && constants.livePreviewMode !== 'hover'"
            :ref="(el) => setMapRef(domRefs.liveCards, p.id, el)"
            class="cosmos-live-card"
            :class="{ 'is-waiting': agentsByPlanet[p.id].status === 'waiting' }"
            @pointerdown.stop
          >
            <button
              v-for="s in agentsByPlanet[p.id].liveSessions.slice(0, 2)"
              :key="s.catalogKey"
              type="button"
              class="cosmos-live-row"
              @click.stop="openSessionInDrawer(agentsByPlanet[p.id].id, s)"
            >
              <div class="cosmos-live-top">
                <span class="cosmos-status-pip" :class="[s.status, constants.activeFlash && s.status === 'running' ? 'is-flashing' : '']"></span>
                <span class="cosmos-live-title">{{ s.title }}</span>
                <span class="cosmos-live-time">{{ s.updatedLabel }}</span>
              </div>
              <div
                class="cosmos-live-snippet"
                :class="[constants.livePreviewMode === '3' ? 'lines-3' : 'lines-2', { 'is-waiting': s.status === 'waiting' }]"
              >{{ s.summary }}</div>
            </button>
          </div>
        </div>

        <!-- Deep-Sky Astronomical Portals -->
        <button
          v-for="pt in portals"
          :key="pt.id"
          :ref="(el) => setMapRef(domRefs.portals, pt.id, el)"
          type="button"
          class="cosmos-sky-anomaly"
          style="display:none"
          @click.stop="jumpToScale(pt.target)"
        >
          <span class="cosmos-sky-anomaly-ring" :style="{ width: pt.ring + 'px', height: pt.ring + 'px' }"></span>
          <span class="cosmos-sky-anomaly-label">
            <span>{{ $t(pt.labelKey) }}</span>
            <span class="cosmos-sky-anomaly-scale">{{ pt.scale }}</span>
          </span>
        </button>

        <!-- Return to Solar System Beacon -->
        <button
          :ref="(el) => { domRefs.homeBeacon.value = el; }"
          type="button"
          class="cosmos-home-beacon"
          style="display:none"
          @click.stop="jumpToScale(13.0)"
        >{{ $t('cosmos.scale.homeSolar') }}</button>

        <!-- Galaxy Book Clusters -->
        <button
          v-for="b in galaxyBooks"
          :key="b.id"
          :ref="(el) => setMapRef(domRefs.books, b.id, el)"
          type="button"
          class="cosmos-book-dot"
          style="display:none"
          @click.stop="showToast($t('cosmos.galaxy.bookPending', { title: b.title }))"
        >
          <span class="cosmos-status-pip" :style="{ background: b.color, boxShadow: '0 0 7px ' + b.color }"></span>
          <span>{{ b.title }}</span>
        </button>
      </div>

      <!-- Hover Session Preview Card (Click specific session -> Opens Right Conversation Drawer) -->
      <div
        v-if="hoverCardAgent && !dragActive && currentBand === 'solar' && !isObservingEvent"
        ref="hoverCardRef"
        class="cosmos-hover-card"
        :style="hoverCardStyle"
        @pointerenter="onHoverCardEnter"
        @pointerleave="onHoverCardLeave"
        @pointerdown.stop
        @wheel.stop
      >
        <div class="cosmos-hover-head">
          <span class="cosmos-hover-id">
            <span class="cosmos-status-pip" :class="hoverCardAgent.status"></span>
            <span>{{ hoverCardAgent.name }}</span>
            <span class="cosmos-hover-planet">· {{ $t('cosmos.planets.' + hoverPlanetId + '.name') }}</span>
          </span>
          <span class="cosmos-hover-path" v-if="hoverCardAgent.folder">{{ hoverCardAgent.folder }}</span>
        </div>

        <div class="cosmos-hover-list">
          <button
            v-for="s in hoverPreviewSessions"
            :key="s.catalogKey"
            type="button"
            class="cosmos-hover-row"
            @click.stop="openSessionInDrawer(hoverCardAgent.id, s)"
          >
            <span class="cosmos-status-pip" :class="s.status"></span>
            <div class="cosmos-hover-main">
              <div class="cosmos-hover-top">
                <span class="cosmos-hover-title">{{ s.title }}</span>
                <span class="cosmos-hover-time">{{ s.updatedLabel }}</span>
              </div>
              <div class="cosmos-hover-snippet" :class="{ 'is-waiting': s.status === 'waiting' }">{{ s.summary }}</div>
            </div>
          </button>
          <div v-if="!hoverPreviewSessions.length" class="cosmos-hover-empty">{{ $t('cosmos.agent.noSessions') }}</div>
        </div>

        <div class="cosmos-hover-foot">
          <span>{{ $t('cosmos.agent.sessionsCount', { count: hoverCardAgent.sessions.length }) }}</span>
          <span>{{ $t('cosmos.agent.hoverHint') }}</span>
        </div>
      </div>

      <!-- Left Subtle Cosmic Scale Ruler -->
      <nav class="cosmos-scale-gauge" aria-label="Cosmic scale">
        <button
          v-for="tick in scaleTicks"
          :key="tick.band"
          type="button"
          class="cosmos-scale-tick"
          :class="{ 'is-active': currentBand === tick.band }"
          @click.stop="jumpToScale(tick.target)"
        >
          <span class="cosmos-scale-dot" aria-hidden="true"></span>
          <span>{{ tick.exp }}</span>
          <span class="cosmos-scale-name">{{ $t(tick.labelKey) }}</span>
        </button>
      </nav>

      <!-- Top-Center Cosmic Event Countdown, Stop Control & Telescope Watch Dock -->
      <CosmosEventsOverlay
        :visible="constants.showEventsCountdown && currentBand === 'solar'"
        :auto-enabled="constants.eventsAutoEnabled"
        :active-event="eventActiveSnapshot"
        :next-event-index="eventNextIndex"
        :countdown-sec="eventCountdownSec"
        @observe="onObserveEvent"
        @stop-event="onStopEvent"
        @toggle-auto="onToggleAutoEvents"
        @toggle-pause="onTogglePauseEvent"
        @replay="onReplayEvent"
        @next-random="onNextRandomEvent"
        @set-zoom="onSetEventZoom"
      />

      <!-- Cross-Scale Gravity Alert -->
      <button
        v-if="waitingAgent && currentBand !== 'solar'"
        type="button"
        class="cosmos-gravity-alert"
        @click.stop="jumpToWaitingAgent"
      >
        <span class="cosmos-status-pip waiting"></span>
        <span>{{ $t('cosmos.agent.gravityAlert', { name: waitingAgent.name }) }}</span>
      </button>

      <!-- Top-Right Two Immersive Micro-Icons: Cosmic Constants (Λ) + Abandon Cosmos -->
      <div class="cosmos-corner-actions" @pointerdown.stop>
        <button
          type="button"
          class="cosmos-corner-icon"
          :aria-expanded="constantsOpen ? 'true' : 'false'"
          :title="$t('cosmos.constants.title')"
          :aria-label="$t('cosmos.constants.title')"
          @click.stop="constantsOpen = !constantsOpen"
        >
          <svg viewBox="0 0 24 24"><path d="M5 19 12 5l7 14M8.5 14h7"/></svg>
        </button>

        <button
          type="button"
          class="cosmos-corner-icon is-abandon"
          :title="$t('cosmos.mode.abandonTitle')"
          :aria-label="$t('cosmos.mode.abandon')"
          @click.stop="abandonCosmos"
        >
          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>
        </button>
      </div>

      <!-- Cosmic Constants + Authentic Yeaft Settings Popover -->
      <CosmosConstantsPopover
        v-if="constantsOpen"
        :constants="constants"
        :agents="projectedAgentList"
        :agent-to-planet="assignments.agentToPlanet"
        :renderer-mode="rendererMode"
        @update-constant="onUpdateConstant"
        @assign-planet="onAssignPlanet"
        @open-settings="openYeaftSettings"
        @open-agent-settings="openYeaftAgentSettings"
      />

      <!-- Zero-Agent Gentle Onboarding Pill -->
      <div v-if="projectedAgentList.length === 0 && currentBand === 'solar' && !drawerOpen && !quickAgent" class="cosmos-empty-agents-hint">
        <span>{{ $t('cosmos.agent.noAgentsTitle') }}</span>
        <button type="button" class="cosmos-empty-agents-cta" @click="openYeaftSettings({ tab: 'security' })">
          {{ $t('cosmos.agent.connectAgent') }}
        </button>
      </div>

      <!-- Click-Planet Quick Auto-Route Composer -->
      <CosmosQuickComposer
        v-if="quickAgent && !drawerOpen && currentBand === 'solar'"
        :agent="quickAgent"
        :planet-id="assignments.agentToPlanet[quickAgent.id] || 'earth'"
        @close="quickAgentId = null"
        @open-conversation="openAgentConversationFromQuick"
        @routed="onAutoRouted"
        @open-llm-config="openAgentLlmConfig"
      />

      <!-- Right Feathered Planetary Conversation Drawer -->
      <CosmosConversationDrawer
        v-if="drawerOpen && drawerAgent"
        :agent="drawerAgent"
        :planet-id="assignments.agentToPlanet[drawerAgent.id] || 'earth'"
        :all-agents="projectedAgentList"
        :widened="workbenchWidened"
        @close="closeDrawer"
        @select-session="onDrawerSelectSession"
        @create-session="openSessionCreate"
        @open-llm-config="openAgentLlmConfig"
        @toggle-widen="workbenchWidened = !workbenchWidened"
        @message-sent="emitTelemetryBeam"
      />

      <!-- Galaxy Scale Minimal Book Creator -->
      <div v-if="currentBand === 'galaxy'" class="cosmos-corner-dock" @pointerdown.stop>
        <div v-if="bookCreateOpen" class="cosmos-book-popover">
          <div class="cosmos-book-head">
            <span>{{ $t('cosmos.galaxy.createBookTitle') }}</span>
            <button type="button" class="cosmos-icon-btn" @click="bookCreateOpen = false">
              <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
          <form class="cosmos-book-form" @submit.prevent="submitNewBook">
            <input v-model="bookDraftTitle" type="text" class="cosmos-book-input" :placeholder="$t('cosmos.galaxy.bookPlaceholder')" />
            <div class="cosmos-book-foot">
              <select v-model="bookDraftDomain" class="cosmos-book-select">
                <option v-for="d in bookDomains" :key="d.id" :value="d.id">{{ d.id }}</option>
              </select>
              <button type="submit" class="cosmos-drawer-cta">{{ $t('cosmos.galaxy.createBook') }}</button>
            </div>
          </form>
        </div>
        <button type="button" class="cosmos-whisper-btn" @click="bookCreateOpen = !bookCreateOpen">
          + {{ $t('cosmos.galaxy.createBook') }}
        </button>
      </div>

      <!-- Black Hole Horizon Minimal Whisper Dock -->
      <div v-if="currentBand === 'horizon'" class="cosmos-corner-dock" @pointerdown.stop>
        <div class="cosmos-whisper-row">
          <button type="button" class="cosmos-whisper-btn" @click="jumpToScale(13.0)">
            {{ $t('cosmos.scale.escapeSolar') }}
          </button>
          <span class="cosmos-whisper-note">{{ $t('cosmos.horizon.minerSoon') }}</span>
        </div>
      </div>

      <!-- Empty Planet Assign Menu -->
      <div
        v-if="emptyPlanetMenu"
        class="cosmos-context-menu"
        :style="{ left: emptyPlanetMenu.x + 'px', top: emptyPlanetMenu.y + 'px' }"
        @pointerdown.stop
      >
        <div class="cosmos-menu-title">
          {{ $t('cosmos.agent.assignPlanet', { planet: $t('cosmos.planets.' + emptyPlanetMenu.planetId + '.name'), theme: $t('cosmos.planets.' + emptyPlanetMenu.planetId + '.theme') }) }}
        </div>
        <button
          v-for="ag in projectedAgentList"
          :key="ag.id"
          type="button"
          class="cosmos-menu-item"
          @click="assignFromMenu(ag.id, emptyPlanetMenu.planetId)"
        >
          <span>{{ ag.name }}</span>
          <span class="cosmos-menu-sub" v-if="assignments.agentToPlanet[ag.id]">
            {{ $t('cosmos.planets.' + assignments.agentToPlanet[ag.id] + '.name') }}
          </span>
        </button>
      </div>

      <!-- Drag Ghost -->
      <div v-if="dragActive" class="cosmos-drag-ghost" :class="{ 'is-swap': dragIsSwap }" :style="{ left: dragX + 'px', top: dragY + 'px' }">{{ dragGhostText }}</div>

      <!-- Ephemeral Cosmic Toast -->
      <div v-if="toast" class="cosmos-toast" role="status" @pointerdown.stop>
        <span>{{ toast.text }}</span>
        <button v-if="toast.actionLabel && toast.onAction" type="button" class="cosmos-toast-action" @click="runToastAction">{{ toast.actionLabel }}</button>
      </div>

      <!-- Authentic Yeaft Modals -->
      <SettingsPanel v-if="settingsModal.open" :visible="settingsModal.open" :initial-tab="settingsModal.tab" :initial-sub-tab="settingsModal.subTab" @close="settingsModal.open = false" />
      <AgentSettingsPanel v-if="agentSettingsModal.open" :initial-agent-id="agentSettingsModal.agentId" :initial-category="agentSettingsModal.category" @close="agentSettingsModal.open = false" />
      <SessionCreateModal v-if="sessionCreateModal.open" :initial-agent-id="sessionCreateModal.agentId" @close="sessionCreateModal.open = false" @created="onSessionCreated" />
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const sessionsStore = Pinia.useSessionsStore ? Pinia.useSessionsStore() : null;
    const { proxy } = Vue.getCurrentInstance();
    const $t = (k, p) => (proxy?.$t ? proxy.$t(k, p) : k);

    const glCanvasRef = Vue.ref(null);
    const hudCanvasRef = Vue.ref(null);
    const hoverCardRef = Vue.ref(null);

    const domRefs = {
      planets: {},
      hits: {},
      tags: {},
      liveCards: {},
      portals: {},
      books: {},
      homeBeacon: { value: null },
    };
    const setMapRef = (bucket, key, el) => {
      if (el) bucket[key] = el;
      else delete bucket[key];
    };

    const constants = Vue.reactive(loadCosmosConstants());
    const savedBindings = Vue.ref(loadPlanetBindings());
    const galaxyBooks = Vue.ref(loadGalaxyBooks());
    const canvasEpoch = Vue.ref(0);
    const rendererMode = Vue.ref('webgl2');

    const constantsOpen = Vue.ref(false);
    const quickAgentId = Vue.ref(null);
    const drawerOpen = Vue.ref(false);
    const drawerAgentId = Vue.ref(null);
    const workbenchWidened = Vue.ref(false);
    const hoverPlanetId = Vue.ref(null);
    const hoverCardPinned = Vue.ref(false);
    const hoverCardStyle = Vue.ref({ left: '0px', top: '0px' });
    const emptyPlanetMenu = Vue.ref(null);
    const camOrbiting = Vue.ref(false);
    const currentBand = Vue.ref('solar');
    const nowTick = Vue.ref(Date.now());

    const bookCreateOpen = Vue.ref(false);
    const bookDraftTitle = Vue.ref('');
    const bookDraftDomain = Vue.ref('auto');

    const settingsModal = Vue.reactive({ open: false, tab: 'general', subTab: '' });
    const agentSettingsModal = Vue.reactive({ open: false, agentId: null, category: 'llm' });
    const sessionCreateModal = Vue.reactive({ open: false, agentId: null });

    const dragActive = Vue.ref(false);
    const dragFromPlanetId = Vue.ref(null);
    const dragOverPlanetId = Vue.ref(null);
    const dragX = Vue.ref(0);
    const dragY = Vue.ref(0);

    const toast = Vue.ref(null);
    let toastTimer = null;
    function showToast(text, opts = {}) {
      clearTimeout(toastTimer);
      toast.value = { text, actionLabel: opts.actionLabel || '', onAction: opts.onAction || null };
      toastTimer = setTimeout(() => { toast.value = null; }, opts.durationMs || 4200);
    }
    function runToastAction() {
      const fn = toast.value?.onAction;
      toast.value = null;
      if (typeof fn === 'function') fn();
    }

    const projectedAgentsMap = Vue.computed(() => projectAgentsForCosmos({
      chatStore: store, sessionsStore, nowMs: nowTick.value, isEn: getLocale() === 'en', t: $t,
    }));
    const projectedAgentList = Vue.computed(() => Object.values(projectedAgentsMap.value));
    const assignments = Vue.computed(() => resolvePlanetAssignments(store.agents || [], savedBindings.value));

    const agentsByPlanet = Vue.computed(() => {
      const map = {};
      for (const [planetId, agentId] of Object.entries(assignments.value.planetToAgent)) {
        const ag = projectedAgentsMap.value[agentId];
        if (ag) map[planetId] = ag;
      }
      return map;
    });

    const quickAgent = Vue.computed(() => (quickAgentId.value ? projectedAgentsMap.value[quickAgentId.value] || null : null));
    const drawerAgent = Vue.computed(() => (drawerAgentId.value ? projectedAgentsMap.value[drawerAgentId.value] || null : null));
    const focusedPlanetId = Vue.computed(() => {
      if (drawerOpen.value && drawerAgentId.value) return assignments.value.agentToPlanet[drawerAgentId.value] || null;
      if (quickAgentId.value) return assignments.value.agentToPlanet[quickAgentId.value] || null;
      return null;
    });
    const waitingAgent = Vue.computed(() => projectedAgentList.value.find((a) => a.status === 'waiting') || null);
    const hoverCardAgent = Vue.computed(() => (hoverPlanetId.value ? agentsByPlanet.value[hoverPlanetId.value] || null : null));
    const hoverPreviewSessions = Vue.computed(() => {
      const ag = hoverCardAgent.value;
      if (!ag) return [];
      return ag.liveSessions.length > 0 ? ag.liveSessions.slice(0, 4) : ag.sessions.slice(0, 3);
    });
    const dragIsSwap = Vue.computed(() => Boolean(dragOverPlanetId.value && agentsByPlanet.value[dragOverPlanetId.value]));
    const dragGhostText = Vue.computed(() => {
      const moving = dragFromPlanetId.value ? agentsByPlanet.value[dragFromPlanetId.value] : null;
      if (!moving) return '';
      if (dragOverPlanetId.value) {
        const pName = $t(`cosmos.planets.${dragOverPlanetId.value}.name`);
        const pTheme = $t(`cosmos.planets.${dragOverPlanetId.value}.theme`);
        const occ = agentsByPlanet.value[dragOverPlanetId.value];
        return occ
          ? $t('cosmos.agent.dragSwap', { from: moving.name, to: occ.name, planet: pName })
          : $t('cosmos.agent.dragMove', { planet: pName, theme: pTheme });
      }
      return $t('cosmos.agent.dragHint', { name: moving.name });
    });

    const eventSim = createCosmicEventState({ autoEnabled: constants.eventsAutoEnabled });
    const eventActiveSnapshot = Vue.ref(null);
    const eventNextIndex = Vue.ref(eventSim.nextIdx);
    const eventCountdownSec = Vue.ref(eventSim.countdown);
    const isObservingEvent = Vue.computed(() => Boolean(eventActiveSnapshot.value?.observing));

    function syncEventRefs() {
      eventActiveSnapshot.value = eventSim.active ? { ...eventSim.active } : null;
      eventNextIndex.value = eventSim.nextIdx;
      eventCountdownSec.value = eventSim.countdown;
    }

    const anim = {
      time: 0, realTime: 0, lastTs: 0, lastEventUiSync: 0,
      scaleLog: 13.0, targetScaleLog: 13.0, warpEnergy: 0,
      parallax: { x: 0, y: 0, tx: 0, ty: 0 },
      camRot: { x: 0, y: 0, tx: 0, ty: 0 },
      centerShiftX: 0, targetCenterShiftX: 0,
      mouseX: -999, mouseY: -999,
      hoverPlanetId: null, focusedPlanetId: null,
      solarSunScreen: { x: 0, y: 0, r: 50 },
      planetScreen: {},
      meteors: [], nextMeteorAt: 4.5,
      orbitRipples: [], telemetryBeams: [],
      drag: null, camDrag: null, constants,
    };

    const pools = createParticlePools();
    const webGraph = createCosmicWebGraph();
    const gpuParticles = new Float32Array(3100 * 7);

    let engine = null;
    let rafId = 0;
    let hoverHideTimer = null;
    let hoverAnchoredPlanetId = null;
    let hoverEnterPointer = { x: 0, y: 0 };
    let waitJumpTimer = null;
    let nowInterval = null;

    function clearHoverHideTimer() {
      if (hoverHideTimer) {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = null;
      }
    }

    function computeHoverCardPosition(planetId, cardHeight = 190) {
      const pos = anim.planetScreen[planetId];
      if (!pos) return null;
      const w = 294, h = cardHeight || 190;
      const vw = window.innerWidth || 1280, vh = window.innerHeight || 720;
      const panelW = drawerOpen.value ? (workbenchWidened.value ? Math.min(760, vw * 0.5) : Math.min(488, vw * 0.34)) : 0;
      const rightLimit = vw - panelW - 18;
      let x = pos.x + pos.r + 12;
      if (x + w > rightLimit) x = pos.x - pos.r - w - 12;
      x = Math.max(16, Math.min(rightLimit - w, x));
      const y = Math.max(16, Math.min(vh - h - 16, pos.y - h * 0.45));
      return { left: `${Math.round(x)}px`, top: `${Math.round(y)}px` };
    }

    function updateHoverCardPosition(planetId, force = false) {
      // Anchor the hover card once positioned for a planet so a clickable menu
      // does not drift frame-by-frame away from the pointer while orbiting.
      if (!force && (hoverCardPinned.value || hoverAnchoredPlanetId === planetId)) return;
      const el = hoverCardRef.value;
      const next = computeHoverCardPosition(planetId, el?.offsetHeight || 190);
      if (!next) return;
      hoverCardStyle.value = next;
      if (el) {
        el.style.left = next.left;
        el.style.top = next.top;
      }
      hoverAnchoredPlanetId = planetId;
    }

    function onPlanetEnter(planetId, e) {
      if (e?.pointerType === 'touch') return;
      if (anim.drag?.active || currentBand.value !== 'solar' || isObservingEvent.value) return;
      clearHoverHideTimer();
      anim.hoverPlanetId = planetId;
      hoverEnterPointer = { x: e?.clientX ?? anim.mouseX, y: e?.clientY ?? anim.mouseY };
      if (agentsByPlanet.value[planetId]) {
        const isSwitching = hoverPlanetId.value !== planetId;
        if (isSwitching || hoverAnchoredPlanetId !== planetId) {
          const initial = computeHoverCardPosition(planetId, 190);
          if (initial) {
            hoverCardStyle.value = initial;
            hoverAnchoredPlanetId = planetId;
          } else {
            hoverAnchoredPlanetId = null;
          }
        }
        hoverPlanetId.value = planetId;
        if (isSwitching) {
          Vue.nextTick(() => {
            const el = hoverCardRef.value;
            if (!el || hoverPlanetId.value !== planetId) return;
            const vh = window.innerHeight || 720;
            const curTop = parseFloat(hoverCardStyle.value.top) || 16;
            const actualH = el.offsetHeight || 190;
            if (curTop + actualH > vh - 16) {
              hoverCardStyle.value = {
                left: hoverCardStyle.value.left,
                top: `${Math.round(Math.max(16, vh - actualH - 16))}px`,
              };
            }
          });
        }
      } else {
        hoverAnchoredPlanetId = null;
        hoverPlanetId.value = null;
      }
    }
    function onPlanetLeave(planetId, e) {
      if (anim.hoverPlanetId === planetId) anim.hoverPlanetId = null;
      // If the planet drifted under a stationary cursor (orbit or drawer camera
      // easing), do not yank the hover card away before the user moves their pointer.
      const px = e?.clientX ?? anim.mouseX;
      const py = e?.clientY ?? anim.mouseY;
      if (Math.hypot(px - hoverEnterPointer.x, py - hoverEnterPointer.y) >= 6) {
        scheduleHideHover(480);
      }
    }
    function onHoverCardEnter() { hoverCardPinned.value = true; clearHoverHideTimer(); }
    function onHoverCardLeave() { hoverCardPinned.value = false; scheduleHideHover(320); }
    function scheduleHideHover(delayMs = 480) {
      clearHoverHideTimer();
      hoverHideTimer = setTimeout(() => {
        hoverHideTimer = null;
        if (!anim.hoverPlanetId && !hoverCardPinned.value) {
          hoverAnchoredPlanetId = null;
          hoverPlanetId.value = null;
        }
      }, delayMs);
    }
    function hideHoverImmediate() {
      clearHoverHideTimer();
      hoverCardPinned.value = false;
      hoverAnchoredPlanetId = null;
      hoverPlanetId.value = null;
    }

    function jumpToScale(targetLog) {
      const prev = anim.targetScaleLog;
      anim.targetScaleLog = Math.max(7.0, Math.min(24.0, targetLog));
      if (Math.abs(anim.targetScaleLog - prev) > 0.6) anim.warpEnergy = Math.min(1.0, anim.warpEnergy + 0.85);
      if (eventSim.active?.observing) { stopCosmicEvent(eventSim); syncEventRefs(); }
      hideHoverImmediate();
      emptyPlanetMenu.value = null;
      if (scaleBand(anim.targetScaleLog) !== 'solar') {
        quickAgentId.value = null;
        if (drawerOpen.value) closeDrawer();
      }
      if (scaleBand(anim.targetScaleLog) !== 'galaxy') bookCreateOpen.value = false;
    }

    const activeTouchPointers = new Map();
    let pinchPrevDist = 0;

    function getTouchPinchDist() {
      const pts = Array.from(activeTouchPointers.values());
      if (pts.length < 2) return 0;
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }

    function cancelActiveDrags() {
      anim.camDrag = null;
      anim.drag = null;
      camOrbiting.value = false;
      dragActive.value = false;
      dragFromPlanetId.value = null;
      dragOverPlanetId.value = null;
    }

    function onCanvasPointerDown(e) {
      if (e.pointerType !== 'touch' && e.button !== 0) return;
      emptyPlanetMenu.value = null;
      constantsOpen.value = false;
      if (e.pointerType === 'touch') {
        activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (activeTouchPointers.size >= 2) {
          cancelActiveDrags();
          pinchPrevDist = getTouchPinchDist();
          return;
        }
      }
      anim.camDrag = { startX: e.clientX, startY: e.clientY, yaw0: anim.camRot.tx, pitch0: anim.camRot.ty, moved: false };
      camOrbiting.value = true;
    }
    function resetCamera() {
      anim.camRot.tx = 0; anim.camRot.ty = 0;
      showToast($t('cosmos.scale.resetView'));
    }

    function onPlanetPointerDown(planetId, ev) {
      if (ev.pointerType !== 'touch' && ev.button !== 0) return;
      if (ev.pointerType === 'touch') {
        activeTouchPointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (activeTouchPointers.size >= 2) {
          cancelActiveDrags();
          pinchPrevDist = getTouchPinchDist();
          return;
        }
      }
      emptyPlanetMenu.value = null;
      constantsOpen.value = false;
      const agent = agentsByPlanet.value[planetId];
      if (!agent) {
        if (projectedAgentList.value.length === 0) { openYeaftSettings({ tab: 'security' }); return; }
        emptyPlanetMenu.value = {
          planetId,
          x: Math.min(ev.clientX, (window.innerWidth || 1280) - 240),
          y: Math.min(ev.clientY, (window.innerHeight || 720) - 220),
        };
        return;
      }
      anim.drag = {
        agentId: agent.id, fromPlanetId: planetId,
        startX: ev.clientX, startY: ev.clientY, currX: ev.clientX, currY: ev.clientY,
        active: false, overPlanetId: null,
      };
    }

    function performMoveOrSwap(agentId, targetPlanetId) {
      const result = moveOrSwapPlanetBinding(store.agents || [], savedBindings.value, agentId, targetPlanetId);
      if (!result.changed) return;
      savedBindings.value = result.bindings;
      savePlanetBindings(result.bindings);
      const moving = projectedAgentsMap.value[agentId];
      const targetName = $t(`cosmos.planets.${targetPlanetId}.name`);
      const targetTheme = $t(`cosmos.planets.${targetPlanetId}.theme`);
      if (result.swappedWith) {
        const occ = projectedAgentsMap.value[result.swappedWith];
        const fromName = result.fromPlanetId ? $t(`cosmos.planets.${result.fromPlanetId}.name`) : '';
        anim.orbitRipples.push({ planetId: targetPlanetId, t: 0, color: '244, 194, 122' });
        if (result.fromPlanetId) anim.orbitRipples.push({ planetId: result.fromPlanetId, t: 0, color: '124, 196, 255' });
        showToast($t('cosmos.agent.swapped', { from: moving?.name || agentId, to: occ?.name || result.swappedWith, target: targetName, source: fromName }));
      } else {
        anim.orbitRipples.push({ planetId: targetPlanetId, t: 0, color: '124, 196, 255' });
        showToast($t('cosmos.agent.moved', { name: moving?.name || agentId, planet: targetName, theme: targetTheme }));
      }
    }
    function assignFromMenu(agentId, planetId) { emptyPlanetMenu.value = null; performMoveOrSwap(agentId, planetId); }

    function onGlobalPointerMove(e) {
      if (e.pointerType === 'touch' && activeTouchPointers.has(e.pointerId)) {
        activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (activeTouchPointers.size >= 2) {
          const dist = getTouchPinchDist();
          if (pinchPrevDist > 12 && dist > 12) {
            if (eventSim.active?.observing) {
              const zoomDelta = (dist - pinchPrevDist) * 0.008;
              setCosmicEventZoom(eventSim, eventSim.active.targetZoom + zoomDelta);
              syncEventRefs();
            } else {
              const ratio = pinchPrevDist / dist;
              const step = Math.max(-1.2, Math.min(1.2, Math.log(ratio) * 4.4));
              anim.targetScaleLog = Math.max(7.0, Math.min(24.0, anim.targetScaleLog + step));
              anim.warpEnergy = Math.min(1.0, anim.warpEnergy + Math.min(0.45, Math.abs(step) * 0.65));
              hideHoverImmediate();
              if (scaleBand(anim.targetScaleLog) !== 'solar') {
                quickAgentId.value = null;
                if (drawerOpen.value) closeDrawer();
              }
            }
          }
          pinchPrevDist = dist;
          return;
        }
      }

      anim.mouseX = e.clientX; anim.mouseY = e.clientY;
      anim.parallax.tx = (e.clientX / Math.max(window.innerWidth, 1)) * 2 - 1;
      anim.parallax.ty = (e.clientY / Math.max(window.innerHeight, 1)) * 2 - 1;

      if (anim.drag) {
        anim.drag.currX = e.clientX; anim.drag.currY = e.clientY;
        const dist = Math.hypot(e.clientX - anim.drag.startX, e.clientY - anim.drag.startY);
        if (!anim.drag.active && dist > 6) {
          anim.drag.active = true; hideHoverImmediate();
          dragActive.value = true; dragFromPlanetId.value = anim.drag.fromPlanetId;
        }
        if (anim.drag.active) {
          dragX.value = e.clientX; dragY.value = e.clientY;
          let closest = null, minD = 96;
          for (const p of PLANETS) {
            if (p.id === anim.drag.fromPlanetId) continue;
            const pos = anim.planetScreen[p.id];
            if (!pos) continue;
            const d = Math.hypot(e.clientX - pos.x, e.clientY - pos.y);
            if (d < Math.max(pos.r + 36, 62) && d < minD) { minD = d; closest = p.id; }
          }
          anim.drag.overPlanetId = closest;
          dragOverPlanetId.value = closest;
        }
        return;
      }
      if (anim.camDrag) {
        const dx = e.clientX - anim.camDrag.startX, dy = e.clientY - anim.camDrag.startY;
        if (Math.hypot(dx, dy) > 4) anim.camDrag.moved = true;
        anim.camRot.tx = Math.max(-0.85, Math.min(0.85, anim.camDrag.yaw0 + dx * 0.0024));
        anim.camRot.ty = Math.max(-0.42, Math.min(0.45, anim.camDrag.pitch0 + dy * 0.0022));
      }

      if (hoverPlanetId.value && !anim.hoverPlanetId && !hoverCardPinned.value) {
        const cardEl = hoverCardRef.value;
        let nearCard = false;
        if (cardEl) {
          const r = cardEl.getBoundingClientRect();
          nearCard = e.clientX >= r.left - 8 && e.clientX <= r.right + 8 && e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8;
        }
        if (nearCard) {
          clearHoverHideTimer();
        } else if (!hoverHideTimer && Math.hypot(e.clientX - hoverEnterPointer.x, e.clientY - hoverEnterPointer.y) >= 8) {
          scheduleHideHover(420);
        }
      }
    }

    function onGlobalPointerCancel(e) {
      if (e && e.pointerType === 'touch') {
        activeTouchPointers.delete(e.pointerId);
        if (activeTouchPointers.size < 2) pinchPrevDist = 0;
      }
      cancelActiveDrags();
    }

    function onGlobalPointerUp(e) {
      if (e?.type === 'pointercancel') {
        onGlobalPointerCancel(e);
        return;
      }
      if (e && e.pointerType === 'touch') {
        activeTouchPointers.delete(e.pointerId);
        if (activeTouchPointers.size < 2) pinchPrevDist = 0;
      }
      if (anim.drag) {
        const drag = anim.drag;
        anim.drag = null;
        dragActive.value = false; dragFromPlanetId.value = null; dragOverPlanetId.value = null;
        if (drag.active) {
          if (drag.overPlanetId) performMoveOrSwap(drag.agentId, drag.overPlanetId);
        } else {
          // Single click on planet -> Quick Auto-Route Composer
          hideHoverImmediate();
          if (drawerOpen.value) closeDrawer();
          quickAgentId.value = drag.agentId;
        }
        return;
      }
      if (anim.camDrag) {
        const moved = anim.camDrag.moved;
        anim.camDrag = null;
        camOrbiting.value = false;
        if (!moved) {
          if (quickAgentId.value) quickAgentId.value = null;
          if (drawerOpen.value) closeDrawer();
        }
      }
    }

    function onStageWheel(e) {
      if (settingsModal.open || agentSettingsModal.open || sessionCreateModal.open) return;
      if (e.target.closest('.cosmos-drawer, .cosmos-quick-composer, .cosmos-constants-popover, .cosmos-hover-card, .cosmos-event-almanac, .cosmos-book-popover')) return;
      e.preventDefault();
      if (eventSim.active?.observing) {
        const delta = -Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 100) * 0.0028;
        setCosmicEventZoom(eventSim, eventSim.active.targetZoom + delta);
        syncEventRefs();
        return;
      }
      const step = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0115;
      anim.targetScaleLog = Math.max(7.0, Math.min(24.0, anim.targetScaleLog + step));
      anim.warpEnergy = Math.min(1.0, anim.warpEnergy + Math.min(0.45, Math.abs(step) * 0.55));
      hideHoverImmediate();
      if (scaleBand(anim.targetScaleLog) !== 'solar') {
        quickAgentId.value = null;
        if (drawerOpen.value) closeDrawer();
      }
    }

    function openSessionInDrawer(agentId, session) {
      hideHoverImmediate();
      quickAgentId.value = null;
      drawerAgentId.value = agentId;
      drawerOpen.value = true;
      if (session?.descriptor) {
        store.openCatalogSession?.(session.descriptor);
      } else if (session?.id) {
        store.enterYeaft?.(agentId, { deferBootstrap: true });
        store.setActiveSessionFilter?.(session.id, { agentId, force: false });
        store.reloadYeaftMessages?.();
      } else if (agentId) {
        store.enterYeaft?.(agentId);
      }
    }

    function openAgentConversationFromQuick({ agentId, sessionId }) {
      const ag = projectedAgentsMap.value[agentId];
      const session = sessionId
        ? ag?.sessions?.find((s) => s.id === sessionId) || { id: sessionId }
        : ag?.sessions?.[0] || null;
      openSessionInDrawer(agentId, session);
    }

    function onDrawerSelectSession({ agentId, session }) { openSessionInDrawer(agentId, session); }

    function closeDrawer() {
      drawerOpen.value = false;
      workbenchWidened.value = false;
      if (store.workbenchExpanded) store.workbenchExpanded = false;
    }

    function emitTelemetryBeam({ planetId }) {
      if (!planetId) return;
      anim.telemetryBeams.push({ planetId, x0: (window.innerWidth || 1280) * 0.5, y0: (window.innerHeight || 720) - 72, t: 0 });
    }

    function onAutoRouted({ agentId, planetId, result, message }) {
      emitTelemetryBeam({ planetId });
      showToast(message, result?.sessionId ? {
        actionLabel: $t('cosmos.quick.viewSession'),
        onAction: () => openAgentConversationFromQuick({ agentId, sessionId: result.sessionId }),
      } : {});
    }

    function jumpToWaitingAgent() {
      const ag = waitingAgent.value;
      jumpToScale(13.0);
      if (waitJumpTimer) {
        clearTimeout(waitJumpTimer);
        waitJumpTimer = null;
      }
      if (ag) {
        const waitSession = ag.liveSessions.find((s) => s.status === 'waiting') || ag.sessions[0] || null;
        waitJumpTimer = setTimeout(() => {
          waitJumpTimer = null;
          openSessionInDrawer(ag.id, waitSession);
        }, 320);
      }
    }

    function onObserveEvent(eventId) {
      if (scaleBand(anim.targetScaleLog) !== 'solar') jumpToScale(13.0);
      const act = startCosmicEvent(eventSim, eventId, { observe: true });
      hideHoverImmediate();
      syncEventRefs();
      showToast($t('cosmos.events.lockedToast', { name: $t(`cosmos.events.${act.def.id}.name`) }));
    }
    function onStopEvent() {
      const wasActive = stopCosmicEvent(eventSim);
      syncEventRefs();
      if (wasActive) showToast($t('cosmos.events.stoppedToast'));
    }
    function onToggleAutoEvents() {
      constants.eventsAutoEnabled = !constants.eventsAutoEnabled;
      saveCosmosConstants(constants);
      eventSim.autoEnabled = constants.eventsAutoEnabled;
      syncEventRefs();
      showToast($t(constants.eventsAutoEnabled ? 'cosmos.events.autoResumedToast' : 'cosmos.events.autoPausedToast'));
    }
    function onTogglePauseEvent() { if (eventSim.active) { eventSim.active.paused = !eventSim.active.paused; syncEventRefs(); } }
    function onReplayEvent() { if (eventSim.active) { eventSim.active.elapsed = 0.01; eventSim.active.paused = false; syncEventRefs(); } }
    function onNextRandomEvent() {
      const curIdx = eventSim.active ? COSMIC_EVENTS.findIndex((e) => e.id === eventSim.active.def.id) : eventSim.lastPlayedIdx;
      const nextIdx = pickRandomEventIndex(curIdx);
      startCosmicEvent(eventSim, COSMIC_EVENTS[nextIdx].id, { observe: true });
      syncEventRefs();
    }
    function onSetEventZoom(z) { setCosmicEventZoom(eventSim, z); syncEventRefs(); }

    function onUpdateConstant({ key, value }) {
      if (!(key in constants)) return;
      constants[key] = value;
      saveCosmosConstants(constants);
      if (key === 'eventsAutoEnabled') {
        eventSim.autoEnabled = Boolean(value);
        if (!value && eventSim.active && !eventSim.active.observing) stopCosmicEvent(eventSim);
        syncEventRefs();
      }
      if (key === 'showEventsCountdown' && !value && eventSim.active) { stopCosmicEvent(eventSim); syncEventRefs(); }
      if (key === 'renderQuality') {
        rebuildCosmosEngine(value);
      }
    }
    function onAssignPlanet({ agentId, planetId }) { if (agentId && planetId) performMoveOrSwap(agentId, planetId); }

    function openYeaftSettings({ tab = 'general', subTab = '' } = {}) {
      constantsOpen.value = false;
      settingsModal.tab = tab; settingsModal.subTab = subTab; settingsModal.open = true;
    }
    function openYeaftAgentSettings({ agentId = null, category = 'operations' } = {}) {
      constantsOpen.value = false;
      agentSettingsModal.agentId = agentId || drawerAgentId.value || quickAgentId.value || store.currentAgent || null;
      agentSettingsModal.category = category;
      agentSettingsModal.open = true;
    }
    function openAgentLlmConfig(agentId) { openYeaftAgentSettings({ agentId, category: 'llm' }); }
    function openSessionCreate(agentId) {
      sessionCreateModal.agentId = agentId || drawerAgentId.value || store.currentAgent || null;
      sessionCreateModal.open = true;
    }
    function onSessionCreated(created) {
      sessionCreateModal.open = false;
      const sid = created?.sessionId || created?.id;
      if (created?.agentId && sid) openSessionInDrawer(created.agentId, { id: sid });
    }
    function abandonCosmos() {
      constantsOpen.value = false;
      if (store.workbenchExpanded) store.workbenchExpanded = false;
      store.setUiMode('classic');
    }

    function submitNewBook() {
      const title = bookDraftTitle.value.trim();
      if (!title) return;
      const dom = BOOK_DOMAINS.find((d) => d.id === bookDraftDomain.value) || BOOK_DOMAINS[0];
      const armIdx = dom.id === 'auto' ? galaxyBooks.value.length % 4 : dom.arm;
      const armColor = (BOOK_DOMAINS.find((d) => d.arm === armIdx && d.id !== 'auto') || BOOK_DOMAINS[1]).color;
      galaxyBooks.value = [...galaxyBooks.value, {
        id: `b-${Date.now()}`, title, arm: armIdx,
        r: 0.34 + (galaxyBooks.value.length % 4) * 0.11,
        theta: (armIdx * Math.PI) / 2 + 0.8 + Math.random() * 0.65,
        color: armColor,
      }];
      saveGalaxyBooks(galaxyBooks.value);
      bookDraftTitle.value = '';
      bookCreateOpen.value = false;
      showToast($t('cosmos.galaxy.bookCreated', { title }));
    }

    function onKeyDown(e) {
      if (e.key !== 'Escape') return;
      if (settingsModal.open) { settingsModal.open = false; return; }
      if (agentSettingsModal.open) { agentSettingsModal.open = false; return; }
      if (sessionCreateModal.open) { sessionCreateModal.open = false; return; }
      if (emptyPlanetMenu.value) { emptyPlanetMenu.value = null; return; }
      if (constantsOpen.value) { constantsOpen.value = false; return; }
      if (bookCreateOpen.value) { bookCreateOpen.value = false; return; }
      if (eventSim.active?.observing) { onStopEvent(); return; }
      if (store.workbenchExpanded && drawerOpen.value) { store.workbenchExpanded = false; return; }
      if (drawerOpen.value) { closeDrawer(); return; }
      if (quickAgentId.value) { quickAgentId.value = null; return; }
      if (currentBand.value !== 'solar') jumpToScale(13.0);
    }

    function onDocClick(e) {
      if (emptyPlanetMenu.value && !e.target.closest('.cosmos-context-menu')) emptyPlanetMenu.value = null;
      if (constantsOpen.value && !e.target.closest('.cosmos-constants-popover, .cosmos-corner-actions')) constantsOpen.value = false;
    }

    function planetTagClass(id) {
      const ag = agentsByPlanet.value[id];
      if (!ag || !constants.activeFlash || ag.liveSessions.length === 0) return {};
      return { 'is-flashing-waiting': ag.status === 'waiting', 'is-flashing-running': ag.status !== 'waiting' };
    }
    function planetPipClass(ag) {
      return [ag.status, constants.activeFlash && ag.status === 'running' ? 'is-flashing' : ''];
    }

    let softTimer = 0;
    let unmounted = false;
    let consecutiveSlowFrames = 0;
    let autoDowngraded = false;

    function resolveInitialQuality(override) {
      if (override) return override;
      try {
        const param = new URLSearchParams(window.location.search).get('cosmosRenderer');
        if (param === 'webgl' || param === 'high') return 'high';
        if (param === '2d' || param === 'lite') return 'lite';
      } catch { /* ignore */ }
      return constants.renderQuality || 'auto';
    }

    function mountEngine(quality) {
      if (unmounted) return;
      cancelAnimationFrame(rafId);
      clearTimeout(softTimer);
      engine?.destroy?.();
      engine = createCosmosEngine(glCanvasRef.value, hudCanvasRef.value, {
        renderQuality: resolveInitialQuality(quality),
      });
      rendererMode.value = engine?.mode || '2d';
      consecutiveSlowFrames = 0;
      if (engine) {
        anim.lastTs = performance.now();
        rafId = requestAnimationFrame(loop);
      }
    }

    function rebuildCosmosEngine(quality) {
      cancelAnimationFrame(rafId);
      clearTimeout(softTimer);
      engine?.destroy?.();
      engine = null;
      const epoch = (canvasEpoch.value += 1);
      Vue.nextTick(() => {
        if (!unmounted && epoch === canvasEpoch.value) mountEngine(quality);
      });
    }

    function scheduleNextFrame() {
      if (!engine || unmounted) return;
      let delayMs = 0;
      if (!engine.isWebGL) delayMs = 30;
      else if (engine.isSoftware) delayMs = 46;
      else if (engine.isMobile && constants.renderQuality !== 'high') delayMs = 24;

      if (delayMs > 0) {
        softTimer = setTimeout(() => {
          if (!unmounted && engine) rafId = requestAnimationFrame(loop);
        }, delayMs);
      } else {
        rafId = requestAnimationFrame(loop);
      }
    }

    function loop(now) {
      if (!engine || unmounted) return;
      if (!document.hidden) {
        const t0 = performance.now();
        stepCosmosFrame(now, {
          engine, anim, eventSim, pools, webGraph, gpuParticles, constants, domRefs,
          getAgentsByPlanet: () => agentsByPlanet.value,
          getGalaxyBooks: () => galaxyBooks.value,
          getUiState: () => ({
            currentBand: currentBand.value,
            drawerOpen: drawerOpen.value,
            quickOpen: Boolean(quickAgentId.value),
            workbenchWidened: workbenchWidened.value,
            focusedPlanetId: focusedPlanetId.value,
            dragActive: dragActive.value,
            dragOverPlanetId: dragOverPlanetId.value,
            hoverPlanetId: hoverPlanetId.value,
          }),
          onBandChange: (band) => { currentBand.value = band; },
          onSyncEvents: syncEventRefs,
          onUpdateHoverPos: updateHoverCardPosition,
        });

        // Adaptive guard for masked software renderers: if WebGL stays severely stalled
        // (>115ms per frame for 20 consecutive frames) in 'auto' mode, smoothly switch to 2D.
        if (engine.isWebGL && constants.renderQuality === 'auto' && !autoDowngraded) {
          const frameCost = performance.now() - t0;
          if (frameCost > 115) {
            consecutiveSlowFrames += 1;
            if (consecutiveSlowFrames >= 20) {
              autoDowngraded = true;
              showToast($t('cosmos.constants.autoDowngradedToast'));
              rebuildCosmosEngine('lite');
              return;
            }
          } else {
            consecutiveSlowFrames = 0;
          }
        }
      }
      scheduleNextFrame();
    }

    Vue.onMounted(() => {
      unmounted = false;
      mountEngine();
      window.addEventListener('pointermove', onGlobalPointerMove);
      window.addEventListener('pointerup', onGlobalPointerUp);
      window.addEventListener('pointercancel', onGlobalPointerCancel);
      window.addEventListener('keydown', onKeyDown);
      document.addEventListener('click', onDocClick);
      nowInterval = setInterval(() => { nowTick.value = Date.now(); }, 15000);
      syncEventRefs();
    });

    Vue.onBeforeUnmount(() => {
      unmounted = true;
      activeTouchPointers.clear();
      cancelAnimationFrame(rafId);
      clearTimeout(softTimer);
      clearTimeout(toastTimer);
      clearTimeout(hoverHideTimer);
      if (waitJumpTimer) {
        clearTimeout(waitJumpTimer);
        waitJumpTimer = null;
      }
      clearInterval(nowInterval);
      window.removeEventListener('pointermove', onGlobalPointerMove);
      window.removeEventListener('pointerup', onGlobalPointerUp);
      window.removeEventListener('pointercancel', onGlobalPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', onDocClick);
      engine?.destroy?.();
      engine = null;
    });

    return {
      glCanvasRef, hudCanvasRef, hoverCardRef, domRefs, setMapRef, canvasEpoch, rendererMode,
      planets: PLANETS, bookDomains: BOOK_DOMAINS,
      portals: [
        { id: 'to-galaxy', labelKey: 'cosmos.scale.galaxy', scale: '10²¹', target: 21.0, ring: 54 },
        { id: 'to-web', labelKey: 'cosmos.scale.web', scale: '10²⁴', target: 24.0, ring: 50 },
        { id: 'to-horizon', labelKey: 'cosmos.scale.horizon', scale: '10⁷', target: 7.0, ring: 46 },
      ],
      scaleTicks: [
        { band: 'web', exp: '10²⁴', labelKey: 'cosmos.scale.web', target: 24.0 },
        { band: 'galaxy', exp: '10²¹', labelKey: 'cosmos.scale.galaxy', target: 21.0 },
        { band: 'solar', exp: '10¹³', labelKey: 'cosmos.scale.solar', target: 13.0 },
        { band: 'horizon', exp: '10⁷', labelKey: 'cosmos.scale.horizon', target: 7.0 },
      ],
      constants, constantsOpen, galaxyBooks,
      quickAgentId, quickAgent, drawerOpen, drawerAgent, workbenchWidened,
      hoverPlanetId, hoverCardAgent, hoverPreviewSessions, hoverCardStyle, emptyPlanetMenu,
      camOrbiting, currentBand, projectedAgentList, assignments, agentsByPlanet, focusedPlanetId, waitingAgent,
      dragActive, dragFromPlanetId, dragOverPlanetId, dragX, dragY, dragIsSwap, dragGhostText,
      bookCreateOpen, bookDraftTitle, bookDraftDomain, toast,
      settingsModal, agentSettingsModal, sessionCreateModal,
      eventActiveSnapshot, eventNextIndex, eventCountdownSec, isObservingEvent,
      planetTagClass, planetPipClass,
      onCanvasPointerDown, resetCamera, onPlanetPointerDown, onPlanetEnter, onPlanetLeave,
      onHoverCardEnter, onHoverCardLeave, onStageWheel, jumpToScale,
      openSessionInDrawer, openAgentConversationFromQuick, onDrawerSelectSession, closeDrawer,
      emitTelemetryBeam, onAutoRouted, jumpToWaitingAgent, assignFromMenu,
      onObserveEvent, onStopEvent, onToggleAutoEvents, onTogglePauseEvent, onReplayEvent, onNextRandomEvent, onSetEventZoom,
      onUpdateConstant, onAssignPlanet, openYeaftSettings, openYeaftAgentSettings, openAgentLlmConfig, openSessionCreate, onSessionCreated,
      abandonCosmos, submitNewBook, showToast, runToastAction,
    };
  },
};
