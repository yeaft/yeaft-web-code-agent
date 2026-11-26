/**
 * Yeaft Cosmos — Random Distant Cosmic Event Countdown Pill, Almanac,
 * Auto-Zoom Toggle & Deep-Sky Telescope Observation Dock
 */
import {
  COSMIC_EVENTS,
  formatEventCountdown,
  formatEventPhysicalDistance,
} from '../../cosmos/events-controller.js';
import { getLocale } from '../../utils/i18n.js';

export default {
  name: 'CosmosEventsOverlay',
  props: {
    visible: { type: Boolean, default: true },
    autoEnabled: { type: Boolean, default: true },
    autoZoom: { type: Boolean, default: false },
    activeEvent: { type: Object, default: null },
    nextEventIndex: { type: Number, default: 0 },
    countdownSec: { type: Number, default: 60 },
  },
  emits: [
    'observe',
    'return-solar',
    'stop-event',
    'toggle-auto',
    'toggle-auto-zoom',
    'toggle-pause',
    'replay',
    'next-random',
    'set-zoom',
    'scrub',
  ],
  template: `
    <div v-if="visible" class="cosmos-event-wrap" @pointerdown.stop @wheel.stop>
      <div
        class="cosmos-event-pill"
        :class="{ 'is-live': Boolean(activeEvent), 'is-auto-off': !activeEvent && !autoEnabled }"
        :style="activeAccentStyle"
      >
        <span class="cosmos-event-dot" aria-hidden="true"></span>

        <button
          type="button"
          class="cosmos-event-main"
          :aria-expanded="almanacOpen ? 'true' : 'false'"
          @click.stop="almanacOpen = !almanacOpen"
        >
          <span class="cosmos-event-name">{{ pillTitle }}</span>
          <span v-if="activeEvent && pillDistance" class="cosmos-event-dist">{{ pillDistance }}</span>
          <span class="cosmos-event-timer">{{ pillTimer }}</span>
          <svg class="cosmos-event-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>

        <button
          type="button"
          class="cosmos-event-watch-btn"
          @click.stop="onWatchClick"
        >
          <span>{{ activeEvent?.observing ? $t('cosmos.events.returnSolar') : $t('cosmos.events.watch') }}</span>
        </button>

        <!-- Explicit Stop / Silence Auto-Events Button -->
        <button
          v-if="activeEvent"
          type="button"
          class="cosmos-event-stop-btn is-live-stop"
          :title="$t('cosmos.events.stopEvent')"
          :aria-label="$t('cosmos.events.stopEvent')"
          @click.stop="$emit('stop-event')"
        >
          <span>■ {{ $t('cosmos.events.stop') }}</span>
        </button>
        <button
          v-else
          type="button"
          class="cosmos-event-stop-btn"
          :class="{ 'is-resume': !autoEnabled }"
          :title="autoEnabled ? $t('cosmos.events.pauseAuto') : $t('cosmos.events.resumeAuto')"
          :aria-label="autoEnabled ? $t('cosmos.events.pauseAuto') : $t('cosmos.events.resumeAuto')"
          @click.stop="$emit('toggle-auto')"
        >
          <span>{{ autoEnabled ? '■ ' + $t('cosmos.events.stop') : '▶' }}</span>
        </button>

        <span
          v-if="activeEvent"
          class="cosmos-event-progress"
          aria-hidden="true"
          :style="{ transform: 'scaleX(' + activeProgress.toFixed(4) + ')' }"
        ></span>
      </div>

      <!-- 8-Event Cosmic Almanac -->
      <div v-if="almanacOpen" class="cosmos-event-almanac" role="dialog" :aria-label="$t('cosmos.events.almanacTitle')">
        <div class="cosmos-almanac-head">
          <span class="cosmos-almanac-title">{{ $t('cosmos.events.almanacTitle') }}</span>
          <span class="cosmos-almanac-sub">{{ $t('cosmos.events.almanacSub') }}</span>
        </div>

        <div class="cosmos-almanac-pref">
          <div class="cosmos-almanac-pref-copy">
            <span class="cosmos-almanac-pref-label">{{ $t('cosmos.constants.eventsAutoZoom') }}</span>
            <span class="cosmos-almanac-pref-meta">{{ autoZoom ? $t('cosmos.events.autoZoomOn') : $t('cosmos.events.autoZoomOff') }}</span>
          </div>
          <button
            type="button"
            class="cosmos-switch"
            :class="{ 'is-on': autoZoom }"
            role="switch"
            :aria-checked="autoZoom ? 'true' : 'false'"
            :aria-label="$t('cosmos.constants.eventsAutoZoom')"
            @click.stop="$emit('toggle-auto-zoom')"
          ></button>
        </div>

        <div class="cosmos-almanac-list">
          <button
            v-for="(ev, idx) in events"
            :key="ev.id"
            type="button"
            class="cosmos-almanac-row"
            :class="{ 'is-active': activeEvent && activeEvent.def.id === ev.id }"
            @click.stop="pickEvent(ev.id)"
          >
            <div class="cosmos-almanac-left">
              <span class="cosmos-almanac-swatch" :style="{ background: ev.swatch, boxShadow: '0 0 10px ' + ev.swatch }"></span>
              <div class="cosmos-almanac-copy">
                <div class="cosmos-almanac-title-line">
                  <span class="cosmos-almanac-name">{{ $t('cosmos.events.' + ev.id + '.name') }}</span>
                  <span class="cosmos-almanac-dist">{{ rowDistanceBadge(ev) }}</span>
                </div>
                <div class="cosmos-almanac-desc">{{ $t('cosmos.events.' + ev.id + '.desc') }}</div>
              </div>
            </div>
            <span class="cosmos-almanac-cta">{{ rowCta(ev, idx) }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Telescope Observation Dock (only visible while zoomed into a distant event) -->
    <div
      v-if="activeEvent && activeEvent.observing"
      class="cosmos-watch-dock"
      :style="activeAccentStyle"
      @pointerdown.stop
      @wheel.stop
    >
      <div class="cosmos-ewd-top">
        <div class="cosmos-ewd-meta">
          <span class="cosmos-ewd-dot" aria-hidden="true"></span>
          <span class="cosmos-ewd-badge">{{ $t('cosmos.events.' + activeEvent.def.id + '.name') }}</span>
          <span v-if="activePhaseLabel" class="cosmos-ewd-phase">{{ activePhaseLabel }}</span>
          <span v-if="activeBearingLabel" class="cosmos-ewd-bearing">{{ activeBearingLabel }}</span>
        </div>

        <div class="cosmos-ewd-zoom">
          <button type="button" class="cosmos-ewd-mini" :title="$t('cosmos.events.zoomOut')" :aria-label="$t('cosmos.events.zoomOut')" @click="$emit('set-zoom', activeEvent.targetZoom - 0.25)">−</button>
          <input
            type="range"
            class="cosmos-ewd-range"
            min="0.75"
            max="3.4"
            step="0.05"
            :aria-label="$t('cosmos.events.zoomRange')"
            :value="activeEvent.targetZoom"
            @input="$emit('set-zoom', Number($event.target.value))"
          />
          <button type="button" class="cosmos-ewd-mini" :title="$t('cosmos.events.zoomIn')" :aria-label="$t('cosmos.events.zoomIn')" @click="$emit('set-zoom', activeEvent.targetZoom + 0.25)">+</button>
          <span class="cosmos-ewd-val">{{ activeEvent.targetZoom.toFixed(1) }}×</span>
        </div>

        <div class="cosmos-ewd-actions">
          <button type="button" class="cosmos-ewd-btn" @click="$emit('toggle-pause')">
            {{ activeEvent.paused ? $t('cosmos.events.resume') : $t('cosmos.events.pause') }}
          </button>
          <button type="button" class="cosmos-ewd-btn" @click="$emit('replay')">{{ $t('cosmos.events.replay') }}</button>
          <button type="button" class="cosmos-ewd-btn" @click="$emit('next-random')">{{ $t('cosmos.events.nextRandom') }}</button>
          <button type="button" class="cosmos-ewd-btn" @click="$emit('return-solar')">{{ $t('cosmos.events.returnSolar') }}</button>
          <button type="button" class="cosmos-ewd-btn is-stop" @click="$emit('stop-event')">■ {{ $t('cosmos.events.stop') }}</button>
        </div>
      </div>

      <div
        ref="timelineRef"
        class="cosmos-ewd-timeline"
        role="slider"
        tabindex="0"
        :aria-label="$t('cosmos.events.timelineLabel')"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="Math.round(activeProgress * 100)"
        :aria-valuetext="timelineValueText"
        @pointerdown.stop="onTimelinePointerDown"
        @keydown="onTimelineKeyDown"
      >
        <div class="cosmos-ewd-timeline-track">
          <div class="cosmos-ewd-timeline-fill" :style="{ transform: 'scaleX(' + activeProgress.toFixed(4) + ')' }"></div>
        </div>
      </div>
    </div>
  `,
  setup(props, { emit }) {
    const { proxy } = Vue.getCurrentInstance();
    const $t = (k, p) => (proxy?.$t ? proxy.$t(k, p) : k);
    const almanacOpen = Vue.ref(false);
    const timelineRef = Vue.ref(null);
    let stopScrubListeners = null;

    const nextEventDef = Vue.computed(() => (
      COSMIC_EVENTS[props.nextEventIndex % COSMIC_EVENTS.length] || COSMIC_EVENTS[0]
    ));

    const activeAccentStyle = Vue.computed(() => (
      props.activeEvent?.def?.swatch
        ? { '--ev-accent': props.activeEvent.def.swatch }
        : {}
    ));

    const activeProgress = Vue.computed(() => {
      const act = props.activeEvent;
      if (!act || !act.duration) return 0;
      return Math.max(0, Math.min(1, act.elapsed / act.duration));
    });

    const activePhaseLabel = Vue.computed(() => {
      const act = props.activeEvent;
      if (!act) return '';
      const phaseIdx = Math.min(3, Math.floor(activeProgress.value * 4));
      return $t(`cosmos.events.${act.def.id}.phase${phaseIdx}`);
    });

    const timelineValueText = Vue.computed(() => {
      const pct = Math.round(activeProgress.value * 100);
      return activePhaseLabel.value ? `${pct}% · ${activePhaseLabel.value}` : `${pct}%`;
    });

    const pillDistance = Vue.computed(() => {
      const act = props.activeEvent;
      if (!act) return '';
      const d = act.observing ? (act.effDist || act.def.obsDist) : (act.ambientDist || act.effDist);
      return formatEventPhysicalDistance(act.def, d, getLocale() === 'en');
    });

    const activeBearingLabel = Vue.computed(() => {
      const act = props.activeEvent;
      const loc = act?.location;
      if (!act || !loc) return '';
      const dir = $t(`cosmos.events.dir.${loc.sector}`);
      const dist = formatEventPhysicalDistance(act.def, act.effDist || act.ambientDist, getLocale() === 'en');
      return `${dir} · ${dist}`;
    });

    const pillTitle = Vue.computed(() => {
      if (props.activeEvent) return $t(`cosmos.events.${props.activeEvent.def.id}.name`);
      if (!props.autoEnabled) return $t('cosmos.events.autoPaused');
      return $t(`cosmos.events.${nextEventDef.value.id}.name`);
    });

    const pillTimer = Vue.computed(() => {
      if (props.activeEvent) {
        if (props.activeEvent.paused) return $t('cosmos.events.paused');
        const rem = Math.max(0, Math.ceil(props.activeEvent.duration - props.activeEvent.elapsed));
        return `${$t('cosmos.events.live')} · ${rem}s`;
      }
      if (!props.autoEnabled) return '—';
      return formatEventCountdown(props.countdownSec);
    });

    function rowDistanceBadge(ev) {
      const isEn = getLocale() === 'en';
      const band = $t(`cosmos.events.${ev.id}.band`);
      const sampleDist = (props.activeEvent && props.activeEvent.def.id === ev.id)
        ? (props.activeEvent.ambientDist || ev.obsDist * 3.2)
        : ev.obsDist * 3.4;
      return `${band} · ${formatEventPhysicalDistance(ev, sampleDist, isEn)}`;
    }

    function rowCta(ev, idx) {
      if (props.activeEvent && props.activeEvent.def.id === ev.id) {
        return props.activeEvent.observing ? $t('cosmos.events.focusing') : $t('cosmos.events.watch');
      }
      if (!props.activeEvent && props.autoEnabled && props.nextEventIndex === idx) {
        return formatEventCountdown(props.countdownSec);
      }
      return props.autoZoom ? $t('cosmos.events.playNow') : $t('cosmos.events.playDistant');
    }

    function pickEvent(evId) {
      almanacOpen.value = false;
      emit('observe', evId);
    }

    function onWatchClick() {
      almanacOpen.value = false;
      if (props.activeEvent?.observing) {
        emit('return-solar');
      } else {
        const targetId = props.activeEvent ? props.activeEvent.def.id : nextEventDef.value.id;
        emit('observe', { eventId: targetId, forceObserve: true });
      }
    }

    function applyScrubFromEvent(ev) {
      const el = timelineRef.value;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const frac = Math.max(0.005, Math.min(0.99, (ev.clientX - rect.left) / rect.width));
      emit('scrub', frac);
    }

    function clearScrubListeners() {
      if (stopScrubListeners) {
        stopScrubListeners();
        stopScrubListeners = null;
      }
    }

    function onTimelinePointerDown(e) {
      if (e.pointerType !== 'touch' && e.button !== 0) return;
      clearScrubListeners();
      const activePointerId = e.pointerId ?? null;
      applyScrubFromEvent(e);
      const matchesPointer = (ev) => (activePointerId == null || ev?.pointerId == null || ev.pointerId === activePointerId);
      const onMove = (me) => {
        if (matchesPointer(me)) applyScrubFromEvent(me);
      };
      const onUp = (ue) => {
        if (matchesPointer(ue)) clearScrubListeners();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      stopScrubListeners = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
    }

    function onTimelineKeyDown(e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        emit('scrub', Math.max(0.005, activeProgress.value - 0.05));
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        emit('scrub', Math.min(0.99, activeProgress.value + 0.05));
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        emit('scrub', Math.max(0.005, activeProgress.value - 0.15));
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        emit('scrub', Math.min(0.99, activeProgress.value + 0.15));
      } else if (e.key === 'Home') {
        e.preventDefault();
        emit('scrub', 0.005);
      } else if (e.key === 'End') {
        e.preventDefault();
        emit('scrub', 0.99);
      }
    }

    const onOutside = (e) => {
      if (almanacOpen.value && !e.target.closest('.cosmos-event-wrap')) {
        almanacOpen.value = false;
      }
    };

    Vue.onMounted(() => document.addEventListener('click', onOutside));
    Vue.onBeforeUnmount(() => {
      clearScrubListeners();
      document.removeEventListener('click', onOutside);
    });

    return {
      events: COSMIC_EVENTS,
      almanacOpen,
      timelineRef,
      activeAccentStyle,
      activeProgress,
      activePhaseLabel,
      timelineValueText,
      pillDistance,
      activeBearingLabel,
      pillTitle,
      pillTimer,
      rowDistanceBadge,
      rowCta,
      pickEvent,
      onWatchClick,
      onTimelinePointerDown,
      onTimelineKeyDown,
    };
  },
};
