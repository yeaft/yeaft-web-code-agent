import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
import { maybeRenewToken } from './auth.js';
import { authenticateRequest, setSessionCookie } from './auth/request-auth.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerInvitationRoutes } from './routes/invitation-routes.js';
import { registerUserRoutes } from './routes/user-routes.js';
import { registerSessionRoutes } from './routes/session-routes.js';
import { registerUploadRoutes } from './routes/upload-routes.js';
import { registerAdminRoutes } from './routes/admin-routes.js';
import { registerExpertRoutes } from './routes/expert-routes.js';
import { registerSandboxRoutes } from './routes/sandbox-routes.js';

// 登录速率限制: IP -> { attempts, resetAt }
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 30;
const LOGIN_WINDOW_MS = 5 * 60 * 1000; // 5 分钟窗口

function checkRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { attempts: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  record.attempts++;
  return record.attempts <= LOGIN_MAX_ATTEMPTS;
}

// 定期清理过期的速率限制记录
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) {
    if (now > record.resetAt) loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000);

/**
 * Middleware to verify JWT token for protected API routes
 */
function requireAuth(req, res, next, { fullSession = false } = {}) {
  if (CONFIG.skipAuth) {
    req.user = { username: 'dev-user', role: 'admin' };
    return next();
  }

  const result = authenticateRequest({
    authorizationHeader: req.headers.authorization,
    cookieHeader: req.headers.cookie,
  });
  if (!result) {
    const hasCredential = !!req.headers.authorization || !!req.headers.cookie;
    return res.status(401).json({
      error: hasCredential ? 'Invalid or expired token' : 'Authentication required',
    });
  }

  if (fullSession && result.type) return res.status(403).json({ error: 'Full session required' });

  // Sliding renewal: if the token is in the last `jwtRenewThresholdMs` of its
  // life, mint a fresh one and update both browser auth channels.
  // Skip renewal for non-session tokens (temp/totp/totp-setup) — those have
  // their own short-lived semantics and must not be promoted to full sessions.
  if (!result.type) {
    const fresh = maybeRenewToken(result.token, result.exp, result.username);
    if (fresh) {
      setSessionCookie(req, res, fresh);
      if (result.source !== 'cookie') res.setHeader('X-New-Token', fresh);
    } else if (result.source !== 'cookie') {
      // Repair the cookie for existing bearer-only sessions after deployment.
      setSessionCookie(req, res, result.token);
    }
  }

  req.user = { username: result.username, role: result.role === 'admin' ? 'admin' : 'pro' };
  next();
}

/**
 * Middleware to require admin role
 */
function requireAdmin(req, res, next) {
  if (CONFIG.skipAuth) return next();
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Read version from version.json (injected at Docker build time)
const __apiDirname = dirname(fileURLToPath(import.meta.url));
let serverVersion = 'dev';
try {
  const versionFile = JSON.parse(readFileSync(join(__apiDirname, '../version.json'), 'utf-8'));
  serverVersion = versionFile.version || 'dev';
} catch {}

// Shared middleware/helpers passed to sub-route modules
const requireSessionAuth = (req, res, next) => requireAuth(req, res, next, { fullSession: true });
const shared = { requireAuth, requireSessionAuth, requireAdmin, checkRateLimit };

export function registerApiRoutes(app) {
  // Version API
  app.get('/api/version', (req, res) => {
    res.json({ version: serverVersion });
  });

  // Delegate to sub-route modules
  registerAuthRoutes(app, shared);
  registerInvitationRoutes(app, shared);
  registerUserRoutes(app, shared);
  registerSessionRoutes(app, shared);
  registerUploadRoutes(app, shared);
  registerAdminRoutes(app, shared);
  registerExpertRoutes(app, shared);
  registerSandboxRoutes(app, shared);
}
