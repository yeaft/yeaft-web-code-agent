/**
 * SearchSettingsTab.js — Unify Settings → Search tab.
 *
 * Lets the user pick which web-search backend the engine uses
 * (Tavily today; Playwright service is a placeholder for the upcoming
 * self-hosted browser microservice — disabled until the service ships)
 * and edit / replace the Tavily API key. The key is stored on the
 * agent in `~/.yeaft/config.json` under `search.tavilyApiKey`; the UI
 * only ever sees a masked form (`tvly-d...j3dgV`) so the WS feed
 * never carries the raw secret.
 *
 * Live load semantics: on mount we fire `loadSearchSettings()` and (if
 * a key is configured) `loadTavilyUsage()`. We intentionally do NOT
 * poll — quota changes slowly and a stale display is less confusing
 * than a moving target. The "Refresh" button gives manual control.
 *
 * Save semantics: clicking Save sends the whole edited form. If the
 * user didn't touch the key field (`keyDirty` stays false) we OMIT
 * `tavilyApiKey` from the payload so the server merges it as
 * "(unchanged)" — required to avoid wiping the saved key when only
 * the backend radio was changed.
 */
export default {
  name: 'SearchSettingsTab',
  emits: ['message'],
  template: `
    <div class="search-settings-tab">
      <div class="settings-section">
        <h3 class="settings-section-title">{{ $t('search.settings.backendTitle') }}</h3>
        <p class="settings-section-desc">{{ $t('search.settings.backendDesc') }}</p>

        <label class="search-radio-row">
          <input type="radio" value="tavily" v-model="form.backend" />
          <div class="search-radio-body">
            <div class="search-radio-label">{{ $t('search.settings.backend.tavily') }}</div>
            <div class="search-radio-hint">{{ $t('search.settings.backend.tavilyHint') }}</div>
          </div>
        </label>

        <label class="search-radio-row disabled">
          <input type="radio" value="playwright" v-model="form.backend" disabled />
          <div class="search-radio-body">
            <div class="search-radio-label">
              {{ $t('search.settings.backend.playwright') }}
              <span class="search-coming-soon">{{ $t('search.settings.comingSoon') }}</span>
            </div>
            <div class="search-radio-hint">{{ $t('search.settings.backend.playwrightHint') }}</div>
          </div>
        </label>
      </div>

      <div class="settings-section">
        <h3 class="settings-section-title">{{ $t('search.settings.tavilyKeyTitle') }}</h3>
        <p class="settings-section-desc">
          {{ $t('search.settings.tavilyKeyDesc') }}
          <a href="https://tavily.com" target="_blank" rel="noopener">tavily.com</a>
        </p>

        <div class="search-key-row">
          <input
            type="text"
            class="search-key-input"
            :value="keyDisplay"
            :placeholder="settings && settings.tavilyKeyConfigured ? ($t('search.settings.tavilyKeyUnchanged') + ' (' + settings.tavilyKeyMasked + ')') : 'tvly-...'"
            @input="onKeyInput"
            @focus="onKeyFocus"
          />
          <button
            v-if="settings && settings.tavilyKeyConfigured && !keyDirty"
            class="search-btn-secondary"
            @click="clearKey"
            :title="$t('search.settings.clearKey')"
          >
            {{ $t('search.settings.clearKey') }}
          </button>
        </div>
      </div>

      <div class="settings-section" v-if="settings && settings.tavilyKeyConfigured">
        <h3 class="settings-section-title">
          {{ $t('search.settings.usageTitle') }}
          <button class="search-link-btn" @click="refreshUsage" :disabled="usageLoading">
            {{ usageLoading ? $t('search.settings.usageLoading') : $t('search.settings.usageRefresh') }}
          </button>
        </h3>
        <div v-if="usage && !usage.error" class="search-usage-card">
          <div class="search-usage-row">
            <span class="search-usage-label">{{ $t('search.settings.usagePlan') }}</span>
            <span class="search-usage-value">{{ usage.plan }}</span>
          </div>
          <div class="search-usage-row">
            <span class="search-usage-label">{{ $t('search.settings.usageUsed') }}</span>
            <span class="search-usage-value">
              {{ usage.used }}<template v-if="usage.limit !== null"> / {{ usage.limit }}</template>
            </span>
          </div>
          <div v-if="usage.limit" class="search-usage-bar">
            <div class="search-usage-bar-fill" :style="{ width: pct(usage.used, usage.limit) + '%' }"></div>
          </div>
          <div class="search-usage-row" v-if="usage.paygoUsed > 0 || usage.paygoLimit">
            <span class="search-usage-label">{{ $t('search.settings.usagePaygo') }}</span>
            <span class="search-usage-value">
              {{ usage.paygoUsed }}<template v-if="usage.paygoLimit !== null"> / {{ usage.paygoLimit }}</template>
            </span>
          </div>
        </div>
        <div v-else-if="usage && usage.error" class="search-usage-error">
          {{ $t('search.settings.usageError') }}: {{ usage.error }}
        </div>
        <div v-else class="search-usage-pending">{{ $t('search.settings.usageLoading') }}</div>
      </div>

      <div class="settings-section settings-section-actions">
        <button class="search-btn-primary" @click="save" :disabled="saving || !dirty">
          {{ saving ? $t('search.settings.saving') : $t('search.settings.save') }}
        </button>
        <button class="search-btn-secondary" @click="reset" :disabled="!dirty || saving">
          {{ $t('search.settings.cancel') }}
        </button>
      </div>
    </div>
  `,
  setup(_, { emit }) {
    const store = Pinia.useChatStore();
    const instance = Vue.getCurrentInstance();
    const $t = (key) => instance?.proxy?.$t?.(key) ?? key;

    const settings = Vue.computed(() => store.searchSettings);
    const usage = Vue.computed(() => store.tavilyUsage);
    const usageLoading = Vue.computed(() => store.tavilyUsageLoading);

    // Local form mirrors store state; we diff on save so an unchanged
    // backend doesn't trigger a write.
    const form = Vue.reactive({
      backend: 'tavily',
      key: '',
    });
    const keyDirty = Vue.ref(false);
    const saving = Vue.ref(false);

    function syncFromStore() {
      const s = settings.value;
      form.backend = s?.backend || 'tavily';
      form.key = ''; // never display the masked key inside the editable input
      keyDirty.value = false;
    }

    Vue.watch(settings, syncFromStore, { immediate: true });

    const keyDisplay = Vue.computed(() => {
      if (keyDirty.value) return form.key;
      // Empty when not dirty — placeholder communicates state.
      return '';
    });

    const dirty = Vue.computed(() => {
      const s = settings.value;
      if (!s) return keyDirty.value;
      if ((s.backend || 'tavily') !== form.backend) return true;
      if (keyDirty.value) return true;
      return false;
    });

    function onKeyInput(e) {
      keyDirty.value = true;
      form.key = e.target.value;
    }
    function onKeyFocus() {
      // First click on a configured-key input clears the masked
      // placeholder visually so the user knows they're editing.
      if (!keyDirty.value && settings.value?.tavilyKeyConfigured) {
        keyDirty.value = true;
        form.key = '';
      }
    }
    function clearKey() {
      keyDirty.value = true;
      form.key = '';
    }
    function reset() {
      syncFromStore();
    }

    async function save() {
      if (saving.value || !dirty.value) return;
      saving.value = true;
      try {
        const payload = { backend: form.backend };
        // Only include the key when the user actually edited it.
        if (keyDirty.value) payload.tavilyApiKey = form.key.trim();
        const res = await store.updateSearchSettings(payload);
        if (res?.error) {
          emit('message', res.error, true);
        } else {
          emit('message', $t('search.settings.saveSuccess'), false);
          if (keyDirty.value) await store.loadTavilyUsage();
        }
      } catch (e) {
        emit('message', e.message || String(e), true);
      } finally {
        saving.value = false;
      }
    }

    async function refreshUsage() {
      await store.loadTavilyUsage();
    }

    function pct(used, limit) {
      if (!limit) return 0;
      return Math.min(100, Math.round((used / limit) * 100));
    }

    Vue.onMounted(async () => {
      await store.loadSearchSettings();
      // Probe usage only if a key is configured — otherwise Tavily would
      // 401 and we'd surface a confusing error to a user who hasn't even
      // saved a key yet.
      if (store.searchSettings?.tavilyKeyConfigured) {
        store.loadTavilyUsage();
      }
    });

    return {
      settings, usage, usageLoading, form, keyDirty, keyDisplay,
      saving, dirty,
      onKeyInput, onKeyFocus, clearKey, reset, save, refreshUsage, pct,
    };
  },
};
