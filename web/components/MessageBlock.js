import MessageItem from './MessageItem.js';
import AssistantTurn from './AssistantTurn.js';
import VpTurnBlock from './VpTurnBlock.js';
import SubAgentCard from './SubAgentCard.js';
import UserTurnBlock from './UserTurnBlock.js';

// Shared by the virtual history and each pending user-turn column.
export default {
  name: 'MessageBlock',
  components: { MessageItem, AssistantTurn, VpTurnBlock, SubAgentCard, UserTurnBlock },
  props: { block: Object, context: Object },
  emits: ['quote-message', 'edit-message-as-new', 'fork-from-turn'],
  template: `
          <section
            v-if="block.type === 'message-block'"
            class="message-block"
            :data-vp-id="block.vpId || ''"
            :data-message-id="block.messageId || ''"
          >
            <template v-for="item in context.visibleItemsForBlock(block)" :key="item.id">
              <!-- The rendered row id is stable even when one assistant row
                   aggregates several persisted messages. Search navigation maps
                   persisted ids to this row before scrolling or flashing. -->
              <div class="msg-row" :data-msg-id="item.id" :class="{ 'msg-flash': item.id === context.flashMsgId }">
                <!-- User message in Yeaft group view: render IM-style on the
                     right side via UserTurnBlock (mirror of VpTurnBlock).
                     Outside of group view (legacy 1:1 chat) keep the original
                     MessageItem path so chat-mode is untouched. -->
                <UserTurnBlock
                  v-if="item.type === 'user' && context.useImStyleForUser"
                  :message="item.message"
                  :hide-speaker-identity="context.hideSpeakerIdentity"
                  @quote="$emit('quote-message', $event)"
                  @edit-as-new="$emit('edit-message-as-new', $event)"
                />
                <!-- User / system / error messages: rendered by MessageItem -->
                <MessageItem v-else-if="item.type === 'user' || item.type === 'system' || item.type === 'error'" :message="item.message" />

                <!-- Assistant turn — VP-block redesign (2026-05-08).
                     - Yeaft multi-VP turns (speakerVpId set) -> VpTurnBlock,
                       which renders the VP header plus the full AssistantTurn
                       body. VirtualTranscript handles delayed mounting for
                       off-screen blocks; messages themselves are not collapsed.
                     - Legacy 1:1 Chat turns (no VP attribution) -> plain
                       AssistantTurn unchanged. -->
                <VpTurnBlock
                  v-else-if="item.type === 'assistant-turn' && item.speakerVpId"
                  :turn="item"
                  :hide-speaker-identity="context.hideSpeakerIdentity"
                  :show-fork-action="context.forkFromTurnEnabled && !!item.forkBoundaryTurnId && !item.isStreaming && !item.isActive"
                  :fork-action-disabled="context.forkFromTurnDisabled"
                  :fork-action-title="context.forkFromTurnTitle"
                  @fork-from-turn="$emit('fork-from-turn', item)"
                  :now-ms="context.nowMs"
                  :response-collapsible="context.responseToggleBelongsToItem(block, item)"
                  :response-collapsed="block.responseCollapsed"
                  :response-toggle-label="context.responseCollapseLabel(block)"
                  :origin-message-id="block.originMessageId"
                  @quote="$emit('quote-message', $event)"
                  @toggle-response-collapse="context.toggleMessageTurnResponse(block)"
                  @open-debug="context.onOpenTurnDebug(item)"
                />
                <AssistantTurn
                  v-else-if="item.type === 'assistant-turn'"
                  :turn="item"
                  :hide-speaker-identity="context.hideSpeakerIdentity"
                  :show-fork-action="context.forkFromTurnEnabled && !!item.forkBoundaryTurnId && !item.isStreaming && !item.isActive"
                  :fork-action-disabled="context.forkFromTurnDisabled"
                  :fork-action-title="context.forkFromTurnTitle"
                  @fork-from-turn="$emit('fork-from-turn', item)"
                  :actions-expanded="context.assistantTurnActionsExpandedFor(item)"
                  :tool-expand-states="context.toolExpandStates"
                  :tool-state-prefix="context.turnUiKey(item)"
                  :session-actions="context.useImStyleForUser"
                  :response-collapsible="context.responseToggleBelongsToItem(block, item)"
                  :response-collapsed="block.responseCollapsed"
                  :response-toggle-label="context.responseCollapseLabel(block)"
                  :origin-message-id="block.originMessageId"
                  @update-actions-expanded="value => context.setAssistantTurnActionsExpanded(item, value)"
                  @update-tool-expanded="context.setToolExpanded"
                  @quote="$emit('quote-message', $event)"
                  @toggle-response-collapse="context.toggleMessageTurnResponse(block)"
                />
              </div>
        <!-- feat-6af5f9f1 PR A: ReflectionCard mounts removed from the
                   main message stream. Reflection is an engine-internal context
                   compaction step - surfacing it inline during normal chat is
                   noise. Cards remain in store.yeaftReflectionCards so the
                   debug panel (PR B) can render them under the loop they
                   summarize. The component is still imported because PR B
                   will reuse it inside YeaftDebugPanel. -->
              <!-- PR-M3: sub-agent cards anchored to this row. -->
              <SubAgentCard
                v-for="card in context.subAgentCardsForRow(item)"
                :key="card.key"
                :card="card"
              />
            </template>
            <div v-if="context.showBlockResponseToggle(block)" class="message-block-collapsed-response">
              <div class="message-block-collapsed-preview">
                <div class="vp-turn-block-main-header message-block-collapsed-preview-header">
                  <span
                    v-if="!context.hideSpeakerIdentity"
                    class="vp-turn-block-name message-block-collapsed-preview-speaker"
                    :style="context.collapsedResponsePreviewSpeaker(block).style"
                  >{{ context.collapsedResponsePreviewSpeaker(block).name }}</span>
                  <template v-if="context.collapsedResponsePreviewSpeaker(block).timeText">
                    <span v-if="!context.hideSpeakerIdentity" class="vp-turn-block-sep" aria-hidden="true">·</span>
                    <span
                      class="vp-turn-block-time"
                      :title="context.collapsedResponsePreviewSpeaker(block).fullTimeText"
                    >{{ context.collapsedResponsePreviewSpeaker(block).timeText }}</span>
                  </template>
                  <span class="vp-turn-block-spacer"></span>
                  <button
                    type="button"
                    class="response-collapse-btn message-block-collapse-header-btn"
                    :class="{ 'is-collapsed': block.responseCollapsed }"
                    @click="context.toggleMessageTurnResponse(block)"
                    :title="context.responseCollapseLabel(block)"
                    :aria-label="context.responseCollapseLabel(block)"
                    :aria-expanded="String(!block.responseCollapsed)"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                      <path v-if="block.responseCollapsed" fill="currentColor" d="M7 10l5 5 5-5z"/>
                      <path v-else fill="currentColor" d="M7 14l5-5 5 5z"/>
                    </svg>
                    <span class="response-collapse-label">{{ context.responseCollapseLabel(block) }}</span>
                  </button>
                </div>
                <button
                  type="button"
                  class="message-block-collapsed-preview-body markdown-body"
                  @click="context.toggleMessageTurnResponse(block)"
                  :title="context.responseCollapseLabel(block)"
                  :aria-label="context.responseCollapseLabel(block)"
                >
                  <span
                    v-for="(line, index) in context.collapsedResponsePreviewLines(block)"
                    :key="index"
                    class="message-block-collapsed-preview-line"
                  >{{ line }}</span>
                </button>
              </div>
            </div>
          </section>
          <template v-else>
            <div class="msg-row" :data-msg-id="block.id" :class="{ 'msg-flash': block.id === context.flashMsgId }">
              <UserTurnBlock
                v-if="block.type === 'user' && context.useImStyleForUser"
                :message="block.message"
                :hide-speaker-identity="context.hideSpeakerIdentity"
                @quote="$emit('quote-message', $event)"
                @edit-as-new="$emit('edit-message-as-new', $event)"
              />
              <MessageItem v-else-if="block.type === 'user' || block.type === 'system' || block.type === 'error'" :message="block.message" />
              <VpTurnBlock
                v-else-if="block.type === 'assistant-turn' && block.speakerVpId"
                :turn="block"
                :hide-speaker-identity="context.hideSpeakerIdentity"
                :show-fork-action="context.forkFromTurnEnabled && !!block.forkBoundaryTurnId && !block.isStreaming && !block.isActive"
                :fork-action-disabled="context.forkFromTurnDisabled"
                :fork-action-title="context.forkFromTurnTitle"
                @fork-from-turn="$emit('fork-from-turn', block)"
                :now-ms="context.nowMs"
                @quote="$emit('quote-message', $event)"
                @open-debug="context.onOpenTurnDebug(block)"
              />
              <AssistantTurn
                v-else-if="block.type === 'assistant-turn'"
                :turn="block"
                :hide-speaker-identity="context.hideSpeakerIdentity"
                :show-fork-action="context.forkFromTurnEnabled && !!block.forkBoundaryTurnId && !block.isStreaming && !block.isActive"
                :fork-action-disabled="context.forkFromTurnDisabled"
                :fork-action-title="context.forkFromTurnTitle"
                @fork-from-turn="$emit('fork-from-turn', block)"
                :actions-expanded="context.assistantTurnActionsExpandedFor(block)"
                :tool-expand-states="context.toolExpandStates"
                :tool-state-prefix="context.turnUiKey(block)"
                :session-actions="context.useImStyleForUser"
                @update-actions-expanded="value => context.setAssistantTurnActionsExpanded(block, value)"
                @update-tool-expanded="context.setToolExpanded"
                @quote="$emit('quote-message', $event)"
              />
            </div>
            <SubAgentCard
              v-for="card in context.subAgentCardsForRow(block)"
              :key="card.key"
              :card="card"
            />
          </template>
  `,
};
