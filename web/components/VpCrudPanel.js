/**
 * VpCrudPanel — task-343.
 *
 * Extracted from VpCrudModal body (no overlay / no modal chrome) so the VP
 * library can live as a tab inside YeaftSettings. All CRUD logic is kept
 * verbatim: list view (card grid), create form, edit form, delete confirm,
 * synchronous onBlur vpId validation via web/utils/vp-id-validator.js.
 *
 * Mount contract:
 *   Host provides its own dialog frame + close affordance. This panel
 *   only emits nothing and renders self-contained list/form toggle.
 *   Host may pass initialEditVpId to jump directly into the edit form.
 */
import { useVpStore } from '../stores/vp.js';
import { validateVpId, i18nKeyForReason, isIdReasonCode } from '../utils/vp-id-validator.js';

export default {
  name: 'VpCrudPanel',
  props: {
    initialEditVpId: { type: String, default: '' },
  },
  template: `
    <div class="vp-crud-panel">
      <!-- LIST VIEW -->
      <div v-if="view === 'list'" class="vp-crud-body vp-crud-list">
        <div v-if="vpList.length === 0" class="vp-crud-empty">
          <span class="vp-crud-empty-text">{{ $t('yeaft.vp.crud.empty') }}</span>
          <button class="sp-btn sp-btn-primary vp-crud-primary-btn" type="button" @click="startCreate">
            {{ $t('yeaft.vp.createFirst') }}
          </button>
        </div>

        <template v-else>
          <div class="vp-crud-list-toolbar">
            <button class="sp-btn sp-btn-primary vp-crud-primary-btn" type="button" @click="startCreate">
              {{ $t('yeaft.vp.crud.addNew') }}
            </button>
          </div>
          <div class="vp-crud-card-grid">
            <div class="vp-crud-card" v-for="vp in vpList" :key="vp.vpId">
              <div class="vp-crud-card-main">
                <div class="vp-crud-card-meta">
                  <div class="vp-crud-card-title-row">
                    <div class="vp-crud-card-name">
                      <span>{{ vp.displayName || vp.vpId }}</span>
                    </div>
                    <span v-if="vp.isStock" class="vp-crud-stock-badge" :title="$t('yeaft.vp.crud.stockReadOnly')">
                      {{ $t('yeaft.vp.crud.stockBadge') }}
                    </span>
                  </div>
                </div>
              </div>
              <div class="vp-crud-card-actions">
                <button
                  class="vp-crud-link-btn"
                  type="button"
                  @click="startView(vp)"
                  :disabled="busy"
                >
                  {{ $t('yeaft.vp.crud.viewPrompt') }}
                </button>
                <button
                  class="vp-crud-link-btn"
                  type="button"
                  @click="startEdit(vp)"
                  :disabled="busy || vp.isStock"
                  :title="vp.isStock ? $t('yeaft.vp.crud.stockReadOnly') : ''"
                >
                  {{ $t('yeaft.vp.crud.edit') }}
                </button>
                <button
                  class="vp-crud-link-btn is-danger"
                  type="button"
                  @click="confirmDelete(vp)"
                  :disabled="busy || vp.isStock"
                  :title="vp.isStock ? $t('yeaft.vp.crud.stockReadOnly') : ''"
                >
                  {{ $t('yeaft.vp.crud.delete') }}
                </button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- DETAIL (VIEW PROMPT) VIEW — read-only -->
      <div v-else-if="view === 'detail'" class="vp-crud-body vp-crud-detail">
        <div class="vp-crud-form-header">
          <span>{{ $t('yeaft.vp.crud.view.title') }}</span>
          <span v-if="detail && detail.isStock" class="vp-crud-stock-badge vp-crud-stock-badge--compact">
            {{ $t('yeaft.vp.crud.stockBadge') }}
          </span>
        </div>

        <div v-if="detailLoading" class="vp-crud-empty-text">{{ $t('yeaft.vp.crud.saving') }}</div>
        <template v-else-if="detail">
          <div class="vp-crud-field vp-crud-field-readonly">
            <span class="vp-crud-field-label">{{ $t('yeaft.vp.crud.form.vpId') }}</span>
            <div class="vp-crud-readonly-value">@{{ detail.vpId }}</div>
          </div>
          <div class="vp-crud-field vp-crud-field-readonly">
            <span class="vp-crud-field-label">{{ $t('yeaft.vp.crud.form.displayName') }}</span>
            <div class="vp-crud-readonly-value">{{ detail.displayName || detail.vpId }}</div>
          </div>
          <div class="vp-crud-field vp-crud-field-readonly" v-if="detail.role">
            <span class="vp-crud-field-label">{{ $t('yeaft.vp.crud.form.role') }}</span>
            <div class="vp-crud-readonly-value">{{ detail.role }}</div>
          </div>
          <div class="vp-crud-field vp-crud-field-readonly" v-if="detail.traits && detail.traits.length">
            <span class="vp-crud-field-label">{{ $t('yeaft.vp.crud.form.traits') }}</span>
            <div class="vp-crud-readonly-value">{{ detail.traits.join(', ') }}</div>
          </div>
          <div class="vp-crud-field vp-crud-field-readonly" v-if="detail.modelHint">
            <span class="vp-crud-field-label">{{ $t('yeaft.vp.crud.form.modelHint') }}</span>
            <div class="vp-crud-readonly-value">{{ detail.modelHint }}</div>
          </div>
          <div class="vp-crud-field vp-crud-field-readonly">
            <span class="vp-crud-field-label">{{ $t('yeaft.vp.crud.form.persona') }}</span>
            <pre v-if="detail.persona" class="vp-crud-persona-preview">{{ detail.persona }}</pre>
            <div v-else class="vp-crud-readonly-value vp-crud-readonly-empty">
              {{ $t('yeaft.vp.crud.view.personaEmpty') }}
            </div>
          </div>
        </template>
        <div v-else class="vp-crud-form-error">{{ detailError || $t('yeaft.vp.idError.unknown') }}</div>

        <div class="vp-crud-form-actions">
          <button type="button" class="vp-crud-link-btn" @click="returnToList">
            {{ $t('yeaft.vp.crud.view.back') }}
          </button>
          <button
            v-if="detail && !detail.isStock"
            type="button"
            class="sp-btn sp-btn-primary vp-crud-primary-btn"
            @click="editFromDetail"
            :disabled="busy"
          >
            {{ $t('yeaft.vp.crud.view.editFromHere') }}
          </button>
        </div>
      </div>

      <!-- FORM VIEW -->
      <form v-else class="vp-crud-body vp-crud-form" @submit.prevent="onSubmit" novalidate>
        <div class="vp-crud-form-header">
          <span>{{ editing ? $t('yeaft.vp.crud.form.update') : $t('yeaft.vp.crud.form.create') }}</span>
        </div>

        <label class="vp-crud-field">
          <span class="vp-crud-field-label">{{ $t('yeaft.vp.crud.form.vpId') }}</span>
          <input
            type="text"
            v-model.trim="form.vpId"
            :readonly="!!editing"
            :disabled="!!editing"
            @blur="onVpIdBlur"
            @input="onVpIdInput"
            maxlength="40"
            autocomplete="off"
            spellcheck="false"
            class="vp-crud-input"
            :class="{ 'is-error': idStatus === 'error', 'is-ok': idStatus === 'ok' }"
            ref="vpIdInput"
          />
          <span class="vp-crud-hint">{{ $t('yeaft.vp.crud.form.vpId.tooltip') }}</span>
          <span v-if="idStatus === 'error' && idErrorKey" class="vp-crud-field-error">
            {{ $t(idErrorKey) }}
          </span>
          <span v-else-if="idStatus === 'ok'" class="vp-crud-field-ok">
            ✓ {{ $t('yeaft.vp.crud.form.ok') }}
          </span>
          <span v-else-if="editing" class="vp-crud-hint vp-crud-hint-muted">
            {{ $t('yeaft.vp.crud.form.idLocked') }}
          </span>
        </label>

        <label class="vp-crud-field">
          <span class="vp-crud-field-label">{{ $t('yeaft.vp.crud.form.displayName') }}</span>
          <input type="text" v-model.trim="form.displayName" class="vp-crud-input" maxlength="80" />
        </label>

        <label class="vp-crud-field">
          <span class="vp-crud-field-label">{{ $t('yeaft.vp.crud.form.role') }}</span>
          <input
            type="text"
            v-model.trim="form.role"
            class="vp-crud-input"
            :placeholder="$t('yeaft.vp.crud.form.rolePlaceholder')"
            maxlength="120"
          />
        </label>

        <label class="vp-crud-field">
          <span class="vp-crud-field-label">{{ $t('yeaft.vp.crud.form.traits') }}</span>
          <input
            type="text"
            v-model="form.traitsRaw"
            class="vp-crud-input"
            maxlength="200"
          />
          <span class="vp-crud-hint">{{ $t('yeaft.vp.crud.form.traitsHint') }}</span>
        </label>

        <label class="vp-crud-field">
          <span class="vp-crud-field-label">{{ $t('yeaft.vp.crud.form.modelHint') }}</span>
          <select v-model="form.modelHint" class="vp-crud-input">
            <option value="">{{ $t('yeaft.vp.crud.form.modelHint.none') }}</option>
            <option value="primary">{{ $t('yeaft.vp.crud.form.modelHint.primary') }}</option>
            <option value="fast">{{ $t('yeaft.vp.crud.form.modelHint.fast') }}</option>
          </select>
        </label>

        <label class="vp-crud-field">
          <span class="vp-crud-field-label">{{ $t('yeaft.vp.crud.form.persona') }}</span>
          <textarea
            v-model="form.persona"
            class="vp-crud-textarea"
            rows="8"
            :placeholder="$t('yeaft.vp.crud.form.personaPlaceholder')"
          ></textarea>
        </label>

        <div v-if="formError" class="vp-crud-form-error">{{ formError }}</div>

        <div class="vp-crud-form-actions">
          <button type="button" class="vp-crud-link-btn" @click="returnToList" :disabled="busy">
            {{ $t('yeaft.vp.crud.form.cancel') }}
          </button>
          <button type="submit" class="sp-btn sp-btn-primary vp-crud-primary-btn" :disabled="!canSubmit">
            {{ busy ? $t('yeaft.vp.crud.saving') : $t('yeaft.vp.crud.form.submit') }}
          </button>
        </div>
      </form>
    </div>
  `,
  data() {
    return {
      view: 'list',          // 'list' | 'form' | 'detail'
      editing: null,         // null for create, vp object for edit
      busy: false,
      idStatus: 'idle',      // 'idle' | 'ok' | 'error'
      idErrorKey: '',
      formError: '',
      form: this.blankForm(),
      // task-vp-customize: read-only "View prompt" mode.
      detail: null,          // { vpId, displayName, role, traits, modelHint, persona, isStock }
      detailLoading: false,
      detailError: '',
    };
  },
  computed: {
    vpStore() { return useVpStore(); },
    vpList() { return this.vpStore.vpList; },
    canSubmit() {
      if (this.busy) return false;
      if (this.editing) return true;
      return this.idStatus === 'ok';
    },
  },
  methods: {
    blankForm() {
      return {
        vpId: '',
        displayName: '',
        role: '',
        traitsRaw: '',
        modelHint: '',
        persona: '',
      };
    },
    /**
     * Populate `this.form` from a VP-shaped object (either a fresh read
     * response or this.detail). Shared between `startEdit` and
     * `editFromDetail` so a new VP field only needs to be added once.
     */
    populateFormFrom(src) {
      this.form = {
        vpId: src.vpId,
        displayName: src.displayName || '',
        role: src.role || '',
        traitsRaw: Array.isArray(src.traits) ? src.traits.join(', ') : '',
        modelHint: src.modelHint || '',
        persona: typeof src.persona === 'string' ? src.persona : '',
      };
    },

    /**
     * Single exit path back to the list view. Clears detail-view state
     * AND form / editing state so a re-entry starts clean. The cancel
     * button on the form, the "Back" button on the detail view, and the
     * live-removal watcher all funnel through here.
     */
    returnToList(message) {
      this.view = 'list';
      this.editing = null;
      this.form = this.blankForm();
      this.idStatus = 'idle';
      this.idErrorKey = '';
      this.formError = typeof message === 'string' ? message : '';
      this.detail = null;
      this.detailError = '';
      this.detailLoading = false;
    },

    startCreate() {
      this.editing = null;
      this.form = this.blankForm();
      this.idStatus = 'idle';
      this.idErrorKey = '';
      this.formError = '';
      this.view = 'form';
      this.$nextTick(() => {
        const el = this.$refs.vpIdInput;
        if (el && typeof el.focus === 'function') el.focus();
      });
    },
    async startEdit(vp) {
      if (this.busy) return;
      if (!vp || !vp.vpId) return;
      // Defence-in-depth: even if the template's :disabled is bypassed,
      // refuse to enter edit form for a stock VP.
      if (vp.isStock) return;
      this.busy = true;
      this.formError = '';
      try {
        const res = await this.chatStore().vpCrudRequest('read', vp.vpId);
        // FIX (review C2): on read failure we MUST NOT fall back silently
        // to the list-snapshot — that gave users a stale form they thought
        // was the live record, and saves landed on a divergent persona.
        // Surface the error and stay on the list.
        if (!(res && res.ok && res.vp)) {
          const code = (res && res.error && res.error.code) || 'unknown';
          const key = i18nKeyForReason(code);
          const translated = this.$t(key);
          this.formError = translated && translated !== key
            ? translated
            : ((res && res.error && res.error.message) || code);
          return;
        }
        const src = res.vp;
        this.editing = { vpId: src.vpId };
        this.populateFormFrom(src);
        this.idStatus = 'ok';
        this.idErrorKey = '';
        this.view = 'form';
      } finally {
        this.busy = false;
      }
    },

    /**
     * Open the read-only "View prompt" detail view for any VP (stock or
     * user-authored). Pulls the persona body via `vpCrudRequest('read', id)`
     * which is the same path startEdit uses.
     */
    openInitialEdit() {
      const id = this.initialEditVpId;
      if (!id) return;
      const vp = (this.vpStore && this.vpStore.vps && this.vpStore.vps[id])
        || (this.vpList || []).find(item => item && item.vpId === id)
        || { vpId: id };
      if (vp.isStock) return;
      this.startEdit(vp);
    },

    async startView(vp) {
      if (this.busy || !vp || !vp.vpId) return;
      this.busy = true;
      this.detailLoading = true;
      this.detailError = '';
      this.detail = null;
      this.view = 'detail';
      try {
        const res = await this.chatStore().vpCrudRequest('read', vp.vpId);
        if (res && res.ok && res.vp) {
          this.detail = {
            vpId: res.vp.vpId,
            displayName: res.vp.displayName || '',
            role: res.vp.role || '',
            traits: Array.isArray(res.vp.traits) ? res.vp.traits : [],
            modelHint: res.vp.modelHint || '',
            persona: typeof res.vp.persona === 'string' ? res.vp.persona : '',
            // Prefer the authoritative isStock from the read response
            // (echoed by readVp); fall back to the list-snapshot flag
            // only if an older agent hasn't been redeployed yet.
            isStock: !!(res.vp.isStock != null ? res.vp.isStock : vp.isStock),
          };
        } else {
          const code = (res && res.error && res.error.code) || 'unknown';
          const key = i18nKeyForReason(code);
          const translated = this.$t(key);
          this.detailError = translated && translated !== key
            ? translated
            : ((res && res.error && res.error.message) || code);
        }
      } catch (err) {
        this.detailError = (err && err.message) || this.$t('yeaft.vp.idError.unknown');
      } finally {
        this.detailLoading = false;
        this.busy = false;
      }
    },

    /**
     * "Edit" button on the detail view: jump straight into the edit form
     * using the already-loaded `this.detail` so we don't refetch.
     */
    editFromDetail() {
      if (!this.detail || this.detail.isStock) return;
      const src = this.detail;
      this.editing = { vpId: src.vpId };
      this.populateFormFrom(src);
      this.idStatus = 'ok';
      this.idErrorKey = '';
      this.formError = '';
      this.view = 'form';
    },

    async confirmDelete(vp) {
      if (this.busy) return;
      // Defence-in-depth: stock VPs cannot be deleted from the UI.
      if (vp && vp.isStock) return;
      const label = vp.displayName || vp.vpId;
      const prompt = this.$t('yeaft.vp.crud.deleteConfirm').replace('{name}', label);
      if (typeof window !== 'undefined' && window.confirm && !window.confirm(prompt)) return;
      this.busy = true;
      try {
        const res = await this.chatStore().vpCrudRequest('delete', vp.vpId);
        if (!res.ok) {
          const code = (res.error && res.error.code) || 'unknown';
          const key = i18nKeyForReason(code);
          const translated = this.$t(key);
          this.formError = this.$t('yeaft.vp.crud.deleteFailed').replace(
            '{error}',
            translated && translated !== key ? translated : ((res.error && res.error.message) || code),
          );
        }
      } finally {
        this.busy = false;
      }
    },

    onVpIdInput() {
      if (this.idStatus === 'error') {
        this.idStatus = 'idle';
        this.idErrorKey = '';
      }
    },
    onVpIdBlur() {
      if (this.editing) return;
      const v = validateVpId(this.form.vpId);
      if (v.ok) {
        this.idStatus = 'ok';
        this.idErrorKey = '';
      } else {
        this.idStatus = 'error';
        this.idErrorKey = i18nKeyForReason(v.reason);
      }
    },

    parseTraits(raw) {
      if (!raw) return [];
      return String(raw)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    },

    chatStore() {
      return (window.Pinia && window.Pinia.useChatStore && window.Pinia.useChatStore())
        || (typeof Pinia !== 'undefined' && Pinia.useChatStore && Pinia.useChatStore());
    },

    async onSubmit() {
      if (!this.canSubmit) return;
      this.busy = true;
      this.formError = '';
      const payload = {
        vpId: this.form.vpId,
        displayName: this.form.displayName || this.form.vpId,
        role: this.form.role,
        traits: this.parseTraits(this.form.traitsRaw),
        modelHint: this.form.modelHint || null,
        persona: this.form.persona,
      };
      const op = this.editing ? 'update' : 'create';
      try {
        const res = await this.chatStore().vpCrudRequest(op, payload);
        if (res.ok) {
          this.view = 'list';
          this.editing = null;
          this.form = this.blankForm();
        } else {
          const code = (res.error && res.error.code) || 'unknown';
          const key = i18nKeyForReason(code);
          const translated = this.$t(key);
          this.formError = this.$t('yeaft.vp.crud.saveFailed').replace(
            '{error}',
            translated && translated !== key ? translated : ((res.error && res.error.message) || code),
          );
          // FIX (review I2): the closed enum lives in vp-id-validator.js's
          // `ID_REASON_CODES`. Substring regexes against the code (a) used
          // to false-positive any future code containing 'long'/'empty'
          // etc., and (b) missed `stock_readonly` even though it's the
          // most security-relevant id-related refusal.
          if (this.editing == null && isIdReasonCode(code)) {
            this.idStatus = 'error';
            this.idErrorKey = key;
          }
        }
      } finally {
        this.busy = false;
      }
    },
  },

  /**
   * Live-removal sync (review C3): if the VP currently being viewed in
   * the detail panel or edited in the form disappears from the store
   * (another tab deletes it, or a `vp_removed` event arrives), bounce
   * back to the list rather than letting the user save edits on a ghost
   * record. The store handles `vp_removed` already — we only need to
   * react to its observable consequence (`vpStore.vps` losing the key).
   */
  mounted() {
    this.openInitialEdit();
  },
  watch: {
    initialEditVpId() {
      this.openInitialEdit();
    },
    'vpStore.vps': {
      deep: true,
      handler(vps) {
        const id = this.detail?.vpId || this.editing?.vpId;
        if (!id) return;
        if (vps && vps[id]) return;
        // The VP we were viewing / editing is gone. Bail back to the list
        // with a translated notice. Avoid stomping a more specific error
        // that the user is currently looking at.
        if (this.view === 'detail' || this.view === 'form') {
          this.returnToList(this.$t('yeaft.vp.crud.view.removed'));
        }
      },
    },
  },
};
