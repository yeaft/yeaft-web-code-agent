/**
 * UserTurnBlock — IM-style human-side row for the Yeaft Session view.
 * VP turns keep their speaker avatar on the left; user turns render as a
 * plain right-aligned message frame. There is no user avatar: the human
 * side is already implied by alignment and bubble styling.
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
 *     all that machinery stays single-sourced.
 *
 * Layout:
 *   ┌──────────────────────────────────────────┐
 *   │ message body (right-aligned bubble)      │
 *   └──────────────────────────────────────────┘
 *
 * Mounted only by MessageList in Yeaft mode when the active view is a
 * Session conversation. Chat-mode user messages still go straight to
 * MessageItem (no IM-style frame, no avatar).
 *
 * Props:
 *   message — the user message object, passed through to MessageItem.
 */
import MessageItem from './MessageItem.js';

export default {
  name: 'UserTurnBlock',
  components: { MessageItem },
  props: {
    message: { type: Object, required: true },
  },
  template: `
    <div class="user-turn-block" :data-msg-id="message.id || ''">
      <div class="user-turn-block-main">
        <MessageItem :message="message" />
      </div>
    </div>
  `,
};
