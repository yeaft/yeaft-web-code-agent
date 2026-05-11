/**
 * VpCrudPanel — task-343.
 *
 * Extracted from VpCrudModal body (no overlay / no modal chrome) so the VP
 * library can live as a tab inside UnifySettings. All CRUD logic is kept
 * verbatim: list view (card grid), create form, edit form, delete confirm,
 * synchronous onBlur vpId validation via web/utils/vp-id-validator.js.
 *
 * Mount contract:
 *   Host provides its own dialog frame + close affordance. This panel
 *   only emits nothing and renders self-contained list/form toggle.
 */
import { useVpStore } from '../stores/vp.js';
import { validateVpId, i18nKeyForReason } from '../utils/vp-id-validator.js';

export default {
  name: 'VpCrudPanel',
  template: `
    <div class="vp-crud-panel">
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
                <div class="vp-crud-card-name">{{ vpLabelFor(vp.vpId) }}</div>
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
    vpLabelFor(vpId) { return this.vpStore.vpLabel(vpId); },

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
      const label = this.vpLabelFor(vp.vpId);
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
          this.formError = this.$t('unify.vp.crud.saveFailed').replace(
            '{error}',
            translated && translated !== key ? translated : ((res.error && res.error.message) || code),
          );
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
