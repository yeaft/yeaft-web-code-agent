import { useAuthStore } from '../stores/auth.js';
import { setLocale } from '../utils/i18n.js';

export default {
  name: 'LoginPage',
  template: `
    <div class="login-page">
      <button class="login-lang-toggle" @click="toggleLang">
        {{ currentLocale === 'zh-CN' ? 'EN' : '中文' }}
      </button>
      <div class="login-container">
        <h1>Claude Web Chat</h1>
        <p class="login-subtitle">{{ $t('login.subtitle') }}</p>

        <!-- Step 1: Username/Password -->
        <template v-if="authStore.loginStep === 'credentials' && !authStore.qrPanel">
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
          <button @click="login" :disabled="authStore.loading">
            {{ authStore.loading ? $t('login.loggingIn') : $t('login.login') }}
          </button>
          <template v-if="hasAnySso">
            <div class="login-divider">
              <span>{{ $t('login.or') }}</span>
            </div>
            <button v-if="authStore.aadEnabled" class="ms-login-btn sso-btn sso-btn-microsoft" @click="loginWithMicrosoft" :disabled="authStore.loading">
              <svg class="ms-logo" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg">
                <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
                <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
                <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
                <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
              </svg>
              {{ $t('login.microsoft') }}
            </button>
            <button v-if="authStore.ssoProviders.github" class="sso-btn sso-btn-github" @click="loginWithSso('github')" :disabled="authStore.loading">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.3 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2A11.5 11.5 0 0 1 12 5.8c1 0 2 .1 3 .4 2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.7.9 1.2 1.9 1.2 3.2 0 4.6-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"/></svg>
              {{ $t('login.github') }}
            </button>
            <button v-if="authStore.ssoProviders.google" class="sso-btn sso-btn-google" @click="loginWithSso('google')" :disabled="authStore.loading">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.07H2.18A11 11 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.83z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.83C6.71 7.31 9.14 5.38 12 5.38z"/></svg>
              {{ $t('login.google') }}
            </button>
            <button v-if="authStore.ssoProviders.wechat" class="sso-btn sso-btn-wechat" @click="loginWithSso('wechat')" :disabled="authStore.loading">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="#07C160" d="M9.5 4C5.36 4 2 6.91 2 10.5c0 2.07 1.13 3.91 2.86 5.09L4 18l2.7-1.41c.85.22 1.76.34 2.7.34h.51c-.13-.42-.21-.86-.21-1.32 0-3 2.91-5.43 6.5-5.43.32 0 .64.02.95.06C16.63 7.32 13.4 4 9.5 4zM7 8.5a1 1 0 110 2 1 1 0 010-2zm5 0a1 1 0 110 2 1 1 0 010-2zm4.21 3.66c-3.04 0-5.5 1.92-5.5 4.29 0 1.39.91 2.65 2.34 3.46l-.46 1.5 1.93-.95c.55.13 1.13.2 1.69.2 3.04 0 5.5-1.92 5.5-4.21 0-2.37-2.46-4.29-5.5-4.29zm-1.71 2.21a.75.75 0 110 1.5.75.75 0 010-1.5zm3.42 0a.75.75 0 110 1.5.75.75 0 010-1.5z"/></svg>
              {{ $t('login.wechat') }}
            </button>
            <button v-if="authStore.ssoProviders.alipay" class="sso-btn sso-btn-alipay" @click="loginWithAlipayQr" :disabled="authStore.loading">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="#1677FF" d="M21 15.4c-1.7-.6-3.5-1.2-5.4-2 .5-.9 1-1.9 1.3-3h-3.4v-1.1h4v-.6h-4V6.5h-1.7c-.3 0-.3.3-.3.3v1.9H7.3v.6h4.2v1.1H8v.6h6.7c-.2.7-.5 1.4-.8 2-2-.6-4-1-5.6-1-2.6 0-4.4 1.2-4.5 2.9-.1 1.6 1 3.5 4 3.5 2.1 0 4-1.1 5.5-3 2.6 1.2 5 2.4 7.8 3.4.4-.5.6-1 .8-1.4.2-.5.1-1-.1-1.5zM7.3 16.7c-2.1 0-2.7-1.5-2.5-2.3.1-.5.7-1.1 1.7-1.3.5-.1 1.6-.1 2.8.2 1 .2 2.1.6 3.2.9-.9 1.7-2.5 2.5-5.2 2.5z"/></svg>
              {{ $t('login.alipay') }}
            </button>
          </template>
          <p v-if="authStore.registrationEnabled" class="register-link">
            {{ $t('login.noAccount') }}<a href="#" @click.prevent="authStore.showRegister()">{{ $t('login.registerWithCode') }}</a>
          </p>
        </template>

        <!-- SSO QR-scan panel (Alipay etc.) -->
        <template v-if="authStore.qrPanel && authStore.loginStep === 'credentials'">
          <div class="sso-qr-panel">
            <p class="totp-title">{{ qrPanelTitle }}</p>
            <p class="totp-hint">{{ $t('login.qr.hint') }}</p>
            <div class="qr-container">
              <canvas ref="qrCanvas" class="qr-code"></canvas>
            </div>
            <p v-if="authStore.qrPanel.status === 'error'" class="error">
              {{ authStore.qrPanel.error }}
            </p>
            <button @click="authStore.cancelSsoQr()" class="back-button">
              {{ $t('common.back') }}
            </button>
          </div>
        </template>

        <!-- Registration -->
        <template v-else-if="authStore.loginStep === 'register'">
          <p class="totp-title">{{ $t('login.register.title') }}</p>
          <!-- TODO: restore invitation code input — currently hidden for open registration -->
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
          <button @click="doRegister" :disabled="authStore.loading">
            {{ authStore.loading ? $t('login.register.submitting') : $t('login.register.submit') }}
          </button>
          <button @click="authStore.backToCredentials" class="back-button">
            {{ $t('login.register.back') }}
          </button>
          <p v-if="registerSuccess" class="success-msg">{{ $t('login.register.success') }}</p>
        </template>

        <!-- TOTP Setup (first time) -->
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
            <button @click="setupTotp" :disabled="authStore.loading">
              {{ authStore.loading ? $t('login.totp.verifying') : $t('login.totp.complete') }}
            </button>
            <button @click="authStore.backToCredentials" class="back-button">
              {{ $t('common.back') }}
            </button>
          </div>
        </template>

        <!-- TOTP Verification (returning user) -->
        <template v-else-if="authStore.loginStep === 'totp'">
          <p class="verification-hint">
            {{ $t('login.totp.prompt') }}
          </p>
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
          <button @click="verifyTotp" :disabled="authStore.loading">
            {{ authStore.loading ? $t('login.totp.verifying') : $t('login.totp.verify') }}
          </button>
          <button @click="authStore.backToCredentials" class="back-button">
            {{ $t('common.back') }}
          </button>
        </template>

        <!-- Email Verification -->
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
          <button @click="verify" :disabled="authStore.loading">
            {{ authStore.loading ? $t('login.email.verifying') : $t('login.email.verify') }}
          </button>
          <button @click="authStore.backToCredentials" class="back-button">
            {{ $t('common.back') }}
          </button>
        </template>

        <p v-if="authStore.error" class="error">{{ authStore.error }}</p>
        <p v-if="localError" class="error">{{ localError }}</p>
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

    // Registration fields
    const regInvitationCode = Vue.ref('');
    const regUsername = Vue.ref('');
    const regPassword = Vue.ref('');
    const regPasswordConfirm = Vue.ref('');
    const regEmail = Vue.ref('');
    const registerSuccess = Vue.ref(false);

    const focusPassword = () => {
      if (passwordInput.value) {
        passwordInput.value.focus();
      }
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

      // Focus appropriate input based on next step
      Vue.nextTick(() => {
        if ((authStore.loginStep === 'totp' || authStore.loginStep === 'totp-setup') && totpInput.value) {
          totpInput.value.focus();
        } else if (authStore.loginStep === 'verification' && codeInput.value) {
          codeInput.value.focus();
        }
      });
    };

    const loginWithMicrosoft = async () => {
      localError.value = '';
      await authStore.loginWithMicrosoft();
    };

    const loginWithSso = (provider) => {
      authStore.loginWithSso(provider);
    };

    const qrCanvas = Vue.ref(null);

    const loginWithAlipayQr = async () => {
      localError.value = '';
      const ok = await authStore.startSsoQr('alipay');
      if (!ok) return;
      Vue.nextTick(() => renderQrCode());
    };

    const renderQrCode = () => {
      if (!authStore.qrPanel || !qrCanvas.value) return;
      if (typeof qrcode !== 'function') {
        console.error('[LoginPage] qrcode library not loaded');
        return;
      }
      try {
        // qrcode-generator: typeNumber=0 (auto), errorCorrectionLevel='M'
        const qr = qrcode(0, 'M');
        qr.addData(authStore.qrPanel.authorizeUrl);
        qr.make();
        const canvas = qrCanvas.value;
        const moduleCount = qr.getModuleCount();
        const cellSize = 6;
        const margin = 4 * cellSize;
        const size = moduleCount * cellSize + margin * 2;
        canvas.width = size;
        canvas.height = size;
        canvas.style.width = '220px';
        canvas.style.height = '220px';
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#000';
        for (let r = 0; r < moduleCount; r++) {
          for (let c = 0; c < moduleCount; c++) {
            if (qr.isDark(r, c)) {
              ctx.fillRect(margin + c * cellSize, margin + r * cellSize, cellSize, cellSize);
            }
          }
        }
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

    // Re-render QR when panel changes (e.g. after retry)
    Vue.watch(() => authStore.qrPanel?.authorizeUrl, (url) => {
      if (url) Vue.nextTick(() => renderQrCode());
    });

    const hasAnySso = Vue.computed(() =>
      authStore.aadEnabled ||
      authStore.ssoProviders.github ||
      authStore.ssoProviders.google ||
      authStore.ssoProviders.wechat ||
      authStore.ssoProviders.alipay
    );

    const verifyTotp = async () => {
      if (!totpCode.value || totpCode.value.length !== 6) {
        localError.value = t('login.error.enter6Digit');
        return;
      }
      localError.value = '';
      const success = await authStore.verifyTotpCode(totpCode.value);
      if (success && authStore.loginStep === 'verification') {
        totpCode.value = '';
        Vue.nextTick(() => {
          if (codeInput.value) codeInput.value.focus();
        });
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
        Vue.nextTick(() => {
          if (codeInput.value) codeInput.value.focus();
        });
      }
    };

    const doRegister = async () => {
      localError.value = '';
      registerSuccess.value = false;

      // TODO: restore invitation code validation — currently disabled for open registration
      // if (!regInvitationCode.value) {
      //   localError.value = t('login.error.enterInviteCode');
      //   return;
      // }
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
        // Auto switch to login after a short delay
        username.value = regUsername.value;
        regInvitationCode.value = '';
        regUsername.value = '';
        regPassword.value = '';
        regPasswordConfirm.value = '';
        regEmail.value = '';
        setTimeout(() => {
          authStore.backToCredentials();
        }, 1500);
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

    // Focus input on mount and check auth mode
    Vue.onMounted(async () => {
      await authStore.checkAuthMode();

      if (authStore.loginStep === 'credentials' && usernameInput.value) {
        usernameInput.value.focus();
      }
    });

    // Watch for step changes to focus appropriate input
    Vue.watch(() => authStore.loginStep, (newStep) => {
      Vue.nextTick(() => {
        if (newStep === 'credentials' && usernameInput.value) {
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
      loginWithMicrosoft,
      loginWithSso,
      loginWithAlipayQr,
      qrCanvas,
      qrPanelTitle,
      hasAnySso,
      verify,
      verifyTotp,
      setupTotp,
      doRegister
    };
  }
};
