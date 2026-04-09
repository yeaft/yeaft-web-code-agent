import { CONFIG, isEmailConfigured, isTotpEnabled, isAadEnabled } from '../config.js';
import { loginStep1, loginStep2, logout, verifyTotpStep, completeTotpSetup, register, loginWithAad } from '../auth.js';

/**
 * Register authentication-related API routes.
 */
export function registerAuthRoutes(app, { requireAuth, checkRateLimit }) {
  app.get('/api/auth/mode', (req, res) => {
    const aadEnabled = isAadEnabled();
    res.json({
      skipAuth: CONFIG.skipAuth,
      emailVerification: isEmailConfigured(),
      totpEnabled: isTotpEnabled(),
      registrationEnabled: !CONFIG.skipAuth,
      aadEnabled,
      ...(aadEnabled && {
        aadClientId: CONFIG.aad.clientId,
        aadTenantId: CONFIG.aad.tenantId
      })
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
}
