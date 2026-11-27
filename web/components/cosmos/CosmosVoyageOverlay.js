/**
 * Yeaft Cosmos — Interstellar Soaring & Multi-System Sightseeing Overlay
 *
 * Provides:
 * - Top-left compact Star System selector pill + "Soar" free-flight toggle
 * - Glass Star Atlas dropdown listing all 5 curated sightseeing destinations
 * - Bottom-center Flight / Sightseeing control dock (cruise speed, autopilot, next destination, return home)
 */
import { STAR_SYSTEMS, formatSystemDistance } from '../../cosmos/star-systems.js';
import { getLocale } from '../../utils/i18n.js';

export default {
  name: 'CosmosVoyageOverlay',
  props: {
    visible: { type: Boolean, default: true },
    systemId: { type: String, default: 'sol' },
    soaring: { type: Boolean, default: false },
    soarSpeed: { type: Number, default: 1.25 },
    autoPilot: { type: Boolean, default: true },
    warpingToId: { type: String, default: '' },
    planetFocused: { type: Boolean, default: false },
    drawerOpen: { type: Boolean, default: false },
  },
  emits: [
    'toggle-soar',
    'select-system',
    'next-system',
    'return-sol',
    'set-speed',
    'toggle-autopilot',
  ],
  template: `
    <div v-if="visible" class="cosmos-voyage-layer" @pointerdown.stop>
      <!-- Top-Left Voyage Pill & Star Atlas Dropdown -->
      <div class="cosmos-voyage-anchor">
        <div class="cosmos-voyage-bar" :class="{ 'is-soaring': soaring, 'is-warping': Boolean(warpingToId) }">
          <button
            type="button"
            class="cosmos-voyage-sys-btn"
            :aria-expanded="atlasOpen ? 'true' : 'false'"
            :aria-label="$t('cosmos.voyage.atlasTitle')"
            @click="atlasOpen = !atlasOpen"
          >
            <span class="cosmos-voyage-dot" :style="{ background: activeSystem.accent, boxShadow: '0 0 8px ' + activeSystem.accent }" aria-hidden="true"></span>
            <span class="cosmos-voyage-sys-name">{{ $t('cosmos.voyage.systems.' + activeSystem.id + '.name') }}</span>
            <span v-if="!activeSystem.isHome" class="cosmos-voyage-sys-dist">{{ formatDist(activeSystem.distanceLy) }}</span>
            <svg class="cosmos-voyage-caret" :class="{ 'is-open': atlasOpen }" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.5 6.5 8 10l3.5-3.5" />
            </svg>
          </button>

          <span class="cosmos-voyage-sep" aria-hidden="true"></span>

          <button
            type="button"
            class="cosmos-voyage-soar-btn"
            :class="{ 'is-active': soaring }"
            :aria-pressed="soaring ? 'true' : 'false'"
            :title="$t('cosmos.voyage.soarHint')"
            @click="onToggleSoar"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M17.2 2.8 9.4 10.6M17.2 2.8l-5 14.4-2.8-6.6-6.6-2.8 14.4-5Z" />
            </svg>
            <span>{{ soaring ? $t('cosmos.voyage.soaring') : $t('cosmos.voyage.soar') }}</span>
          </button>
        </div>

        <!-- Star Atlas Dropdown -->
        <div
          v-if="atlasOpen"
          class="cosmos-voyage-atlas"
          role="menu"
          :aria-label="$t('cosmos.voyage.atlasTitle')"
          @wheel.stop
        >
          <div class="cosmos-voyage-atlas-head">
            <span>{{ $t('cosmos.voyage.atlasTitle') }}</span>
            <span class="cosmos-voyage-atlas-sub">{{ $t('cosmos.voyage.atlasHint') }}</span>
          </div>
          <div class="cosmos-voyage-atlas-list">
            <button
              v-for="sys in systems"
              :key="sys.id"
              type="button"
              role="menuitem"
              class="cosmos-voyage-atlas-item"
              :class="{
                'is-current': sys.id === systemId && !warpingToId,
                'is-target': sys.id === warpingToId,
              }"
              @click="onPickSystem(sys.id)"
            >
              <span class="cosmos-voyage-dot is-lg" :style="{ background: sys.accent, boxShadow: '0 0 9px ' + sys.accent }" aria-hidden="true"></span>
              <span class="cosmos-voyage-item-main">
                <span class="cosmos-voyage-item-top">
                  <span class="cosmos-voyage-item-name">{{ $t('cosmos.voyage.systems.' + sys.id + '.name') }}</span>
                  <span class="cosmos-voyage-item-meta">{{ formatDist(sys.distanceLy) }}</span>
                </span>
                <span class="cosmos-voyage-item-desc">{{ $t('cosmos.voyage.systems.' + sys.id + '.desc') }}</span>
              </span>
            </button>
          </div>
        </div>
      </div>

      <!-- Bottom-Center Sightseeing / Free-Flight Soar Dock -->
      <div
        v-if="showFlightDock"
        class="cosmos-voyage-dock"
        @wheel.stop
      >
        <template v-if="warpingToId">
          <span class="cosmos-voyage-dot is-pulse" :style="{ background: warpTargetSystem.accent }" aria-hidden="true"></span>
          <span class="cosmos-voyage-dock-title">
            {{ $t('cosmos.voyage.warpingTo', { name: $t('cosmos.voyage.systems.' + warpTargetSystem.id + '.name') }) }}
          </span>
          <span class="cosmos-voyage-dock-meta">{{ formatDist(warpTargetSystem.distanceLy) }}</span>
        </template>

        <template v-else-if="soaring">
          <span class="cosmos-voyage-dock-title">{{ $t('cosmos.voyage.soarModeTitle') }}</span>
          <div class="cosmos-voyage-speed">
            <button
              type="button"
              class="cosmos-ewd-mini"
              :aria-label="$t('cosmos.voyage.slower')"
              @click="$emit('set-speed', soarSpeed / 1.35)"
            >−</button>
            <span class="cosmos-voyage-speed-val">{{ soarSpeed.toFixed(1) }}×</span>
            <button
              type="button"
              class="cosmos-ewd-mini"
              :aria-label="$t('cosmos.voyage.faster')"
              @click="$emit('set-speed', soarSpeed * 1.35)"
            >+</button>
          </div>
          <button
            type="button"
            class="cosmos-ewd-btn"
            :class="{ 'is-active': autoPilot }"
            @click="$emit('toggle-autopilot')"
          >{{ $t('cosmos.voyage.autoPilot') }}</button>
          <button
            type="button"
            class="cosmos-ewd-btn"
            @click="$emit('next-system')"
          >{{ $t('cosmos.voyage.nextSystem') }}</button>
          <button
            type="button"
            class="cosmos-ewd-btn cosmos-voyage-home-btn"
            @click="$emit('toggle-soar', false)"
          >{{ $t('cosmos.voyage.exitSoar') }}</button>
        </template>

        <template v-else>
          <span class="cosmos-voyage-dot" :style="{ background: activeSystem.accent, boxShadow: '0 0 8px ' + activeSystem.accent }" aria-hidden="true"></span>
          <span class="cosmos-voyage-dock-title">{{ $t('cosmos.voyage.systems.' + activeSystem.id + '.name') }}</span>
          <span class="cosmos-voyage-dock-meta">{{ activeSystem.spectral }}</span>
          <button
            type="button"
            class="cosmos-ewd-btn"
            @click="$emit('next-system')"
          >{{ $t('cosmos.voyage.nextSystem') }}</button>
          <button
            type="button"
            class="cosmos-ewd-btn cosmos-voyage-home-btn"
            @click="$emit('return-sol')"
          >{{ $t('cosmos.voyage.returnSol') }}</button>
        </template>
      </div>
    </div>
  `,
  setup(props, { emit }) {
    const atlasOpen = Vue.ref(false);
    const systems = STAR_SYSTEMS;

    const activeSystem = Vue.computed(
      () => systems.find((s) => s.id === props.systemId) || systems[0],
    );
    const warpTargetSystem = Vue.computed(
      () => systems.find((s) => s.id === props.warpingToId) || activeSystem.value,
    );
    const showFlightDock = Vue.computed(() => {
      if (props.planetFocused || props.drawerOpen) return false;
      return Boolean(props.warpingToId || props.soaring || props.systemId !== 'sol');
    });

    function formatDist(ly) {
      return formatSystemDistance(ly, getLocale() === 'en');
    }

    function onPickSystem(id) {
      atlasOpen.value = false;
      emit('select-system', id);
    }

    function onToggleSoar() {
      atlasOpen.value = false;
      emit('toggle-soar');
    }

    function onGlobalPointerDown(e) {
      if (!atlasOpen.value) return;
      if (e.target && e.target.closest && e.target.closest('.cosmos-voyage-anchor')) return;
      atlasOpen.value = false;
    }

    Vue.onMounted(() => {
      window.addEventListener('pointerdown', onGlobalPointerDown);
    });
    Vue.onUnmounted(() => {
      window.removeEventListener('pointerdown', onGlobalPointerDown);
    });

    return {
      atlasOpen,
      systems,
      activeSystem,
      warpTargetSystem,
      showFlightDock,
      formatDist,
      onPickSystem,
      onToggleSoar,
    };
  },
};
