/**
 * VpCrudModal — task-334-ui-g.
 *
 * The VP library entry point: lists all VPs and opens an inline form for
 * create / edit. Delete is confirm-prompt. Form uses synchronous onBlur
 * vpId validation (no WS round-trip) via web/utils/vp-id-validator.js; the
 * backend re-validates on receipt, so client-only bypass is harmless —
 * the filesystem never sees a bad id.
 *
 * State machine:
 *   view = 'list'                        — default; shows VP cards
 *   view = 'form' + editing = null       — create form
 *   view = 'form' + editing = <vp obj>   — edit form (vpId locked)
 *
 * Data source:
 *   list   — useVpStore().vpList (already synced via vp_snapshot + live-diff)
 *   form   — for edit, fetched via `unify_vp_read` so persona body + exact
 *            shape is authoritative (the sidebar snapshot is a projection).
 *
 * The modal does NOT optimistically update the store after create/update —
 * VpLoader's debounced rescan emits `vp_updated` within ~500ms which drives
 * the list. This keeps a single source of truth (the filesystem) and avoids
 * mis-wiring personaHash / lastMutationAt. Delete is the same: `vp_removed`
 * from rescan is the authority.
 */
import { useVpStore } from '../stores/vp.js';
import { validateVpId, i18nKeyForReason } from '../utils/vp-id-validator.js';

export default {
  name: 'VpCrudModal',
  emits: ['close'],
  template: `
    <div class="vp-crud-overlay" @click.self="onOverlayClick" role="dialog" aria-modal="true" :aria-label="$t('unify.vp.crud.title')">
      <div class="vp-crud-modal">
        <header class="vp-crud-header">
          <span class="vp-crud-title">{{ $t('unify.vp.crud.title') }}</span>
          <button class="vp-crud-close" type="button" @click="requestClose" :aria-label="$t('unify.vp.crud.close')">×</button>
        </header>

        <!-- LIST VIEW -->
        <div v-if="view === 'list'" class="vp-crud-body vp-crud-list">
          <div v-if="vpList.length === 0" class="vp-crud-empty">
            <span class="vp-crud-empty-text">{{ $t('unify.vp.crud.empty') }}</span>
            <button class="vp-crud-primary-btn" type="button" @click="startCreate">
              {{ $t('unify.vp.createFirst') }}
            </button>
          </div>

          <template v-else>
            <div class="vp-crud-list-toolbar">
              <button class="vp-crud-primary-btn" type="button" @click="startCreate">
                {{ $t('unify.vp.crud.addNew') }}
              </button>
            </div>
            <div class="vp-crud-card-grid">
              <div class="vp-crud-card" v-for="vp in vpList" :key="vp.vpId">
                <div class="vp-crud-card-avatar" :style="{ background: vpColorFor(vp.vpId) }">
                  {{ vpInitialFor(vp.vpId) }}
                </div>
                <div class="vp-crud-card-meta">
                  <div class="vp-crud-card-name">{{ vp.displayName || vp.vpId }}</div>
                  <div class="vp-crud-card-id">@{{ vp.vpId }}</div>
                  <div class="vp-crud-card-role" v-if="vp.role">{{ vp.role }}</div>
                </div>
                <div class="vp-crud-card-actions">
                  <button class="vp-crud-link-btn" type="button" @click="startEdit(vp)" :disabled="busy">
                    {{ $t('unify.vp.crud.edit') }}
                  </button>
                  <button class="vp-crud-link-btn is-danger" type="button" @click="confirmDelete(vp)" :disabled="busy">
                    {{ $t('unify.vp.crud.delete') }}
                  </button>
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- FORM VIEW -->
        <form v-else class="vp-crud-body vp-crud-form" @submit.prevent="onSubmit" novalidate>
          <div class="vp-crud-form-header">
            <span>{{ editing ? $t('unify.vp.crud.form.update') : $t('unify.vp.crud.form.create') }}</span>
          </div>

          <label class="vp-crud-field">
            <span class="vp-crud-field-label">{{ $t('unify.vp.crud.form.vpId') }}</span>
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
            <span class="vp-crud-hint">{{ $t('unify.vp.crud.form.vpId.tooltip') }}</span>
            <span v-if="idStatus === 'error' && idErrorKey" class="vp-crud-field-error">
              {{ $t(idErrorKey) }}
            </span>
            <span v-else-if="idStatus === 'ok'" class="vp-crud-field-ok">
              ✓ {{ $t('unify.vp.crud.form.ok') }}
            </span>
            <span v-else-if="editing" class="vp-crud-hint vp-crud-hint-muted">
              {{ $t('unify.vp.crud.form.idLocked') }}
            </span>
          </label>

          <label class="vp-crud-field">
            <span class="vp-crud-field-label">{{ $t('unify.vp.crud.form.displayName') }}</span>
            <input type="text" v-model.trim="form.displayName" class="vp-crud-input" maxlength="80" />
          </label>

          <label class="vp-crud-field">
            <span class="vp-crud-field-label">{{ $t('unify.vp.crud.form.role') }}</span>
            <input
              type="text"
              v-model.trim="form.role"
              class="vp-crud-input"
              :placeholder="$t('unify.vp.crud.form.rolePlaceholder')"
              maxlength="120"
            />
          </label>

          <label class="vp-crud-field">
            <span class="vp-crud-field-label">{{ $t('unify.vp.crud.form.traits') }}</span>
            <input
              type="text"
              v-model="form.traitsRaw"
              class="vp-crud-input"
              maxlength="200"
            />
            <span class="vp-crud-hint">{{ $t('unify.vp.crud.form.traitsHint') }}</span>
          </label>

          <label class="vp-crud-field">
            <span class="vp-crud-field-label">{{ $t('unify.vp.crud.form.modelHint') }}</span>
            <select v-model="form.modelHint" class="vp-crud-input">
              <option value="">{{ $t('unify.vp.crud.form.modelHint.none') }}</option>
              <option value="primary">{{ $t('unify.vp.crud.form.modelHint.primary') }}</option>
              <option value="fast">{{ $t('unify.vp.crud.form.modelHint.fast') }}</option>
            </select>
          </label>

          <label class="vp-crud-field">
            <span class="vp-crud-field-label">{{ $t('unify.vp.crud.form.persona') }}</span>
            <textarea
              v-model="form.persona"
              class="vp-crud-textarea"
              rows="8"
              :placeholder="$t('unify.vp.crud.form.personaPlaceholder')"
            ></textarea>
          </label>

          <div v-if="formError" class="vp-crud-form-error">{{ formError }}</div>

          <div class="vp-crud-form-actions">
            <button type="button" class="vp-crud-link-btn" @click="view = 'list'" :disabled="busy">
              {{ $t('unify.vp.crud.form.cancel') }}
            </button>
            <button type="submit" class="vp-crud-primary-btn" :disabled="!canSubmit">
              {{ busy ? $t('unify.vp.crud.saving') : $t('unify.vp.crud.form.submit') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  `,
  data() {
    return {
      view: 'list',          // 'list' | 'form'
      editing: null,         // null for create, vp object for edit
      busy: false,
      idStatus: 'idle',      // 'idle' | 'ok' | 'error'
      idErrorKey: '',
      formError: '',
      form: this.blankForm(),
    };
  },
  computed: {
    vpStore() { return useVpStore(); },
    vpList() { return this.vpStore.vpList; },
    canSubmit() {
      if (this.busy) return false;
      // On create, require a valid vpId. On update, vpId is locked and
      // already known-valid (we read it from disk).
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
    vpColorFor(vpId) { return this.vpStore.vpColor(vpId); },
    vpInitialFor(vpId) { return this.vpStore.vpInitial(vpId); },

    requestClose() {
      if (this.busy) return;
      this.$emit('close');
    },
    onOverlayClick() { this.requestClose(); },

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
      this.busy = true;
      this.formError = '';
      try {
        const res = await this.chatStore().vpCrudRequest('read', vp.vpId);
        const src = (res && res.ok && res.vp) ? res.vp : vp;
        this.editing = { vpId: src.vpId };
        this.form = {
          vpId: src.vpId,
          displayName: src.displayName || '',
          role: src.role || '',
          traitsRaw: Array.isArray(src.traits) ? src.traits.join(', ') : '',
          modelHint: src.modelHint || '',
          persona: typeof src.persona === 'string' ? src.persona : '',
        };
        this.idStatus = 'ok';
        this.idErrorKey = '';
        this.view = 'form';
      } finally {
        this.busy = false;
      }
    },
    async confirmDelete(vp) {
      if (this.busy) return;
      const label = vp.displayName || vp.vpId;
      const prompt = this.$t('unify.vp.crud.deleteConfirm').replace('{name}', label);
      if (typeof window !== 'undefined' && window.confirm && !window.confirm(prompt)) return;
      this.busy = true;
      try {
        const res = await this.chatStore().vpCrudRequest('delete', vp.vpId);
        if (!res.ok) {
          const code = (res.error && res.error.code) || 'unknown';
          const key = i18nKeyForReason(code);
          const translated = this.$t(key);
          this.formError = this.$t('unify.vp.crud.deleteFailed').replace(
            '{error}',
            translated && translated !== key ? translated : ((res.error && res.error.message) || code),
          );
        }
      } finally {
        this.busy = false;
      }
    },

    onVpIdInput() {
      // Clear stale errors as the user types; real validation runs onBlur.
      if (this.idStatus === 'error') {
        this.idStatus = 'idle';
        this.idErrorKey = '';
      }
    },
    onVpIdBlur() {
      if (this.editing) return; // vpId locked on edit
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
          // Prefer the mapped i18n key; fall back to raw code + error message.
          const translated = this.$t(key);
          this.formError = this.$t('unify.vp.crud.saveFailed').replace(
            '{error}',
            translated && translated !== key ? translated : ((res.error && res.error.message) || code),
          );
          // If the failure was a duplicate / id issue, reflect it on the field.
          if (this.editing == null && (code === 'duplicate' || /reserved|digits|character|long|empty/.test(code))) {
            this.idStatus = 'error';
            this.idErrorKey = key;
          }
        }
      } finally {
        this.busy = false;
      }
    },
  },
};
