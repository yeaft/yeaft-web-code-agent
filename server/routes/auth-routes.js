import { CONFIG, isEmailConfigured, isTotpEnabled, isAadEnabled, getEnabledSsoProviders, getUserByUsername } from '../config.js';
import { loginStep1, loginStep2, logout, verifyTotpStep, completeTotpSetup, register, loginWithAad } from '../auth.js';
import { buildAuthorizeUrl, handleCallback } from '../auth/oauth-flow.js';
import { verifyToken } from '../auth/token.js';
import { identityDb, userDb } from '../database.js';

/**
 * Register authentication-related API routes.
 */
export function registerAuthRoutes(app, { requireAuth, checkRateLimit }) {
  app.get('/api/auth/mode', (req, res) => {
    const aadEnabled = isAadEnabled();
    const ssoProviders = getEnabledSsoProviders();
    res.json({
      skipAuth: CONFIG.skipAuth,
      emailVerification: isEmailConfigured(),
      totpEnabled: isTotpEnabled(),
      registrationEnabled: !CONFIG.skipAuth,
      aadEnabled,
      ...(aadEnabled && {
        aadClientId: CONFIG.aad.clientId,
        aadTenantId: CONFIG.aad.tenantId
      }),
      // Server-driven SSO providers (each one handled via /api/auth/sso/:provider/start).
      ssoProviders
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    if (!checkRateLimit(req.ip)) {
      return res.status(429).json({ success: false, error: 'Too many login attempts, please try again later' });
    }
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required' });
    }
    try {
      const result = await loginStep1(username, password);
      res.json(result);
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  app.post('/api/auth/verify', (req, res) => {
    if (!checkRateLimit(req.ip)) {
      return res.status(429).json({ success: false, error: 'Too many attempts, please try again later' });
    }
    const { tempToken, code } = req.body;
    if (!tempToken || !code) {
      return res.status(400).json({ success: false, error: 'Token and code are required' });
    }
    const result = loginStep2(tempToken, code);
    res.json(result);
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      logout(token);
    }
    res.json({ success: true });
  });

  app.post('/api/auth/verify-totp', async (req, res) => {
    if (!checkRateLimit(req.ip)) {
      return res.status(429).json({ success: false, error: 'Too many attempts, please try again later' });
    }
    const { tempToken, totpCode } = req.body;
    if (!tempToken || !totpCode) {
      return res.status(400).json({ success: false, error: 'Token and TOTP code are required' });
    }
    try {
      const result = await verifyTotpStep(tempToken, totpCode);
      res.json(result);
    } catch (err) {
      console.error('TOTP verification error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  app.post('/api/auth/setup-totp', async (req, res) => {
    const { setupToken, totpCode } = req.body;
    if (!setupToken || !totpCode) {
      return res.status(400).json({ success: false, error: 'Setup token and TOTP code are required' });
    }
    try {
      const result = await completeTotpSetup(setupToken, totpCode);
      res.json(result);
    } catch (err) {
      console.error('TOTP setup error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // Registration (public - requires invitation code)
  app.post('/api/auth/register', async (req, res) => {
    if (!checkRateLimit(req.ip)) {
      return res.status(429).json({ success: false, error: 'Too many attempts, please try again later' });
    }
    const { username, password, email, invitationCode } = req.body;
    try {
      const result = await register(username, password, email, invitationCode);
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (err) {
      console.error('Registration error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // Azure AD (Microsoft Entra ID) SSO login
  app.post('/api/auth/aad', async (req, res) => {
    if (!checkRateLimit(req.ip)) {
      return res.status(429).json({ success: false, error: 'Too many attempts, please try again later' });
    }
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ success: false, error: 'id_token is required' });
    }
    try {
      const result = await loginWithAad(idToken);
      res.json(result);
    } catch (err) {
      console.error('AAD login error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ─── Server-driven SSO (GitHub / Google / WeChat / Alipay / Microsoft) ────
  // Login flow: /start → 302 to provider → user consents → provider 302 to /callback
  // Bind flow: same, but /start requires Authorization header so callback knows which user

  app.get('/api/auth/sso/:provider/start', (req, res) => {
    const { provider } = req.params;
    const intent = req.query.intent === 'bind' ? 'bind' : 'login';
    let userId = null;

    if (intent === 'bind') {
      // Bind requires the caller to be already logged in. The browser navigates
      // here directly so we read the token from the `Authorization` query
      // parameter (frontend hands it over explicitly because top-level navigation
      // can't set headers).
      const token = String(req.query.token || '');
      const ver = verifyToken(token);
      if (!ver.valid) {
        return res.status(401).send('Authentication required to bind an identity');
      }
      const u = userDb.getByUsername(ver.username);
      if (!u) return res.status(401).send('User not found');
      userId = u.id;
    }

    try {
      const url = buildAuthorizeUrl({ provider, intent, userId });
      res.redirect(url);
    } catch (err) {
      console.error(`[SSO ${provider}] start error:`, err.message);
      res.status(400).send(`SSO start failed: ${err.message}`);
    }
  });

  app.get('/api/auth/sso/:provider/callback', async (req, res) => {
    const { provider } = req.params;
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send('Missing code or state');
    }
    try {
      const result = await handleCallback({ provider, code: String(code), state: String(state) });
      if (result.kind === 'login') {
        // Pass token + sessionKey + role through URL fragment so JS can store them.
        const params = new URLSearchParams({
          token: result.token,
          sessionKey: result.sessionKey,
          role: result.role
        });
        return res.redirect(`/#/sso-complete?${params.toString()}`);
      }
      if (result.kind === 'bind') {
        return res.redirect(`/#/settings?ssoBound=${encodeURIComponent(provider)}`);
      }
      // error
      const msg = encodeURIComponent(result.error || 'SSO failed');
      const status = result.status || 400;
      if (status === 409) {
        return res.redirect(`/#/settings?ssoError=conflict&provider=${encodeURIComponent(provider)}`);
      }
      return res.status(status).send(`SSO error: ${result.error}`);
    } catch (err) {
      console.error(`[SSO ${provider}] callback error:`, err);
      res.status(500).send('Internal server error');
    }
  });

  // List the current user's bound identities.
  app.get('/api/auth/identities', requireAuth, (req, res) => {
    const u = userDb.getByUsername(req.user.username);
    if (!u) return res.status(404).json({ success: false, error: 'User not found' });
    const rows = identityDb.listForUser(u.id).map(r => ({
      provider: r.provider,
      email: r.email,
      displayName: r.display_name,
      createdAt: Number(r.created_at),
      lastLoginAt: r.last_login_at ? Number(r.last_login_at) : null
    }));
    // Whether the user has a password (i.e. can log in without any SSO identity).
    const hasPassword = !!u.password_hash;
    res.json({ success: true, identities: rows, hasPassword });
  });

  // Unbind an identity. Refuse if it would leave the user with no login method.
  app.delete('/api/auth/identities/:provider', requireAuth, (req, res) => {
    const { provider } = req.params;
    const u = userDb.getByUsername(req.user.username);
    if (!u) return res.status(404).json({ success: false, error: 'User not found' });
    const total = identityDb.countForUser(u.id);
    const hasPassword = !!u.password_hash;
    if (!hasPassword && total <= 1) {
      return res.status(400).json({
        success: false,
        error: 'Cannot remove the only login method. Set a password first.'
      });
    }
    const removed = identityDb.removeForUser(u.id, provider);
    if (!removed) return res.status(404).json({ success: false, error: 'No such linked identity' });
    // Keep legacy users.aad_oid in sync if microsoft is unbound.
    if (provider === 'microsoft' && u.aad_oid) {
      try { userDb.updateAadOid(u.id, null); } catch { /* ignore */ }
    }
    res.json({ success: true });
  });
}
