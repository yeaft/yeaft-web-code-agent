/**
 * CrewChatView - Crew 群聊视图（入口组件）
 *
 * 拆分为子组件和模块：
 *   crew/CrewTurnRenderer.js    — turn 渲染子组件（消除 3x 重复模板）
 *   crew/CrewRolePanel.js       — 左侧角色面板子组件
 *   crew/CrewFeaturePanel.js    — 右侧 Feature 看板子组件
 *   crew/crewInput.js           — 输入处理 composable
 *   crew/crewScroll.js          — 滚动管理 composable
 *   crew/crewHelpers.js         — 工具函数（样式、格式化、图标）
 *   crew/crewMessageGrouping.js — 消息分组逻辑（turns、segments、blocks）
 *   crew/crewKanban.js          — Kanban/TODO 计算逻辑
 *   crew/crewRolePresets.js     — 预设角色数据
 */
import { clearMarkdownCache } from '../utils/markdown.js';
import {
  ICONS, formatTokens, PRESET_ROLES
} from './crew/crewHelpers.js';
import {
  appendToSegments, rebuildBlocksFromSegments,
  createFbCache, fullBuildFeatureBlocks,
  shouldShowTurnDivider, getMaxRound, getBlockTurns
} from './crew/crewMessageGrouping.js';
import {
  parseCrewTasks, computeCompletedTaskIds, collectActiveTasks,
  buildTodosByFeature, buildFeatureKanban, groupKanban, kanbanProgress
} from './crew/crewKanban.js';
import { rolePresets } from './crew/crewRolePresets.js';
import { createCrewInput } from './crew/crewInput.js';
import { createCrewScroll } from './crew/crewScroll.js';
import CrewTurnRenderer from './crew/CrewTurnRenderer.js';
import CrewRolePanel from './crew/CrewRolePanel.js';
import CrewFeaturePanel from './crew/CrewFeaturePanel.js';

import CrewNotifications from './crew/CrewNotifications.js';

export default {
  name: 'CrewChatView',
  components: { CrewTurnRenderer, CrewRolePanel, CrewFeaturePanel, CrewNotifications },
  props: {
    conversationId: { type: String, default: null },
    paneId: { type: String, default: null }
  },
  template: `
    <div class="crew-chat-view">
      <div class="crew-workspace" :class="{ 'hide-roles': !effectivePanelVisible.roles, 'hide-features': !effectivePanelVisible.features, 'feature-expanded': !!expandedFeatureTaskId, 'mobile-panel-roles': effectiveMobilePanel === 'roles', 'mobile-panel-features': effectiveMobilePanel === 'features' }">
        <div class="crew-mobile-overlay" v-if="effectiveMobilePanel" @click="clearMobilePanel"></div>

        <!-- Left Panel: Role Cards -->
        <crew-role-panel
          :store="store"
          :session-roles="sessionRoles"
          :role-color-map="roleColorMap"
          :crew-status="paneCrewStatus"
          :crew-messages="paneCrewMessages"
          @scroll-to-role="scrollToRoleLatest"
          @control-action="controlAction"
          @clear-role="clearRole"
          @abort-role="abortRole"
          @show-add-role="showAddRole = true"
        />

        <!-- Center Panel: Chat Flow -->
        <div class="crew-panel-center">

      <!-- Messages -->
      <div class="crew-messages" ref="messagesRef" @scroll="scroll.onScroll()">
        <div v-if="paneCrewMessages.length === 0" class="crew-empty">
          <div class="crew-empty-icon" v-html="icons.crew.replace(/16/g, '48')"></div>
          <div class="crew-empty-text" v-if="paneCrewSession">{{ $t('crew.emptyWaiting') }}</div>
          <div class="crew-empty-text" v-else>{{ $t('crew.emptyWaitingSession') }}</div>
        </div>

        <div v-if="scroll.isLoadingHistory.value" class="crew-load-more crew-load-more-loading">
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
          {{ $t('crew.loadingHistory') }}
        </div>
        <div v-else-if="scroll.hiddenBlockCount.value > 0" class="crew-load-more" @click="scroll.loadMoreBlocks()">
          {{ $t('crew.loadOlder') }} <span class="crew-load-more-count">({{ scroll.hiddenBlockCount.value }})</span>
        </div>
        <div v-else-if="scroll.hasOlderMessages.value" class="crew-load-more" @click="loadHistory">
          {{ $t('crew.loadHistory') }}
        </div>

        <template v-for="(block, bidx) in scroll.visibleBlocks.value" :key="block.id">
          <!-- Only render global blocks (PM/human messages); feature content is in the right panel -->
          <template v-if="block.type === 'global'">
            <template v-for="(turn, tidx) in block.turns" :key="turn.id">
              <div v-if="tidx > 0 && shouldShowTurnDivider(block.turns, tidx)" class="crew-turn-divider"></div>
              <div v-if="turn.type === 'turn' && getMaxRound(turn) > 0" class="crew-round-divider">
                <div class="crew-round-line"></div>
                <span class="crew-round-label">Round {{ getMaxRound(turn) }}</span>
                <div class="crew-round-line"></div>
              </div>
              <crew-turn-renderer
                :turn="turn"
                :show-human-bubble="true"
                :expanded-turns="expandedTurns"
                :icons="icons"
                :role-color-map="roleColorMap"
                :get-role-display-name="getRoleDisplayName"
                @toggle-turn="toggleTurn"
                @ask-submit="onAskSubmit"
              />
            </template>
          </template>
        </template>

        <!-- Typing dots: visible after user sends message, before AI responds -->
        <div v-if="previewIsWaitingResponse" class="typing-indicator" :class="waitingStatus ? ('status-' + waitingStatus) : ''">
          <span></span><span></span><span></span>
          <template v-if="animationType === 'cat'">
          <span class="svg-cat-walk" :style="catStyle">
          <span class="svg-running-cat" :class="catSpeed" aria-hidden="true">
            <svg viewBox="0 0 36 28" xmlns="http://www.w3.org/2000/svg">
              <g class="svg-cat-silhouette">
                <g class="svg-cat-tail-group">
                  <path class="svg-cat-tail" d="M7.5 17 Q3 12 4 6 Q4.5 3 6 5" stroke-width="2"/>
                </g>
                <g class="svg-cat-leg-bl"><path class="svg-cat-leg" d="M10 20 L8 25 Q8 26.5 9.5 26.5 L10.5 26.5" stroke-width="0"/></g>
                <g class="svg-cat-leg-br"><path class="svg-cat-leg" d="M8 20 L6 25 Q6 26.5 7.5 26.5 L8.5 26.5" stroke-width="0"/></g>
                <ellipse class="svg-cat-body" cx="15" cy="17" rx="7.5" ry="5"/>
                <g class="svg-cat-leg-fl"><path class="svg-cat-leg" d="M21 20 L23 25 Q23 26.5 21.5 26.5 L20.5 26.5" stroke-width="0"/></g>
                <g class="svg-cat-leg-fr"><path class="svg-cat-leg" d="M19 20 L21 25 Q21 26.5 19.5 26.5 L18.5 26.5" stroke-width="0"/></g>
                <g class="svg-cat-head-group">
                  <circle class="svg-cat-head" cx="24" cy="9" r="7"/>
                  <g class="svg-cat-ear-l"><polygon class="svg-cat-ear" points="18,7 20,-1 23,6"/></g>
                  <g class="svg-cat-ear-r"><polygon class="svg-cat-ear" points="25,6 28,-1 30,7"/></g>
                  <polygon class="svg-cat-inner-ear" points="19,6.5 20.5,0.5 22,5.5"/>
                  <polygon class="svg-cat-inner-ear" points="26,5.5 27.5,0.5 29,6.5"/>
                  <ellipse class="svg-cat-eye" cx="21.5" cy="8.5" rx="2" ry="2.2"/>
                  <ellipse class="svg-cat-eye" cx="27" cy="8.5" rx="2" ry="2.2"/>
                  <ellipse class="svg-cat-pupil" cx="22" cy="8.8" rx="1.1" ry="1.3"/>
                  <ellipse class="svg-cat-pupil" cx="27.5" cy="8.8" rx="1.1" ry="1.3"/>
                  <circle class="svg-cat-eye-shine" cx="21.2" cy="7.8" r="0.6"/>
                  <circle class="svg-cat-eye-shine" cx="26.7" cy="7.8" r="0.6"/>
                  <!-- Closed happy eyes — curved ∪ lines, only visible in petted mode -->
                  <path class="svg-cat-closed-eye" d="M19.8 8.5 Q21.5 10.5 23.2 8.5" stroke-width="0.8" fill="none"/>
                  <path class="svg-cat-closed-eye" d="M25.3 8.5 Q27 10.5 28.7 8.5" stroke-width="0.8" fill="none"/>
                  <path class="svg-cat-nose" d="M23.5 11.5 L24.2 12.2 L25 11.5 Z"/>
                  <path class="svg-cat-mouth" d="M23 12.5 Q24.2 13.8 24.2 12.5" stroke-width="0.7"/>
                  <path class="svg-cat-mouth" d="M24.3 12.5 Q24.3 13.8 25.5 12.5" stroke-width="0.7"/>
                  <line class="svg-cat-whisker" x1="19.5" y1="11" x2="14" y2="10" stroke-width="0.5"/>
                  <line class="svg-cat-whisker" x1="19.5" y1="12" x2="14" y2="12.5" stroke-width="0.5"/>
                  <line class="svg-cat-whisker" x1="29" y1="11" x2="34" y2="10" stroke-width="0.5"/>
                  <line class="svg-cat-whisker" x1="29" y1="12" x2="34" y2="12.5" stroke-width="0.5"/>
                  <!-- Breath puffs — only visible in tired mode -->
                  <circle class="svg-cat-breath svg-cat-breath-1" cx="27" cy="14" r="0.8"/>
                  <circle class="svg-cat-breath svg-cat-breath-2" cx="28" cy="13.5" r="0.6"/>
                  <circle class="svg-cat-breath svg-cat-breath-3" cx="29" cy="14.5" r="0.5"/>
                </g>
              </g>
              <ellipse class="svg-cat-leg-blur" cx="12.5" cy="22" rx="1.8" ry="1.2"/>
              <ellipse class="svg-cat-leg-blur" cx="17.5" cy="22" rx="1.8" ry="1.2"/>
              <ellipse class="svg-cat-leg-blur svg-cat-leg-blur-inner" cx="14" cy="22" rx="1.5" ry="1"/>
              <ellipse class="svg-cat-leg-blur svg-cat-leg-blur-inner" cx="16" cy="22" rx="1.5" ry="1"/>
              <!-- Petting hand — only visible in speed-petted mode -->
              <g class="svg-cat-petting-hand">
                <line class="svg-cat-hand-arm" x1="24" y1="-3" x2="24" y2="0" stroke-width="2.5" stroke-linecap="round"/>
                <ellipse class="svg-cat-hand-palm" cx="24" cy="1.5" rx="3.5" ry="2"/>
                <ellipse class="svg-cat-finger" cx="21.5" cy="3.2" rx="0.9" ry="1.2"/>
                <ellipse class="svg-cat-finger" cx="24" cy="3.5" rx="0.9" ry="1.3"/>
                <ellipse class="svg-cat-finger" cx="26.5" cy="3.2" rx="0.9" ry="1.2"/>
              </g>
              <!-- Napping bed — soft oval cushion, only visible in napping mode -->
              <ellipse class="svg-cat-bed" cx="15" cy="24" rx="12" ry="3"/>
              <!-- Drool — tiny droplet near mouth, only visible in napping mode -->
              <circle class="svg-cat-drool" cx="26.5" cy="14" r="0.6"/>
            </svg>
          </span>
          </span>
          </template>
          <template v-else>
          <span class="svg-dog-scene" :class="'dog-phase-' + dogPhase" aria-hidden="true">
            <svg viewBox="0 0 120 28" xmlns="http://www.w3.org/2000/svg">
              <!-- Left post -->
              <rect class="svg-dog-post" x="1" y="18" width="2" height="8" rx="0.5"/>
              <!-- Left leash (Spike) -->
              <path class="svg-dog-leash svg-dog-leash-l" :d="leashPathL" stroke-width="0.8" :style="{ opacity: leashOpacityL }"/>
              <!-- Left snap FX near left post -->
              <g class="svg-dog-snap-fx" :style="{ transformOrigin: '3px 20px' }">
                <line class="svg-dog-snap-line" x1="0" y1="16" x2="6" y2="24"/>
                <line class="svg-dog-snap-line" x1="6" y1="16" x2="0" y2="24"/>
              </g>
              <!-- Spike (left, big dog) — dynamic transform -->
              <g :transform="spikeTransform">
                <g class="svg-dog-silhouette">
                  <g class="svg-dog-tail-group" style="transform-origin: -1px 13px"><path class="svg-dog-tail" d="M-1 13 Q-3 9 -1 6" stroke-width="2.2"/></g>
                  <g class="svg-dog-leg-bl" style="transform-origin: 2px 18px"><path class="svg-dog-leg" d="M2 18 L1 24 Q1 25.5 2.5 25.5" stroke-width="0"/></g>
                  <g class="svg-dog-leg-br" style="transform-origin: 4px 18px"><path class="svg-dog-leg" d="M4 18 L3 24 Q3 25.5 4.5 25.5" stroke-width="0"/></g>
                  <ellipse class="svg-dog-body" cx="8" cy="14" rx="7" ry="5"/>
                  <g class="svg-dog-leg-fl" style="transform-origin: 13px 18px"><path class="svg-dog-leg" d="M13 18 L14 24 Q14 25.5 12.5 25.5" stroke-width="0"/></g>
                  <g class="svg-dog-leg-fr" style="transform-origin: 11px 18px"><path class="svg-dog-leg" d="M11 18 L12 24 Q12 25.5 10.5 25.5" stroke-width="0"/></g>
                  <rect class="svg-dog-collar" x="12" y="9.5" width="3.5" height="2" rx="0.5"/>
                  <polygon class="svg-dog-spike-stud" points="13,9.5 13.4,8.5 13.8,9.5"/>
                  <polygon class="svg-dog-spike-stud" points="14.5,9.5 14.9,8.5 15.3,9.5"/>
                  <g class="svg-dog-head-group">
                    <circle class="svg-dog-head" cx="16" cy="7" r="5.5"/>
                    <polygon class="svg-dog-ear svg-dog-ear-l" points="11.5,5 13,-2 15,4"/>
                    <polygon class="svg-dog-ear svg-dog-ear-r" points="17,4 19,-2 20.5,5"/>
                    <ellipse class="svg-dog-jaw" cx="17" cy="11.5" rx="3" ry="1.8"/>
                    <ellipse class="svg-dog-eye" cx="14" cy="6.5" rx="1.5" ry="1.6"/>
                    <ellipse class="svg-dog-eye" cx="18.5" cy="6.5" rx="1.5" ry="1.6"/>
                    <ellipse class="svg-dog-pupil" cx="14.5" cy="6.8" rx="0.7" ry="0.9"/>
                    <ellipse class="svg-dog-pupil" cx="19" cy="6.8" rx="0.7" ry="0.9"/>
                    <circle class="svg-dog-eye-shine" cx="13.8" cy="6" r="0.4"/>
                    <circle class="svg-dog-eye-shine" cx="18.3" cy="6" r="0.4"/>
                    <ellipse class="svg-dog-nose" cx="17" cy="9.5" rx="1.5" ry="1"/>
                    <path class="svg-dog-mouth" d="M15 10.5 Q17 11.5 19 10.5" stroke-width="0.6"/>
                    <ellipse class="svg-dog-bark-mouth" cx="17" cy="12" rx="2.5" ry="1.5"/>
                    <ellipse class="svg-dog-tongue" cx="17" cy="13" rx="1" ry="0.7"/>
                  </g>
                </g>
              </g>
              <!-- Right post -->
              <rect class="svg-dog-post" x="117" y="18" width="2" height="8" rx="0.5"/>
              <!-- Right leash (Teddy) -->
              <path class="svg-dog-leash svg-dog-leash-r" :d="leashPathR" stroke-width="0.8" :style="{ opacity: leashOpacityR }"/>
              <!-- Right snap FX near right post -->
              <g class="svg-dog-snap-fx" :style="{ transformOrigin: '118px 20px' }">
                <line class="svg-dog-snap-line" x1="115" y1="16" x2="121" y2="24"/>
                <line class="svg-dog-snap-line" x1="121" y1="16" x2="115" y2="24"/>
              </g>
              <!-- Teddy (right, small dog) — dynamic transform -->
              <g :transform="teddyTransform">
                <g class="svg-dog-silhouette">
                  <g class="svg-dog-tail-group" style="transform-origin: -1px 11px"><path class="svg-dog-tail" d="M-1 11 Q-3 7 -1 5 Q1 3 0 6" stroke-width="1.5"/></g>
                  <g class="svg-dog-leg-bl" style="transform-origin: 2px 14px"><path class="svg-dog-leg" d="M2 14 L1.5 22 Q1.5 23.5 3 23.5" stroke-width="0"/></g>
                  <g class="svg-dog-leg-br" style="transform-origin: 3.5px 14px"><path class="svg-dog-leg" d="M3.5 14 L3 22 Q3 23.5 4.5 23.5" stroke-width="0"/></g>
                  <ellipse class="svg-dog-body" cx="6" cy="12" rx="5" ry="3.5"/>
                  <g class="svg-dog-leg-fl" style="transform-origin: 10px 14px"><path class="svg-dog-leg" d="M10 14 L10.5 22 Q10.5 23.5 9 23.5" stroke-width="0"/></g>
                  <g class="svg-dog-leg-fr" style="transform-origin: 8.5px 14px"><path class="svg-dog-leg" d="M8.5 14 L9 22 Q9 23.5 7.5 23.5" stroke-width="0"/></g>
                  <rect class="svg-dog-collar" x="9.5" y="7.5" width="2.5" height="1.5" rx="0.5"/>
                  <g class="svg-dog-head-group">
                    <circle class="svg-dog-head" cx="12.5" cy="5.5" r="5"/>
                    <circle class="svg-dog-fluff" cx="12.5" cy="4.5" r="5.5"/>
                    <ellipse class="svg-dog-ear svg-dog-ear-l" cx="8.5" cy="6.5" rx="2" ry="3"/>
                    <ellipse class="svg-dog-ear svg-dog-ear-r" cx="16.5" cy="6.5" rx="2" ry="3"/>
                    <ellipse class="svg-dog-eye" cx="10.5" cy="5" rx="1.8" ry="2"/>
                    <ellipse class="svg-dog-eye" cx="15" cy="5" rx="1.8" ry="2"/>
                    <ellipse class="svg-dog-pupil" cx="11" cy="5.3" rx="0.9" ry="1.1"/>
                    <ellipse class="svg-dog-pupil" cx="15.5" cy="5.3" rx="0.9" ry="1.1"/>
                    <circle class="svg-dog-eye-shine" cx="10.3" cy="4.5" r="0.5"/>
                    <circle class="svg-dog-eye-shine" cx="14.8" cy="4.5" r="0.5"/>
                    <ellipse class="svg-dog-nose" cx="12.8" cy="7.5" rx="1" ry="0.7"/>
                    <path class="svg-dog-mouth" d="M11.5 8.3 Q12.8 9 14 8.3" stroke-width="0.5"/>
                    <ellipse class="svg-dog-bark-mouth" cx="12.8" cy="9.5" rx="2" ry="1.2"/>
                    <ellipse class="svg-dog-tongue" cx="12.8" cy="10.3" rx="0.8" ry="0.5"/>
                  </g>
                </g>
              </g>
              <!-- Question marks (stunned phase) -->
              <text class="svg-dog-question svg-dog-question-l" :x="questionLX" y="4" font-size="6">?</text>
              <text class="svg-dog-question svg-dog-question-r" :x="questionRX" y="4" font-size="6">?</text>
            </svg>
          </span>
          </template>
          <span v-if="waitingStatus === 'disconnected'" class="typing-status-text typing-status-error">
            {{ $t('chat.waiting.disconnected') }}
          </span>
          <span v-else-if="waitingStatus === 'compacting'" class="typing-status-text typing-status-compact">
            {{ $t('chat.waiting.compacting') }}
          </span>
          <span v-else-if="waitingStatus === 'agent-offline'" class="typing-status-text typing-status-error">
            {{ $t('chat.waiting.agentOffline') }}
            <button class="typing-refresh-btn" @click="refreshCrewSession">{{ $t('chat.waiting.refresh') }}</button>
          </span>
          <span v-else-if="waitingStatus === 'session-lost'" class="typing-status-text typing-status-warn">
            {{ $t('chat.waiting.sessionLost') }}
          </span>
          <span v-else-if="waitingStatus === 'cli-exited'" class="typing-status-text typing-status-warn">
            {{ $t('chat.waiting.cliExited') }}
          </span>
        </div>

        <div class="crew-scroll-bottom"
             :class="{ 'is-hidden': scroll.isAtBottom.value }"
             @click="scroll.scrollToBottomAndReset()">
          {{ $t('crew.scrollToLatest') }}
        </div>

        <div v-if="isInitializing" class="crew-init-progress">
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
          <span class="crew-typing-dot"></span>
          <span class="crew-init-text">{{ initProgressText }}</span>
        </div>
      </div>

      <!-- Input -->
      <div class="input-area crew-input-area">
        <div class="crew-input-hints" v-if="paneCrewSession && paneCrewStatus">
          <span class="crew-hint-meta">R{{ paneCrewStatus.round || 0 }}</span>
          <span class="crew-hint-sep">&middot;</span>
          <span class="crew-hint-meta">\${{ (paneCrewStatus.costUsd || 0).toFixed(2) }}</span>
          <template v-if="totalTokens > 0">
            <span class="crew-hint-sep">&middot;</span>
            <span class="crew-hint-meta">{{ formatTokens(totalTokens) }}</span>
          </template>
        </div>
        <div v-if="currentPendingAsk" class="crew-ask-hint" @click="scrollToAskCard">
          <span class="crew-ask-hint-icon">{{ currentPendingAsk.roleIcon }}</span>
          <span class="crew-ask-hint-text">{{ currentPendingAsk.roleName }} {{ $t('crew.askingYou') }}</span>
          <span class="crew-ask-hint-dismiss" :title="$t('crew.dismissAsk')" @click.stop="dismissPendingAsk">✕</span>
        </div>
        <div class="attachments-preview" v-if="input.attachments.value.length > 0">
          <div class="attachment-item" v-for="(file, index) in input.attachments.value" :key="index">
            <img v-if="file.preview" :src="file.preview" class="attachment-thumb" />
            <span v-else class="attachment-icon">\u{1F4CE}</span>
            <span class="attachment-name">{{ file.name }}</span>
            <button class="attachment-remove" @click="input.removeAttachment(index)">&times;</button>
          </div>
        </div>
        <div class="input-wrapper">
          <input
            type="file"
            ref="fileInput"
            id="crew-file-input"
            @change="input.handleFileSelect($event)"
            multiple
            accept="image/*,text/*,.pdf,.doc,.docx,.xls,.xlsx,.json,.md,.py,.js,.ts,.css,.html"
            class="file-input-hidden"
          />
          <label class="attach-btn" for="crew-file-input" :title="$t('crew.uploadFile')">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/>
            </svg>
          </label>
          <div class="textarea-wrapper">
            <div class="slash-autocomplete" v-if="input.slashMenuVisible.value && input.slashFlatItems.value.length > 0">
              <template v-for="group in input.slashGroupedCommands.value" :key="group.label">
                <div class="slash-group-label">{{ group.label }}</div>
                <div
                  v-for="item in group.items"
                  :key="item.cmd"
                  class="slash-autocomplete-item"
                  :class="{ active: item.flatIndex === input.slashMenuIndex.value }"
                  @mousedown.prevent="input.selectSlashCommand(item.cmd)"
                  @mouseenter="input.slashMenuIndex.value = item.flatIndex"
                >
                  <span class="slash-cmd-name">{{ item.cmd }}</span>
                  <span class="slash-cmd-desc">{{ item.desc }}</span>
                </div>
                <div v-if="!group.isLast" class="slash-group-separator"></div>
              </template>
            </div>
            <textarea
              ref="inputRef"
              v-model="input.inputText.value"
              @input="input.handleInput()"
              @keydown="input.handleKeydown($event, () => sendMessage())"
              @paste="input.handlePaste($event)"
              @blur="input.onBlur()"
              :placeholder="$t('crew.inputPlaceholder')"
              rows="1"
            ></textarea>
            <div class="crew-at-menu" v-if="input.atMenuVisible.value && input.filteredAtRoles.value.length > 0">
              <div v-for="(role, idx) in input.filteredAtRoles.value" :key="role.name"
                class="crew-at-menu-item" :class="{ active: idx === input.atMenuIndex.value }"
                @mousedown.prevent="input.selectAtRole(role)">
                <span v-if="role.icon" class="crew-at-menu-icon">{{ role.icon }}</span>
                <span class="crew-at-menu-name">{{ role.displayName }}</span>
                <span class="crew-at-menu-desc">{{ role.description }}</span>
              </div>
            </div>
          </div>
          <button class="send-btn" @click="sendMessage" :disabled="!input.canSend.value" :title="$t('crew.send')">
            <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      </div>

        </div><!-- /crew-panel-center -->

        <!-- Right Panel: Feature Kanban -->
        <crew-feature-panel
          :store="store"
          :feature-kanban="featureKanban"
          :feature-kanban-grouped="featureKanbanGrouped"
          :kanban-progress-data="kanbanProgressData"
          :feature-blocks="featureBlocks"
          :get-block-turns="resolveBlockTurns"
          :expanded-turns="expandedTurns"
          :expanded-feature-task-id="expandedFeatureTaskId"
          :now-tick="nowTick"
          :icons="icons"
          :role-color-map="roleColorMap"
          :get-role-display-name="getRoleDisplayName"
          :persisted-feature-ids="persistedFeatureIds"
          :crew-messages="paneCrewMessages"
          @toggle-turn="toggleTurn"
          @expand-feature="expandFeature"
          @close-feature="closeFeature"
          @ask-submit="onAskSubmit"
        />
      </div><!-- /crew-workspace -->

      <!-- Route Notification Toasts -->
      <crew-notifications
        :notifications="store.crewNotifications"
        @dismiss="dismissNotification"
      />

      <!-- Add Role Modal -->
      <div v-if="showAddRole" class="crew-add-role-overlay" @click.self="showAddRole = false">
        <div class="crew-add-role-modal">
          <div class="crew-add-role-title">{{ $t('crew.addRoleTitle') }}</div>

          <div class="crew-add-role-presets">
            <button v-for="preset in availablePresets" :key="preset.name" class="crew-preset-btn" @click="quickAddPreset(preset)">
              <span v-if="preset.icon">{{ preset.icon }} </span>{{ preset.displayName }}
            </button>
          </div>

          <details class="crew-add-custom-details">
            <summary class="crew-add-custom-summary">{{ $t('crew.customRole') }}</summary>
            <div class="crew-add-role-form">
              <div class="crew-add-role-row">
                <input v-model="newRole.name" :placeholder="$t('crew.namePlaceholder')" class="crew-add-input" />
                <input v-model="newRole.displayName" :placeholder="$t('crew.displayNamePlaceholder')" class="crew-add-input" />
                <input v-model="newRole.icon" :placeholder="$t('crew.iconPlaceholder')" class="crew-add-input" style="width: 50px; flex: none;" />
              </div>
              <input v-model="newRole.description" :placeholder="$t('crew.descPlaceholder')" class="crew-add-input" />
              <textarea v-model="newRole.claudeMd" :placeholder="$t('crew.promptPlaceholder')" rows="2" class="crew-add-input"></textarea>
              <div class="crew-add-role-actions">
                <button class="crew-add-role-confirm" @click="confirmAddRole" :disabled="!newRole.name || !newRole.displayName">{{ $t('crew.add') }}</button>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  `,

  setup() {
    const store = Pinia.useChatStore();
    const authStore = Pinia.useAuthStore();
    return { store, authStore };
  },

  data() {
    return {
      icons: ICONS,
      showAddRole: false,
      expandedTurns: {},
      expandedFeatures: {},
      expandedHistories: {},
      expandedFeatureTaskId: null,
      nowTick: Date.now(),
      typingStartTime: 0,
      catPosition: 0,
      catDirection: 1,
      animationType: 'cat',
      dogPosL: 5,
      dogPosR: 95,
      dogPhase: 'bark-both',
      dogFlipL: 1,    // 1 = face right, -1 = face left
      dogFlipR: -1,   // -1 = face left, 1 = face right
      newRole: this.getEmptyRole(),
      rolePresets
    };
  },

  created() {
    this.input = createCrewInput(this.store, this.authStore, {
      getInputRef: () => this.$refs.inputRef,
      getFileInputRef: () => this.$refs.fileInput,
      getCurrentPendingAsk: () => this.currentPendingAsk,
      getConversationId: () => this.effectiveConvId
    });
    this.scroll = createCrewScroll(this.store, {
      getMessagesRef: () => this.$refs.messagesRef,
      getFeatureBlocks: () => this.featureBlocks,
      getConversationId: () => this.effectiveConvId
    });
  },

  computed: {
    effectivePanelVisible() {
      return this.store.getPanelVisible(this.paneId);
    },
    effectiveMobilePanel() {
      return this.store.getPaneMobilePanel(this.paneId);
    },
    effectiveConvId() {
      return this.conversationId || this.store.currentConversation;
    },
    // Per-pane crew data — reads from effectiveConvId instead of global currentConversation
    paneCrewSession() {
      const convId = this.effectiveConvId;
      if (!convId) return null;
      return this.store.crewSessions[convId] || null;
    },
    paneCrewStatus() {
      const convId = this.effectiveConvId;
      if (!convId) return null;
      return this.store.crewStatuses[convId] || null;
    },
    paneCrewMessages() {
      const convId = this.effectiveConvId;
      if (!convId) return [];
      return this.store.crewMessagesMap[convId] || [];
    },
    isWaitingResponse() {
      // Safety net: completed sessions should never show typing indicator
      if (this.paneCrewStatus?.status === 'completed') return false;
      const messages = this.paneCrewMessages;
      if (!messages || messages.length === 0) return false;
      const lastMsg = messages[messages.length - 1];
      return lastMsg.role === 'human' && !lastMsg._sendFailed;
    },
    waitingStatus() {
      if (!this.isWaitingResponse) return null;
      if (this.store.connectionState !== 'connected') return 'disconnected';
      const convId = this.effectiveConvId;
      if (this.store.compactStatus?.conversationId === convId && this.store.compactStatus?.status === 'compacting') return 'compacting';
      const health = this.store.sessionHealth?.[convId];
      if (health) return health.status;
      if (this.typingStartTime && this.nowTick - this.typingStartTime > 8000) return 'thinking';
      return null;
    },
    catSpeed() {
      if (!this.typingStartTime) return 'speed-napping';
      const elapsed = (this.nowTick - this.typingStartTime) % 19000;
      if (elapsed >= 16000) return 'speed-petted';
      if (elapsed >= 14000) return 'speed-tired';
      if (elapsed >= 11500) return 'speed-crazy';
      if (elapsed >= 9000) return 'speed-turbo';
      if (elapsed >= 6500) return 'speed-fast';
      if (elapsed >= 4000) return 'speed-normal';
      return 'speed-napping';
    },
    catStyle() {
      const pos = this.catPosition;
      const dir = this.catDirection;
      const frac = pos / 100;
      const style = { left: `calc(40px + (100% - 80px) * ${frac})` };
      if (dir < 0) style.transform = 'scaleX(-1)';
      return style;
    },
    spikeTransform() {
      const collarSvgX = this.dogPosL * 1.2;
      if (this.dogFlipL < 0) {
        return `translate(${collarSvgX + 13.5}, 0) scale(-1, 1)`;
      }
      return `translate(${collarSvgX - 13.5}, 0)`;
    },
    teddyTransform() {
      const collarSvgX = this.dogPosR * 1.2;
      if (this.dogFlipR > 0) {
        return `translate(${collarSvgX - 10.5}, 2)`;
      }
      return `translate(${collarSvgX + 10.5}, 2) scale(-1, 1)`;
    },
    leashConnected() {
      const p = this.dogPhase;
      return p === 'bark-both' || p === 'left-approach' || p === 'right-approach' || p === 'both-approach' || p === 'reset';
    },
    leashPathL() {
      const collarSvgX = this.dogPosL * 1.2;
      const collarY = 10;
      if (this.leashConnected) {
        const sag = Math.max(0, (collarSvgX - 3) * 0.12);
        return `M3,18 Q${(3 + collarSvgX) / 2},${18 + sag} ${collarSvgX},${collarY}`;
      }
      if (this.dogPhase === 'rehang') {
        return `M${collarSvgX},${collarY} Q${collarSvgX - 3},20 3,18`;
      }
      const dragDir = this.dogFlipL < 0 ? 1 : -1;
      const dragX = collarSvgX + dragDir * 8;
      return `M${collarSvgX},${collarY} Q${collarSvgX},18 ${dragX},22`;
    },
    leashPathR() {
      const collarSvgX = this.dogPosR * 1.2;
      const collarY = 10;
      if (this.leashConnected) {
        const sag = Math.max(0, (118 - collarSvgX) * 0.12);
        return `M118,18 Q${(118 + collarSvgX) / 2},${18 + sag} ${collarSvgX},${collarY}`;
      }
      if (this.dogPhase === 'rehang') {
        return `M${collarSvgX},${collarY} Q${collarSvgX + 3},20 118,18`;
      }
      const dragDir = this.dogFlipR > 0 ? -1 : 1;
      const dragX = collarSvgX + dragDir * 8;
      return `M${collarSvgX},${collarY} Q${collarSvgX},18 ${dragX},22`;
    },
    leashOpacityL() {
      return this.dogPhase === 'snap' ? 0.2 : 0.4;
    },
    leashOpacityR() {
      return this.dogPhase === 'snap' ? 0.2 : 0.4;
    },
    questionLX() { return this.dogPosL * 1.2; },
    questionRX() { return this.dogPosR * 1.2; },
    previewIsWaitingResponse() {
      const urlPreview = new URLSearchParams(window.location.search).get('preview');
      if (urlPreview === 'cat' || urlPreview === 'dog' || urlPreview === 'animation') return true;
      return this.isWaitingResponse;
    },
    isInitializing() {
      return this.paneCrewStatus?.status === 'initializing';
    },
    initProgressText() {
      const p = this.paneCrewStatus?.initProgress;
      if (p === 'roles') return this.$t('crew.initRoles');
      if (p === 'worktrees') return this.$t('crew.initWorktrees');
      return this.$t('crew.initPreparing');
    },
    totalTokens() {
      const s = this.paneCrewStatus;
      if (!s) return 0;
      return (s.totalInputTokens || 0) + (s.totalOutputTokens || 0);
    },
    availablePresets() {
      const existing = this.paneCrewSession?.roles?.map(r => r.name) || [];
      return this.rolePresets.filter(p => !existing.includes(p.name));
    },
    crewTasks() {
      return parseCrewTasks(this.paneCrewMessages);
    },
    completedTaskCount() {
      return this.crewTasks.filter(t => t.done).length;
    },
    doneTasks() {
      return this.crewTasks.filter(t => t.done);
    },
    activeTasks() {
      const persistedFeatures = this.paneCrewStatus?.features || [];
      return collectActiveTasks(persistedFeatures, this.paneCrewMessages);
    },
    persistedFeatureIds() {
      const features = this.paneCrewStatus?.features || [];
      return new Set(features.map(f => f.taskId));
    },
    completedTaskIds() {
      return computeCompletedTaskIds(this.doneTasks, this.activeTasks);
    },
    featureBlocks() {
      const allMessages = this.paneCrewMessages;
      const completed = this.completedTaskIds;
      const len = allMessages.length;

      if (!this._fbCache) {
        this._fbCache = createFbCache(null);
      }
      const cache = this._fbCache;

      if (cache._lastArr !== allMessages) {
        Object.assign(cache, createFbCache(allMessages));
        if (len === 0) return cache.blocks;
        return fullBuildFeatureBlocks(allMessages, completed, cache);
      }

      if (len === 0) {
        Object.assign(cache, createFbCache(allMessages));
        return cache.blocks;
      }

      const startIdx = cache.processedLen;
      if (startIdx > len) {
        Object.assign(cache, createFbCache(allMessages));
        return fullBuildFeatureBlocks(allMessages, completed, cache);
      }

      if (startIdx < len) {
        appendToSegments(allMessages, startIdx, cache);
      }

      rebuildBlocksFromSegments(cache, completed);
      return cache.blocks;
    },
    pendingAsks() {
      const asks = [];
      const messages = this.paneCrewMessages;
      for (const msg of messages) {
        if (msg.type === 'tool' && msg.toolName === 'AskUserQuestion' && !msg.askAnswered && msg.askRequestId) {
          asks.push({
            taskId: msg.taskId || null,
            roleIcon: msg.roleIcon,
            roleName: msg.roleName,
            askMsg: msg,
          });
        }
      }
      return asks;
    },
    currentPendingAsk() {
      return this.pendingAsks.length > 0 ? this.pendingAsks[0] : null;
    },
    todosByFeature() {
      return buildTodosByFeature(this.paneCrewMessages);
    },
    sessionRoles() {
      return this.paneCrewSession?.roles || [];
    },
    roleColorMap() {
      const map = {};
      let fbIndex = 0;
      for (const role of this.sessionRoles) {
        if (PRESET_ROLES.includes(role.name)) {
          map[role.name] = null;
        } else {
          map[role.name] = fbIndex++;
        }
      }
      return map;
    },
    featureKanban() {
      return buildFeatureKanban(
        this.activeTasks, this.todosByFeature, this.featureBlocks,
        this.completedTaskIds, this.$t('crew.globalTask')
      );
    },
    featureKanbanGrouped() {
      return groupKanban(this.featureKanban);
    },
    kanbanProgressData() {
      return kanbanProgress(this.featureKanban);
    },
    kanbanFeatureCount() {
      // Count features with signals (messages, todos, streaming, activity).
      // Mirrors filteredFeatures filter in CrewFeaturePanel.
      const persisted = this.persistedFeatureIds;
      return this.featureKanban.filter(f => {
        if (persisted.has(f.taskId)) return true;
        const block = this.featureBlocks.find(
          b => b.type === 'feature' && b.taskId === f.taskId
        );
        if (block) {
          const turns = getBlockTurns(block, this._fbCache);
          if (turns && turns.length > 0) return true;
        }
        if (f.totalCount > 0) return true;
        if (f.hasStreaming) return true;
        if (f.lastActivityAt > 0) return true;
        return false;
      }).length;
    }
  },

  watch: {
    '$route'() {
      this.store.setPaneMobilePanel(this.paneId, null);
    },
    isWaitingResponse: {
      handler(val) {
        if (val) {
          this.typingStartTime = Date.now();
          this.animationType = 'cat'; // Dog needs more polish; preview via ?preview=dog
          this.catPosition = 0;
          this.catDirection = 1;
          this.dogPosL = 5; this.dogPosR = 95; this.dogPhase = 'bark-both';
          this.dogFlipL = 1; this.dogFlipR = -1;
          if (this.animationType === 'cat') {
            this._startCatWalk();
          } else {
            this._startDogWalk();
          }
        } else {
          this.typingStartTime = 0;
          this.catPosition = 0;
          this.catDirection = 1;
          this._stopCatWalk();
          this._stopDogWalk();
        }
      },
      immediate: true
    },
    kanbanFeatureCount(val) {
      this.store.setCrewInProgressCount(this.effectiveConvId, val);
    },
    'effectiveConvId'(newId, oldId) {
      this.store.setPaneMobilePanel(this.paneId, null);
      if (oldId) this.input.saveDraft(oldId);
      this.input.restoreDraft(newId);
      this._draftConvId = newId;
      this._fbCache = null;
      clearMarkdownCache();
      this.scroll.visibleBlockCount.value = 20;
      this.$nextTick(() => {
        setTimeout(() => this.scroll.scrollToMeaningfulContent(), 300);
      });
    },
    'input.inputText.value'(val) {
      const convId = this.effectiveConvId;
      if (convId) {
        if (val) {
          this.store.inputDrafts[convId] = val;
        } else {
          delete this.store.inputDrafts[convId];
        }
      }
    },
    'paneCrewMessages': {
      handler() {
        this.$nextTick(() => this.scroll.smartScrollToBottom());
      },
      deep: true
    }
  },

  methods: {
    formatTokens,
    shouldShowTurnDivider,
    getMaxRound,

    _updateCatWalk() {
      if (!this.typingStartTime) return;
      this.nowTick = Date.now();
      const elapsed = (this.nowTick - this.typingStartTime) % 19000;
      if (elapsed < 4000) {
        // 0-4s: napping — stay at start
        this.catPosition = 0;
        this.catDirection = 1;
      } else if (elapsed < 11500) {
        // 4-11.5s: walk forward — Normal 2.5s, Fast 2.5s, Turbo 2.5s
        const walkElapsed = elapsed - 4000;
        let pos;
        if (walkElapsed < 2500) {
          pos = (walkElapsed / 2500) * 16;
        } else if (walkElapsed < 5000) {
          pos = 16 + ((walkElapsed - 2500) / 2500) * 29;
        } else {
          pos = 45 + ((walkElapsed - 5000) / 2500) * 55;
        }
        this.catPosition = pos;
        this.catDirection = 1;
      } else if (elapsed < 14000) {
        // 11.5-14s: crazy sprint back
        this.catPosition = (1 - (elapsed - 11500) / 2500) * 100;
        this.catDirection = -1;
      } else {
        // 14-19s: tired + petted — stay at start, face right
        this.catPosition = 0;
        this.catDirection = 1;
      }
      this._catRafId = requestAnimationFrame(() => this._updateCatWalk());
    },
    _startCatWalk() {
      this._stopCatWalk();
      this._catRafId = requestAnimationFrame(() => this._updateCatWalk());
    },
    _stopCatWalk() {
      if (this._catRafId) {
        cancelAnimationFrame(this._catRafId);
        this._catRafId = null;
      }
    },

    _updateDogWalk() {
      if (!this.typingStartTime || this.animationType !== 'dog') return;
      this.nowTick = Date.now();
      const elapsed = (this.nowTick - this.typingStartTime) % 18000;

      if (elapsed < 2000) {
        this.dogPosL = 5; this.dogPosR = 95; this.dogPhase = 'bark-both';
        this.dogFlipL = 1; this.dogFlipR = -1;
      } else if (elapsed < 5000) {
        const t = (elapsed - 2000) / 3000;
        this.dogPosL = 5 + t * 25; this.dogPosR = 95;
        this.dogPhase = 'left-approach';
        this.dogFlipL = 1; this.dogFlipR = -1;
      } else if (elapsed < 8000) {
        const t = (elapsed - 5000) / 3000;
        this.dogPosL = 30; this.dogPosR = 95 - t * 25;
        this.dogPhase = 'right-approach';
        this.dogFlipL = 1; this.dogFlipR = -1;
      } else if (elapsed < 10000) {
        const t = (elapsed - 8000) / 2000;
        this.dogPosL = 30 + t * 13; this.dogPosR = 70 - t * 13;
        this.dogPhase = 'both-approach';
        this.dogFlipL = 1; this.dogFlipR = -1;
      } else if (elapsed < 11000) {
        this.dogPosL = 43; this.dogPosR = 57;
        this.dogPhase = 'snap';
        this.dogFlipL = 1; this.dogFlipR = -1;
      } else if (elapsed < 12500) {
        this.dogPosL = 43; this.dogPosR = 57;
        this.dogPhase = 'stunned';
        this.dogFlipL = 1; this.dogFlipR = -1;
      } else if (elapsed < 15000) {
        const t = (elapsed - 12500) / 2500;
        this.dogPosL = 43 - t * 38; this.dogPosR = 57 + t * 38;
        this.dogPhase = 'retreat';
        this.dogFlipL = -1; this.dogFlipR = 1;
      } else if (elapsed < 17000) {
        this.dogPosL = 5; this.dogPosR = 95;
        this.dogPhase = 'rehang';
        this.dogFlipL = -1; this.dogFlipR = 1;
      } else {
        this.dogPosL = 5; this.dogPosR = 95;
        this.dogPhase = 'reset';
        this.dogFlipL = 1; this.dogFlipR = -1;
      }
      this._dogRafId = requestAnimationFrame(() => this._updateDogWalk());
    },
    _startDogWalk() {
      this._stopDogWalk();
      this._dogRafId = requestAnimationFrame(() => this._updateDogWalk());
    },
    _stopDogWalk() {
      if (this._dogRafId) {
        cancelAnimationFrame(this._dogRafId);
        this._dogRafId = null;
      }
    },

    dismissNotification(id) {
      const idx = this.store.crewNotifications.findIndex(n => n.id === id);
      if (idx !== -1) this.store.crewNotifications.splice(idx, 1);
    },

    clearMobilePanel() {
      this.store.setPaneMobilePanel(this.paneId, null);
    },

    getEmptyRole() {
      return { name: '', displayName: '', icon: '\u{1F916}', description: '', model: 'sonnet', claudeMd: '', isDecisionMaker: false };
    },

    toggleTurn(turnId) {
      this.expandedTurns[turnId] = !this.expandedTurns[turnId];
    },

    getRoleDisplayName(roleName) {
      const session = this.paneCrewSession;
      if (!session) return roleName;
      const role = session.roles.find(r => r.name === roleName);
      return role ? role.displayName : roleName;
    },

    sendMessage(e) {
      this.input.sendMessage(e, () => {
        this.scroll.isAtBottom.value = true;
        this.scroll.scrollToBottom();
      });
    },

    controlAction(action, targetRole = null) {
      if (action === 'clear') {
        if (!confirm(this.$t('crew.confirmClear'))) return;
      }
      this.store.sendCrewControl(action, targetRole, this.effectiveConvId);
    },

    clearRole(roleName) {
      if (!roleName) return;
      this.controlAction('clear_role', roleName);
    },

    abortRole(roleName) {
      if (!roleName) return;
      this.controlAction('abort_role', roleName);
    },

    quickAddPreset(preset) {
      this.store.addCrewRole({ ...preset }, this.effectiveConvId);
      if (this.availablePresets.length <= 1) {
        this.showAddRole = false;
      }
    },

    confirmAddRole() {
      if (!this.newRole.name || !this.newRole.displayName) return;
      this.store.addCrewRole({ ...this.newRole }, this.effectiveConvId);
      this.showAddRole = false;
      this.newRole = this.getEmptyRole();
    },

    dismissPendingAsk() {
      const ask = this.currentPendingAsk;
      if (ask) {
        ask.askMsg.askAnswered = true;
        ask.askMsg.selectedAnswers = { _dismissed: true };
      }
    },

    scrollToAskCard() {
      // Find the first AskCard element in the messages area and scroll to it
      const container = this.$refs.messagesRef;
      if (!container) return;
      const askCard = container.querySelector('.ask-card-wrapper');
      if (askCard) {
        askCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    },

    onAskSubmit(requestId, answers) {
      this.store.answerUserQuestion(requestId, answers, this.effectiveConvId);
    },

    scrollToRoleLatest(roleName) {
      this.scroll.scrollToRoleLatest(
        roleName, this.featureBlocks,
        this.expandedFeatures, this.expandedHistories, this.$el
      );
    },

    scrollToFeature(taskId) {
      this.scroll.scrollToFeature(taskId, this.expandedFeatures, this.$el);
    },

    resolveBlockTurns(block) {
      return getBlockTurns(block, this._fbCache);
    },

    expandFeature(taskId) {
      this.expandedFeatureTaskId = this.expandedFeatureTaskId === taskId ? null : taskId;
    },

    closeFeature() {
      this.expandedFeatureTaskId = null;
    },

    loadHistory() {
      this.scroll.loadHistory((getter, cb) => this.$watch(getter, cb));
    },

    refreshCrewSession() {
      const convId = this.effectiveConvId;
      if (!convId) return;
      const conv = this.store.conversations.find(c => c.id === convId);
      this.store.sendWsMessage({ type: 'refresh_conversation', conversationId: convId, agentId: conv?.agentId });
    }
  },

  mounted() {
    const closeMenus = () => {};
    document.addEventListener('click', closeMenus);
    this._cleanupClick = closeMenus;
    this._elapsedTimer = setInterval(() => { this.nowTick = Date.now(); }, 1000);
    const convId = this.effectiveConvId;
    this._draftConvId = convId;
    this.input.restoreDraft(convId);
    this.$nextTick(() => this.scroll.scrollToBottom());

    // Preview mode initialization
    const urlPreview = new URLSearchParams(window.location.search).get('preview');
    if (urlPreview === 'cat' || urlPreview === 'dog' || urlPreview === 'animation') {
      this.typingStartTime = Date.now();
      if (urlPreview === 'dog') {
        this.animationType = 'dog';
      } else if (urlPreview === 'cat') {
        this.animationType = 'cat';
      } else {
        this.animationType = 'cat';
      }
      if (this.animationType === 'cat') {
        this._startCatWalk();
      } else {
        this.dogPosL = 5; this.dogPosR = 95; this.dogPhase = 'bark-both';
        this.dogFlipL = 1; this.dogFlipR = -1;
        this._startDogWalk();
      }
    }
  },

  beforeUnmount() {
    if (this._cleanupClick) {
      document.removeEventListener('click', this._cleanupClick);
    }
    if (this._elapsedTimer) {
      clearInterval(this._elapsedTimer);
    }
    this._stopCatWalk();
    this._stopDogWalk();
    const convId = this._draftConvId || this.effectiveConvId;
    this.input.saveDraft(convId);
  }
};
