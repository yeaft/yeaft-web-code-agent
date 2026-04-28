import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
import { verifyToken, maybeRenewToken } from './auth.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerInvitationRoutes } from './routes/invitation-routes.js';
import { registerUserRoutes } from './routes/user-routes.js';
import { registerSessionRoutes } from './routes/session-routes.js';
import { registerUploadRoutes } from './routes/upload-routes.js';
import { registerAdminRoutes } from './routes/admin-routes.js';
import { registerExpertRoutes } from './routes/expert-routes.js';

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
function requireAuth(req, res, next) {
  if (CONFIG.skipAuth) {
    req.user = { username: 'dev-user', role: 'admin' };
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.replace('Bearer ', '');
  const result = verifyToken(token);

  if (!result.valid) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Sliding renewal: if the token is in the last `jwtRenewThresholdMs` of its
  // life, mint a fresh one and surface it to the client via X-New-Token. The
  // browser fetch wrapper picks this up and swaps localStorage transparently.
  // Header is also exposed via Access-Control-Expose-Headers in the CORS layer
  // so XHR/fetch can read it across origins.
  const fresh = maybeRenewToken(token, result.exp, result.username);
  if (fresh) {
    res.setHeader('X-New-Token', fresh);
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
const shared = { requireAuth, requireAdmin, checkRateLimit };

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
}
