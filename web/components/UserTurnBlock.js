/**
 * UserTurnBlock — IM-style human-side row for the Yeaft group-chat view.
 * The mirror image of VpTurnBlock: VP turns sit on the LEFT with the
 * avatar in a 36px gutter on the left and the content right-aligned to
 * the right of the gutter; UserTurnBlock puts the content column on the
 * LEFT and the avatar gutter on the RIGHT (`1fr 36px` vs `36px 1fr`).
 *
 * Why two components instead of one parameterized:
 *   - The header inside VpTurnBlock carries name + start time + stop
 *     button + collapse toggle. The user row has no streaming state, no
 *     stop affordance, and no collapse — it's a static bubble with just
 *     a timestamp. A single component juggling both halves would have
 *     to v-if/v-else every header element; two siblings stay readable.
 *   - MessageItem's user branch (the legacy 1:1 chat user bubble) does
 *     a lot besides text — expert-selection chips, attachment indicator,
 *     attachment grid expansion. We delegate the body to MessageItem so
 *     all that machinery stays in one place. UserTurnBlock is purely the
 *     IM-style row wrapper (avatar gutter + bubble column).
 *
 * Layout:
 *   ┌──────────────────────────────────────────┬────────┐
 *   │ message body (right-aligned bubble)      │ avatar │
 *   └──────────────────────────────────────────┴────────┘
 *
 * Mounted only by MessageList in Yeaft mode when the active view is a
 * group conversation. Chat-mode user messages still go straight to
 * MessageItem (no IM-style frame, no avatar).
 *
 * Props:
 *   message — the user message object, passed through to MessageItem.
 */
import MessageItem from './MessageItem.js';
import UserAvatar from './UserAvatar.js';

export default {
  name: 'UserTurnBlock',
  components: { MessageItem, UserAvatar },
  props: {
    message: { type: Object, required: true },
  },
  template: `
    <div class="user-turn-block" :data-msg-id="message.id || ''">
      <div class="user-turn-block-main">
        <MessageItem :message="message" />
      </div>
      <div class="user-turn-block-avatar" :title="avatarLabel">
        <UserAvatar :size="36" :aria-label="avatarLabel" />
      </div>
    </div>
  `,
  setup() {
    const t = Vue.inject('t', null);
    const avatarLabel = Vue.computed(() => (t ? t('yeaft.user.youLabel') : 'You'));
    return { avatarLabel };
  },
};
