/**
 * QuickPreview — PR-2 of the feature-pill double-track redesign.
 *
 * Renders the instant Track-A "quick preview" bubble under a user message.
 * Track A is the always-on Quick Response engine that emits an
 * { intent: 'quick' | 'feature', preview: string } event before the main
 * engine has even started. The user sees the preview within ~200ms — much
 * faster than waiting for the full assistant turn.
 *
 * Behaviour:
 *   - intent = 'quick'   → final answer; the bubble stays as the canonical reply.
 *   - intent = 'feature' → Track-A handed off to the main engine (via the
 *     feature-arc); the preview is "VP is starting work on X" and gets
 *     superseded by the FeaturePill once the feature_started event lands.
 *     We dim the bubble in that case so the user's eye moves to the pill.
 *
 * Props:
 *   preview — store record from `unifyQuickPreviews[`${vpId}:${turnId}`]`,
 *             shape: { vpId, turnId, intent, preview, ts }.
 *   superseded — boolean; true if this preview's VP/turn now has an active
 *             FeaturePill rendered below the bubble. Lets the parent dim
 *             the bubble without hiding it (so the user can still see the
 *             original pre-feature gist).
 */
export default {
  name: 'QuickPreview',
  props: {
    preview: { type: Object, required: true },
    superseded: { type: Boolean, default: false },
  },
  template: `
    <div
      class="quick-preview-bubble"
      :class="['quick-preview-' + (preview.intent || 'quick'), { 'quick-preview-superseded': superseded }]"
      :data-vp-id="preview.vpId"
      :data-turn-id="preview.turnId"
    >
      <span class="quick-preview-icon" aria-hidden="true">⚡</span>
      <span class="quick-preview-body">{{ preview.preview }}</span>
      <span v-if="superseded" class="quick-preview-superseded-tag" :title="$t('unify.quickPreview.superseded.title')">
        {{ $t('unify.quickPreview.superseded.label') }}
      </span>
    </div>
  `,
};
