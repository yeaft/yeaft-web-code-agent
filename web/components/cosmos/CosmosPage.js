/**
 * Yeaft Cosmos — Main 4-Scale Living Universe Workspace
 *
 * Scales: Cosmic Web (10^24) · Galaxy Library (10^21) · Solar System (10^13) · Event Horizon (10^7)
 * Interactions:
 * - Click planet -> Quick Auto-Route Composer (`yeaft_auto_route_send`) with direct "Open Chat" button
 * - Hover planet -> Lightweight session preview card -> Click session -> Right Planetary Conversation Drawer
 * - Top-right Interstellar Signal Stream -> Unified waiting/unread replies, scheduled task notices & running feed
 * - Drag planet onto another planet -> Move or swap Agent orbits (persisted)
 * - Scroll wheel / deep-sky portals / left ruler -> Smooth multi-scale zoom transition
 * - Top-right micro-icons -> Cosmic Constants (+ authentic Yeaft Settings) & Abandon Cosmos (-> classic UI)
 */
import {
  PLANETS,
  BOOK_DOMAINS,
  COSMOS_DRAWER_WIDTH,
  loadCosmosConstants,
  saveCosmosConstants,
  loadPlanetBindings,
  savePlanetBindings,
  resolvePlanetAssignments,
  moveOrSwapPlanetBinding,
  scaleBand,
  loadGalaxyBooks,
  saveGalaxyBooks,
  clampCosmosDrawerWidth,
  loadCosmosDrawerWidth,
  saveCosmosDrawerWidth,
} from '../../cosmos/constants.js';
import { createCosmosEngine } from '../../cosmos/gl-engine.js';
import { createParticlePools, createCosmicWebGraph } from '../../cosmos/particle-hud.js';
import {
  COSMIC_EVENTS,
  createCosmicEventState,
  startCosmicEvent,
  focusActiveCosmicEvent,
  focusCosmicEventByUid,
  unfocusCosmicEvent,
  stopCosmicEvent,
  setCosmicEventZoom,
  setCosmicEventViewAngles,
  resetCosmicEventView,
  scrubCosmicEvent,
  hitTestAmbientEvent,
  pickRandomEventIndex,
  formatEventPhysicalDistance,
} from '../../cosmos/events-controller.js';
import { stepCosmosFrame } from '../../cosmos/stage-loop.js';
import { projectAgentsForCosmos } from '../../cosmos/agent-projection.js';
import { buildCosmosSignalStream } from '../../cosmos/signal-stream.js';
import { getLocale } from '../../utils/i18n.js';
import { setThemeColorSurface } from '../../utils/document-theme.js';

import CosmosQuickComposer from './CosmosQuickComposer.js';
import CosmosConversationDrawer from './CosmosConversationDrawer.js';
import CosmosConstantsPopover from './CosmosConstantsPopover.js';
import CosmosEventsOverlay from './CosmosEventsOverlay.js';
import CosmosSignalStream from './CosmosSignalStream.js';
import CosmosGalaxyOverlay from './creations/CosmosGalaxyOverlay.js';
import CreationInteriorModal from './creations/CreationInteriorModal.js';
import SettingsPanel from '../SettingsPanel.js';
import AgentSettingsPanel from '../AgentSettingsPanel.js';
import SessionSettingsModal from '../SessionSettingsModal.js';
import { useCreationsStore } from '../../stores/creations.js';

export default {
  name: 'CosmosPage',
  components: {
    CosmosQuickComposer,
    CosmosConversationDrawer,
    CosmosConstantsPopover,
    CosmosEventsOverlay,
    CosmosSignalStream,
    CosmosGalaxyOverlay,
    CreationInteriorModal,
    SettingsPanel,
    AgentSettingsPanel,
    SessionSettingsModal,
  },
  template: `
    <div
      class="cosmos-page"
      :class="{
        'is-drawer-open': drawerOpen,
        'is-drawer-resizing': drawerResizing,
        'is-workbench-widened': workbenchWidened,
        'is-workbench-maximized': drawerOpen && workbenchMaximized,
        'is-orbiting': camOrbiting,
        'is-drag-mode': dragActive,
        'is-observing-event': isObservingEvent,
      }"
      :style="cosmosPageStyle"
      @wheel="onStageWheel"
    >
      <canvas ref="glCanvasRef" :key="canvasEpoch" class="cosmos-gl-canvas" :class="{ 'is-orbiting': camOrbiting }" @pointerdown="onCanvasPointerDown" @dblclick="onCanvasDblClick"></canvas>
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
                v-if="agentsByPlanet[p.id].attentionCount > 0 || agentsByPlanet[p.id].liveSessions.length > 0"
                class="cosmos-planet-count"
                :class="{
                  'is-waiting': agentsByPlanet[p.id].status === 'waiting',
                  'is-unread': agentsByPlanet[p.id].status !== 'waiting' && agentsByPlanet[p.id].hasUnread,
                }"
              >{{ agentsByPlanet[p.id].attentionCount > 0 ? agentsByPlanet[p.id].attentionCount : agentsByPlanet[p.id].liveSessions.length }}</span>
            </template>
            <template v-else>
              {{ $t('cosmos.planets.' + p.id + '.name') }}
            </template>
          </button>
        </div>

        <!-- Deep-Sky Astronomical Portals (pure visual portals, zero text overlay) -->
        <button
          v-for="pt in portals"
          :key="pt.id"
          :ref="(el) => setMapRef(domRefs.portals, pt.id, el)"
          type="button"
          class="cosmos-sky-anomaly"
          :data-portal-id="pt.id"
          :aria-label="$t(pt.labelKey) + ' · ' + pt.scale"
          style="display:none"
          @click.stop="jumpToScale(pt.target)"
        >
          <span class="cosmos-sky-anomaly-ring" :style="{ width: pt.ring + 'px', height: pt.ring + 'px' }" aria-hidden="true"></span>
        </button>

        <!-- Return to Solar System Beacon -->
        <button
          :ref="(el) => { domRefs.homeBeacon.value = el; }"
          type="button"
          class="cosmos-home-beacon"
          style="display:none"
          @click.stop="jumpToScale(13.0)"
        >{{ $t('cosmos.scale.homeSolar') }}</button>

        <!-- Galaxy Creation Stars (Per-Agent luminous bodies on spiral arms) -->
        <button
          v-for="b in activeGalaxyStars"
          :key="b.id"
          :ref="(el) => setMapRef(domRefs.books, b.id, el)"
          type="button"
          class="cosmos-book-dot"
          :class="['is-' + (b.kind || 'book'), 'is-' + (b.status || 'active')]"
          style="display:none"
          @click.stop="onClickGalaxyStar(b)"
          @dblclick.stop="onDblClickGalaxyStar(b)"
        >
          <span class="cosmos-status-pip creation-star-pip" :class="'is-' + (b.kind || 'book')"></span>
          <span>{{ b.title }}</span>
        </button>
      </div>

      <!-- Hover Session Preview Card (Click specific session -> Opens Right Conversation Drawer) -->
      <div
        v-if="hoverCardAgent && !dragActive && currentBand === 'solar' && !isObservingEvent && !isCompactViewport"
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
            <span class="cosmos-status-pip" :class="[s.status, { 'is-unread': s.unread && s.status === 'done' }]"></span>
            <div class="cosmos-hover-main">
              <div class="cosmos-hover-top">
                <span class="cosmos-hover-title">{{ s.title }}</span>
                <span class="cosmos-hover-time">{{ s.updatedLabel }}</span>
              </div>
              <div v-if="s.projectPath" class="cosmos-hover-project" :title="s.projectPath">{{ s.projectPath }}</div>
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
        :auto-zoom="constants.eventsAutoZoom"
        :active-event="eventActiveSnapshot"
        :active-events="eventActiveList"
        :next-event-index="eventNextIndex"
        :countdown-sec="eventCountdownSec"
        @observe="onObserveEvent"
        @return-solar="onReturnFromEvent"
        @stop-event="onStopEvent"
        @toggle-auto="onToggleAutoEvents"
        @toggle-auto-zoom="onToggleAutoZoom"
        @toggle-pause="onTogglePauseEvent"
        @replay="onReplayEvent"
        @next-random="onNextRandomEvent"
        @set-zoom="onSetEventZoom"
        @reset-view="onResetEventView"
        @scrub="onScrubEvent"
      />

      <!-- Planet Focus Inspection Dock (0.8x-24x terrain zoom + 3D orbit + Return to Sun) -->
      <div
        v-if="focusedCameraPlanetId && currentBand === 'solar' && !isObservingEvent"
        class="cosmos-planet-focus-dock"
        :class="{ 'is-corner-dock': Boolean(quickAgent && !drawerOpen) }"
        @pointerdown.stop
        @wheel.stop
      >
        <span class="cosmos-pf-name">{{ $t('cosmos.planets.' + focusedCameraPlanetId + '.name') }}</span>
        <div class="cosmos-pf-zoom">
          <button
            type="button"
            class="cosmos-ewd-mini"
            :title="$t('cosmos.planetFocus.zoomOut')"
            :aria-label="$t('cosmos.planetFocus.zoomOut')"
            @click="setPlanetZoom(planetFocusZoom / 1.35)"
          >−</button>
          <input
            type="range"
            class="cosmos-ewd-range cosmos-pf-range"
            min="0.8"
            max="24"
            step="0.1"
            :aria-label="$t('cosmos.planetFocus.zoomRange')"
            :value="planetFocusZoom"
            @input="setPlanetZoom(Number($event.target.value))"
          />
          <button
            type="button"
            class="cosmos-ewd-mini"
            :title="$t('cosmos.planetFocus.zoomIn')"
            :aria-label="$t('cosmos.planetFocus.zoomIn')"
            @click="setPlanetZoom(planetFocusZoom * 1.35)"
          >+</button>
          <span class="cosmos-ewd-val">{{ planetFocusZoom.toFixed(1) }}×</span>
        </div>
        <button
          v-if="planetFocusRotated"
          type="button"
          class="cosmos-ewd-btn"
          @click="resetPlanetInspect"
        >{{ $t('cosmos.planetFocus.resetAngle') }}</button>
        <button
          type="button"
          class="cosmos-ewd-btn cosmos-pf-return"
          :title="$t('cosmos.planetFocus.returnSunTitle')"
          @click="unfocusPlanet"
        >{{ $t('cosmos.planetFocus.returnSun') }}</button>
      </div>

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

      <!-- Top-Right Immersive Controls: Signal Stream Capsule + Cosmic Constants (Λ) + Abandon Cosmos -->
      <div class="cosmos-corner-actions" @pointerdown.stop>
        <button
          ref="signalTriggerRef"
          type="button"
          class="cosmos-signal-trigger"
          :class="{
            'is-icon-only': signalStream.badgeCount === 0 && signalStream.runningCount === 0,
            'has-waiting': signalStream.waitingCount > 0,
            'has-unread': signalStream.waitingCount === 0 && signalStream.unreadCount > 0,
            'has-running-only': signalStream.badgeCount === 0 && signalStream.runningCount > 0,
          }"
          :aria-expanded="signalTriggerExpanded ? 'true' : 'false'"
          :title="signalTriggerLabel"
          :aria-label="signalTriggerLabel"
          @click.stop="onToggleSignalTrigger"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6-5.6-1.9 5.6-1.9Z"/>
          </svg>
          <span v-if="signalStream.badgeCount > 0" class="cosmos-signal-trigger-count">{{ signalStream.badgeCount }}</span>
          <span v-else-if="signalStream.runningCount > 0" class="cosmos-signal-trigger-pulse" aria-hidden="true"></span>
        </button>

        <button
          type="button"
          class="cosmos-corner-icon"
          :aria-expanded="constantsOpen ? 'true' : 'false'"
          :title="$t('cosmos.constants.title')"
          :aria-label="$t('cosmos.constants.title')"
          @click.stop="onToggleConstants"
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

      <!-- Unified Interstellar Signal Stream (Top-Right Floating Replies + Drawer-Docked Popover + Mobile Sheet) -->
      <CosmosSignalStream
        :items="signalStream.items"
        :waiting-count="signalStream.waitingCount"
        :unread-count="signalStream.unreadCount"
        :running-count="signalStream.runningCount"
        :badge-count="signalStream.badgeCount"
        :dismissible-count="signalStream.dismissibleCount"
        :drawer-open="drawerOpen"
        :is-compact="isCompactViewport"
        :preview-mode="constants.livePreviewMode"
        :popover-open="signalPopoverOpen"
        :stream-hidden="signalStreamHidden"
        :suppressed="constantsOpen || isObservingEvent"
        @open-signal="onOpenSignal"
        @dismiss-signal="onDismissSignal"
        @mark-all-read="onMarkAllSignalsRead"
        @close-popover="closeSignalPopover({ restoreFocus: true })"
      />

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
        @open-search="openCosmosSessionSearch($event?.agentId)"
        @routed="onAutoRouted"
        @open-llm-config="openAgentLlmConfig"
      />

      <!-- Right Feathered Planetary Conversation Drawer -->
      <CosmosConversationDrawer
        v-if="drawerOpen && drawerAgent"
        ref="drawerRef"
        :agent="drawerAgent"
        :planet-id="assignments.agentToPlanet[drawerAgent.id] || 'earth'"
        :all-agents="projectedAgentList"
        :agent-to-planet="assignments.agentToPlanet"
        :widened="workbenchWidened"
        :drawer-width="effectiveDrawerWidth"
        :min-drawer-width="drawerMinWidth"
        :max-drawer-width="drawerMaxWidth"
        :viewport-width="viewportWidth"
        :resizing="drawerResizing"
        @close="closeDrawer"
        @select-session="onDrawerSelectSession"
        @open-quick-composer="openQuickComposerFromDrawer"
        @open-session-settings="openSessionSettings"
        @open-llm-config="openAgentLlmConfig"
        @toggle-widen="toggleWorkbenchWiden"
        @resize-start="onDrawerResizeStart"
        @resize="onDrawerResize"
        @resize-end="onDrawerResizeEnd"
        @resize-reset="onDrawerResizeReset"
        @message-sent="emitTelemetryBeam"
      />

      <!-- Galaxy Scale Per-Agent Creation Studio Overlay (L1 HUD, Star Catalog, L2 Inspector, Omni-Ignite Dock) -->
      <CosmosGalaxyOverlay
        ref="galaxyOverlayRef"
        :agents="projectedAgentList"
        :visible="currentBand === 'galaxy'"
        @open-creation="openGalaxyCreation"
        @toast="showToast"
      />

      <!-- L3 Full-Screen Creation Interior (Read Mode & Co-Creation Studio) -->
      <CreationInteriorModal v-if="creationsStore.activeCreation" />

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
      <SessionSettingsModal
        v-if="sessionSettingsModal.open && sessionSettingsModal.sessionId"
        :group-id="sessionSettingsModal.sessionId"
        :agent-id="sessionSettingsModal.agentId"
        :initial-section="sessionSettingsModal.section"
        @close="closeSessionSettings"
        @open-vp-library="openVpLibraryFromSessionSettings"
      />
    </div>
  `,
  setup() {
    const store = Pinia.useChatStore();
    const sessionsStore = Pinia.useSessionsStore ? Pinia.useSessionsStore() : null;
    const creationsStore = useCreationsStore();
    const { proxy } = Vue.getCurrentInstance();
    const $t = (k, p) => (proxy?.$t ? proxy.$t(k, p) : k);

    const glCanvasRef = Vue.ref(null);
    const hudCanvasRef = Vue.ref(null);
    const hoverCardRef = Vue.ref(null);
    const drawerRef = Vue.ref(null);
    const galaxyOverlayRef = Vue.ref(null);
    const signalTriggerRef = Vue.ref(null);

    const domRefs = {
      planets: {},
      hits: {},
      tags: {},
      portals: {},
      books: {},
      homeBeacon: { value: null },
      eventBeacon: { value: null },
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
    const signalPopoverOpen = Vue.ref(false);
    const signalStreamHidden = Vue.ref(false);
    const quickAgentId = Vue.ref(null);
    const drawerOpen = Vue.ref(false);
    const drawerAgentId = Vue.ref(null);
    const workbenchWidened = Vue.ref(false);
    const workbenchMaximized = Vue.computed(() => Boolean(store.workbenchExpanded && store.workbenchMaximized));
    const viewportWidth = Vue.ref(typeof window !== 'undefined' ? (window.innerWidth || 1280) : 1280);
    const isCompactViewport = Vue.computed(() => viewportWidth.value <= 768);
    const customDrawerWidth = Vue.ref(loadCosmosDrawerWidth());
    const drawerResizing = Vue.ref(false);
    const drawerMinWidth = COSMOS_DRAWER_WIDTH.min;
    const drawerMaxWidth = Vue.computed(() => (
      Math.max(
        COSMOS_DRAWER_WIDTH.min,
        Math.min(COSMOS_DRAWER_WIDTH.max, Math.floor(viewportWidth.value - COSMOS_DRAWER_WIDTH.minRemaining)),
      )
    ));
    const effectiveDrawerWidth = Vue.computed(() => {
      const vw = viewportWidth.value;
      if (vw <= 768) return vw;
      if (workbenchMaximized.value) return drawerMaxWidth.value;
      if (workbenchWidened.value) {
        const customClamped = customDrawerWidth.value != null
          ? clampCosmosDrawerWidth(customDrawerWidth.value, vw)
          : 0;
        const wideDefault = Math.min(760, Math.max(540, Math.round(vw * 0.50)));
        return clampCosmosDrawerWidth(Math.max(customClamped, wideDefault), vw);
      }
      if (customDrawerWidth.value != null) {
        return clampCosmosDrawerWidth(customDrawerWidth.value, vw);
      }
      return clampCosmosDrawerWidth(Math.min(488, Math.max(388, Math.round(vw * 0.34))), vw);
    });
    const cosmosPageStyle = Vue.computed(() => (
      viewportWidth.value > 768 ? { '--c-panel-w': `${effectiveDrawerWidth.value}px` } : {}
    ));
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
    const sessionSettingsModal = Vue.reactive({ open: false, sessionId: null, agentId: null, section: 'session' });

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
    const isDrawerConversationCovered = Vue.computed(() => (
      !(drawerOpen.value && currentBand.value === 'solar')
      || Boolean(store.workbenchExpanded)
      || Boolean(settingsModal.open || agentSettingsModal.open || sessionSettingsModal.open)
    ));
    const activeDrawerSessionKey = Vue.computed(() => {
      if (isDrawerConversationCovered.value
        || !drawerAgentId.value
        || store.currentView !== 'yeaft'
        || store.currentAgent !== drawerAgentId.value) return '';
      const route = store.activeSessionRoute;
      if (route) {
        if (route.runtimeProvider !== 'yeaft' || route.agentId !== drawerAgentId.value || !route.sessionId) return '';
        return `${drawerAgentId.value}\u001f${route.sessionId}`;
      }
      const sid = store.yeaftActiveSessionFilter || '';
      return sid ? `${drawerAgentId.value}\u001f${sid}` : '';
    });
    const signalStream = Vue.computed(() => buildCosmosSignalStream({
      projectedAgents: projectedAgentList.value,
      agentToPlanet: assignments.value.agentToPlanet,
      scheduledTaskNotifications: store.scheduledTaskNotifications || [],
      activeDrawerKey: activeDrawerSessionKey.value,
      nowMs: nowTick.value,
      isEn: getLocale() === 'en',
      t: $t,
    }));
    const signalTriggerLabel = Vue.computed(() => (
      signalStream.value.badgeCount > 0
        ? $t('cosmos.signals.triggerAria', { count: signalStream.value.badgeCount })
        : $t('cosmos.signals.triggerIdleAria')
    ));
    const signalTriggerExpanded = Vue.computed(() => {
      if (signalPopoverOpen.value) return true;
      if (drawerOpen.value || isCompactViewport.value || constants.livePreviewMode === 'collapsed' || signalStream.value.totalCount === 0) {
        return false;
      }
      return !signalStreamHidden.value && !constantsOpen.value && !isObservingEvent.value;
    });
    const hoverCardAgent = Vue.computed(() => (hoverPlanetId.value ? agentsByPlanet.value[hoverPlanetId.value] || null : null));
    const hoverPreviewSessions = Vue.computed(() => {
      const ag = hoverCardAgent.value;
      if (!ag) return [];
      const prioritized = ag.sessions.slice().sort((a, b) => {
        const score = (s) => (s.status === 'waiting' ? 0 : (s.unread ? 1 : (s.status === 'running' ? 2 : 3)));
        return score(a) - score(b) || (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      return prioritized.slice(0, 4);
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

    const eventSim = createCosmicEventState({
      autoEnabled: constants.eventsAutoEnabled,
      autoZoom: constants.eventsAutoZoom,
    });
    const eventActiveSnapshot = Vue.ref(null);
    const eventActiveList = Vue.ref([]);
    const eventNextIndex = Vue.ref(eventSim.nextIdx);
    const eventCountdownSec = Vue.ref(eventSim.countdown);
    const isObservingEvent = Vue.computed(() => Boolean(eventActiveSnapshot.value?.observing));

    const focusedCameraPlanetId = Vue.ref(null);
    const planetFocusZoom = Vue.ref(1.0);
    const planetFocusRotated = Vue.ref(false);

    function syncEventRefs() {
      eventActiveSnapshot.value = eventSim.active
        ? { ...eventSim.active, location: eventSim.active.location ? { ...eventSim.active.location } : null }
        : null;
      eventActiveList.value = Array.isArray(eventSim.events)
        ? eventSim.events.map((e) => ({ ...e, location: e.location ? { ...e.location } : null }))
        : (eventActiveSnapshot.value ? [eventActiveSnapshot.value] : []);
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
      planetFocus: {
        planetId: null,
        lastPlanetId: null,
        blend: 0,
        zoom: 1.0,
        targetZoom: 1.0,
        inspectYaw: 0,
        inspectPitch: 0,
        targetInspectYaw: 0,
        targetInspectPitch: 0,
      },
      lastEventFrames: [],
      meteors: [], nextMeteorAt: 4.5,
      orbitRipples: [], telemetryBeams: [],
      drag: null, camDrag: null, constants,
    };

    function focusPlanet(planetId, { defaultZoom = 2.2 } = {}) {
      if (!planetId) return;
      if (eventSim.active?.observing) {
        unfocusCosmicEvent(eventSim);
        syncEventRefs();
      }
      if (scaleBand(anim.targetScaleLog) !== 'solar') {
        anim.targetScaleLog = 13.0;
        anim.warpEnergy = Math.min(1, anim.warpEnergy + 0.45);
      }
      const pf = anim.planetFocus;
      const switching = pf.planetId !== planetId;
      pf.planetId = planetId;
      pf.lastPlanetId = planetId;
      if (switching) {
        pf.targetZoom = Math.max(0.8, Math.min(24.0, defaultZoom));
        pf.targetInspectYaw = 0;
        pf.targetInspectPitch = 0;
      }
      focusedCameraPlanetId.value = planetId;
      planetFocusZoom.value = pf.targetZoom;
      planetFocusRotated.value = Math.abs(pf.targetInspectYaw) > 0.04 || Math.abs(pf.targetInspectPitch) > 0.04;
    }

    function unfocusPlanet() {
      const pf = anim.planetFocus;
      if (!pf.planetId) return;
      pf.planetId = null;
      pf.targetZoom = 1.0;
      pf.targetInspectYaw = 0;
      pf.targetInspectPitch = 0;
      focusedCameraPlanetId.value = null;
      planetFocusZoom.value = 1.0;
      planetFocusRotated.value = false;
    }

    function setPlanetZoom(val) {
      const pf = anim.planetFocus;
      if (!pf.planetId) return;
      const clamped = Math.max(0.8, Math.min(24.0, Number(val) || 1.0));
      pf.targetZoom = clamped;
      planetFocusZoom.value = clamped;
    }

    function resetPlanetInspect() {
      const pf = anim.planetFocus;
      if (!pf.planetId) return;
      pf.targetInspectYaw = 0;
      pf.targetInspectPitch = 0;
      planetFocusRotated.value = false;
    }

    const pools = createParticlePools();
    let webGraph = null;
    const getWebGraph = () => {
      if (!webGraph) webGraph = createCosmicWebGraph();
      return webGraph;
    };
    const gpuParticles = new Float32Array(3100 * 7);
    const eventGpuParticles = new Float32Array(520 * 7);

    let engine = null;
    let rafId = 0;
    let mountRafId = 0;
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
      const panelW = drawerOpen.value ? effectiveDrawerWidth.value : 0;
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
      unfocusPlanet();
      const prev = anim.targetScaleLog;
      anim.targetScaleLog = Math.max(7.0, Math.min(24.0, targetLog));
      if (Math.abs(anim.targetScaleLog - prev) > 0.6) anim.warpEnergy = Math.min(1.0, anim.warpEnergy + 0.85);
      if (eventSim.active?.observing) { unfocusCosmicEvent(eventSim); syncEventRefs(); }
      hideHoverImmediate();
      emptyPlanetMenu.value = null;
      if (scaleBand(anim.targetScaleLog) !== 'solar') {
        quickAgentId.value = null;
        if (drawerOpen.value) closeDrawer();
      }
      if (scaleBand(anim.targetScaleLog) !== 'galaxy') {
        bookCreateOpen.value = false;
        creationsStore.inspectorTarget = null;
        if (creationsStore.igniteDraft?.open) {
          creationsStore.igniteDraft = { ...creationsStore.igniteDraft, open: false };
        }
        creationsStore.closeCreation();
      }
    }

    const activeTouchPointers = new Map();
    let pinchPrevDist = 0;

    function getTouchPinchDist() {
      const pts = Array.from(activeTouchPointers.values());
      if (pts.length < 2) return 0;
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }

    function matchesDragPointer(dragState, e) {
      if (!dragState) return false;
      if (dragState.pointerId == null || e?.pointerId == null) return true;
      return dragState.pointerId === e.pointerId;
    }

    function cancelPlanetDrag() {
      anim.drag = null;
      dragActive.value = false;
      dragFromPlanetId.value = null;
      dragOverPlanetId.value = null;
    }

    function cancelCamDrag() {
      anim.camDrag = null;
      camOrbiting.value = false;
    }

    function cancelActiveDrags() {
      cancelCamDrag();
      cancelPlanetDrag();
    }

    function onCanvasPointerDown(e) {
      if (e.pointerType !== 'touch' && e.button !== 0) return;
      emptyPlanetMenu.value = null;
      constantsOpen.value = false;
      signalPopoverOpen.value = false;
      if (e.pointerType === 'touch') {
        activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (activeTouchPointers.size >= 2) {
          cancelActiveDrags();
          pinchPrevDist = getTouchPinchDist();
          return;
        }
      }
      const mode = eventSim.active?.observing
        ? 'event'
        : (anim.planetFocus.planetId ? 'planet' : 'solar');
      anim.camDrag = {
        pointerId: e.pointerId ?? null,
        mode,
        startX: e.clientX,
        startY: e.clientY,
        yaw0: mode === 'event'
          ? (eventSim.active?.targetViewYaw || 0)
          : (mode === 'planet' ? anim.planetFocus.targetInspectYaw : anim.camRot.tx),
        pitch0: mode === 'event'
          ? (eventSim.active?.targetViewPitch || 0)
          : (mode === 'planet' ? anim.planetFocus.targetInspectPitch : anim.camRot.ty),
        moved: false,
      };
      camOrbiting.value = true;
    }
    const activeGalaxyStars = Vue.computed(() => {
      const list = creationsStore.currentAgentCreations || [];
      return list.map((c, idx) => {
        const celestial = c.celestial || c.placement || {};
        const arm = Number.isFinite(celestial.arm) ? celestial.arm : (idx % 4);
        const r = Number.isFinite(celestial.r) ? celestial.r : Math.min(0.76, 0.30 + (idx % 5) * 0.105);
        const theta = Number.isFinite(celestial.theta) ? celestial.theta : ((arm * Math.PI) / 2 + 0.68 + idx * 0.43);
        return { ...c, arm, r, theta };
      });
    });

    function ensureGalaxyAgentSelected() {
      const list = projectedAgentList.value;
      if (!list.length) return;
      const existing = creationsStore.selectedAgentId;
      if (existing && list.some((a) => a.id === existing)) {
        const current = list.find((a) => a.id === existing);
        if (current?.online && current.capabilities?.includes('creations')) {
          const bucket = creationsStore.byAgent[existing];
          if (!bucket?.loaded && !bucket?.loading) {
            creationsStore.listCreations(existing).catch(() => {});
          }
        }
        return;
      }
      const preferred = list.find((a) => a.id === store.currentAgent && a.online && a.capabilities?.includes('creations'))
        || list.find((a) => a.online && a.capabilities?.includes('creations'))
        || list.find((a) => a.online)
        || list[0];
      if (preferred?.id) {
        creationsStore.selectGalaxyAgent(preferred.id).catch(() => {});
      }
    }

    Vue.watch([currentBand, projectedAgentList], ([band], prev) => {
      if (band === 'galaxy') {
        ensureGalaxyAgentSelected();
      } else if (prev && prev[0] === 'galaxy') {
        creationsStore.inspectorTarget = null;
        if (creationsStore.igniteDraft?.open) {
          creationsStore.igniteDraft = { ...creationsStore.igniteDraft, open: false };
        }
        creationsStore.closeCreation();
      }
    }, { immediate: true });

    function onClickGalaxyStar(star) {
      if (!star?.id || !creationsStore.selectedAgentId) return;
      creationsStore.inspectorTarget = { agentId: creationsStore.selectedAgentId, creationId: star.id };
    }

    function onDblClickGalaxyStar(star) {
      if (!star?.id || !creationsStore.selectedAgentId) return;
      openGalaxyCreation({ agentId: creationsStore.selectedAgentId, creationId: star.id });
    }

    async function openGalaxyCreation({ agentId, creationId, mode } = {}) {
      const targetAgentId = agentId || creationsStore.selectedAgentId;
      if (!targetAgentId || !creationId) return;
      try {
        await creationsStore.openCreation(targetAgentId, creationId, { mode });
      } catch (err) {
        showToast(err?.message || $t('creation.galaxy.offlineReadonly'));
      }
    }

    function resetCamera() {
      if (eventSim.active?.observing) {
        onResetEventView();
        return;
      }
      if (anim.planetFocus.planetId) {
        resetPlanetInspect();
        showToast($t('cosmos.scale.resetView'));
        return;
      }
      anim.camRot.tx = 0; anim.camRot.ty = 0;
      showToast($t('cosmos.scale.resetView'));
    }

    function onCanvasDblClick(e) {
      if (
        currentBand.value === 'galaxy'
        && creationsStore.viewMode === 'galaxy'
        && !creationsStore.activeCreation
        && creationsStore.selectedAgentId
      ) {
        const w = window.innerWidth || 1280;
        const h = window.innerHeight || 720;
        const gRad = Math.min(w, h) * 0.52;
        const gTilt = 0.54 + anim.camRot.y * 0.16;
        const gSpin = -anim.realTime * 0.016 - anim.time * 0.012;
        const dx = (e.clientX - (w * 0.5 + anim.parallax.x * 12)) / Math.max(1, gRad);
        const dy = (e.clientY - (h * 0.5 + anim.parallax.y * 8)) / Math.max(1, gRad * gTilt);
        const r = Math.max(0.18, Math.min(0.84, Math.hypot(dx, dy)));
        const theta = Math.atan2(dy, dx) - gSpin;
        const arm = ((Math.round(((theta % (Math.PI * 2)) + Math.PI * 2) / (Math.PI / 2)) % 4) + 4) % 4;
        creationsStore.igniteDraft = {
          ...creationsStore.igniteDraft,
          open: true,
          celestial: { arm, r, theta },
        };
        return;
      }
      resetCamera();
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
      signalPopoverOpen.value = false;
      const agent = agentsByPlanet.value[planetId];
      if (!agent) {
        focusPlanet(planetId);
        if (projectedAgentList.value.length === 0) { openYeaftSettings({ tab: 'security' }); return; }
        emptyPlanetMenu.value = {
          planetId,
          x: Math.min(ev.clientX, (window.innerWidth || 1280) - 240),
          y: Math.min(ev.clientY, (window.innerHeight || 720) - 220),
        };
        return;
      }
      anim.drag = {
        pointerId: ev.pointerId ?? null,
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
      if (anim.planetFocus.planetId && result.fromPlanetId === anim.planetFocus.planetId) {
        focusPlanet(targetPlanetId, { defaultZoom: anim.planetFocus.targetZoom });
      }
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
              const res = setCosmicEventZoom(eventSim, eventSim.active.targetZoom + zoomDelta, { allowExit: true });
              syncEventRefs();
              if (res?.exited) showToast($t('cosmos.events.returnedToast'));
            } else if (anim.planetFocus.planetId) {
              const ratio = dist / Math.max(pinchPrevDist, 1);
              setPlanetZoom(anim.planetFocus.targetZoom * Math.pow(ratio, 1.35));
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

      if (matchesDragPointer(anim.drag, e)) {
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
      if (matchesDragPointer(anim.camDrag, e)) {
        const dx = e.clientX - anim.camDrag.startX;
        const dy = e.clientY - anim.camDrag.startY;
        if (Math.hypot(dx, dy) > 4) anim.camDrag.moved = true;
        if (anim.camDrag.mode === 'event') {
          setCosmicEventViewAngles(eventSim, anim.camDrag.yaw0 + dx * 0.006, anim.camDrag.pitch0 + dy * 0.005);
          syncEventRefs();
        } else if (anim.camDrag.mode === 'planet') {
          anim.planetFocus.targetInspectYaw = anim.camDrag.yaw0 + dx * 0.0075;
          anim.planetFocus.targetInspectPitch = Math.max(-1.05, Math.min(1.05, anim.camDrag.pitch0 + dy * 0.0055));
          planetFocusRotated.value = Math.abs(anim.planetFocus.targetInspectYaw) > 0.04 || Math.abs(anim.planetFocus.targetInspectPitch) > 0.04;
        } else {
          anim.camRot.tx = Math.max(-0.85, Math.min(0.85, anim.camDrag.yaw0 + dx * 0.0024));
          anim.camRot.ty = Math.max(-0.42, Math.min(0.45, anim.camDrag.pitch0 + dy * 0.0022));
        }
      } else if (!anim.drag && currentBand.value === 'solar' && !eventSim.active?.observing) {
        const hitEv = hitTestAmbientEvent(anim.lastEventFrames, e.clientX, e.clientY);
        eventSim.hoveredUid = hitEv ? hitEv.uid : null;
        if (glCanvasRef.value) {
          glCanvasRef.value.style.cursor = hitEv ? 'pointer' : '';
        }
      } else if (eventSim.hoveredUid || glCanvasRef.value?.style.cursor) {
        eventSim.hoveredUid = null;
        if (glCanvasRef.value) glCanvasRef.value.style.cursor = '';
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

    function onWindowBlur() {
      activeTouchPointers.clear();
      pinchPrevDist = 0;
      cancelActiveDrags();
    }

    function onGlobalPointerCancel(e) {
      if (e && e.pointerType === 'touch') {
        activeTouchPointers.delete(e.pointerId);
        if (activeTouchPointers.size < 2) pinchPrevDist = 0;
      }
      if (matchesDragPointer(anim.drag, e)) cancelPlanetDrag();
      if (matchesDragPointer(anim.camDrag, e)) cancelCamDrag();
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
      if (matchesDragPointer(anim.drag, e)) {
        const drag = anim.drag;
        cancelPlanetDrag();
        if (drag.active) {
          if (drag.overPlanetId) performMoveOrSwap(drag.agentId, drag.overPlanetId);
        } else {
          // Single click on planet -> Center camera on planet + open Quick Auto-Route Composer
          hideHoverImmediate();
          focusPlanet(drag.fromPlanetId);
          if (drawerOpen.value) closeDrawer();
          quickAgentId.value = drag.agentId;
        }
        return;
      }
      if (matchesDragPointer(anim.camDrag, e)) {
        const moved = anim.camDrag.moved;
        const clickX = e.clientX;
        const clickY = e.clientY;
        cancelCamDrag();
        if (!moved) {
          // 1. Direct click on an unfolding ambient cosmic event on the shared canvas
          if (currentBand.value === 'solar' && !eventSim.active?.observing) {
            const hitEv = hitTestAmbientEvent(anim.lastEventFrames, clickX, clickY);
            if (hitEv) {
              unfocusPlanet();
              const act = focusCosmicEventByUid(eventSim, hitEv.uid);
              hideHoverImmediate();
              quickAgentId.value = null;
              if (drawerOpen.value) closeDrawer();
              syncEventRefs();
              if (act) showToast(formatEventLocationToast(act));
              return;
            }
          }
          // 2. Direct click on the Sun returns from planet focus to Sun center
          if (anim.planetFocus.planetId && anim.solarSunScreen?.r > 0) {
            const dSun = Math.hypot(clickX - anim.solarSunScreen.x, clickY - anim.solarSunScreen.y);
            if (dSun <= Math.max(36, anim.solarSunScreen.r * 1.18)) {
              unfocusPlanet();
              return;
            }
          }
          // 3. Direct click on a zoomed planet body (when hit element is hidden on deep close-up)
          if (currentBand.value === 'solar' && !eventSim.active?.observing) {
            for (const p of PLANETS) {
              const pos = anim.planetScreen[p.id];
              if (!pos || pos.r < 6) continue;
              const hitR = pos.r * (p.bodyType === 6 ? 1.55 : 1.05);
              if (Math.hypot(clickX - pos.x, clickY - pos.y) <= hitR) {
                if (anim.planetFocus.planetId !== p.id) {
                  focusPlanet(p.id);
                  const ag = agentsByPlanet.value[p.id];
                  if (ag) {
                    if (drawerOpen.value) closeDrawer();
                    quickAgentId.value = ag.id;
                  }
                }
                return;
              }
            }
          }
          if (quickAgentId.value) quickAgentId.value = null;
          if (drawerOpen.value) closeDrawer();
        }
      }
    }

    function onStageWheel(e) {
      if (settingsModal.open || agentSettingsModal.open || sessionSettingsModal.open || creationsStore.activeCreation) return;
      if (e.target.closest('.cosmos-drawer, .cosmos-quick-composer, .cosmos-constants-popover, .cosmos-hover-card, .cosmos-event-almanac, .cosmos-book-popover, .cosmos-signal-stream, .cosmos-signal-popover, .cosmos-signal-mobile-banner, .creation-galaxy-hud, .creation-catalog-panel, .creation-inspector-card, .creation-ignite-dock, .creation-interior-modal')) return;
      e.preventDefault();
      if (eventSim.active?.observing) {
        const delta = -Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 100) * 0.0032;
        const res = setCosmicEventZoom(eventSim, eventSim.active.targetZoom + delta, { allowExit: true });
        syncEventRefs();
        if (res?.exited) showToast($t('cosmos.events.returnedToast'));
        return;
      }
      if (Date.now() < (eventSim.exitCooldownUntil || 0)) {
        return;
      }
      // When focused on a planet, wheel ONLY zooms that planet (0.8x-24x) — NEVER enters Black Hole Horizon!
      if (anim.planetFocus.planetId) {
        const clampedDelta = Math.max(-140, Math.min(140, e.deltaY));
        const factor = Math.exp(-clampedDelta * 0.0024);
        setPlanetZoom(anim.planetFocus.targetZoom * factor);
        hideHoverImmediate();
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

    function closeSignalPopover({ restoreFocus = false } = {}) {
      if (!signalPopoverOpen.value) return;
      signalPopoverOpen.value = false;
      if (restoreFocus) {
        Vue.nextTick(() => signalTriggerRef.value?.focus?.());
      }
    }

    function openSessionInDrawer(agentId, session) {
      hideHoverImmediate();
      signalPopoverOpen.value = false;
      if (!agentId || !projectedAgentsMap.value[agentId]) return false;
      if (currentBand.value !== 'solar') jumpToScale(13.0);
      if (eventSim.active?.observing) {
        unfocusCosmicEvent(eventSim);
        syncEventRefs();
      }
      if (store.workbenchExpanded) collapseOpenWorkbench();
      const targetPlanetId = assignments.value.agentToPlanet[agentId];
      if (targetPlanetId) focusPlanet(targetPlanetId, { defaultZoom: 1.9 });
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
      const isNativeYeaft = !session?.runtimeProvider || session.runtimeProvider === 'yeaft';
      if (isNativeYeaft && session?.id && agentId) {
        store.acknowledgeYeaftSessionSignals?.(session.id, agentId, { sessionRead: true });
      }
      return true;
    }

    function onToggleConstants() {
      constantsOpen.value = !constantsOpen.value;
      if (constantsOpen.value) signalPopoverOpen.value = false;
    }

    function onToggleSignalTrigger() {
      constantsOpen.value = false;
      if (signalPopoverOpen.value) {
        signalPopoverOpen.value = false;
        return;
      }
      const usePopover = drawerOpen.value
        || isCompactViewport.value
        || constants.livePreviewMode === 'collapsed'
        || signalStream.value.totalCount === 0;
      if (usePopover) {
        signalPopoverOpen.value = true;
      } else {
        signalStreamHidden.value = !signalStreamHidden.value;
      }
    }

    function hasProjectedOrKnownSession(agentId, session) {
      const ag = agentId ? projectedAgentsMap.value[agentId] : null;
      if (!ag) return false;
      if (!session?.id) return false;
      if (session.descriptor) return true;
      if (ag.sessions?.some((s) => s.id === session.id)) return true;
      if (typeof store.hasKnownYeaftSession === 'function' && store.hasKnownYeaftSession(session.id, agentId)) return true;
      if (sessionsStore?.sessionById?.(session.id, agentId)) return true;
      return false;
    }

    function onOpenSignal(item) {
      if (!item?.agentId) return;
      const targetSession = item.session || { id: item.sessionId, runtimeProvider: 'yeaft' };
      if (!projectedAgentsMap.value[item.agentId] || !hasProjectedOrKnownSession(item.agentId, targetSession)) {
        closeSignalPopover({ restoreFocus: true });
        onDismissSignal(item);
        showToast($t(!projectedAgentsMap.value[item.agentId]
          ? 'cosmos.signals.agentUnavailable'
          : 'cosmos.signals.sessionUnavailable'));
        return;
      }
      openSessionInDrawer(item.agentId, targetSession);
    }

    function onDismissSignal(item) {
      if (!item) return;
      if (item.sessionId && item.agentId && typeof store.acknowledgeYeaftSessionSignals === 'function') {
        store.acknowledgeYeaftSessionSignals(item.sessionId, item.agentId, { sessionRead: false });
      } else {
        if (item.sessionId && item.agentId) store.markYeaftSessionRead?.(item.sessionId, item.agentId);
        if (item.scheduledTask?.id) store.dismissScheduledTaskNotification?.(item.scheduledTask.id);
      }
    }

    function onMarkAllSignalsRead() {
      if (typeof store.acknowledgeAllYeaftSessionSignals === 'function') {
        store.acknowledgeAllYeaftSessionSignals();
      } else {
        for (const item of signalStream.value.items) {
          if (item.dismissible) onDismissSignal(item);
        }
      }
      if (signalPopoverOpen.value && signalStream.value.waitingCount === 0 && signalStream.value.runningCount === 0) {
        closeSignalPopover({ restoreFocus: true });
      }
    }

    function openAgentConversationFromQuick({ agentId, sessionId }) {
      const ag = projectedAgentsMap.value[agentId];
      const session = sessionId
        ? ag?.sessions?.find((s) => s.id === sessionId) || { id: sessionId }
        : ag?.sessions?.[0] || null;
      openSessionInDrawer(agentId, session);
    }

    function openCosmosSessionSearch(preferredAgentId = null) {
      const isValidAgent = (id) => Boolean(id && projectedAgentsMap.value[id]);
      if (drawerOpen.value && drawerRef.value && isValidAgent(drawerAgentId.value)
          && (!preferredAgentId || preferredAgentId === drawerAgentId.value)) {
        drawerRef.value.openSessionSwitcher?.({ focusSearch: true });
        return;
      }
      const targetId = [
        preferredAgentId,
        quickAgentId.value,
        drawerAgentId.value,
        store.currentAgent,
        projectedAgentList.value[0]?.id,
      ].find(isValidAgent) || null;
      if (!targetId) return;
      if (currentBand.value !== 'solar') jumpToScale(13.0);
      openAgentConversationFromQuick({ agentId: targetId, sessionId: null });
      Vue.nextTick(() => drawerRef.value?.openSessionSwitcher?.({ focusSearch: true }));
    }

    function onDrawerSelectSession({ agentId, session }) { openSessionInDrawer(agentId, session); }

    function collapseOpenWorkbench() {
      if (store.workbenchExpanded) {
        if (typeof store.toggleWorkbench === 'function') store.toggleWorkbench();
        else store.workbenchExpanded = false;
      }
      if (store.workbenchMaximized) store.workbenchMaximized = false;
    }

    function toggleWorkbenchWiden() {
      if (store.workbenchMaximized) {
        if (typeof store.toggleWorkbenchMaximized === 'function') store.toggleWorkbenchMaximized();
        else store.workbenchMaximized = false;
        workbenchWidened.value = false;
        return;
      }
      const vw = viewportWidth.value;
      const wideDefault = Math.min(760, Math.max(540, Math.round(vw * 0.50)));
      const customClamped = customDrawerWidth.value != null
        ? clampCosmosDrawerWidth(customDrawerWidth.value, vw)
        : null;
      if (workbenchWidened.value) {
        workbenchWidened.value = false;
        if (customClamped != null && customClamped >= wideDefault) {
          customDrawerWidth.value = null;
          saveCosmosDrawerWidth(null);
        }
        return;
      }
      if (customClamped != null && customClamped >= wideDefault) {
        customDrawerWidth.value = null;
        saveCosmosDrawerWidth(null);
        return;
      }
      workbenchWidened.value = true;
    }

    function closeDrawer() {
      drawerResizing.value = false;
      drawerOpen.value = false;
      drawerAgentId.value = null;
      workbenchWidened.value = false;
      collapseOpenWorkbench();
    }

    function openQuickComposerFromDrawer(agentId) {
      const targetId = agentId || drawerAgentId.value || null;
      closeDrawer();
      if (targetId) quickAgentId.value = targetId;
    }

    function onDrawerResizeStart(measuredWidth) {
      drawerResizing.value = true;
      if (store.workbenchMaximized) {
        if (typeof store.toggleWorkbenchMaximized === 'function') store.toggleWorkbenchMaximized();
        else store.workbenchMaximized = false;
      }
      if (workbenchWidened.value) workbenchWidened.value = false;
      const seed = Number.isFinite(measuredWidth) && measuredWidth > 0 ? measuredWidth : effectiveDrawerWidth.value;
      customDrawerWidth.value = clampCosmosDrawerWidth(seed, viewportWidth.value);
    }

    function onDrawerResize(nextWidth) {
      customDrawerWidth.value = clampCosmosDrawerWidth(nextWidth, viewportWidth.value);
    }

    function onDrawerResizeEnd() {
      drawerResizing.value = false;
      if (customDrawerWidth.value != null) {
        saveCosmosDrawerWidth(customDrawerWidth.value);
      }
    }

    function onDrawerResizeReset() {
      drawerResizing.value = false;
      if (store.workbenchMaximized) {
        if (typeof store.toggleWorkbenchMaximized === 'function') store.toggleWorkbenchMaximized();
        else store.workbenchMaximized = false;
      }
      workbenchWidened.value = false;
      customDrawerWidth.value = null;
      saveCosmosDrawerWidth(null);
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

    function formatEventLocationToast(act) {
      const name = $t(`cosmos.events.${act.def.id}.name`);
      const loc = act.location;
      if (!loc) return name;
      const dir = $t(`cosmos.events.dir.${loc.sector}`);
      const dist = formatEventPhysicalDistance(act.def, act.effDist || act.ambientDist, getLocale() === 'en');
      return $t('cosmos.events.distantToast', { name, dir, dist });
    }
    function onObserveEvent(payload) {
      const eventId = typeof payload === 'string' ? payload : (payload?.eventId || null);
      const forceObserve = Boolean(payload && typeof payload === 'object' && payload.forceObserve);
      if (scaleBand(anim.targetScaleLog) !== 'solar') jumpToScale(13.0);
      const existingLive = (eventSim.events || []).find((e) => !eventId || e.def.id === eventId) || null;
      const shouldZoomIn = forceObserve || Boolean(existingLive) || Boolean(constants.eventsAutoZoom);
      if (shouldZoomIn) unfocusPlanet();
      const act = startCosmicEvent(eventSim, eventId, { observe: shouldZoomIn });
      hideHoverImmediate();
      if (act.observing) {
        quickAgentId.value = null;
        if (drawerOpen.value) closeDrawer();
      }
      syncEventRefs();
      if (act.observing) {
        showToast(formatEventLocationToast(act));
      } else {
        showToast(formatEventLocationToast(act), {
          actionLabel: $t('cosmos.events.watch'),
          onAction: () => onFocusDistantEvent(act.uid),
        });
      }
    }
    function onFocusDistantEvent(uid = null) {
      if (!eventSim.active && (!eventSim.events || eventSim.events.length === 0)) return;
      if (scaleBand(anim.targetScaleLog) !== 'solar') jumpToScale(13.0);
      unfocusPlanet();
      const act = uid ? focusCosmicEventByUid(eventSim, uid) : focusActiveCosmicEvent(eventSim);
      hideHoverImmediate();
      quickAgentId.value = null;
      if (drawerOpen.value) closeDrawer();
      syncEventRefs();
      if (act) showToast(formatEventLocationToast(act));
    }
    function onReturnFromEvent() {
      const released = unfocusCosmicEvent(eventSim);
      syncEventRefs();
      if (released) showToast($t('cosmos.events.returnedToast'));
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
    function onToggleAutoZoom() {
      constants.eventsAutoZoom = !constants.eventsAutoZoom;
      saveCosmosConstants(constants);
      eventSim.autoZoom = constants.eventsAutoZoom;
      syncEventRefs();
      showToast($t(constants.eventsAutoZoom ? 'cosmos.events.autoZoomOnToast' : 'cosmos.events.autoZoomOffToast'));
    }
    function onTogglePauseEvent() { if (eventSim.active) { eventSim.active.paused = !eventSim.active.paused; syncEventRefs(); } }
    function onReplayEvent() { if (eventSim.active) { eventSim.active.elapsed = 0.01; eventSim.active.paused = false; syncEventRefs(); } }
    function onNextRandomEvent() {
      const curIdx = eventSim.active ? COSMIC_EVENTS.findIndex((e) => e.id === eventSim.active.def.id) : eventSim.lastPlayedIdx;
      const nextIdx = pickRandomEventIndex(curIdx);
      const act = startCosmicEvent(eventSim, COSMIC_EVENTS[nextIdx].id, { observe: true });
      syncEventRefs();
      if (act) showToast(formatEventLocationToast(act));
    }
    function onSetEventZoom(z) { setCosmicEventZoom(eventSim, z); syncEventRefs(); }
    function onResetEventView() {
      resetCosmicEventView(eventSim);
      syncEventRefs();
      showToast($t('cosmos.scale.resetView'));
    }
    function onScrubEvent(frac) { scrubCosmicEvent(eventSim, frac); syncEventRefs(); }

    function onUpdateConstant({ key, value }) {
      if (!(key in constants)) return;
      constants[key] = value;
      saveCosmosConstants(constants);
      if (key === 'eventsAutoEnabled') {
        eventSim.autoEnabled = Boolean(value);
        if (!value && eventSim.active && !eventSim.active.observing) stopCosmicEvent(eventSim);
        syncEventRefs();
      }
      if (key === 'eventsAutoZoom') {
        eventSim.autoZoom = Boolean(value);
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
    function openSessionSettings({ sessionId, agentId = null, section = 'session' } = {}) {
      if (!sessionId) return;
      constantsOpen.value = false;
      sessionSettingsModal.sessionId = sessionId;
      sessionSettingsModal.agentId = agentId || drawerAgentId.value || store.currentAgent || null;
      sessionSettingsModal.section = section || 'session';
      sessionSettingsModal.open = true;
    }
    function closeSessionSettings() {
      sessionSettingsModal.open = false;
      sessionSettingsModal.sessionId = null;
      sessionSettingsModal.agentId = null;
      sessionSettingsModal.section = 'session';
    }
    function openVpLibraryFromSessionSettings() {
      closeSessionSettings();
      openYeaftSettings({ tab: 'yeaft', subTab: 'vp' });
    }
    function abandonCosmos() {
      constantsOpen.value = false;
      creationsStore.inspectorTarget = null;
      if (creationsStore.igniteDraft?.open) {
        creationsStore.igniteDraft = { ...creationsStore.igniteDraft, open: false };
      }
      creationsStore.closeCreation();
      collapseOpenWorkbench();
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
      if (e.defaultPrevented) return;
      if (creationsStore.activeCreation) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && String(e.key || '').toLowerCase() === 'k') {
        if (settingsModal.open || agentSettingsModal.open || sessionSettingsModal.open) return;
        e.preventDefault();
        if (currentBand.value === 'galaxy') {
          galaxyOverlayRef.value?.focusSearch?.();
          return;
        }
        openCosmosSessionSearch();
        return;
      }
      if (e.key !== 'Escape') return;
      // Let SessionSettingsModal (and its nested FolderPickerDialog) own Escape & busy guards.
      if (sessionSettingsModal.open) return;
      if (settingsModal.open) { settingsModal.open = false; return; }
      if (agentSettingsModal.open) { agentSettingsModal.open = false; return; }
      if (emptyPlanetMenu.value) { emptyPlanetMenu.value = null; return; }
      if (signalPopoverOpen.value) { closeSignalPopover({ restoreFocus: true }); return; }
      if (constantsOpen.value) { constantsOpen.value = false; return; }
      if (currentBand.value === 'galaxy' && creationsStore.inspectorTarget) { creationsStore.inspectorTarget = null; return; }
      if (currentBand.value === 'galaxy' && creationsStore.igniteDraft?.open) { creationsStore.igniteDraft = { ...creationsStore.igniteDraft, open: false }; return; }
      if (bookCreateOpen.value) { bookCreateOpen.value = false; return; }
      if (eventSim.active?.observing) { onReturnFromEvent(); return; }
      if (drawerOpen.value && drawerRef.value?.isHistoryOpen?.()) { drawerRef.value.closeSessionSwitcher?.(); return; }
      if (drawerOpen.value && drawerRef.value?.isSearchOpen?.()) { drawerRef.value.closeSearch?.(); return; }
      if (store.workbenchExpanded && drawerOpen.value) { collapseOpenWorkbench(); return; }
      if (drawerOpen.value && drawerRef.value?.isSessionStatusOpen?.()) {
        drawerRef.value.closeSessionStatus?.({ restoreFocus: true });
        return;
      }
      if (drawerOpen.value) { closeDrawer(); return; }
      if (quickAgentId.value) { quickAgentId.value = null; return; }
      if (anim.planetFocus.planetId) { unfocusPlanet(); return; }
      if (currentBand.value !== 'solar') jumpToScale(13.0);
    }

    function onDocClick(e) {
      if (emptyPlanetMenu.value && !e.target.closest('.cosmos-context-menu')) emptyPlanetMenu.value = null;
      if (constantsOpen.value && !e.target.closest('.cosmos-constants-popover, .cosmos-corner-actions')) constantsOpen.value = false;
      if (signalPopoverOpen.value && !e.target.closest('.cosmos-signal-popover, .cosmos-corner-actions')) signalPopoverOpen.value = false;
    }

    function planetTagClass(id) {
      const ag = agentsByPlanet.value[id];
      if (!ag) return {};
      if (constants.activeFlash && ag.liveSessions.length > 0) {
        return { 'is-flashing-waiting': ag.status === 'waiting', 'is-flashing-running': ag.status !== 'waiting' };
      }
      if (ag.hasUnread) return { 'is-has-unread': true };
      return {};
    }
    function planetPipClass(ag) {
      return [
        ag.status,
        constants.activeFlash && ag.status === 'running' ? 'is-flashing' : '',
        ag.status === 'idle' && ag.hasUnread ? 'is-unread' : '',
      ];
    }

    let softTimer = 0;
    let unmounted = false;
    let consecutiveSlowFrames = 0;
    let autoDowngraded = false;
    let lastFrameCostMs = 0;

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
      cancelAnimationFrame(mountRafId);
      mountRafId = 0;
      cancelAnimationFrame(rafId);
      clearTimeout(softTimer);
      engine?.destroy?.();
      engine = createCosmosEngine(glCanvasRef.value, hudCanvasRef.value, {
        renderQuality: resolveInitialQuality(quality),
        onFatalError: () => {
          if (!unmounted && engine?.isWebGL) {
            autoDowngraded = true;
            rebuildCosmosEngine('lite');
          }
        },
      });
      rendererMode.value = engine?.mode || '2d';
      consecutiveSlowFrames = 0;
      if (engine) {
        anim.lastTs = performance.now();
        rafId = requestAnimationFrame(loop);
      }
    }

    function rebuildCosmosEngine(quality) {
      cancelAnimationFrame(mountRafId);
      mountRafId = 0;
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
      else if (engine.isSoftware) delayMs = Math.max(46, Math.min(180, Math.round(lastFrameCostMs * 1.1)));
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
          engine, anim, eventSim, pools, getWebGraph, gpuParticles, eventGpuParticles, constants, domRefs,
          getAgentsByPlanet: () => agentsByPlanet.value,
          getGalaxyBooks: () => activeGalaxyStars.value,
          getUiState: () => ({
            currentBand: currentBand.value,
            viewMode: creationsStore.viewMode,
            interiorOpen: Boolean(creationsStore.activeCreation),
            drawerOpen: drawerOpen.value,
            drawerWidth: effectiveDrawerWidth.value,
            quickOpen: Boolean(quickAgentId.value),
            workbenchWidened: workbenchWidened.value || workbenchMaximized.value,
            focusedPlanetId: focusedPlanetId.value,
            dragActive: dragActive.value,
            dragOverPlanetId: dragOverPlanetId.value,
            hoverPlanetId: hoverPlanetId.value,
          }),
          onBandChange: (band) => { currentBand.value = band; },
          onSyncEvents: syncEventRefs,
          onUpdateHoverPos: updateHoverCardPosition,
          formatEventLabel: (ev) => {
            const name = $t(`cosmos.events.${ev.id}.name`);
            const dist = formatEventPhysicalDistance(ev.def, ev.ambientDist || ev.effDist, getLocale() === 'en');
            return $t('cosmos.events.hoverObserve', { name, dist });
          },
        });

        lastFrameCostMs = performance.now() - t0;

        if (!engine || unmounted) return;
        if (engine.isWebGL && engine.isFailed?.()) {
          autoDowngraded = true;
          rebuildCosmosEngine('lite');
          return;
        }

        // Adaptive guard for masked software renderers: if WebGL stays severely stalled
        // (>115ms per frame for 20 consecutive frames) in 'auto' mode, smoothly switch to 2D.
        if (engine.isWebGL && constants.renderQuality === 'auto' && !autoDowngraded) {
          if (lastFrameCostMs > 115) {
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

    function onWindowResize() {
      viewportWidth.value = window.innerWidth || 1280;
    }

    Vue.watch(
      isDrawerConversationCovered,
      (covered) => {
        store.yeaftConversationCovered = covered;
      },
      { immediate: true, flush: 'sync' },
    );

    Vue.watch(activeDrawerSessionKey, (key) => {
      if (!key) return;
      const sepIdx = key.indexOf('\u001f');
      if (sepIdx <= 0) return;
      const aid = key.slice(0, sepIdx);
      const sid = key.slice(sepIdx + 1);
      if (aid && sid) store.acknowledgeYeaftSessionSignals?.(sid, aid, { sessionRead: true });
    });

    Vue.watch([drawerOpen, isCompactViewport], () => {
      signalPopoverOpen.value = false;
    });

    Vue.onMounted(() => {
      unmounted = false;
      viewportWidth.value = window.innerWidth || 1280;
      // Yield 1 animation frame so the shell UI paints and WebSocket handshake begins
      // immediately before initializing WebGL shaders and context buffers.
      mountRafId = requestAnimationFrame(() => {
        mountRafId = 0;
        if (!unmounted) mountEngine();
      });
      window.addEventListener('resize', onWindowResize);
      window.addEventListener('blur', onWindowBlur);
      window.addEventListener('pointermove', onGlobalPointerMove);
      window.addEventListener('pointerup', onGlobalPointerUp);
      window.addEventListener('pointercancel', onGlobalPointerCancel);
      window.addEventListener('keydown', onKeyDown);
      document.addEventListener('click', onDocClick);
      nowInterval = setInterval(() => { nowTick.value = Date.now(); }, 15000);
      syncEventRefs();
      // The deep-space surface owns the browser / installed-app title bar color.
      const pageEl = glCanvasRef.value?.closest?.('.cosmos-page');
      if (pageEl && typeof window.getComputedStyle === 'function') setThemeColorSurface(window.getComputedStyle(pageEl).getPropertyValue('--c-bg'));
    });

    Vue.onBeforeUnmount(() => {
      unmounted = true;
      activeTouchPointers.clear();
      cancelAnimationFrame(mountRafId);
      mountRafId = 0;
      cancelAnimationFrame(rafId);
      clearTimeout(softTimer);
      clearTimeout(toastTimer);
      clearTimeout(hoverHideTimer);
      if (waitJumpTimer) {
        clearTimeout(waitJumpTimer);
        waitJumpTimer = null;
      }
      clearInterval(nowInterval);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('pointermove', onGlobalPointerMove);
      window.removeEventListener('pointerup', onGlobalPointerUp);
      window.removeEventListener('pointercancel', onGlobalPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', onDocClick);
      store.yeaftConversationCovered = false;
      setThemeColorSurface(null);
      engine?.destroy?.();
      engine = null;
    });

    return {
      glCanvasRef, hudCanvasRef, hoverCardRef, drawerRef, galaxyOverlayRef, signalTriggerRef, domRefs, setMapRef, canvasEpoch, rendererMode,
      creationsStore, activeGalaxyStars,
      planets: PLANETS, bookDomains: BOOK_DOMAINS,
      portals: [
        { id: 'to-galaxy', labelKey: 'cosmos.scale.galaxy', scale: '10²¹', target: 21.0, ring: 64 },
        { id: 'to-web', labelKey: 'cosmos.scale.web', scale: '10²⁴', target: 24.0, ring: 58 },
      ],
      scaleTicks: [
        { band: 'web', exp: '10²⁴', labelKey: 'cosmos.scale.web', target: 24.0 },
        { band: 'galaxy', exp: '10²¹', labelKey: 'cosmos.scale.galaxy', target: 21.0 },
        { band: 'solar', exp: '10¹³', labelKey: 'cosmos.scale.solar', target: 13.0 },
        { band: 'horizon', exp: '10⁷', labelKey: 'cosmos.scale.horizon', target: 7.0 },
      ],
      constants, constantsOpen, signalPopoverOpen, signalStreamHidden, galaxyBooks,
      quickAgentId, quickAgent, drawerOpen, drawerAgent, workbenchWidened, workbenchMaximized,
      viewportWidth, isCompactViewport, drawerResizing, drawerMinWidth, drawerMaxWidth, effectiveDrawerWidth, cosmosPageStyle,
      hoverPlanetId, hoverCardAgent, hoverPreviewSessions, hoverCardStyle, emptyPlanetMenu,
      camOrbiting, currentBand, projectedAgentList, assignments, agentsByPlanet, focusedPlanetId, waitingAgent,
      signalStream, signalTriggerLabel, signalTriggerExpanded,
      dragActive, dragFromPlanetId, dragOverPlanetId, dragX, dragY, dragIsSwap, dragGhostText,
      bookCreateOpen, bookDraftTitle, bookDraftDomain, toast,
      settingsModal, agentSettingsModal, sessionSettingsModal,
      eventActiveSnapshot, eventActiveList, eventNextIndex, eventCountdownSec, isObservingEvent,
      focusedCameraPlanetId, planetFocusZoom, planetFocusRotated,
      focusPlanet, unfocusPlanet, setPlanetZoom, resetPlanetInspect,
      planetTagClass, planetPipClass,
      onCanvasPointerDown, onCanvasDblClick, resetCamera, onPlanetPointerDown, onPlanetEnter, onPlanetLeave,
      onClickGalaxyStar, onDblClickGalaxyStar, openGalaxyCreation,
      onHoverCardEnter, onHoverCardLeave, onStageWheel, jumpToScale,
      openSessionInDrawer, openAgentConversationFromQuick, openCosmosSessionSearch, onDrawerSelectSession, toggleWorkbenchWiden, closeDrawer,
      onToggleConstants, onToggleSignalTrigger, closeSignalPopover, onOpenSignal, onDismissSignal, onMarkAllSignalsRead,
      openQuickComposerFromDrawer, onDrawerResizeStart, onDrawerResize, onDrawerResizeEnd, onDrawerResizeReset,
      emitTelemetryBeam, onAutoRouted, jumpToWaitingAgent, assignFromMenu,
      onObserveEvent, onFocusDistantEvent, onReturnFromEvent, onStopEvent, onToggleAutoEvents, onToggleAutoZoom, onTogglePauseEvent, onReplayEvent, onNextRandomEvent, onSetEventZoom, onResetEventView, onScrubEvent,
      onUpdateConstant, onAssignPlanet, openYeaftSettings, openYeaftAgentSettings, openAgentLlmConfig, openSessionSettings, closeSessionSettings, openVpLibraryFromSessionSettings,
      abandonCosmos, submitNewBook, showToast, runToastAction,
    };
  },
};
