/**
 * Authentication store for managing login state
 */
import { decodeKey } from '../utils/encryption.js';
import {
  bindWorkCenterBrowserOwner,
  clearWorkCenterBrowserOwner,
} from './helpers/work-center-browser-state.js';
const { defineStore } = Pinia;

function clearYeaftHistoryMemory() {
  try {
    const chatStore = globalThis.Pinia?.useChatStore?.();
    chatStore?.clearYeaftHistoryMemory?.();
  } catch {
    // The auth store can reset before the chat store is installed.
  }
}

function clearPluginBrowserState() {
  try { globalThis.Pinia?.useChatStore?.()?.clearPluginState?.(); } catch {
    // Authentication can initialize before the chat store is installed.
  }
}

let activeYeaftHistoryOwnerId = null;

function bindYeaftHistoryOwner(ownerId) {
  clearPluginBrowserState();
  const nextOwnerId = String(ownerId || '').trim() || null;
  try { globalThis.Pinia?.useChatStore?.()?.bindScheduledTaskNotificationOwner?.(nextOwnerId); } catch {}
  if (activeYeaftHistoryOwnerId !== nextOwnerId) clearYeaftHistoryMemory();
  activeYeaftHistoryOwnerId = nextOwnerId;
}

function clearYeaftHistoryOwner() {
  try { globalThis.Pinia?.useChatStore?.()?.bindScheduledTaskNotificationOwner?.(null); } catch {}
  clearPluginBrowserState();
  clearYeaftHistoryMemory();
  activeYeaftHistoryOwnerId = null;
}

const SESSION_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export const useAuthStore = defineStore('auth', {
  state: () => ({
    // Auth mode from server
    skipAuth: false,
    emailVerification: false,
    passwordResetEnabled: false,
    totpEnabled: false,
    registrationEnabled: false,
    aadEnabled: false,
    aadClientId: null,
    aadTenantId: null,
    // Server-driven SSO providers (from /api/auth/mode → ssoProviders)
    ssoProviders: { github: false, google: false, wechat: false, alipay: false },

    // Linked identities for the logged-in user (loaded on demand)
    linkedIdentities: [],
    hasPassword: false,
    identitiesLoading: false,
    identitiesError: null,

    // Current auth state
    initialized: false,
    authGeneration: 0,
    isAuthenticated: false,
    token: null,
    sessionKey: null, // Uint8Array for encryption
    userId: null,
    role: null, // 'admin' | 'pro'

    // Login flow state
    // 'credentials' | 'totp' | 'totp-setup' | 'verification' | 'register' | 'authenticated'
    loginStep: 'credentials',
    tempToken: null,
    emailHint: null,

    // TOTP setup state
    setupToken: null,
    totpSecret: null,
    qrCode: null,

    // Error handling
    error: null,
    loading: false,

    // SSO QR-scan flow (in-page QR for providers like Alipay/WeChat)
    qrPanel: null, // { provider, authorizeUrl, state, status: 'pending'|'scanned'|'error', error? } | null
    _qrPollTimer: null,
    _sessionRefreshTimer: null,
    _sessionRefreshVisibilityHandler: null
  }),

  actions: {
    /** Resolve the server-backed browser session before rendering login. */
    async initialize() {
      if (this.initialized) return this.isAuthenticated;
      try {
        await this.checkAuthMode();
        if (this.skipAuth && this.isAuthenticated) return true;
        let ssoConsumed = false;
        if (typeof window !== 'undefined' && typeof this.consumeSsoRedirect === 'function') {
          ssoConsumed = this.consumeSsoRedirect();
        }
        if (!this.isAuthenticated && !ssoConsumed) {
          await this.restoreSession();
        }
        return this.isAuthenticated;
      } finally {
        this.initialized = true;
      }
    },

    /**
     * Check auth mode from server
     */
    async checkAuthMode() {
      try {
        const response = await fetch('/api/auth/mode');
        const data = await response.json();
        this.skipAuth = data.skipAuth;
        this.emailVerification = data.emailVerification;
        this.passwordResetEnabled = !!data.passwordResetEnabled;
        this.totpEnabled = data.totpEnabled;
        this.registrationEnabled = data.registrationEnabled || false;
        this.aadEnabled = data.aadEnabled || false;
        this.aadClientId = data.aadClientId || null;
        this.aadTenantId = data.aadTenantId || null;
        this.ssoProviders = Object.assign(
          { github: false, google: false, wechat: false, alipay: false },
          data.ssoProviders || {}
        );

        if (this.skipAuth) {
          // In skip auth mode, one local browser owner is the complete auth boundary.
          this.userId = 'skip-auth';
          bindWorkCenterBrowserOwner(this.userId);
          bindYeaftHistoryOwner(this.userId);
          this.authGeneration += 1;
          this.isAuthenticated = true;
          this.loginStep = 'authenticated';
        }
      } catch (err) {
        console.error('Failed to check auth mode:', err);
      }
    },

    /**
     * Step 1: Login with username and password
     */
    async login(username, password) {
      this.loading = true;
      this.error = null;

      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (!data.success) {
          this.error = data.error || 'Login failed';
          return false;
        }

        if (data.needTotpSetup) {
          // First-time TOTP setup required
          this.setupToken = data.setupToken;
          this.totpSecret = data.totpSecret;
          this.qrCode = data.qrCode;
          this.loginStep = 'totp-setup';
          return true;
        }

        if (data.needTotpCode) {
          // TOTP verification required
          this.tempToken = data.tempToken;
          this.loginStep = 'totp';
          return true;
        }

        if (data.needEmailCode) {
          // Need email verification
          this.tempToken = data.tempToken;
          this.emailHint = data.emailHint;
          this.loginStep = 'verification';
          return true;
        }

        // No verification needed - login complete
        this.token = data.token;
        this.sessionKey = data.sessionKey ? decodeKey(data.sessionKey) : null;
        this.role = data.role || 'pro';
        this.userId = data.userId || null;
        bindWorkCenterBrowserOwner(this.userId);
        bindYeaftHistoryOwner(this.userId);
        this.authGeneration += 1;
        this.isAuthenticated = true;
        this.loginStep = 'authenticated';

        // Store token for reconnection (use localStorage for persistence across refreshes)
        localStorage.setItem('authToken', data.token);
        this.startSessionRefresh();
        console.log('[Auth] Token saved to localStorage:', !!data.token);

        return true;
      } catch (err) {
        this.error = err.message || 'Network error';
        return false;
      } finally {
        this.loading = false;
      }
    },

    /**
     * Login with Microsoft (Azure AD) via MSAL.js popup
     */
    async loginWithMicrosoft() {
      if (!this.aadEnabled || !this.aadClientId || !this.aadTenantId) {
        this.error = 'Microsoft login is not configured';
        return false;
      }

      // Check if MSAL library is loaded
      if (typeof msal === 'undefined' || !msal.PublicClientApplication) {
        this.error = 'Microsoft authentication library not loaded';
        return false;
      }

      this.loading = true;
      this.error = null;

      try {
        // Initialize MSAL instance
        const msalConfig = {
          auth: {
            clientId: this.aadClientId,
            authority: `https://login.microsoftonline.com/${this.aadTenantId}`,
            redirectUri: window.location.origin + '/auth/callback'
          },
          cache: {
            cacheLocation: 'sessionStorage',
            storeAuthStateInCookie: false
          }
        };

        const msalInstance = new msal.PublicClientApplication(msalConfig);
        await msalInstance.initialize();

        // Login via popup
        const loginResponse = await msalInstance.loginPopup({
          scopes: ['openid', 'profile', 'email']
        });

        if (!loginResponse || !loginResponse.idToken) {
          this.error = 'Microsoft login failed: no token received';
          return false;
        }

        // Send id_token to our backend for verification
        const response = await fetch('/api/auth/aad', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: loginResponse.idToken })
        });

        const data = await response.json();

        if (!data.success) {
          this.error = data.error || 'Microsoft login failed';
          return false;
        }

        // Login complete
        this.token = data.token;
        this.sessionKey = data.sessionKey ? decodeKey(data.sessionKey) : null;
        this.role = data.role || 'pro';
        this.userId = data.userId || null;
        bindWorkCenterBrowserOwner(this.userId);
        bindYeaftHistoryOwner(this.userId);
        this.authGeneration += 1;
        this.isAuthenticated = true;
        this.loginStep = 'authenticated';

        localStorage.setItem('authToken', data.token);
        this.startSessionRefresh();
        console.log('[Auth] Microsoft AAD login successful, token saved');
        return true;
      } catch (err) {
        // MSAL popup cancelled by user
        if (err.errorCode === 'user_cancelled' || err.name === 'BrowserAuthError') {
          this.error = null; // Don't show error for user cancellation
          return false;
        }
        console.error('[Auth] Microsoft login error:', err);
        this.error = err.message || 'Microsoft login failed';
        return false;
      } finally {
        this.loading = false;
      }
    },

    /**
     * Verify TOTP code (for returning users)
     */
    async verifyTotpCode(totpCode) {
      this.loading = true;
      this.error = null;

      try {
        const response = await fetch('/api/auth/verify-totp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tempToken: this.tempToken, totpCode })
        });

        const data = await response.json();

        if (!data.success) {
          this.error = data.error || 'TOTP verification failed';
          return false;
        }

        if (data.needEmailCode) {
          // Need email verification next
          this.tempToken = data.tempToken;
          this.emailHint = data.emailHint;
          this.loginStep = 'verification';
          return true;
        }

        // Login complete
        this.token = data.token;
        this.sessionKey = data.sessionKey ? decodeKey(data.sessionKey) : null;
        this.role = data.role || 'pro';
        this.userId = data.userId || null;
        bindWorkCenterBrowserOwner(this.userId);
        bindYeaftHistoryOwner(this.userId);
        this.authGeneration += 1;
        this.isAuthenticated = true;
        this.loginStep = 'authenticated';
        this.tempToken = null;

        localStorage.setItem('authToken', data.token);
        this.startSessionRefresh();
        console.log('[Auth] TOTP verified, token saved to localStorage:', !!data.token);
        return true;
      } catch (err) {
        this.error = err.message || 'Network error';
        return false;
      } finally {
        this.loading = false;
      }
    },

    /**
     * Complete TOTP setup (for first-time users)
     */
    async completeTotpSetup(totpCode) {
      this.loading = true;
      this.error = null;

      try {
        const response = await fetch('/api/auth/setup-totp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setupToken: this.setupToken, totpCode })
        });

        const data = await response.json();

        if (!data.success) {
          this.error = data.error || 'TOTP setup failed';
          return false;
        }

        // Clear setup state
        this.setupToken = null;
        this.totpSecret = null;
        this.qrCode = null;

        if (data.needEmailCode) {
          // Need email verification next
          this.tempToken = data.tempToken;
          this.emailHint = data.emailHint;
          this.loginStep = 'verification';
          return true;
        }

        // Login complete
        this.token = data.token;
        this.sessionKey = data.sessionKey ? decodeKey(data.sessionKey) : null;
        this.role = data.role || 'pro';
        this.userId = data.userId || null;
        bindWorkCenterBrowserOwner(this.userId);
        bindYeaftHistoryOwner(this.userId);
        this.authGeneration += 1;
        this.isAuthenticated = true;
        this.loginStep = 'authenticated';

        localStorage.setItem('authToken', data.token);
        this.startSessionRefresh();
        console.log('[Auth] TOTP setup complete, token saved to localStorage:', !!data.token);
        return true;
      } catch (err) {
        this.error = err.message || 'Network error';
        return false;
      } finally {
        this.loading = false;
      }
    },

    /**
     * Step 2: Verify email code
     */
    async verifyCode(code) {
      this.loading = true;
      this.error = null;

      try {
        const response = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tempToken: this.tempToken, code })
        });

        const data = await response.json();

        if (!data.success) {
          this.error = data.error || 'Verification failed';
          return false;
        }

        this.token = data.token;
        this.sessionKey = data.sessionKey ? decodeKey(data.sessionKey) : null;
        this.role = data.role || 'pro';
        this.userId = data.userId || null;
        bindWorkCenterBrowserOwner(this.userId);
        bindYeaftHistoryOwner(this.userId);
        this.authGeneration += 1;
        this.isAuthenticated = true;
        this.loginStep = 'authenticated';
        this.tempToken = null;
        this.emailHint = null;

        // Store token for reconnection
        localStorage.setItem('authToken', data.token);
        this.startSessionRefresh();
        console.log('[Auth] Email verified, token saved to localStorage:', !!data.token);

        return true;
      } catch (err) {
        this.error = err.message || 'Network error';
        return false;
      } finally {
        this.loading = false;
      }
    },

    /**
     * Register a new user via invitation code
     */
    async register(username, password, email, invitationCode) {
      this.loading = true;
      this.error = null;

      try {
        const response = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, email: email || undefined, invitationCode })
        });

        const data = await response.json();

        if (!data.success) {
          this.error = data.error || 'Registration failed';
          return false;
        }

        return true;
      } catch (err) {
        this.error = err.message || 'Network error';
        return false;
      } finally {
        this.loading = false;
      }
    },

    /**
     * Switch to registration form
     */
    showRegister() {
      this.loginStep = 'register';
      this.error = null;
    },

    /**
     * Server-driven SSO: redirect to provider start URL.
     * Works for github / google / wechat / alipay / microsoft.
     */
    loginWithSso(provider) {
      window.location.href = `/api/auth/sso/${encodeURIComponent(provider)}/start`;
    },

    /**
     * Mobile-Alipay deep-link launch.
     *
     * Problem: on a phone, the user has only ONE app to scan a QR — they
     * can't scan a QR shown on the same screen. And Alipay's H5 authorize
     * page does NOT auto-pull-up the Alipay app from external browsers
     * (it shows "请在支付宝客户端打开链接").
     *
     * Solution: combine the QR flow's polling mechanism with Alipay's
     * `alipays://platformapi/startapp` URL scheme.
     *
     *   1) Hit /start-qr to mint a `state` and get the authorize URL.
     *      The state is registered with mode='qr', so when Alipay's
     *      callback fires it gets PARKED on the server (under that state)
     *      instead of redirecting the device that completed auth.
     *   2) Wrap the URL in alipays://platformapi/startapp?appId=20000067&url=…
     *      and navigate. The OS launches the Alipay app; the user
     *      consents inside Alipay; Alipay's webview hits our callback,
     *      which parks the result.
     *   3) Meanwhile, the user's ORIGINAL browser (Safari/Chrome) keeps
     *      polling /api/auth/sso/poll/:state. When the user switches
     *      back to that browser, the next poll picks up the result and
     *      logs them in there. No cross-browser cookie sharing needed.
     *
     * Returns true if the deep-link was launched. Polling is started
     * automatically (qrPanel.status drives the UI).
     */
    async loginWithAlipayMobile({ intent = 'login' } = {}) {
      const ok = await this.startSsoQr('alipay', { intent });
      if (!ok) return false;
      const authorizeUrl = this.qrPanel?.authorizeUrl;
      if (!authorizeUrl) return false;
      const deepLink = `alipays://platformapi/startapp?appId=20000067&url=${encodeURIComponent(authorizeUrl)}`;
      // Mark the panel so the UI can show a mobile-friendly "waiting for
      // Alipay" message instead of rendering a QR canvas.
      this.qrPanel = { ...this.qrPanel, mobileDeepLink: true };
      window.location.href = deepLink;
      return true;
    },

    /**
     * Server-driven SSO via in-page QR scan. PC frontend renders the QR code
     * locally; user scans with phone; server's /poll endpoint reports back
     * once the callback fires. Used for Alipay (and WeChat-PC in future).
     *
     * Returns true if the QR was successfully fetched and rendered.
     */
    async startSsoQr(provider, { intent = 'login' } = {}) {
      this.cancelSsoQr();
      this.error = null;
      try {
        const params = new URLSearchParams();
        if (intent === 'bind') {
          if (!this.isAuthenticated) {
            this.error = 'You must be logged in to bind an identity';
            return false;
          }
          params.set('intent', 'bind');
        }
        const qs = params.toString();
        const url = `/api/auth/sso/${encodeURIComponent(provider)}/start-qr${qs ? '?' + qs : ''}`;
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok || !data.success) {
          this.error = data.error || 'Failed to start QR login';
          return false;
        }
        this.qrPanel = {
          provider,
          intent,
          authorizeUrl: data.authorizeUrl,
          state: data.state,
          status: 'pending',
          error: null
        };
        this._startQrPoll();
        return true;
      } catch (err) {
        this.error = err.message || 'Network error';
        return false;
      }
    },

    _startQrPoll() {
      this._stopQrPollTimer();
      const tick = async () => {
        if (!this.qrPanel) return;
        const state = this.qrPanel.state;
        try {
          const res = await fetch(`/api/auth/sso/poll/${encodeURIComponent(state)}`);
          const data = await res.json();
          if (!this.qrPanel || this.qrPanel.state !== state) return; // cancelled

          if (data.status === 'pending') return;
          if (data.status === 'login') {
            this.token = data.token;
            this.sessionKey = data.sessionKey ? decodeKey(data.sessionKey) : null;
            this.role = data.role || 'pro';
            this.userId = data.userId || null;
            bindWorkCenterBrowserOwner(this.userId);
            bindYeaftHistoryOwner(this.userId);
            this.authGeneration += 1;
            this.isAuthenticated = true;
            this.loginStep = 'authenticated';
            localStorage.setItem('authToken', data.token);
            this.startSessionRefresh();
            this.cancelSsoQr();
            return;
          }
          if (data.status === 'bind') {
            this.qrPanel = { ...this.qrPanel, status: 'bound' };
            this._stopQrPollTimer();
            // Settings page will reload identities when it sees this status.
            return;
          }
          // error
          this.qrPanel = { ...this.qrPanel, status: 'error', error: data.error || 'SSO failed' };
          this._stopQrPollTimer();
        } catch (err) {
          // transient network failure — keep polling
          console.warn('[Auth] QR poll error:', err.message);
        }
      };
      this._qrPollTick = tick;
      this._qrPollTimer = setInterval(tick, 2000);

      // Mobile browsers (especially iOS Safari) throttle or fully suspend
      // setInterval in backgrounded tabs. When the user is bounced into
      // the Alipay app and stays there a while, our poll timer freezes;
      // the next tick after they return can take many seconds — looking
      // like the page is stuck. Re-fire immediately on tab visibility
      // change, and reset the interval so the following tick is a fresh
      // 2s away. `pageshow` covers iOS bfcache restore where
      // `visibilitychange` doesn't fire.
      if (typeof document !== 'undefined' && !this._qrVisHandler) {
        this._qrVisHandler = () => {
          if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return;
          if (!this.qrPanel || !this._qrPollTick) return;
          this._qrPollTick();
          if (this._qrPollTimer) clearInterval(this._qrPollTimer);
          this._qrPollTimer = setInterval(this._qrPollTick, 2000);
        };
        document.addEventListener('visibilitychange', this._qrVisHandler);
        if (typeof window !== 'undefined') {
          window.addEventListener('pageshow', this._qrVisHandler);
        }
      }
    },

    _stopQrPollTimer() {
      if (this._qrPollTimer) {
        clearInterval(this._qrPollTimer);
        this._qrPollTimer = null;
      }
      if (this._qrVisHandler) {
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', this._qrVisHandler);
        }
        if (typeof window !== 'undefined') {
          window.removeEventListener('pageshow', this._qrVisHandler);
        }
        this._qrVisHandler = null;
      }
      this._qrPollTick = null;
    },

    cancelSsoQr() {
      this._stopQrPollTimer();
      this.qrPanel = null;
    },

    /**
     * Bind an additional SSO identity to the currently logged-in user.
     * The same-origin navigation carries the browser session cookie.
     */
    bindSso(provider) {
      if (!this.isAuthenticated) {
        this.error = 'You must be logged in to bind an identity';
        return;
      }
      const params = new URLSearchParams({ intent: 'bind' });
      window.location.href = `/api/auth/sso/${encodeURIComponent(provider)}/start?${params.toString()}`;
    },

    /**
     * Consume an SSO redirect of the form `#/sso-complete?token=...&sessionKey=...&role=...`.
     * Returns true if a token was found and applied. Safe to call on every page load.
     */
    consumeSsoRedirect() {
      const hash = window.location.hash || '';
      const idx = hash.indexOf('?');
      if (!hash.startsWith('#/sso-complete') || idx < 0) return false;
      const params = new URLSearchParams(hash.slice(idx + 1));
      const token = params.get('token');
      const sessionKey = params.get('sessionKey');
      const role = params.get('role');
      const userId = params.get('userId');
      if (!token) return false;
      this.token = token;
      this.sessionKey = sessionKey ? decodeKey(sessionKey) : null;
      this.role = role || 'pro';
      this.userId = userId || null;
      bindWorkCenterBrowserOwner(this.userId);
      bindYeaftHistoryOwner(this.userId);
      this.authGeneration += 1;
      this.isAuthenticated = true;
      this.loginStep = 'authenticated';
      localStorage.setItem('authToken', token);
      this.startSessionRefresh();
      // Clear the hash so the token never lingers in history.
      try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch {}
      return true;
    },

    /**
     * Load the current user's bound identities. Used by the Settings → Account tab.
     */
    async loadIdentities() {
      if (!this.isAuthenticated) return;
      this.identitiesLoading = true;
      this.identitiesError = null;
      try {
        const res = await fetch('/api/auth/identities');
        const data = await res.json();
        if (!res.ok || !data.success) {
          this.identitiesError = data.error || 'Failed to load identities';
          return;
        }
        this.linkedIdentities = data.identities || [];
        this.hasPassword = !!data.hasPassword;
      } catch (err) {
        this.identitiesError = err.message || 'Network error';
      } finally {
        this.identitiesLoading = false;
      }
    },

    /**
     * Unbind an SSO identity for the current user.
     */
    async unbindIdentity(provider) {
      if (!this.isAuthenticated) return false;
      this.identitiesError = null;
      try {
        const res = await fetch(`/api/auth/identities/${encodeURIComponent(provider)}`, {
          method: 'DELETE'
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          this.identitiesError = data.error || 'Failed to unbind';
          return false;
        }
        this.linkedIdentities = this.linkedIdentities.filter(i => i.provider !== provider);
        return true;
      } catch (err) {
        this.identitiesError = err.message || 'Network error';
        return false;
      }
    },

    async refreshSession() {
      const requestToken = this.token;
      const requestGeneration = this.authGeneration;
      const requestWasAuthenticated = this.isAuthenticated;
      try {
        const res = await fetch('/api/user/profile', {
          headers: requestToken ? { 'Authorization': `Bearer ${requestToken}` } : {}
        });

        if (this.handleAuthResponse(res, requestToken, requestGeneration, requestWasAuthenticated)) {
          return false;
        }

        if (!res.ok) return false;

        const profile = await res.json().catch(() => ({}));
        if (requestGeneration !== this.authGeneration || this.token !== requestToken) {
          return this.isAuthenticated;
        }
        const freshToken = res.headers?.get?.('X-New-Token');
        const storedToken = localStorage.getItem('authToken');
        if (freshToken && this.token === requestToken && (!storedToken || storedToken === requestToken)) {
          this.token = freshToken;
          localStorage.setItem('authToken', freshToken);
        }
        if (profile?.role) this.role = profile.role;
        const previousUserId = this.userId;
        this.userId = profile?.userId || null;
        bindWorkCenterBrowserOwner(this.userId);
        if (previousUserId !== this.userId) clearYeaftHistoryMemory();
        activeYeaftHistoryOwnerId = this.userId;
        return true;
      } catch (err) {
        console.warn('[Auth] Session refresh failed:', err.message || err);
        return false;
      }
    },

    startSessionRefresh() {
      this.stopSessionRefresh();
      if (!this.isAuthenticated || this.skipAuth) return;
      const refreshIfVisible = () => {
        if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return;
        this.refreshSession();
      };
      this._sessionRefreshTimer = setInterval(refreshIfVisible, SESSION_REFRESH_INTERVAL_MS);
      this._sessionRefreshVisibilityHandler = refreshIfVisible;
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', refreshIfVisible);
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('pageshow', refreshIfVisible);
      }
    },

    stopSessionRefresh() {
      if (this._sessionRefreshTimer) {
        clearInterval(this._sessionRefreshTimer);
        this._sessionRefreshTimer = null;
      }
      if (this._sessionRefreshVisibilityHandler) {
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', this._sessionRefreshVisibilityHandler);
        }
        if (typeof window !== 'undefined') {
          window.removeEventListener('pageshow', this._sessionRefreshVisibilityHandler);
        }
        this._sessionRefreshVisibilityHandler = null;
      }
    },

    /**
     * Logout
     */
    async logout() {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        await fetch('/api/auth/logout', { method: 'POST', headers });
      } catch (err) {
        console.error('Logout error:', err);
      }

      await this.clearStoredSession();
    },

    clearStoredSession(error = null) {
      const historyCleanup = this.reset();
      localStorage.removeItem('authToken');
      if (error) this.error = error;
      return historyCleanup;
    },

    getActiveToken() {
      if (this.token) return this.token;
      const stored = localStorage.getItem('authToken');
      if (stored) this.token = stored;
      return this.token;
    },

    /** Only current-session authentication failures invalidate login. */
    handleAuthResponse(
      response,
      failedToken = null,
      failedGeneration = this.authGeneration,
      requestWasAuthenticated = this.isAuthenticated,
      error = undefined,
    ) {
      if (!response || response.status !== 401) return false;
      if (!requestWasAuthenticated || failedGeneration !== this.authGeneration) return false;
      const activeToken = this.token || localStorage.getItem('authToken') || null;
      if (failedToken !== activeToken) return false;
      this.handleAuthFailure(error, failedToken, failedGeneration);
      return true;
    },

    handleAuthFailure(
      error = 'Session expired. Please log in again.',
      failedToken = null,
      failedGeneration = this.authGeneration,
    ) {
      // Old WebSocket or fetch failures must not clear a newer login.
      if (failedGeneration !== this.authGeneration) return false;
      const activeToken = this.token || localStorage.getItem('authToken') || null;
      if (failedToken !== activeToken) return false;
      this.clearStoredSession(error);
      return false;
    },

    /**
     * Try to restore session from stored token
     */
    async restoreSession() {
      const token = localStorage.getItem('authToken');
      const requestGeneration = this.authGeneration;
      const requestWasAuthenticated = this.isAuthenticated || !!token;
      console.log('[Auth] Restoring session, token exists:', !!token);

      try {
        const res = await fetch('/api/user/profile', {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });

        if (this.handleAuthResponse(res, token, requestGeneration, requestWasAuthenticated)) {
          return false;
        }

        if (!res.ok) {
          this.error = 'Failed to restore session';
          return false;
        }

        const profile = await res.json();
        if (requestGeneration !== this.authGeneration) return this.isAuthenticated;
        const headerToken = res.headers?.get?.('X-New-Token');
        const activeToken = this.getActiveToken();
        if (activeToken !== token) return this.isAuthenticated;
        const freshToken = headerToken && (!activeToken || activeToken === token) ? headerToken : activeToken || token;
        this.token = freshToken;
        if (freshToken && freshToken !== token) localStorage.setItem('authToken', freshToken);
        this.role = profile?.role || 'pro';
        this.userId = profile?.userId || null;
        bindWorkCenterBrowserOwner(this.userId);
        bindYeaftHistoryOwner(this.userId);
        this.authGeneration += 1;
        this.isAuthenticated = true;
        this.loginStep = 'authenticated';
        this.startSessionRefresh();
        return true;
      } catch (err) {
        this.error = err.message || 'Failed to restore session';
        return false;
      }
    },

    /**
     * Set session key received from WebSocket connection
     */
    setSessionKey(encodedKey) {
      if (encodedKey) {
        this.sessionKey = decodeKey(encodedKey);
      }
    },

    /**
     * Go back to credentials step
     */
    backToCredentials() {
      this.loginStep = 'credentials';
      this.tempToken = null;
      this.emailHint = null;
      this.setupToken = null;
      this.totpSecret = null;
      this.qrCode = null;
      this.error = null;
    },

    /**
     * Request a password-reset code by email. Always reports success even if
     * the email isn't on file (server-side anti-enumeration), but still returns
     * a resetToken so the UI can move on to the verify step.
     */
    async requestPasswordReset(email) {
      this.error = null;
      try {
        const res = await fetch('/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (!data.success) {
          this.error = data.error || 'Failed to request password reset';
          return null;
        }
        return data.resetToken || null;
      } catch (err) {
        this.error = err.message || 'Network error';
        return null;
      }
    },

    /**
     * Submit reset code + new password.
     */
    async verifyPasswordReset(resetToken, code, newPassword) {
      this.error = null;
      try {
        const res = await fetch('/api/auth/password-reset/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resetToken, code, newPassword })
        });
        const data = await res.json();
        if (!data.success) {
          this.error = data.error || 'Failed to reset password';
          return false;
        }
        return true;
      } catch (err) {
        this.error = err.message || 'Network error';
        return false;
      }
    },

    /**
     * Permanently delete the current user's account.
     * For password users: pass currentPassword.
     * For SSO-only users: pass confirm: 'DELETE'.
     */
    async deleteAccount({ currentPassword, confirm } = {}) {
      if (!this.isAuthenticated) return { success: false, error: 'Not authenticated' };
      try {
        const res = await fetch('/api/user/me', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ currentPassword, confirm })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          return { success: false, error: data.error || 'Failed to delete account' };
        }
        // Clear local state — server already revoked the browser session.
        await this.clearStoredSession();
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message || 'Network error' };
      }
    },

    /**
     * Reset state
     */
    reset() {
      clearWorkCenterBrowserOwner();
      clearYeaftHistoryOwner();
      this.authGeneration += 1;
      this.stopSessionRefresh();
      this.isAuthenticated = false;
      this.token = null;
      this.sessionKey = null;
      this.userId = null;
      this.role = null;
      this.loginStep = 'credentials';
      this.tempToken = null;
      this.emailHint = null;
      this.setupToken = null;
      this.totpSecret = null;
      this.qrCode = null;
      this.error = null;
      this.loading = false;
    }
  }
});
