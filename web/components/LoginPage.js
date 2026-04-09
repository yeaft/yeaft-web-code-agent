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
        <template v-if="authStore.loginStep === 'credentials'">
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
          <template v-if="authStore.aadEnabled">
            <div class="login-divider">
              <span>{{ $t('login.or') }}</span>
            </div>
            <button class="ms-login-btn" @click="loginWithMicrosoft" :disabled="authStore.loading">
              <svg class="ms-logo" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg">
                <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
                <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
                <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
                <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
              </svg>
              {{ $t('login.microsoft') }}
            </button>
          </template>
          <p v-if="authStore.registrationEnabled" class="register-link">
            {{ $t('login.noAccount') }}<a href="#" @click.prevent="authStore.showRegister()">{{ $t('login.registerWithCode') }}</a>
          </p>
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
      verify,
      verifyTotp,
      setupTotp,
      doRegister
    };
  }
};
