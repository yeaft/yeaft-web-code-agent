/**
 * Yeaft Cosmos — Cosmic Constants Popover, Planet Bindings & Authentic Yeaft Settings Launchers
 */
import { PLANETS } from '../../cosmos/constants.js';

export default {
  name: 'CosmosConstantsPopover',
  props: {
    constants: { type: Object, required: true },
    agents: { type: Array, default: () => [] },
    agentToPlanet: { type: Object, default: () => ({}) },
    rendererMode: { type: String, default: 'webgl2' },
  },
  emits: ['update-constant', 'assign-planet', 'open-settings', 'open-agent-settings'],
  template: `
    <section
      class="cosmos-constants-popover"
      role="dialog"
      :aria-label="$t('cosmos.constants.title')"
      @pointerdown.stop
      @wheel.stop
    >
      <div class="cosmos-const-head">
        <span class="cosmos-const-title">{{ $t('cosmos.constants.title') }}</span>
        <span class="cosmos-const-sym">
          <span class="cosmos-const-engine-badge">{{ rendererMode === '2d' ? $t('cosmos.constants.renderer2D') : $t('cosmos.constants.rendererWebGL') }}</span>
          <span>Λ · G · c</span>
        </span>
      </div>

      <div class="cosmos-const-slider">
        <div class="cosmos-const-slider-top">
          <span>{{ $t('cosmos.constants.orbitSpeed') }}</span>
          <span class="cosmos-const-val">{{ constants.orbitSpeed.toFixed(1) }}×</span>
        </div>
        <input
          type="range"
          class="cosmos-const-range"
          min="0"
          max="2.5"
          step="0.1"
          :value="constants.orbitSpeed"
          @input="$emit('update-constant', { key: 'orbitSpeed', value: Number($event.target.value) })"
        />
      </div>

      <div class="cosmos-const-slider">
        <div class="cosmos-const-slider-top">
          <span>{{ $t('cosmos.constants.starDensity') }}</span>
          <span class="cosmos-const-val">{{ constants.starDensity.toFixed(2) }}</span>
        </div>
        <input
          type="range"
          class="cosmos-const-range"
          min="0.4"
          max="2.0"
          step="0.05"
          :value="constants.starDensity"
          @input="$emit('update-constant', { key: 'starDensity', value: Number($event.target.value) })"
        />
      </div>

      <div class="cosmos-const-slider">
        <div class="cosmos-const-slider-top">
          <span>{{ $t('cosmos.constants.skyBright') }}</span>
          <span class="cosmos-const-val">{{ constants.skyBright.toFixed(2) }}</span>
        </div>
        <input
          type="range"
          class="cosmos-const-range"
          min="0.4"
          max="1.7"
          step="0.05"
          :value="constants.skyBright"
          @input="$emit('update-constant', { key: 'skyBright', value: Number($event.target.value) })"
        />
      </div>

      <div class="cosmos-const-slider">
        <div class="cosmos-const-slider-top">
          <span>{{ $t('cosmos.constants.orbitLines') }}</span>
          <span class="cosmos-const-val">{{ Math.round(constants.orbitLines * 100) }}%</span>
        </div>
        <input
          type="range"
          class="cosmos-const-range"
          min="0"
          max="1.2"
          step="0.05"
          :value="constants.orbitLines"
          @input="$emit('update-constant', { key: 'orbitLines', value: Number($event.target.value) })"
        />
      </div>

      <div class="cosmos-const-toggle-row">
        <span>{{ $t('cosmos.constants.activeFlash') }}</span>
        <button
          type="button"
          class="cosmos-switch"
          :class="{ 'is-on': constants.activeFlash }"
          role="switch"
          :aria-checked="constants.activeFlash ? 'true' : 'false'"
          @click="$emit('update-constant', { key: 'activeFlash', value: !constants.activeFlash })"
        ></button>
      </div>

      <div class="cosmos-const-toggle-row">
        <span>{{ $t('cosmos.constants.livePreview') }}</span>
        <select
          class="cosmos-const-select"
          :value="constants.livePreviewMode"
          @change="$emit('update-constant', { key: 'livePreviewMode', value: $event.target.value })"
        >
          <option value="2">{{ $t('cosmos.constants.livePreview2') }}</option>
          <option value="3">{{ $t('cosmos.constants.livePreview3') }}</option>
          <option value="hover">{{ $t('cosmos.constants.livePreviewHover') }}</option>
        </select>
      </div>

      <div class="cosmos-const-toggle-row">
        <span>{{ $t('cosmos.constants.eventsCountdown') }}</span>
        <button
          type="button"
          class="cosmos-switch"
          :class="{ 'is-on': constants.showEventsCountdown }"
          role="switch"
          :aria-checked="constants.showEventsCountdown ? 'true' : 'false'"
          @click="$emit('update-constant', { key: 'showEventsCountdown', value: !constants.showEventsCountdown })"
        ></button>
      </div>

      <div class="cosmos-const-toggle-row">
        <span>{{ $t('cosmos.constants.eventsAuto') }}</span>
        <button
          type="button"
          class="cosmos-switch"
          :class="{ 'is-on': constants.eventsAutoEnabled }"
          role="switch"
          :aria-checked="constants.eventsAutoEnabled ? 'true' : 'false'"
          @click="$emit('update-constant', { key: 'eventsAutoEnabled', value: !constants.eventsAutoEnabled })"
        ></button>
      </div>

      <div class="cosmos-const-toggle-row">
        <span>{{ $t('cosmos.constants.eventsAutoZoom') }}</span>
        <button
          type="button"
          class="cosmos-switch"
          :class="{ 'is-on': constants.eventsAutoZoom }"
          role="switch"
          :aria-checked="constants.eventsAutoZoom ? 'true' : 'false'"
          @click="$emit('update-constant', { key: 'eventsAutoZoom', value: !constants.eventsAutoZoom })"
        ></button>
      </div>

      <div class="cosmos-const-toggle-row">
        <span>{{ $t('cosmos.constants.renderQuality') }}</span>
        <select
          class="cosmos-const-select"
          :value="constants.renderQuality || 'auto'"
          @change="$emit('update-constant', { key: 'renderQuality', value: $event.target.value })"
        >
          <option value="auto">{{ $t('cosmos.constants.renderAuto') }}</option>
          <option value="high">{{ $t('cosmos.constants.renderHigh') }}</option>
          <option value="lite">{{ $t('cosmos.constants.renderLite') }}</option>
        </select>
      </div>

      <!-- Planetary Orbit Bindings -->
      <div v-if="agents.length > 0" class="cosmos-const-section">
        <div class="cosmos-const-section-title">{{ $t('cosmos.constants.planetBindings') }}</div>
        <div class="cosmos-binding-list">
          <div v-for="ag in agents" :key="ag.id" class="cosmos-binding-row">
            <span class="cosmos-binding-agent">
              <span class="cosmos-status-pip" :class="ag.status"></span>
              <span>{{ ag.name }}</span>
            </span>
            <select
              class="cosmos-const-select"
              :value="agentToPlanet[ag.id] || ''"
              @change="$emit('assign-planet', { agentId: ag.id, planetId: $event.target.value })"
            >
              <option v-for="p in planets" :key="p.id" :value="p.id">
                {{ $t('cosmos.planets.' + p.id + '.name') }}
              </option>
            </select>
          </div>
        </div>
      </div>

      <!-- Authentic Yeaft System Configuration Entrypoints -->
      <div class="cosmos-const-section">
        <div class="cosmos-const-section-title">{{ $t('cosmos.constants.yeaftConfig') }}</div>
        <div class="cosmos-cfg-grid">
          <button type="button" class="cosmos-cfg-item" @click="$emit('open-settings', { tab: 'general' })">
            <div class="cosmos-cfg-item-copy">
              <div class="cosmos-cfg-item-name">{{ $t('cosmos.constants.cfgGeneral') }}</div>
              <div class="cosmos-cfg-item-desc">{{ $t('cosmos.constants.cfgGeneralDesc') }}</div>
            </div>
            <span class="cosmos-cfg-chevron" aria-hidden="true">›</span>
          </button>

          <button type="button" class="cosmos-cfg-item" @click="$emit('open-agent-settings', { category: 'llm' })">
            <div class="cosmos-cfg-item-copy">
              <div class="cosmos-cfg-item-name">{{ $t('cosmos.constants.cfgLlm') }}</div>
              <div class="cosmos-cfg-item-desc">{{ $t('cosmos.constants.cfgLlmDesc') }}</div>
            </div>
            <span class="cosmos-cfg-chevron" aria-hidden="true">›</span>
          </button>

          <button type="button" class="cosmos-cfg-item" @click="$emit('open-settings', { tab: 'yeaft', subTab: 'vp' })">
            <div class="cosmos-cfg-item-copy">
              <div class="cosmos-cfg-item-name">{{ $t('cosmos.constants.cfgEngine') }}</div>
              <div class="cosmos-cfg-item-desc">{{ $t('cosmos.constants.cfgEngineDesc') }}</div>
            </div>
            <span class="cosmos-cfg-chevron" aria-hidden="true">›</span>
          </button>

          <button type="button" class="cosmos-cfg-item" @click="$emit('open-agent-settings', { category: 'operations' })">
            <div class="cosmos-cfg-item-copy">
              <div class="cosmos-cfg-item-name">{{ $t('cosmos.constants.cfgAgent') }}</div>
              <div class="cosmos-cfg-item-desc">{{ $t('cosmos.constants.cfgAgentDesc') }}</div>
            </div>
            <span class="cosmos-cfg-chevron" aria-hidden="true">›</span>
          </button>

          <button type="button" class="cosmos-cfg-item" @click="$emit('open-settings', { tab: 'security' })">
            <div class="cosmos-cfg-item-copy">
              <div class="cosmos-cfg-item-name">{{ $t('cosmos.constants.cfgSecurity') }}</div>
              <div class="cosmos-cfg-item-desc">{{ $t('cosmos.constants.cfgSecurityDesc') }}</div>
            </div>
            <span class="cosmos-cfg-chevron" aria-hidden="true">›</span>
          </button>

          <button type="button" class="cosmos-cfg-item" @click="$emit('open-settings', { tab: 'account' })">
            <div class="cosmos-cfg-item-copy">
              <div class="cosmos-cfg-item-name">{{ $t('cosmos.constants.cfgAccount') }}</div>
              <div class="cosmos-cfg-item-desc">{{ $t('cosmos.constants.cfgAccountDesc') }}</div>
            </div>
            <span class="cosmos-cfg-chevron" aria-hidden="true">›</span>
          </button>
        </div>
      </div>
    </section>
  `,
  setup() {
    return { planets: PLANETS };
  },
};
