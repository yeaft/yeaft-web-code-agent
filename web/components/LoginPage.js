import { useAuthStore } from '../stores/auth.js';
import { setLocale } from '../utils/i18n.js';
import { isMobile, isInAlipay, isInWeChat } from '../utils/device.js';

/**
 * LoginPage — OAuth-first design.
 *
 * Default view (mode='oauth'): brand + tagline + a stack of SSO buttons,
 *   in priority order. Only providers whose server config marks them
 *   enabled are rendered. Below the stack: a small "use account & password"
 *   link that toggles to the credentials form.
 *
 * mode='credentials': the original username/password form, with a "back to
 *   single-sign-on" link that returns to the OAuth view.
 *
 * QR mode (Alipay/WeChat) replaces the panel content entirely, same card.
 *
 * Theme: card and tokens come from CSS variables, so light/dark inherit
 *   from the global data-theme attribute.
 */
export default {
  name: 'LoginPage',
  template: `
    <div class="login-page">
      <button class="login-lang-toggle" @click="toggleLang">
        {{ currentLocale === 'zh-CN' ? 'EN' : '中文' }}
      </button>
      <div class="login-container" :class="{ 'is-narrow': loginMode === 'oauth' && !authStore.qrPanel }">
        <div class="login-brand">
          <h1>Claude Web Chat</h1>
          <p class="login-subtitle">{{ $t('login.subtitle') }}</p>
        </div>

        <!-- ─── OAuth-first view ─────────────────────────────────────── -->
        <template v-if="loginMode === 'oauth' && authStore.loginStep === 'credentials' && !authStore.qrPanel && !forgotStep">
          <div v-if="enabledProviders.length === 0" class="login-empty">
            {{ $t('login.noProviders') }}
            <button class="link-button" @click="loginMode = 'credentials'">
              {{ $t('login.usePassword') }}
            </button>
          </div>

          <div v-else class="sso-stack">
            <button
              v-for="(p, idx) in enabledProviders"
              :key="p.key"
              :class="['sso-btn', 'sso-btn-' + p.key, idx === 0 ? 'is-primary' : '']"
              :disabled="authStore.loading"
              @click="handleProviderClick(p.key)"
            >
              <span class="sso-btn-icon" v-html="p.icon"></span>
              <span class="sso-btn-label">{{ p.label }}</span>
            </button>
          </div>

          <button class="link-button login-switch" @click="switchToCredentials">
            {{ $t('login.usePassword') }} →
          </button>

          <p v-if="authStore.error" class="error">{{ authStore.error }}</p>
          <p v-if="localError" class="error">{{ localError }}</p>
        </template>

        <!-- ─── Credentials view ─────────────────────────────────────── -->
        <template v-else-if="loginMode === 'credentials' && authStore.loginStep === 'credentials' && !authStore.qrPanel && !forgotStep">
          <input
            type="text"
            v-model="username"
            @keypress.enter="focusPassword"
            :placeholder="$t('login.username')"
            autocomplete="username"
            ref="usernameInput"
          >
          <input
            type="password"
            v-model="password"
            @keypress.enter="login"
            :placeholder="$t('login.password')"
            autocomplete="current-password"
            ref="passwordInput"
          >
          <button class="primary-btn" @click="login" :disabled="authStore.loading">
            {{ authStore.loading ? $t('login.loggingIn') : $t('login.login') }}
          </button>

          <button v-if="authStore.passwordResetEnabled" class="link-button login-switch" @click="enterForgotMode">
            {{ $t('login.forgot.link') }}
          </button>

          <button v-if="enabledProviders.length > 0" class="link-button login-switch" @click="loginMode = 'oauth'">
            ← {{ $t('login.useSso') }}
          </button>

          <p v-if="authStore.registrationEnabled" class="register-link">
            {{ $t('login.noAccount') }}<a href="#" @click.prevent="authStore.showRegister()">{{ $t('login.registerWithCode') }}</a>
          </p>

          <p v-if="authStore.error" class="error">{{ authStore.error }}</p>
          <p v-if="localError" class="error">{{ localError }}</p>
        </template>

        <!-- ─── Forgot password: step 1 (email) ─────────────────────── -->
        <template v-if="forgotStep === 'email' && !authStore.qrPanel">
          <p class="totp-title">{{ $t('login.forgot.title') }}</p>
          <p class="totp-hint">{{ $t('login.forgot.emailHint') }}</p>
          <input
            type="email"
            v-model="forgotEmail"
            @keypress.enter="submitForgotEmail"
            :placeholder="$t('login.register.email')"
            autocomplete="email"
          >
          <button class="primary-btn" @click="submitForgotEmail" :disabled="forgotLoading">
            {{ forgotLoading ? $t('login.forgot.sending') : $t('login.forgot.sendCode') }}
          </button>
          <button class="back-button" @click="exitForgotMode">{{ $t('common.back') }}</button>
          <p v-if="authStore.error" class="error">{{ authStore.error }}</p>
          <p v-if="localError" class="error">{{ localError }}</p>
        </template>

        <!-- ─── Forgot password: step 2 (code + new password) ───────── -->
        <template v-if="forgotStep === 'verify' && !authStore.qrPanel">
          <p class="totp-title">{{ $t('login.forgot.title') }}</p>
          <p class="verification-hint">{{ $t('login.forgot.codeSent') }}</p>
          <input
            type="text"
            v-model="forgotCode"
            :placeholder="$t('login.email.enterCode')"
            autocomplete="one-time-code"
            inputmode="numeric"
            maxlength="6"
            class="code-input"
          >
          <input
            type="password"
            v-model="forgotNewPassword"
            :placeholder="$t('settings.security.newPassword')"
            autocomplete="new-password"
          >
          <input
            type="password"
            v-model="forgotConfirm"
            @keypress.enter="submitForgotReset"
            :placeholder="$t('settings.security.confirmPassword')"
            autocomplete="new-password"
          >
          <button class="primary-btn" @click="submitForgotReset" :disabled="forgotLoading">
            {{ forgotLoading ? $t('login.forgot.resetting') : $t('login.forgot.resetBtn') }}
          </button>
          <button class="back-button" @click="forgotStep = 'email'">{{ $t('common.back') }}</button>
          <p v-if="forgotSuccess" class="success-msg">{{ $t('login.forgot.success') }}</p>
          <p v-if="authStore.error" class="error">{{ authStore.error }}</p>
          <p v-if="localError" class="error">{{ localError }}</p>
        </template>

        <!-- ─── SSO QR-scan panel ────────────────────────────────────── -->
        <template v-if="authStore.qrPanel && authStore.loginStep === 'credentials'">
          <div class="sso-qr-panel">
            <p class="totp-title">{{ qrPanelTitle }}</p>
            <p class="totp-hint">{{ $t('login.qr.hint') }}</p>
            <div class="qr-container">
              <img v-if="qrDataUrl" :src="qrDataUrl" alt="QR" class="qr-code">
              <div v-else class="qr-code qr-placeholder"></div>
            </div>
            <p v-if="authStore.qrPanel.status === 'error'" class="error">
              {{ authStore.qrPanel.error }}
            </p>
            <button class="back-button" @click="authStore.cancelSsoQr()">
              {{ $t('common.back') }}
            </button>
          </div>
        </template>

        <!-- ─── Registration ────────────────────────────────────────── -->
        <template v-else-if="authStore.loginStep === 'register'">
          <p class="totp-title">{{ $t('login.register.title') }}</p>
          <input
            v-if="false"
            type="text"
            v-model="regInvitationCode"
            :placeholder="$t('login.register.inviteCode')"
            autocomplete="off"
            ref="regCodeInput"
            class="code-input"
          >
          <input
            type="text"
            v-model="regUsername"
            :placeholder="$t('login.register.username')"
            autocomplete="username"
          >
          <input
            type="password"
            v-model="regPassword"
            :placeholder="$t('login.register.password')"
            autocomplete="new-password"
          >
          <input
            type="password"
            v-model="regPasswordConfirm"
            @keypress.enter="doRegister"
            :placeholder="$t('login.register.confirmPassword')"
            autocomplete="new-password"
          >
          <input
            type="email"
            v-model="regEmail"
            :placeholder="$t('login.register.email')"
            autocomplete="email"
          >
          <button class="primary-btn" @click="doRegister" :disabled="authStore.loading">
            {{ authStore.loading ? $t('login.register.submitting') : $t('login.register.submit') }}
          </button>
          <button class="back-button" @click="authStore.backToCredentials">
            {{ $t('login.register.back') }}
          </button>
          <p v-if="registerSuccess" class="success-msg">{{ $t('login.register.success') }}</p>
          <p v-if="authStore.error" class="error">{{ authStore.error }}</p>
          <p v-if="localError" class="error">{{ localError }}</p>
        </template>

        <!-- ─── TOTP Setup ──────────────────────────────────────────── -->
        <template v-else-if="authStore.loginStep === 'totp-setup'">
          <div class="totp-setup">
            <p class="totp-title">{{ $t('login.totp.setupTitle') }}</p>
            <p class="totp-hint">{{ $t('login.totp.setupHint') }}</p>
            <div class="qr-container">
              <img :src="authStore.qrCode" alt="TOTP QR Code" class="qr-code">
            </div>
            <div class="secret-container">
              <p class="secret-label">{{ $t('login.totp.manualKey') }}</p>
              <code class="secret-key">{{ authStore.totpSecret }}</code>
            </div>
            <input
              type="text"
              v-model="totpCode"
              @keypress.enter="setupTotp"
              :placeholder="$t('login.totp.enterCode')"
              autocomplete="one-time-code"
              inputmode="numeric"
              maxlength="6"
              ref="totpInput"
              class="code-input"
            >
            <button class="primary-btn" @click="setupTotp" :disabled="authStore.loading">
              {{ authStore.loading ? $t('login.totp.verifying') : $t('login.totp.complete') }}
            </button>
            <button class="back-button" @click="authStore.backToCredentials">
              {{ $t('common.back') }}
            </button>
          </div>
        </template>

        <!-- ─── TOTP Verification ───────────────────────────────────── -->
        <template v-else-if="authStore.loginStep === 'totp'">
          <p class="verification-hint">{{ $t('login.totp.prompt') }}</p>
          <input
            type="text"
            v-model="totpCode"
            @keypress.enter="verifyTotp"
            :placeholder="$t('login.totp.enterCode')"
            autocomplete="one-time-code"
            inputmode="numeric"
            maxlength="6"
            ref="totpInput"
            class="code-input"
          >
          <button class="primary-btn" @click="verifyTotp" :disabled="authStore.loading">
            {{ authStore.loading ? $t('login.totp.verifying') : $t('login.totp.verify') }}
          </button>
          <button class="back-button" @click="authStore.backToCredentials">
            {{ $t('common.back') }}
          </button>
        </template>

        <!-- ─── Email Verification ──────────────────────────────────── -->
        <template v-else-if="authStore.loginStep === 'verification'">
          <p class="verification-hint">
            {{ $t('login.email.codeSent', { email: authStore.emailHint }) }}
          </p>
          <input
            type="text"
            v-model="verificationCode"
            @keypress.enter="verify"
            :placeholder="$t('login.email.enterCode')"
            autocomplete="one-time-code"
            inputmode="numeric"
            maxlength="6"
            ref="codeInput"
            class="code-input"
          >
          <button class="primary-btn" @click="verify" :disabled="authStore.loading">
            {{ authStore.loading ? $t('login.email.verifying') : $t('login.email.verify') }}
          </button>
          <button class="back-button" @click="authStore.backToCredentials">
            {{ $t('common.back') }}
          </button>
        </template>
      </div>
    </div>
  `,
  setup() {
    const authStore = useAuthStore();
    const t = Vue.inject('t');
    const currentLocale = Vue.inject('locale');
    const username = Vue.ref('');
    const password = Vue.ref('');
    const verificationCode = Vue.ref('');
    const totpCode = Vue.ref('');
    const localError = Vue.ref('');
    const usernameInput = Vue.ref(null);
    const passwordInput = Vue.ref(null);
    const codeInput = Vue.ref(null);
    const totpInput = Vue.ref(null);
    const regCodeInput = Vue.ref(null);
    const qrCanvas = Vue.ref(null);
    const qrDataUrl = Vue.ref('');

    // Default to OAuth-first; remember last user choice for the session.
    const loginMode = Vue.ref(localStorage.getItem('loginMode') === 'credentials' ? 'credentials' : 'oauth');
    Vue.watch(loginMode, (v) => localStorage.setItem('loginMode', v));

    // Registration fields
    const regInvitationCode = Vue.ref('');
    const regUsername = Vue.ref('');
    const regPassword = Vue.ref('');
    const regPasswordConfirm = Vue.ref('');
    const regEmail = Vue.ref('');
    const registerSuccess = Vue.ref(false);

    // Forgot-password flow state. forgotStep: '' | 'email' | 'verify'.
    const forgotStep = Vue.ref('');
    const forgotEmail = Vue.ref('');
    const forgotResetToken = Vue.ref('');
    const forgotCode = Vue.ref('');
    const forgotNewPassword = Vue.ref('');
    const forgotConfirm = Vue.ref('');
    const forgotLoading = Vue.ref(false);
    const forgotSuccess = Vue.ref(false);

    const enterForgotMode = () => {
      localError.value = '';
      authStore.error = null;
      forgotStep.value = 'email';
      forgotEmail.value = '';
      forgotCode.value = '';
      forgotNewPassword.value = '';
      forgotConfirm.value = '';
      forgotResetToken.value = '';
      forgotSuccess.value = false;
    };

    const exitForgotMode = () => {
      forgotStep.value = '';
      forgotResetToken.value = '';
      forgotSuccess.value = false;
    };

    const submitForgotEmail = async () => {
      localError.value = '';
      if (!forgotEmail.value || !/.+@.+\..+/.test(forgotEmail.value)) {
        localError.value = t('login.forgot.emailInvalid');
        return;
      }
      forgotLoading.value = true;
      try {
        const token = await authStore.requestPasswordReset(forgotEmail.value.trim());
        if (!token) return; // store sets authStore.error
        forgotResetToken.value = token;
        forgotStep.value = 'verify';
      } finally {
        forgotLoading.value = false;
      }
    };

    const submitForgotReset = async () => {
      localError.value = '';
      if (!forgotCode.value) { localError.value = t('login.error.enterVerifyCode'); return; }
      if (!forgotNewPassword.value || forgotNewPassword.value.length < 6) {
        localError.value = t('login.error.passwordMinLen'); return;
      }
      if (forgotNewPassword.value !== forgotConfirm.value) {
        localError.value = t('login.error.passwordMismatch'); return;
      }
      forgotLoading.value = true;
      try {
        const ok = await authStore.verifyPasswordReset(
          forgotResetToken.value,
          forgotCode.value,
          forgotNewPassword.value
        );
        if (ok) {
          forgotSuccess.value = true;
          setTimeout(() => {
            exitForgotMode();
            loginMode.value = 'credentials';
          }, 1500);
        }
      } finally {
        forgotLoading.value = false;
      }
    };

    // Provider definitions in fixed priority order. We use SVG icons inline
    // (no external font / image deps) so light + dark themes both look right.
    const PROVIDER_ICONS = {
      alipay: '<svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#1677FF"/><path fill="#fff" d="M25 18.6c-1.5-.5-3-1-4.6-1.7.4-.8.8-1.6 1.1-2.5h-2.9v-1h3.4v-.5h-3.4v-1.6h-1.4c-.3 0-.3.3-.3.3v1.3h-3.6v.5h3.6v1H11v.5h5.7c-.2.6-.4 1.2-.7 1.7-1.7-.5-3.4-.8-4.7-.8-2.2 0-3.7 1-3.8 2.5-.1 1.4.9 3 3.4 3 1.8 0 3.4-.9 4.7-2.5 2.2 1 4.2 2 6.6 2.9.3-.4.5-.8.7-1.2.2-.4.1-.9-.1-1.3zM11 19.7c-1.8 0-2.3-1.3-2.1-2 .1-.4.6-.9 1.4-1.1.4-.1 1.4-.1 2.4.2.9.2 1.8.5 2.7.8-.7 1.4-2.1 2.1-4.4 2.1z"/></svg>',
      microsoft: '<svg viewBox="0 0 21 21" width="20" height="20" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>',
      github: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.3 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2A11.5 11.5 0 0 1 12 5.8c1 0 2 .1 3 .4 2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.7.9 1.2 1.9 1.2 3.2 0 4.6-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"/></svg>',
      google: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.07H2.18A11 11 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.83z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.83C6.71 7.31 9.14 5.38 12 5.38z"/></svg>',
      wechat: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#07C160" d="M9.5 4C5.36 4 2 6.91 2 10.5c0 2.07 1.13 3.91 2.86 5.09L4 18l2.7-1.41c.85.22 1.76.34 2.7.34h.51c-.13-.42-.21-.86-.21-1.32 0-3 2.91-5.43 6.5-5.43.32 0 .64.02.95.06C16.63 7.32 13.4 4 9.5 4zM7 8.5a1 1 0 110 2 1 1 0 010-2zm5 0a1 1 0 110 2 1 1 0 010-2zm4.21 3.66c-3.04 0-5.5 1.92-5.5 4.29 0 1.39.91 2.65 2.34 3.46l-.46 1.5 1.93-.95c.55.13 1.13.2 1.69.2 3.04 0 5.5-1.92 5.5-4.21 0-2.37-2.46-4.29-5.5-4.29zm-1.71 2.21a.75.75 0 110 1.5.75.75 0 010-1.5zm3.42 0a.75.75 0 110 1.5.75.75 0 010-1.5z"/></svg>'
    };

    /**
     * Build the list of providers we'll actually render. Order is fixed
     * (alipay first per product decision), and we drop anything the server
     * hasn't enabled. The first one becomes the visually emphasized button.
     */
    const enabledProviders = Vue.computed(() => {
      const order = ['alipay', 'microsoft', 'github', 'google', 'wechat'];
      return order
        .filter(key => key === 'microsoft' ? authStore.aadEnabled : !!authStore.ssoProviders[key])
        .map(key => ({
          key,
          label: t(`login.${key}`),
          icon: PROVIDER_ICONS[key]
        }));
    });

    const focusPassword = () => {
      if (passwordInput.value) passwordInput.value.focus();
    };

    const switchToCredentials = () => {
      loginMode.value = 'credentials';
      Vue.nextTick(() => {
        if (usernameInput.value) usernameInput.value.focus();
      });
    };

    const handleProviderClick = (provider) => {
      localError.value = '';
      if (provider === 'microsoft') {
        authStore.loginWithMicrosoft();
        return;
      }
      if (provider === 'alipay') {
        // Alipay's H5 authorize page does NOT auto-launch the Alipay app
        // from external mobile browsers (it shows "请在支付宝客户端打开链接").
        // Use the alipays://platformapi/startapp deep-link to actually pull
        // up the app. Inside the Alipay in-app browser, plain redirect works.
        if (isInAlipay()) {
          authStore.loginWithSso(provider);
        } else if (isMobile()) {
          authStore.loginWithAlipayMobile();
        } else {
          authStore.startSsoQr(provider).then(ok => { if (ok) renderQrCode(); });
        }
        return;
      }
      if (provider === 'wechat') {
        // WeChat Open Platform's QR flow only works when scanned from a
        // *different* device. On mobile we have no good alternative without
        // a separate 公众号 appid, so surface a clear hint instead of a
        // QR code the user can't scan.
        if (isMobile() || isInWeChat()) {
          localError.value = t('login.wechat.mobileUnsupported');
          return;
        }
        authStore.startSsoQr(provider).then(ok => { if (ok) renderQrCode(); });
        return;
      }
      authStore.loginWithSso(provider);
    };

    const login = async () => {
      if (!username.value) {
        localError.value = t('login.error.enterUsername');
        return;
      }
      if (!password.value) {
        localError.value = t('login.error.enterPassword');
        return;
      }
      localError.value = '';
      await authStore.login(username.value, password.value);

      Vue.nextTick(() => {
        if ((authStore.loginStep === 'totp' || authStore.loginStep === 'totp-setup') && totpInput.value) {
          totpInput.value.focus();
        } else if (authStore.loginStep === 'verification' && codeInput.value) {
          codeInput.value.focus();
        }
      });
    };

    /**
     * Build a QR data URL for the current authorize URL.
     *
     * Why a data URL (and not a canvas)?
     *   - The QR panel is rendered via v-if; the canvas ref is null on the
     *     same tick the panel mounts, which leaves the canvas blank if the
     *     watch fires before nextTick resolves. Using qrcode-generator's
     *     built-in createDataURL() removes the timing dependency entirely —
     *     the <img> just shows up in the next paint, no ref required.
     *   - 'Byte' mode is required (the default 'Numeric' rejects URLs).
     *   - typeNumber=0 → smallest size that fits; ec='M' → 15% recovery.
     */
    const renderQrCode = () => {
      if (!authStore.qrPanel) return;
      if (typeof qrcode !== 'function') {
        console.error('[LoginPage] qrcode library not loaded');
        return;
      }
      try {
        const qr = qrcode(0, 'M');
        qr.addData(authStore.qrPanel.authorizeUrl, 'Byte');
        qr.make();
        // cellSize=6 → ~220px image at typical QR sizes; quiet zone of 4
        // modules per spec. createDataURL returns a black/white GIF.
        qrDataUrl.value = qr.createDataURL(6, 4);
      } catch (err) {
        console.error('[LoginPage] QR render failed:', err);
      }
    };

    const qrPanelTitle = Vue.computed(() => {
      const p = authStore.qrPanel?.provider;
      if (p === 'alipay') return t('login.qr.titleAlipay');
      if (p === 'wechat') return t('login.qr.titleWechat');
      return t('login.qr.title');
    });

    Vue.watch(() => authStore.qrPanel?.authorizeUrl, (url) => {
      if (url) renderQrCode();
      else qrDataUrl.value = '';
    });

    const verifyTotp = async () => {
      if (!totpCode.value || totpCode.value.length !== 6) {
        localError.value = t('login.error.enter6Digit');
        return;
      }
      localError.value = '';
      const success = await authStore.verifyTotpCode(totpCode.value);
      if (success && authStore.loginStep === 'verification') {
        totpCode.value = '';
        Vue.nextTick(() => { if (codeInput.value) codeInput.value.focus(); });
      }
    };

    const setupTotp = async () => {
      if (!totpCode.value || totpCode.value.length !== 6) {
        localError.value = t('login.error.enter6Digit');
        return;
      }
      localError.value = '';
      const success = await authStore.completeTotpSetup(totpCode.value);
      if (success && authStore.loginStep === 'verification') {
        totpCode.value = '';
        Vue.nextTick(() => { if (codeInput.value) codeInput.value.focus(); });
      }
    };

    const doRegister = async () => {
      localError.value = '';
      registerSuccess.value = false;
      if (!regUsername.value || regUsername.value.length < 2) {
        localError.value = t('login.error.usernameMinLen');
        return;
      }
      if (!regPassword.value || regPassword.value.length < 6) {
        localError.value = t('login.error.passwordMinLen');
        return;
      }
      if (regPassword.value !== regPasswordConfirm.value) {
        localError.value = t('login.error.passwordMismatch');
        return;
      }

      const success = await authStore.register(
        regUsername.value,
        regPassword.value,
        regEmail.value || undefined,
        regInvitationCode.value
      );

      if (success) {
        registerSuccess.value = true;
        username.value = regUsername.value;
        regInvitationCode.value = '';
        regUsername.value = '';
        regPassword.value = '';
        regPasswordConfirm.value = '';
        regEmail.value = '';
        setTimeout(() => authStore.backToCredentials(), 1500);
      }
    };

    const verify = async () => {
      if (!verificationCode.value) {
        localError.value = t('login.error.enterVerifyCode');
        return;
      }
      localError.value = '';
      await authStore.verifyCode(verificationCode.value);
    };

    Vue.onMounted(async () => {
      await authStore.checkAuthMode();

      // If no SSO provider is enabled, fall back to credentials view.
      if (enabledProviders.value.length === 0 && loginMode.value === 'oauth') {
        loginMode.value = 'credentials';
      }

      if (authStore.loginStep === 'credentials' && loginMode.value === 'credentials' && usernameInput.value) {
        usernameInput.value.focus();
      }
    });

    Vue.watch(() => authStore.loginStep, (newStep) => {
      Vue.nextTick(() => {
        if (newStep === 'credentials' && loginMode.value === 'credentials' && usernameInput.value) {
          usernameInput.value.focus();
        } else if ((newStep === 'totp' || newStep === 'totp-setup') && totpInput.value) {
          totpInput.value.focus();
        } else if (newStep === 'verification' && codeInput.value) {
          codeInput.value.focus();
        } else if (newStep === 'register' && regCodeInput.value) {
          regCodeInput.value.focus();
        }
      });
    });

    const toggleLang = () => {
      setLocale(currentLocale.value === 'zh-CN' ? 'en' : 'zh-CN');
    };

    return {
      authStore,
      currentLocale,
      toggleLang,
      loginMode,
      switchToCredentials,
      enabledProviders,
      handleProviderClick,
      qrCanvas,
      qrDataUrl,
      qrPanelTitle,
      username,
      password,
      verificationCode,
      totpCode,
      localError,
      usernameInput,
      passwordInput,
      codeInput,
      totpInput,
      regCodeInput,
      regInvitationCode,
      regUsername,
      regPassword,
      regPasswordConfirm,
      regEmail,
      registerSuccess,
      focusPassword,
      login,
      verify,
      verifyTotp,
      setupTotp,
      doRegister,
      forgotStep,
      forgotEmail,
      forgotResetToken,
      forgotCode,
      forgotNewPassword,
      forgotConfirm,
      forgotLoading,
      forgotSuccess,
      enterForgotMode,
      exitForgotMode,
      submitForgotEmail,
      submitForgotReset
    };
  }
};
