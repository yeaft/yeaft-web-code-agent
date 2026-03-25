/**
 * ActorCard — Displays a single Actor's live status.
 *
 * Layout: persona icon + name | specialty tag | breathing-dot status
 * Animations: fade-in on spawn, fade-out on release (CSS-driven)
 */
export default {
  name: 'ActorCard',
  props: {
    actor: { type: Object, required: true },
    // { key, persona, specialty, taskId, status, spawnedAt }
    compact: { type: Boolean, default: false }
  },
  template: `
    <div class="conductor-actor-card"
         :class="[
           'status-' + (actor.status || 'active'),
           { compact },
           'actor-enter'
         ]">
      <div class="conductor-actor-avatar">
        <span class="conductor-actor-icon">{{ personaIcon }}</span>
        <span class="conductor-actor-dot" :class="'dot-' + (actor.status || 'active')"></span>
      </div>
      <div class="conductor-actor-info">
        <span class="conductor-actor-name">{{ actor.persona }}</span>
        <span class="conductor-actor-specialty">{{ actor.specialty }}</span>
      </div>
      <span v-if="!compact && actor.status" class="conductor-actor-status-label">
        {{ statusLabel }}
      </span>
    </div>
  `,
  computed: {
    personaIcon() {
      const PERSONA_ICONS = {
        'Jobs': '🧠', 'Torvalds': '🔨', 'Martin': '👁',
        'Beck': '🧪', 'Rams': '🎨',
        // Writing personas
        '猫腻': '📖', '肘子': '✍️', '金庸': '⚔️', '马伯庸': '📝',
        // Trading
        'Soros': '📊', 'Simons': '🔢', 'Dalio': '🏛',
        // Video
        '宫崎骏': '🎬', '新海诚': '🌠', 'Nolan': '🎥'
      };
      return PERSONA_ICONS[this.actor.persona] || '🤖';
    },
    statusLabel() {
      const STATUS_LABELS = {
        active: 'Working',
        idle: 'Idle',
        thinking: 'Thinking',
        tool_use: 'Executing',
        waiting: 'Waiting',
        completed: 'Done',
        error: 'Error'
      };
      return STATUS_LABELS[this.actor.status] || this.actor.status || 'Active';
    }
  }
};
