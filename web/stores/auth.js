/**
 * Authentication store for managing login state
 */
import { decodeKey } from '../utils/encryption.js';

const { defineStore } = Pinia;

export const useAuthStore = defineStore('auth', {
  state: () => ({
    // Auth mode from server
    skipAuth: false,
    emailVerification: false,
    totpEnabled: false,
    registrationEnabled: false,
    aadEnabled: false,
    aadClientId: null,
    aadTenantId: null,

    // Current auth state
    isAuthenticated: false,
    token: null,
    sessionKey: null, // Uint8Array for encryption
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
    loading: false
  }),

  actions: {
    /**
     * Check auth mode from server
     */
    async checkAuthMode() {
      try {
        const response = await fetch('/api/auth/mode');
        const data = await response.json();
        this.skipAuth = data.skipAuth;
        this.emailVerification = data.emailVerification;
        this.totpEnabled = data.totpEnabled;
        this.registrationEnabled = data.registrationEnabled || false;
        this.aadEnabled = data.aadEnabled || false;
        this.aadClientId = data.aadClientId || null;
        this.aadTenantId = data.aadTenantId || null;

        if (this.skipAuth) {
          // In skip auth mode, we're automatically authenticated
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
        this.isAuthenticated = true;
        this.loginStep = 'authenticated';

        // Store token for reconnection (use localStorage for persistence across refreshes)
        localStorage.setItem('authToken', data.token);
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
        this.isAuthenticated = true;
        this.loginStep = 'authenticated';

        localStorage.setItem('authToken', data.token);
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
        this.isAuthenticated = true;
        this.loginStep = 'authenticated';
        this.tempToken = null;

        localStorage.setItem('authToken', data.token);
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
        this.isAuthenticated = true;
        this.loginStep = 'authenticated';

        localStorage.setItem('authToken', data.token);
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
        this.isAuthenticated = true;
        this.loginStep = 'authenticated';
        this.tempToken = null;
        this.emailHint = null;

        // Store token for reconnection
        localStorage.setItem('authToken', data.token);
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
     * Logout
     */
    async logout() {
      try {
        if (this.token) {
          await fetch('/api/auth/logout', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.token}`
            }
          });
        }
      } catch (err) {
        console.error('Logout error:', err);
      }

      this.reset();
      localStorage.removeItem('authToken');
    },

    /**
     * Try to restore session from stored token
     */
    async restoreSession() {
      const token = localStorage.getItem('authToken');
      console.log('[Auth] Restoring session, token exists:', !!token);
      if (!token) return false;

      // Token will be verified when connecting to WebSocket
      this.token = token;
      this.isAuthenticated = true;
      this.loginStep = 'authenticated';
      return true;
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
     * Reset state
     */
    reset() {
      this.isAuthenticated = false;
      this.token = null;
      this.sessionKey = null;
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
