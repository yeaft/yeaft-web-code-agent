/**
 * ExpertRoleEditor — Modal for creating/editing custom expert roles.
 * Supports role metadata (name, title) and multiple actions with prompts.
 */

export default {
  name: 'ExpertRoleEditor',
  template: `
    <div class="expert-editor-overlay" @click.self="$emit('close')">
      <div class="expert-editor-modal">
        <div class="expert-editor-header">
          <span class="expert-editor-title">{{ isEdit ? $t('expertEditor.editTitle') : $t('expertEditor.createTitle') }}</span>
          <button class="expert-editor-close" @click="$emit('close')">&times;</button>
        </div>

        <div class="expert-editor-body">
          <!-- Role Basic Info -->
          <div class="expert-editor-section">
            <div class="expert-editor-section-title">{{ $t('expertEditor.basicInfo') }}</div>
            <div class="expert-editor-field">
              <label>{{ $t('expertEditor.roleName') }} <span class="required">*</span></label>
              <input v-model="form.name" :placeholder="$t('expertEditor.roleNamePlaceholder')" maxlength="30" />
            </div>
            <div class="expert-editor-field">
              <label>{{ $t('expertEditor.roleTitle') }} <span class="required">*</span></label>
              <input v-model="form.title" :placeholder="$t('expertEditor.roleTitlePlaceholder')" maxlength="50" />
            </div>
            <div class="expert-editor-row">
              <div class="expert-editor-field" style="flex:1">
                <label>{{ $t('expertEditor.fullName') }}</label>
                <input v-model="form.fullName" :placeholder="$t('expertEditor.fullNamePlaceholder')" maxlength="50" />
              </div>
              <div class="expert-editor-field" style="flex:1">
                <label>{{ $t('expertEditor.titleEn') }}</label>
                <input v-model="form.titleEn" :placeholder="$t('expertEditor.titleEnPlaceholder')" maxlength="50" />
              </div>
            </div>
          </div>

          <!-- Role Prompt -->
          <div class="expert-editor-section">
            <div class="expert-editor-section-title">{{ $t('expertEditor.rolePrompt') }}</div>
            <div class="expert-editor-field">
              <label>{{ $t('expertEditor.messagePrefix') }}</label>
              <textarea v-model="form.messagePrefix" :placeholder="$t('expertEditor.messagePrefixPlaceholder')" rows="3"></textarea>
            </div>
            <div class="expert-editor-field">
              <label>{{ $t('expertEditor.messagePrefixEn') }}</label>
              <textarea v-model="form.messagePrefixEn" :placeholder="$t('expertEditor.messagePrefixEnPlaceholder')" rows="3"></textarea>
            </div>
          </div>

          <!-- Actions -->
          <div class="expert-editor-section">
            <div class="expert-editor-section-title">
              {{ $t('expertEditor.actions') }}
              <button class="expert-editor-add-action" @click="addAction">+ {{ $t('expertEditor.addAction') }}</button>
            </div>
            <div v-for="(action, idx) in form.actions" :key="idx" class="expert-editor-action-card">
              <div class="expert-editor-action-header">
                <span class="expert-editor-action-num">#{{ idx + 1 }}</span>
                <button class="expert-editor-action-remove" @click="removeAction(idx)" :title="$t('expertEditor.removeAction')">&times;</button>
              </div>
              <div class="expert-editor-row">
                <div class="expert-editor-field" style="flex:1">
                  <label>{{ $t('expertEditor.actionName') }} <span class="required">*</span></label>
                  <input v-model="action.name" :placeholder="$t('expertEditor.actionNamePlaceholder')" maxlength="30" />
                </div>
                <div class="expert-editor-field" style="flex:1">
                  <label>{{ $t('expertEditor.actionNameEn') }}</label>
                  <input v-model="action.nameEn" :placeholder="$t('expertEditor.actionNameEnPlaceholder')" maxlength="30" />
                </div>
              </div>
              <div class="expert-editor-field">
                <label>{{ $t('expertEditor.messageTemplate') }}</label>
                <textarea v-model="action.messageTemplate" :placeholder="$t('expertEditor.messageTemplatePlaceholder')" rows="2"></textarea>
              </div>
              <div class="expert-editor-field">
                <label>{{ $t('expertEditor.messageTemplateEn') }}</label>
                <textarea v-model="action.messageTemplateEn" :placeholder="$t('expertEditor.messageTemplateEnPlaceholder')" rows="2"></textarea>
              </div>
              <div class="expert-editor-field">
                <label>{{ $t('expertEditor.defaultMessage') }}</label>
                <textarea v-model="action.defaultMessage" :placeholder="$t('expertEditor.defaultMessagePlaceholder')" rows="2"></textarea>
              </div>
              <div class="expert-editor-field">
                <label>{{ $t('expertEditor.defaultMessageEn') }}</label>
                <textarea v-model="action.defaultMessageEn" :placeholder="$t('expertEditor.defaultMessageEnPlaceholder')" rows="2"></textarea>
              </div>
            </div>
          </div>
        </div>

        <div class="expert-editor-footer">
          <button class="expert-editor-cancel" @click="$emit('close')">{{ $t('expertEditor.cancel') }}</button>
          <button class="expert-editor-save" :disabled="!canSave || saving" @click="save">
            {{ saving ? $t('expertEditor.saving') : $t('expertEditor.save') }}
          </button>
        </div>
      </div>
    </div>
  `,
  props: {
    /** Existing role to edit, or null for create mode */
    role: { type: Object, default: null }
  },
  emits: ['close', 'saved'],
  setup(props, { emit }) {
    const store = Pinia.useChatStore();
    const saving = Vue.ref(false);

    const isEdit = Vue.computed(() => !!props.role);

    // Form state
    const createEmptyAction = () => ({
      name: '', nameEn: '',
      messageTemplate: '', messageTemplateEn: '',
      defaultMessage: '', defaultMessageEn: ''
    });

    const form = Vue.reactive({
      name: '',
      fullName: '',
      title: '',
      titleEn: '',
      messagePrefix: '',
      messagePrefixEn: '',
      actions: [createEmptyAction()]
    });

    // Initialize from existing role (edit mode)
    if (props.role) {
      form.name = props.role.name || '';
      form.fullName = props.role.fullName || '';
      form.title = props.role.title || '';
      form.titleEn = props.role.titleEn || '';
      form.messagePrefix = props.role.messagePrefix || '';
      form.messagePrefixEn = props.role.messagePrefixEn || '';
      form.actions = (props.role.actions || []).map(a => ({
        name: a.name || '',
        nameEn: a.nameEn || '',
        messageTemplate: a.messageTemplate || '',
        messageTemplateEn: a.messageTemplateEn || '',
        defaultMessage: a.defaultMessage || '',
        defaultMessageEn: a.defaultMessageEn || ''
      }));
      if (form.actions.length === 0) {
        form.actions.push(createEmptyAction());
      }
    }

    const canSave = Vue.computed(() => {
      if (!form.name.trim() || !form.title.trim()) return false;
      // At least check action names if actions exist
      for (const a of form.actions) {
        if (a.name.trim() === '' && (a.messageTemplate || a.defaultMessage)) {
          return false; // Action has content but no name
        }
      }
      return true;
    });

    const addAction = () => {
      form.actions.push(createEmptyAction());
    };

    const removeAction = (idx) => {
      form.actions.splice(idx, 1);
    };

    const save = async () => {
      if (!canSave.value || saving.value) return;
      saving.value = true;

      try {
        // Filter out empty actions
        const validActions = form.actions
          .filter(a => a.name.trim())
          .map((a, i) => ({
            actionId: isEdit.value && props.role.actions?.[i]?.id
              ? props.role.actions[i].id
              : `action-${Date.now()}-${i}`,
            name: a.name.trim(),
            nameEn: a.nameEn.trim() || null,
            messageTemplate: a.messageTemplate || null,
            messageTemplateEn: a.messageTemplateEn || null,
            defaultMessage: a.defaultMessage || null,
            defaultMessageEn: a.defaultMessageEn || null
          }));

        const roleData = {
          name: form.name.trim(),
          fullName: form.fullName.trim() || null,
          title: form.title.trim(),
          titleEn: form.titleEn.trim() || null,
          groupId: 'custom',
          messagePrefix: form.messagePrefix || null,
          messagePrefixEn: form.messagePrefixEn || null,
          actions: validActions
        };

        if (isEdit.value) {
          await store.updateCustomExpertRole(props.role.id, roleData);
        } else {
          await store.createCustomExpertRole(roleData);
        }

        emit('saved');
        emit('close');
      } catch (err) {
        console.error('Failed to save custom expert role:', err);
      } finally {
        saving.value = false;
      }
    };

    return {
      form,
      isEdit,
      canSave,
      saving,
      addAction,
      removeAction,
      save
    };
  }
};
