import { useAuthStore } from '../stores/auth.js';
import { isMobile, isInAlipay, isInWeChat } from '../utils/device.js';
import ProxyTab from './ProxyTab.js';
import DashboardTab from './DashboardTab.js';
import LlmTab from './LlmTab.js';

export default {
  name: 'SettingsPanel',
  components: { ProxyTab, DashboardTab, LlmTab },
  props: {
    visible: Boolean
  },
  emits: ['close'],
  template: `
    <div class="settings-overlay" v-if="visible" @click.self="$emit('close')">
      <div class="settings-dialog">
        <!-- Left Navigation -->
        <div class="settings-nav">
          <div class="settings-nav-title">{{ $t('settings.close') }}</div>
          <button
            v-for="tab in visibleTabs"
            :key="tab.key"
            class="settings-nav-item"
            :class="{ active: activeTab === tab.key }"
            @click="activeTab = tab.key"
          >
            <svg v-if="tab.key === 'general'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
            <svg v-else-if="tab.key === 'account'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
            <svg v-else-if="tab.key === 'security'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
            <svg v-else-if="tab.key === 'proxy'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
            <svg v-else-if="tab.key === 'invitations'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
            <svg v-else-if="tab.key === 'dashboard'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>
            <svg v-else-if="tab.key === 'tools'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>
            <svg v-else-if="tab.key === 'llm'" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M21 10.12h-6.78l2.74-2.82c-2.73-2.7-7.15-2.8-9.88-.1-2.73 2.71-2.73 7.08 0 9.79s7.15 2.71 9.88 0C18.32 15.65 19 14.08 19 12.1h2c0 1.98-.88 4.55-2.64 6.29-3.51 3.48-9.21 3.48-12.72 0-3.5-3.47-3.5-9.11 0-12.58 3.51-3.47 9.14-3.49 12.65-.06L21 3v7.12zM12.5 8v4.25l3.5 2.08-.72 1.21L11 13V8h1.5z"/></svg>
            <span>{{ tab.label }}</span>
          </button>
        </div>

        <!-- Right Content -->
        <div class="settings-content">
          <div class="settings-content-header">
            <h2 class="settings-content-title">{{ currentTabLabel }}</h2>
            <button class="settings-close" @click="$emit('close')" :title="$t('settings.close')">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>
          <div class="settings-scroll">
            <!-- Account -->
            <div v-show="activeTab === 'account'" class="settings-pane">
              <div class="sp-group">
                <div class="sp-row">
                  <div class="sp-row-left">
                    <span class="sp-label">{{ $t('settings.account.username') }}</span>
                  </div>
                  <span class="sp-value">{{ accountDisplayName }}</span>
                </div>
                <div class="sp-row">
                  <div class="sp-row-left">
                    <span class="sp-label">{{ $t('settings.account.role') }}</span>
                  </div>
                  <span class="sp-badge" :class="'sp-role-' + (profile?.role || 'pro')">{{ roleLabel }}</span>
                </div>
                <div class="sp-row">
                  <div class="sp-row-left">
                    <span class="sp-label">{{ $t('settings.account.email') }}</span>
                  </div>
                  <span class="sp-value">{{ profile?.email || $t('settings.account.emailNotSet') }}</span>
                </div>
              </div>

              <div class="sp-group">
                <div class="sp-group-title">{{ $t('settings.account.linkedAccounts') }}</div>
                <p class="sp-desc">{{ $t('settings.account.linkedDesc') }}</p>
                <div v-if="ssoBoundMessage" class="sp-info">{{ ssoBoundMessage }}</div>
                <div v-if="ssoConflictMessage" class="sp-error">{{ ssoConflictMessage }}</div>
                <div v-if="authStore.identitiesLoading" class="sp-desc">{{ $t('common.loading') }}</div>
                <div v-else-if="ssoProviderRows.length === 0" class="sp-desc">{{ $t('login.noProviders') }}</div>
                <div v-else>
                  <div v-for="p in ssoProviderRows" :key="p.key" class="sp-row">
                    <div class="sp-row-left">
                      <span class="sp-label">{{ p.label }}</span>
                      <span class="sp-desc-small" v-if="p.linked && p.identity">
                        {{ p.identity.email || p.identity.displayName || $t('settings.account.linked') }}
                      </span>
                    </div>
                    <button
                      v-if="!p.linked"
                      class="sp-btn sp-btn-muted"
                      :disabled="!p.enabled"
                      :title="!p.enabled ? $t('settings.account.providerDisabled') : ''"
                      @click="bindSso(p.key)"
                    >
                      {{ $t('settings.account.bind') }}
                    </button>
                    <button
                      v-else
                      class="sp-btn sp-btn-danger"
                      :disabled="!canUnbind(p.key)"
                      :title="!canUnbind(p.key) ? $t('settings.account.cantUnbindLast') : ''"
                      @click="unbindSso(p.key)"
                    >
                      {{ $t('settings.account.unbind') }}
                    </button>
                  </div>
                </div>
              </div>

              <div class="sp-group">
                <button class="sp-btn sp-btn-danger" @click="doLogout">{{ $t('settings.account.logout') }}</button>
              </div>
            </div>

            <!-- Security -->
            <div v-show="activeTab === 'security'" class="settings-pane">
              <div class="sp-group">
                <div class="sp-group-title">{{ $t('settings.security.agentKey') }}</div>
                <p class="sp-desc">{{ $t('settings.security.agentKeyDesc') }}</p>
                <div class="sp-secret-row">
                  <code class="sp-secret">{{ showSecret ? (agentSecret || $t('settings.security.none')) : (agentSecret ? '••••••••••••' : $t('settings.security.none')) }}</code>
                  <button class="sp-icon-btn" @click="showSecret = !showSecret" :title="showSecret ? $t('settings.security.hide') : $t('settings.security.show')">
                    <svg v-if="showSecret" viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                    <svg v-else viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>
                  </button>
                  <button class="sp-icon-btn" @click="copySecret" v-if="agentSecret" :title="$t('common.copy')">
                    <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
                  </button>
                </div>
                <div class="sp-actions-row">
                  <button class="sp-btn sp-btn-muted" @click="resetSecret" :disabled="resettingSecret">
                    {{ resettingSecret ? $t('settings.security.resetting') : $t('settings.security.resetKey') }}
                  </button>
                  <span class="sp-warning" v-if="resetConfirm">{{ $t('settings.security.resetWarning') }}</span>
                </div>
                <div class="sp-cmd-group" v-if="agentSecret">
                  <div class="sp-cmd-row">
                    <span class="sp-cmd-label">{{ $t('settings.security.agentCmdInstall') }}</span>
                    <code class="sp-cmd">npm install -g @yeaft/webchat-agent</code>
                    <button class="sp-icon-btn" @click="copyText('npm install -g @yeaft/webchat-agent')" :title="$t('common.copy')">
                      <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
                    </button>
                  </div>
                  <div class="sp-cmd-row">
                    <span class="sp-cmd-label">{{ $t('settings.security.agentCmdService') }}</span>
                    <code class="sp-cmd">yeaft-agent install --server {{ serverWsUrl }} --secret {{ agentSecret }} --name {{ agentName }}</code>
                    <button class="sp-icon-btn" @click="copyText('yeaft-agent install --server ' + serverWsUrl + ' --secret ' + agentSecret + ' --name ' + agentName)" :title="$t('common.copy')">
                      <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
                    </button>
                  </div>
                </div>
              </div>

              <div class="sp-group">
                <div class="sp-group-title">{{ profile && profile.hasPassword === false ? $t('settings.security.setPassword') : $t('settings.security.changePassword') }}</div>
                <p class="sp-desc" v-if="profile && profile.hasPassword === false">{{ $t('settings.security.setPasswordDesc') }}</p>
                <input v-if="profile && profile.hasPassword !== false" type="password" v-model="currentPassword" :placeholder="$t('settings.security.currentPassword')" autocomplete="current-password" class="sp-input">
                <input type="password" v-model="newPassword" :placeholder="$t('settings.security.newPassword')" autocomplete="new-password" class="sp-input">
                <input type="password" v-model="confirmPassword" :placeholder="$t('settings.security.confirmPassword')" autocomplete="new-password" class="sp-input">
                <button class="sp-btn" @click="changePassword" :disabled="changingPassword">
                  {{ changingPassword ? $t('settings.security.changing') : (profile && profile.hasPassword === false ? $t('settings.security.setBtn') : $t('settings.security.changeBtn')) }}
                </button>
              </div>

              <div class="sp-group sp-danger-zone">
                <div class="sp-group-title">{{ $t('settings.security.deleteAccount') }}</div>
                <p class="sp-desc">{{ $t('settings.security.deleteAccountDesc') }}</p>
                <input
                  v-if="profile && profile.hasPassword !== false"
                  type="password"
                  v-model="deletePassword"
                  :placeholder="$t('settings.security.currentPassword')"
                  autocomplete="current-password"
                  class="sp-input"
                  v-show="deleteConfirm">
                <input
                  v-else
                  type="text"
                  v-model="deleteConfirmText"
                  :placeholder="$t('settings.security.deleteConfirmPlaceholder')"
                  class="sp-input"
                  v-show="deleteConfirm">
                <div class="sp-actions-row">
                  <button class="sp-btn sp-btn-danger" @click="deleteAccount" :disabled="deletingAccount">
                    {{ deletingAccount ? $t('settings.security.deleting') : (deleteConfirm ? $t('settings.security.deleteConfirmBtn') : $t('settings.security.deleteBtn')) }}
                  </button>
                  <button v-if="deleteConfirm" class="sp-btn sp-btn-muted" @click="cancelDeleteAccount">{{ $t('common.cancel') }}</button>
                </div>
              </div>
            </div>

            <!-- General -->
            <div v-show="activeTab === 'general'" class="settings-pane">
              <div class="sp-group">
                <div class="sp-row">
                  <span class="sp-label">{{ $t('settings.general.theme') }}</span>
                  <div class="sp-custom-select" :class="{ open: openDropdown === 'theme' }" v-click-outside="() => closeDropdown('theme')">
                    <button class="sp-custom-select-trigger" @click="toggleDropdown('theme')">
                      <span>{{ themeOptions.find(o => o.value === chatStore.theme)?.label }}</span>
                      <svg class="sp-custom-select-chevron" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                    </button>
                    <div class="sp-custom-select-menu" v-show="openDropdown === 'theme'">
                      <div
                        class="sp-custom-select-option"
                        :class="{ active: chatStore.theme === opt.value }"
                        v-for="opt in themeOptions"
                        :key="opt.value"
                        @click="setTheme(opt.value); closeDropdown('theme')"
                      >
                        {{ opt.label }}
                        <svg v-if="chatStore.theme === opt.value" class="sp-custom-select-check" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="sp-row">
                  <span class="sp-label">{{ $t('settings.general.language') }}</span>
                  <div class="sp-custom-select" :class="{ open: openDropdown === 'language' }" v-click-outside="() => closeDropdown('language')">
                    <button class="sp-custom-select-trigger" @click="toggleDropdown('language')">
                      <span>{{ languageOptions.find(o => o.value === selectedLocale)?.label }}</span>
                      <svg class="sp-custom-select-chevron" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                    </button>
                    <div class="sp-custom-select-menu" v-show="openDropdown === 'language'">
                      <div
                        class="sp-custom-select-option"
                        :class="{ active: selectedLocale === opt.value }"
                        v-for="opt in languageOptions"
                        :key="opt.value"
                        @click="selectLanguage(opt.value); closeDropdown('language')"
                      >
                        {{ opt.label }}
                        <svg v-if="selectedLocale === opt.value" class="sp-custom-select-check" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="sp-row">
                  <span class="sp-label">{{ $t('files.officePreviewMode') }}</span>
                  <div class="sp-custom-select" :class="{ open: openDropdown === 'officePreview' }" v-click-outside="() => closeDropdown('officePreview')">
                    <button class="sp-custom-select-trigger" @click="toggleDropdown('officePreview')">
                      <span>{{ officePreviewOptions.find(o => o.value === officePreviewMode)?.label }}</span>
                      <svg class="sp-custom-select-chevron" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                    </button>
                    <div class="sp-custom-select-menu" v-show="openDropdown === 'officePreview'">
                      <div
                        class="sp-custom-select-option"
                        :class="{ active: officePreviewMode === opt.value }"
                        v-for="opt in officePreviewOptions"
                        :key="opt.value"
                        @click="setOfficePreviewMode(opt.value); closeDropdown('officePreview')"
                      >
                        {{ opt.label }}
                        <svg v-if="officePreviewMode === opt.value" class="sp-custom-select-check" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Invitations (admin only) -->
            <div v-show="activeTab === 'invitations'" class="settings-pane" v-if="authStore.role === 'admin'">
              <div class="sp-group">
                <div class="sp-row">
                  <span class="sp-label">{{ $t('settings.invite.create') }}</span>
                  <div class="sp-invite-create-row">
                    <div class="sp-custom-select" :class="{ open: openDropdown === 'inviteRole' }" v-click-outside="() => closeDropdown('inviteRole')">
                      <button class="sp-custom-select-trigger" @click="toggleDropdown('inviteRole')">
                        <span>{{ roleOptions.find(o => o.value === inviteRole)?.label }}</span>
                        <svg class="sp-custom-select-chevron" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
                      </button>
                      <div class="sp-custom-select-menu" v-show="openDropdown === 'inviteRole'">
                        <div
                          class="sp-custom-select-option"
                          :class="{ active: inviteRole === opt.value }"
                          v-for="opt in roleOptions"
                          :key="opt.value"
                          @click="inviteRole = opt.value; closeDropdown('inviteRole')"
                        >
                          {{ opt.label }}
                          <svg v-if="inviteRole === opt.value" class="sp-custom-select-check" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                        </div>
                      </div>
                    </div>
                    <button class="sp-btn-create" @click="createInvitation" :disabled="creatingInvite">
                      <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                      {{ creatingInvite ? $t('settings.invite.creating') : $t('settings.invite.createBtn') }}
                    </button>
                  </div>
                </div>
              </div>

              <div class="sp-group" v-if="invitations.length > 0">
                <div class="sp-group-title">{{ $t('settings.invite.list') }}</div>
                <div class="sp-invite-item" v-for="inv in invitations" :key="inv.code">
                  <div class="sp-invite-main">
                    <div class="sp-invite-info">
                      <div class="sp-invite-top">
                        <code class="sp-invite-code">{{ inv.code }}</code>
                        <span class="sp-badge sp-role-pro">{{ inv.role }}</span>
                        <span class="sp-invite-status" :class="inviteStatusClass(inv)">
                          {{ inviteStatusText(inv) }}
                        </span>
                      </div>
                      <div class="sp-invite-meta">
                        <span v-if="inv.used_by">{{ $t('settings.invite.usedBy', { user: inv.usedByUsername }) }}</span>
                        <span v-else-if="inv.expiresAt < Date.now()">{{ $t('settings.invite.expiredAt', { time: formatTime(inv.expiresAt) }) }}</span>
                        <span v-else>{{ $t('settings.invite.expiresAt', { time: formatTime(inv.expiresAt) }) }}</span>
                      </div>
                    </div>
                  </div>
                  <button class="sp-icon-btn" @click="copyInviteCode(inv.code)" v-if="!inv.used_by && inv.expiresAt >= Date.now()" :title="$t('common.copy')">
                    <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
                  </button>
                  <button class="sp-icon-btn" @click="deleteInvitation(inv.code)" v-if="!inv.used_by" :title="$t('common.delete')">
                    <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                  </button>
                </div>
              </div>
              <div class="sp-group" v-else>
                <p class="sp-desc">{{ $t('settings.invite.noInvites') }}</p>
              </div>
            </div>

            <!-- Proxy -->
            <div v-show="activeTab === 'proxy'" class="settings-pane">
              <ProxyTab />
            </div>

            <!-- Tools -->
            <div v-show="activeTab === 'tools'" class="settings-pane">
              <div class="sp-group">
                <div class="sp-group-title">MCP Servers</div>
                <div v-if="!chatStore.currentAgent" class="sp-desc">
                  {{ $t('settings.tools.noAgent') }}
                </div>
                <div v-else-if="mcpServersList.length === 0" class="sp-desc">
                  {{ $t('settings.tools.noServers') }}
                </div>
                <div v-else>
                  <div class="sp-mcp-item" v-for="server in mcpServersList" :key="server.name">
                    <label class="sp-toggle-row">
                      <span class="sp-toggle-info">
                        <span class="sp-toggle-name">{{ server.name }}</span>
                        <span class="sp-toggle-badge" :class="server.source === 'Built-in' ? 'sp-badge-builtin' : 'sp-badge-mcp'">{{ server.source }}</span>
                      </span>
                      <button
                        class="sp-toggle"
                        :class="{ active: server.enabled }"
                        @click="toggleMcpServer(server.name, !server.enabled)"
                        role="switch"
                        :aria-checked="server.enabled"
                      >
                        <span class="sp-toggle-knob"></span>
                      </button>
                    </label>
                  </div>
                </div>
              </div>
              <p class="sp-desc sp-tools-hint">{{ $t('settings.tools.hint') }}</p>
            </div>

            <!-- LLM Configuration -->
            <div v-show="activeTab === 'llm'" class="settings-pane">
              <LlmTab @message="onLlmMessage" />
            </div>

            <!-- Dashboard (admin only) -->
            <div v-show="activeTab === 'dashboard'" class="settings-pane" v-if="authStore.role === 'admin'">
              <DashboardTab />
            </div>
          </div>
        </div>
      </div>

      <!-- Toast -->
      <transition name="sp-toast">
        <div v-if="message" class="sp-toast" :class="{ error: isError }">{{ message }}</div>
      </transition>

      <!-- SSO bind QR modal: reuses LoginPage's QR-scan UX so binding feels
           identical to logging in. Only shown for QR providers (alipay/
           wechat); other providers still use the redirect flow. -->
      <div
        v-if="authStore.qrPanel && authStore.qrPanel.intent === 'bind'"
        class="settings-overlay sp-qr-overlay"
        @click.self="cancelQrBind"
      >
        <div class="sp-qr-card">
          <p class="totp-title">{{ qrModalTitle }}</p>
          <template v-if="authStore.qrPanel.mobileDeepLink">
            <p class="totp-hint">{{ $t('login.alipay.mobileWaiting') }}</p>
            <p v-if="authStore.qrPanel.status === 'error'" class="error">
              {{ authStore.qrPanel.error }}
            </p>
            <button class="sp-btn" @click="relaunchAlipayMobile">
              {{ $t('login.alipay.relaunch') }}
            </button>
          </template>
          <template v-else>
            <p class="totp-hint">{{ $t('login.qr.hint') }}</p>
            <div class="qr-container">
              <img v-if="qrDataUrl" :src="qrDataUrl" alt="QR" class="qr-code">
              <div v-else class="qr-code qr-placeholder"></div>
            </div>
            <p v-if="authStore.qrPanel.status === 'error'" class="error">
              {{ authStore.qrPanel.error }}
            </p>
          </template>
          <button class="sp-btn sp-btn-muted" @click="cancelQrBind">
            {{ $t('common.back') }}
          </button>
        </div>
      </div>
    </div>
  `,
  directives: {
    'click-outside': {
      mounted(el, binding) {
        el._clickOutside = (e) => {
          if (!el.contains(e.target)) binding.value();
        };
        document.addEventListener('click', el._clickOutside);
      },
      unmounted(el) {
        document.removeEventListener('click', el._clickOutside);
      }
    }
  },
  data() {
    const chatStore = Pinia.useChatStore();
    return {
      activeTab: 'general',
      profile: null,
      agentSecret: null,
      showSecret: false,
      resettingSecret: false,
      resetConfirm: false,
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
      changingPassword: false,
      deletePassword: '',
      deleteConfirm: false,
      deleteConfirmText: '',
      deletingAccount: false,
      invitations: [],
      inviteRole: 'pro',
      creatingInvite: false,
      message: '',
      isError: false,
      selectedLocale: chatStore.locale,
      openDropdown: null,
      officePreviewMode: localStorage.getItem('officePreviewMode') || 'local',
      ssoBoundMessage: '',
      ssoConflictMessage: '',
      qrDataUrl: ''
    };
  },
  computed: {
    authStore() {
      return useAuthStore();
    },
    chatStore() {
      return Pinia.useChatStore();
    },
    roleLabel() {
      const roles = { admin: this.$t('settings.account.roleAdmin'), pro: this.$t('settings.account.rolePro') };
      return roles[this.profile?.role] || this.$t('settings.account.rolePro');
    },
    /**
     * What to show in the "用户名 / Username" row. Prefer displayName (e.g. the
     * Alipay/Microsoft nickname) when it differs from the auto-generated
     * internal username, since SSO-created usernames are often opaque
     * (alipay_user, alipay_user_3). Falls back to username.
     */
    accountDisplayName() {
      const p = this.profile;
      if (!p) return '-';
      if (p.displayName && p.displayName !== p.username) return p.displayName;
      return p.username || '-';
    },
    /**
     * Default agent name suggested in the install command. We combine the
     * user's username with a short, stable id derived from username so two
     * machines installed from the same account don't collide on display name
     * trivially. Users can still override --name on the CLI.
     */
    agentName() {
      const p = this.profile;
      const base = (p && (p.username || p.displayName)) || 'agent';
      // FNV-1a 32-bit, stable per username, no crypto dep needed.
      let h = 0x811c9dc5;
      for (let i = 0; i < base.length; i++) {
        h ^= base.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      const id = h.toString(16).padStart(8, '0').slice(0, 6);
      // Sanitize username for shell/CLI: keep alnum/_/-, collapse others.
      const safe = String(base).replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'agent';
      return `${safe}-${id}`;
    },
    visibleTabs() {
      const tabs = [
        { key: 'general', label: this.$t('settings.tabs.general') },
        { key: 'account', label: this.$t('settings.tabs.account') },
        { key: 'security', label: this.$t('settings.tabs.security') }
      ];
      if (this.authStore.role === 'admin' || this.authStore.role === 'pro') {
        tabs.push({ key: 'proxy', label: this.$t('settings.tabs.proxy') });
        tabs.push({ key: 'tools', label: this.$t('settings.tabs.tools') });
        tabs.push({ key: 'llm', label: this.$t('settings.tabs.llm') });
      }
      if (this.authStore.role === 'admin') {
        tabs.push({ key: 'invitations', label: this.$t('settings.tabs.invitations') });
        tabs.push({ key: 'dashboard', label: this.$t('settings.tabs.dashboard') });
      }
      return tabs;
    },
    currentTabLabel() {
      const tab = this.visibleTabs.find(t => t.key === this.activeTab);
      return tab?.label || '';
    },
    themeOptions() {
      return [
        { value: 'light', label: this.$t('settings.general.lightTheme') },
        { value: 'dark', label: this.$t('settings.general.darkTheme') }
      ];
    },
    languageOptions() {
      return [
        { value: 'zh-CN', label: '中文' },
        { value: 'en', label: 'English' }
      ];
    },
    officePreviewOptions() {
      return [
        { value: 'local', label: this.$t('files.localRender') },
        { value: 'online', label: this.$t('files.officeOnline') }
      ];
    },
    roleOptions() {
      return [
        { value: 'pro', label: this.$t('settings.invite.proUser') }
      ];
    },
    serverWsUrl() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${location.host}`;
    },
    mcpServersList() {
      const agentId = this.chatStore.currentAgent;
      if (!agentId) return [];
      return this.chatStore.mcpServers[agentId] || [];
    },
    ssoProviderRows() {
      const auth = this.authStore;
      const linked = new Map((auth.linkedIdentities || []).map(i => [i.provider, i]));
      // Only render providers the server has enabled. We still keep the
      // `enabled` flag for backwards compat with the template, but the
      // filter step ensures disabled providers don't appear at all.
      const all = [
        { key: 'alipay',    label: this.$t('login.alipay'),    enabled: !!auth.ssoProviders.alipay },
        { key: 'microsoft', label: this.$t('login.microsoft'), enabled: !!auth.aadEnabled },
        { key: 'github',    label: this.$t('login.github'),    enabled: !!auth.ssoProviders.github },
        { key: 'google',    label: this.$t('login.google'),    enabled: !!auth.ssoProviders.google },
        { key: 'wechat',    label: this.$t('login.wechat'),    enabled: !!auth.ssoProviders.wechat }
      ];
      // Show a row if either (a) the provider is enabled now, or (b) the
      // user has a stale link to it (so they can still unbind even after
      // an admin disables the provider).
      return all
        .filter(r => r.enabled || linked.has(r.key))
        .map(r => ({
          ...r,
          linked: linked.has(r.key),
          identity: linked.get(r.key) || null
        }));
    },
    qrModalTitle() {
      const p = this.authStore.qrPanel?.provider;
      if (p === 'alipay') return this.$t('login.qr.titleAlipay');
      if (p === 'wechat') return this.$t('login.qr.titleWechat');
      return this.$t('login.qr.title');
    }
  },
  watch: {
    visible(val) {
      if (val) {
        this.loadData();
      } else {
        // Closing settings while a bind QR is up should tear it down too.
        if (this.authStore.qrPanel) this.cancelQrBind();
      }
    },
    activeTab(val) {
      if (val === 'tools' && this.chatStore.currentAgent) {
        this.chatStore.sendWsMessage({
          type: 'get_mcp_servers',
          agentId: this.chatStore.currentAgent
        });
      }
    },
    // When the bind QR completes (server reports status='bound'), close the
    // modal, refresh the linked-identities list, and surface a success toast.
    'authStore.qrPanel.status'(status) {
      if (status === 'bound') {
        const provider = this.authStore.qrPanel?.provider;
        this.authStore.cancelSsoQr();
        this.qrDataUrl = '';
        this.authStore.loadIdentities();
        this.ssoBoundMessage = this.$t('settings.account.ssoBoundMsg', {
          provider: provider ? this.$t('login.' + provider) : ''
        });
      }
    },
    // Re-render the QR if the authorize URL changes mid-flow (e.g. retry).
    'authStore.qrPanel.authorizeUrl'(url) {
      if (url && this.authStore.qrPanel?.intent === 'bind') {
        this.renderQrCode();
      }
    }
  },
  methods: {
    changeLanguage() {
      this.chatStore.changeLocale(this.selectedLocale);
    },

    selectLanguage(value) {
      this.selectedLocale = value;
      this.chatStore.changeLocale(value);
    },

    toggleDropdown(name) {
      this.openDropdown = this.openDropdown === name ? null : name;
    },

    closeDropdown(name) {
      if (this.openDropdown === name) this.openDropdown = null;
    },

    setTheme(theme) {
      if (this.chatStore.theme !== theme) {
        this.chatStore.toggleTheme();
      }
    },

    setOfficePreviewMode(mode) {
      this.officePreviewMode = mode;
      localStorage.setItem('officePreviewMode', mode);
    },

    async loadData() {
      this.message = '';
      this._consumeSsoQueryFlags();
      try {
        const headers = this.getHeaders();
        const [profileRes, secretRes] = await Promise.all([
          fetch('/api/user/profile', { headers }),
          fetch('/api/user/agent-secret', { headers })
        ]);
        if (profileRes.ok) {
          this.profile = await profileRes.json();
        }
        if (secretRes.ok) {
          const data = await secretRes.json();
          this.agentSecret = data.agentSecret;
        }
        if (this.authStore.role === 'admin') {
          await this.loadInvitations();
        }
        // Load linked SSO identities (best-effort).
        try { await this.authStore.loadIdentities(); } catch {}
      } catch (e) {
        console.error('Failed to load settings data:', e);
      }
    },

    _consumeSsoQueryFlags() {
      // Hash format from server callback: #/settings?ssoBound=github
      // or #/settings?ssoError=conflict&provider=github
      const hash = window.location.hash || '';
      const idx = hash.indexOf('?');
      if (idx < 0) return;
      const params = new URLSearchParams(hash.slice(idx + 1));
      const bound = params.get('ssoBound');
      const err = params.get('ssoError');
      const provider = params.get('provider');
      if (bound) {
        this.ssoBoundMessage = this.$t('settings.account.ssoBoundMsg', { provider: bound });
        this.activeTab = 'account';
      }
      if (err === 'conflict') {
        this.ssoConflictMessage = this.$t('settings.account.ssoConflictMsg', { provider: provider || '' });
        this.activeTab = 'account';
      }
      if (bound || err) {
        try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch {}
      }
    },

    bindSso(provider) {
      this.ssoBoundMessage = '';
      this.ssoConflictMessage = '';
      // Alipay on mobile: needs the alipays:// deep-link to actually pull
      // up the Alipay app. In-Alipay-browser: plain redirect works.
      if (provider === 'alipay' && isInAlipay()) {
        this.authStore.bindSso(provider);
        return;
      }
      if (provider === 'alipay' && isMobile()) {
        this.authStore.loginWithAlipayMobile({ intent: 'bind' });
        return;
      }
      if (provider === 'wechat' && (isMobile() || isInWeChat())) {
        this.ssoConflictMessage = this.$t('login.wechat.mobileUnsupported');
        return;
      }
      // QR providers (alipay, wechat) get the same in-page scan flow that
      // login uses. Everything else goes through the OAuth redirect.
      if (provider === 'alipay' || provider === 'wechat') {
        this.startQrBind(provider);
      } else {
        this.authStore.bindSso(provider);
      }
    },

    async startQrBind(provider) {
      this.qrDataUrl = '';
      const ok = await this.authStore.startSsoQr(provider, { intent: 'bind' });
      if (!ok) {
        this.ssoConflictMessage = this.authStore.error || this.$t('settings.account.bindFailed');
        return;
      }
      this.renderQrCode();
    },

    cancelQrBind() {
      this.authStore.cancelSsoQr();
      this.qrDataUrl = '';
    },

    relaunchAlipayMobile() {
      const panel = this.authStore.qrPanel;
      if (!panel || !panel.authorizeUrl) return;
      const deepLink = `alipays://platformapi/startapp?appId=20000067&url=${encodeURIComponent(panel.authorizeUrl)}`;
      window.location.href = deepLink;
    },

    renderQrCode() {
      const panel = this.authStore.qrPanel;
      if (!panel || !panel.authorizeUrl) return;
      if (typeof qrcode !== 'function') {
        console.error('[SettingsPanel] qrcode library not loaded');
        return;
      }
      try {
        const qr = qrcode(0, 'M');
        qr.addData(panel.authorizeUrl, 'Byte');
        qr.make();
        this.qrDataUrl = qr.createDataURL(6, 4);
      } catch (err) {
        console.error('[SettingsPanel] QR render failed:', err);
      }
    },

    async unbindSso(provider) {
      this.ssoBoundMessage = '';
      this.ssoConflictMessage = '';
      const ok = await this.authStore.unbindIdentity(provider);
      if (!ok) {
        this.ssoConflictMessage = this.authStore.identitiesError || this.$t('settings.account.unbindFailed');
      }
    },

    canUnbind(provider) {
      const linked = this.authStore.linkedIdentities || [];
      const isLinked = linked.some(i => i.provider === provider);
      if (!isLinked) return false;
      // Can unbind unless it's the only login method.
      if (this.authStore.hasPassword) return true;
      return linked.length > 1;
    },

    async loadInvitations() {
      try {
        const res = await fetch('/api/invitations', { headers: this.getHeaders() });
        if (res.ok) {
          const data = await res.json();
          this.invitations = data.invitations.map(inv => ({
            ...inv,
            code: inv.id,
            expiresAt: inv.expires_at,
            usedByUsername: inv.used_by_username || null
          }));
        }
      } catch (e) {
        console.error('Failed to load invitations:', e);
      }
    },

    getHeaders() {
      const h = { 'Content-Type': 'application/json' };
      if (this.authStore.token) {
        h['Authorization'] = `Bearer ${this.authStore.token}`;
      }
      return h;
    },

    async copySecret() {
      if (this.agentSecret) {
        await this.copyText(this.agentSecret);
      }
    },

    async copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        this.showMessage(this.$t('settings.msg.copiedClipboard'));
      } catch {
        this.showMessage(this.$t('settings.msg.copyFailed'), true);
      }
    },

    async resetSecret() {
      if (!this.resetConfirm) {
        this.resetConfirm = true;
        return;
      }
      this.resettingSecret = true;
      try {
        const res = await fetch('/api/user/agent-secret/reset', {
          method: 'POST',
          headers: this.getHeaders()
        });
        if (res.ok) {
          const data = await res.json();
          this.agentSecret = data.agentSecret;
          this.showSecret = true;
          this.showMessage(this.$t('settings.msg.keyReset'));
        } else {
          const data = await res.json();
          this.showMessage(data.error || this.$t('settings.msg.resetFailed'), true);
        }
      } catch (e) {
        this.showMessage(this.$t('settings.msg.resetFailed') + ': ' + e.message, true);
      } finally {
        this.resettingSecret = false;
        this.resetConfirm = false;
      }
    },

    async changePassword() {
      const isFirstSet = this.profile && this.profile.hasPassword === false;
      if (!isFirstSet && !this.currentPassword) {
        this.showMessage(this.$t('settings.security.enterCurrentPwd'), true);
        return;
      }
      if (!this.newPassword || this.newPassword.length < 6) {
        this.showMessage(this.$t('settings.security.newPwdMin'), true);
        return;
      }
      if (this.newPassword !== this.confirmPassword) {
        this.showMessage(this.$t('settings.security.pwdMismatch'), true);
        return;
      }
      this.changingPassword = true;
      try {
        const body = { newPassword: this.newPassword };
        if (!isFirstSet) body.currentPassword = this.currentPassword;
        const res = await fetch('/api/user/profile', {
          method: 'PUT',
          headers: this.getHeaders(),
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (res.ok && data.success) {
          this.showMessage(isFirstSet ? this.$t('settings.security.pwdSet') : this.$t('settings.security.pwdChanged'));
          this.currentPassword = '';
          this.newPassword = '';
          this.confirmPassword = '';
          // Refresh profile so the form mode flips from "set" to "change".
          try {
            const p = await fetch('/api/user/profile', { headers: this.getHeaders() });
            if (p.ok) this.profile = await p.json();
          } catch {}
        } else {
          this.showMessage(data.error || this.$t('settings.msg.changeFailed'), true);
        }
      } catch (e) {
        this.showMessage(this.$t('settings.msg.changeFailed') + ': ' + e.message, true);
      } finally {
        this.changingPassword = false;
      }
    },

    cancelDeleteAccount() {
      this.deleteConfirm = false;
      this.deletePassword = '';
      this.deleteConfirmText = '';
    },

    async deleteAccount() {
      // First click arms the form; second click submits.
      if (!this.deleteConfirm) {
        this.deleteConfirm = true;
        return;
      }
      const hasPwd = this.profile && this.profile.hasPassword !== false;
      if (hasPwd && !this.deletePassword) {
        this.showMessage(this.$t('settings.security.enterCurrentPwd'), true);
        return;
      }
      if (!hasPwd && this.deleteConfirmText !== 'DELETE') {
        this.showMessage(this.$t('settings.security.deleteConfirmRequired'), true);
        return;
      }
      this.deletingAccount = true;
      try {
        const r = await this.authStore.deleteAccount(
          hasPwd ? { currentPassword: this.deletePassword } : { confirm: 'DELETE' }
        );
        if (!r.success) {
          this.showMessage(r.error || this.$t('settings.security.deleteFailed'), true);
          return;
        }
        // Account is gone — bounce to a clean login page.
        window.location.reload();
      } finally {
        this.deletingAccount = false;
      }
    },

    async createInvitation() {
      this.creatingInvite = true;
      try {
        const res = await fetch('/api/invitations', {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({ role: this.inviteRole })
        });
        if (res.ok) {
          await this.loadInvitations();
          this.showMessage(this.$t('settings.msg.inviteCreated'));
        } else {
          const data = await res.json();
          this.showMessage(data.error || this.$t('settings.msg.createFailed'), true);
        }
      } catch (e) {
        this.showMessage(this.$t('settings.msg.createFailed') + ': ' + e.message, true);
      } finally {
        this.creatingInvite = false;
      }
    },

    async copyInviteCode(code) {
      try {
        await navigator.clipboard.writeText(code);
        this.showMessage(this.$t('settings.msg.inviteCopied'));
      } catch {
        this.showMessage(this.$t('settings.msg.copyFailed'), true);
      }
    },

    async deleteInvitation(code) {
      try {
        const res = await fetch(`/api/invitations/${code}`, {
          method: 'DELETE',
          headers: this.getHeaders()
        });
        if (res.ok) {
          await this.loadInvitations();
          this.showMessage(this.$t('settings.msg.inviteDeleted'));
        } else {
          const data = await res.json();
          this.showMessage(data.error || this.$t('settings.msg.deleteFailed'), true);
        }
      } catch (e) {
        this.showMessage(this.$t('settings.msg.deleteFailed') + ': ' + e.message, true);
      }
    },

    inviteStatusClass(inv) {
      if (inv.used_by) return 'used';
      if (inv.expiresAt < Date.now()) return 'expired';
      return '';
    },

    inviteStatusText(inv) {
      if (inv.used_by) return this.$t('settings.invite.used');
      if (inv.expiresAt < Date.now()) return this.$t('settings.invite.expired');
      return this.$t('settings.invite.available');
    },

    formatTime(ts) {
      return new Date(ts).toLocaleString();
    },

    async doLogout() {
      await this.authStore.logout();
      window.location.reload();
    },

    showMessage(msg, error = false) {
      this.message = msg;
      this.isError = error;
      setTimeout(() => { this.message = ''; }, 3000);
    },

    toggleMcpServer(serverName, enabled) {
      const agentId = this.chatStore.currentAgent;
      if (!agentId) return;
      // Optimistic update
      const servers = this.chatStore.mcpServers[agentId];
      if (servers) {
        const server = servers.find(s => s.name === serverName);
        if (server) server.enabled = enabled;
      }
      // Send to server
      this.chatStore.sendWsMessage({
        type: 'update_mcp_config',
        agentId,
        config: { [serverName]: enabled }
      });
    },

    onLlmMessage(msg, isError) {
      this.showMessage(msg, isError);
    }
  }
};
