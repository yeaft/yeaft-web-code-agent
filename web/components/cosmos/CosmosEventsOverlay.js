/**
 * Yeaft Cosmos — Random Cosmic Event Countdown Pill, Stop Button, Almanac & Telescope Dock
 */
import { COSMIC_EVENTS, formatEventCountdown } from '../../cosmos/events-controller.js';

export default {
  name: 'CosmosEventsOverlay',
  props: {
    visible: { type: Boolean, default: true },
    autoEnabled: { type: Boolean, default: true },
    activeEvent: { type: Object, default: null },
    nextEventIndex: { type: Number, default: 0 },
    countdownSec: { type: Number, default: 60 },
  },
  emits: [
    'observe',
    'stop-event',
    'toggle-auto',
    'toggle-pause',
    'replay',
    'next-random',
    'set-zoom',
  ],
  template: `
    <div v-if="visible" class="cosmos-event-wrap" @pointerdown.stop @wheel.stop>
      <div
        class="cosmos-event-pill"
        :class="{ 'is-live': Boolean(activeEvent), 'is-auto-off': !activeEvent && !autoEnabled }"
      >
        <span class="cosmos-event-dot" aria-hidden="true"></span>

        <button
          type="button"
          class="cosmos-event-main"
          :aria-expanded="almanacOpen ? 'true' : 'false'"
          @click.stop="almanacOpen = !almanacOpen"
        >
          <span class="cosmos-event-name">{{ pillTitle }}</span>
          <span class="cosmos-event-timer">{{ pillTimer }}</span>
          <svg class="cosmos-event-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>

        <button
          type="button"
          class="cosmos-event-watch-btn"
          @click.stop="onWatchClick"
        >
          <span>{{ activeEvent?.observing ? $t('cosmos.events.focusing') : $t('cosmos.events.watch') }}</span>
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
      </div>

      <!-- 8-Event Cosmic Almanac -->
      <div v-if="almanacOpen" class="cosmos-event-almanac" role="dialog" :aria-label="$t('cosmos.events.almanacTitle')">
        <div class="cosmos-almanac-head">
          <span class="cosmos-almanac-title">{{ $t('cosmos.events.almanacTitle') }}</span>
          <span class="cosmos-almanac-sub">{{ $t('cosmos.events.almanacSub') }}</span>
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
              <span class="cosmos-almanac-swatch" :style="{ background: ev.swatch, boxShadow: '0 0 8px ' + ev.swatch }"></span>
              <div class="cosmos-almanac-copy">
                <div class="cosmos-almanac-name">{{ $t('cosmos.events.' + ev.id + '.name') }}</div>
                <div class="cosmos-almanac-desc">{{ $t('cosmos.events.' + ev.id + '.desc') }}</div>
              </div>
            </div>
            <span class="cosmos-almanac-cta">{{ rowCta(ev, idx) }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Telescope Observation Dock (only visible while focusing an event) -->
    <div v-if="activeEvent && activeEvent.observing" class="cosmos-watch-dock" @pointerdown.stop @wheel.stop>
      <span class="cosmos-ewd-badge">{{ $t('cosmos.events.' + activeEvent.def.id + '.name') }}</span>

      <div class="cosmos-ewd-zoom">
        <button type="button" class="cosmos-ewd-mini" :title="$t('cosmos.events.zoomOut')" @click="$emit('set-zoom', activeEvent.targetZoom - 0.25)">−</button>
        <input
          type="range"
          class="cosmos-ewd-range"
          min="0.65"
          max="3.4"
          step="0.05"
          :value="activeEvent.targetZoom"
          @input="$emit('set-zoom', Number($event.target.value))"
        />
        <button type="button" class="cosmos-ewd-mini" :title="$t('cosmos.events.zoomIn')" @click="$emit('set-zoom', activeEvent.targetZoom + 0.25)">+</button>
        <span class="cosmos-ewd-val">{{ activeEvent.targetZoom.toFixed(1) }}×</span>
      </div>

      <div class="cosmos-ewd-actions">
        <button type="button" class="cosmos-ewd-btn" @click="$emit('toggle-pause')">
          {{ activeEvent.paused ? $t('cosmos.events.resume') : $t('cosmos.events.pause') }}
        </button>
        <button type="button" class="cosmos-ewd-btn" @click="$emit('replay')">{{ $t('cosmos.events.replay') }}</button>
        <button type="button" class="cosmos-ewd-btn" @click="$emit('next-random')">{{ $t('cosmos.events.nextRandom') }}</button>
        <button type="button" class="cosmos-ewd-btn is-stop" @click="$emit('stop-event')">■ {{ $t('cosmos.events.stop') }}</button>
      </div>
    </div>
  `,
  setup(props, { emit }) {
    const { proxy } = Vue.getCurrentInstance();
    const $t = (k, p) => (proxy?.$t ? proxy.$t(k, p) : k);
    const almanacOpen = Vue.ref(false);

    const nextEventDef = Vue.computed(() => (
      COSMIC_EVENTS[props.nextEventIndex % COSMIC_EVENTS.length] || COSMIC_EVENTS[0]
    ));

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

    function rowCta(ev, idx) {
      if (props.activeEvent && props.activeEvent.def.id === ev.id) {
        return props.activeEvent.observing ? $t('cosmos.events.focusing') : $t('cosmos.events.watch');
      }
      if (!props.activeEvent && props.autoEnabled && props.nextEventIndex === idx) {
        return formatEventCountdown(props.countdownSec);
      }
      return $t('cosmos.events.playNow');
    }

    function pickEvent(evId) {
      almanacOpen.value = false;
      emit('observe', evId);
    }

    function onWatchClick() {
      almanacOpen.value = false;
      if (props.activeEvent?.observing) {
        emit('stop-event');
      } else {
        emit('observe', props.activeEvent ? props.activeEvent.def.id : nextEventDef.value.id);
      }
    }

    const onOutside = (e) => {
      if (almanacOpen.value && !e.target.closest('.cosmos-event-wrap')) {
        almanacOpen.value = false;
      }
    };

    Vue.onMounted(() => document.addEventListener('click', onOutside));
    Vue.onBeforeUnmount(() => document.removeEventListener('click', onOutside));

    return {
      events: COSMIC_EVENTS,
      almanacOpen,
      pillTitle,
      pillTimer,
      rowCta,
      pickEvent,
      onWatchClick,
    };
  },
};
