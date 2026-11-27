import 'dotenv/config';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { userDb } from './database.js';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load users from environment variable or users.json file
 * Format for AUTH_USERS: username:passwordHash:email
 * TOTP settings are loaded from SQLite database
 *
 * On startup, users are migrated into SQLite with role='admin'.
 * After migration, all runtime queries go through the database.
 */
function loadUsers() {
  const users = [];

  // Try loading from environment variable first
  if (process.env.AUTH_USERS) {
    const userEntries = process.env.AUTH_USERS.split(',');
    for (const entry of userEntries) {
      const parts = entry.split(':');
      const [username, passwordHash, email] = parts;
      if (username && passwordHash && email) {
        const trimmedUsername = username.trim();
        // Load TOTP settings from database
        const totpData = userDb.getTotp(trimmedUsername);
        users.push({
          username: trimmedUsername,
          passwordHash: passwordHash.trim(),
          email: email.trim(),
          totpSecret: totpData?.totpSecret || null,
          totpEnabled: totpData?.totpEnabled || false
        });
      }
    }
  }

  // Try loading from users.json file (fallback for backward compatibility)
  const usersFile = join(__dirname, 'users.json');
  if (existsSync(usersFile)) {
    try {
      const fileContent = JSON.parse(readFileSync(usersFile, 'utf-8'));
      if (Array.isArray(fileContent.users)) {
        for (const u of fileContent.users) {
          // Skip if user already loaded from env
          if (users.find(existing => existing.username === u.username)) continue;
          // Load TOTP settings from database
          const totpData = userDb.getTotp(u.username);
          users.push({
            ...u,
            totpSecret: totpData?.totpSecret || u.totpSecret || null,
            totpEnabled: totpData?.totpEnabled || u.totpEnabled || false
          });
        }
      }
    } catch (err) {
      console.error('Failed to load users.json:', err.message);
    }
  }

  // Migrate all loaded users into SQLite (idempotent)
  let migrated = 0;
  for (const u of users) {
    const result = userDb.migrateUser(u.username, u.passwordHash, u.email, 'admin');
    if (result) migrated++;
  }
  if (migrated > 0) {
    console.log(`[Migration] Synced ${migrated} users from AUTH_USERS/users.json to database`);
  }

  return users;
}

// Default secrets - these MUST be changed in production
const DEFAULT_JWT_SECRET = 'default-secret-change-in-production';
const DEFAULT_AGENT_SECRET = 'agent-shared-secret';

function commaList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

export const CONFIG = {
  // Server settings
  port: parseInt(process.env.PORT, 10) || 3456,
  host: process.env.SERVER_HOST || undefined,

  // Authentication
  skipAuth: process.env.SKIP_AUTH === 'true',
  users: loadUsers(),

  // JWT settings
  jwtSecret: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '3d',
  // Sliding renew: when an inbound request's token has less than this many ms
  // remaining, requireAuth issues a fresh token via the X-New-Token response
  // header. 1 day means an active user never sees an unexpected logout.
  jwtRenewThresholdMs: parseInt(process.env.JWT_RENEW_THRESHOLD_MS, 10) || 24 * 60 * 60 * 1000,
  tempTokenExpiresIn: process.env.TEMP_TOKEN_EXPIRES_IN || '10m',

  // Email verification
  emailCodeLength: parseInt(process.env.EMAIL_CODE_LENGTH, 10) || 6,
  emailCodeExpiresIn: parseInt(process.env.EMAIL_CODE_EXPIRES_IN, 10) || 300000, // 5 minutes in ms

  // SMTP settings
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'WebChat <noreply@example.com>'
  },

  // Agent authentication (global fallback — per-user agent_secret is preferred)
  agentSecret: process.env.AGENT_SECRET || DEFAULT_AGENT_SECRET,

  // Browser setup/viewer routes are available by default; an administrator can
  // still disable the entire surface explicitly. Downloads remain opt-in in the
  // Workbench and all lifecycle/signaling routes stay owner-scoped.
  // TURN credentials use the standard time-limited HMAC username scheme; Web and
  // Agent endpoints receive separately scoped usernames from the route ledger.
  browserRuntime: {
    enabled: process.env.BROWSER_RUNTIME_ENABLED !== 'false',
    iceTransportPolicy: process.env.BROWSER_ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all',
    stunUrls: commaList(process.env.BROWSER_STUN_URLS),
    turnUrls: commaList(process.env.BROWSER_TURN_URLS),
    turnSecret: process.env.BROWSER_TURN_SECRET || '',
    credentialTtlSeconds: Math.min(3600, Math.max(60, parseInt(process.env.BROWSER_TURN_TTL_SECONDS, 10) || 600)),
    routeTtlMs: Math.min(60 * 60_000, Math.max(60_000, parseInt(process.env.BROWSER_ROUTE_TTL_MS, 10) || 15 * 60_000)),
  },

  // A Sandbox is an ordinary yeaft-agent container managed by this Server's Docker daemon.
  // The Server controls only the container lifecycle; Agent behavior stays on the existing wire.
  sandbox: {
    enabled: process.env.SANDBOX_ENABLED === 'true',
    image: process.env.SANDBOX_AGENT_IMAGE || 'ghcr.io/yeaft/yeaft-web-code-agent-agent:dev',
    serverUrl: process.env.SANDBOX_SERVER_URL || '',
    stateDir: process.env.SANDBOX_STATE_DIR || join(homedir(), '.yeaft', 'container-agents'),
    // Shared cgroup slice (created by the absolute Node/CLI command printed by
    // `yeaft-agent container setup-limits` on the Host) that caps the sum of all
    // sandbox containers' CPU/memory usage. Empty means no cgroup-parent is
    // passed and sandbox containers are unprotected.
    cgroupParent: process.env.SANDBOX_CGROUP_PARENT || ''
  },

  // File upload settings
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 50 * 1024 * 1024, // 50MB
  maxPendingUploadBytesPerUser: Math.max(1, parseInt(process.env.MAX_PENDING_UPLOAD_BYTES_PER_USER, 10) || 100 * 1024 * 1024),
  maxPendingUploadBytes: Math.max(1, parseInt(process.env.MAX_PENDING_UPLOAD_BYTES, 10) || 256 * 1024 * 1024),
  fileCleanupInterval: parseInt(process.env.FILE_CLEANUP_INTERVAL, 10) || 600000, // 10 minutes

  // TOTP (Two-Factor Authentication) settings
  totp: {
    enabled: process.env.TOTP_ENABLED !== 'false', // Enable by default
    issuer: process.env.TOTP_ISSUER || 'Claude Web Chat',
    window: parseInt(process.env.TOTP_WINDOW, 10) || 1 // Allow 1 step before/after
  },

  // Azure AD (Microsoft Entra ID) SSO settings
  aad: {
    enabled: process.env.AAD_ENABLED === 'true',
    clientId: process.env.AAD_CLIENT_ID || '',
    tenantId: process.env.AAD_TENANT_ID || '',
    autoCreateUser: process.env.AAD_AUTO_CREATE_USER !== 'false', // Auto-create local user on first AAD login
    defaultRole: process.env.AAD_DEFAULT_ROLE || 'pro' // Default role for auto-created AAD users
  },

  // Multi-provider SSO settings (server-driven OAuth code flow)
  // Each provider follows the same shape: { enabled, clientId/secret, callbackUrl, autoCreateUser, defaultRole }
  // Microsoft re-uses the existing aad.* block above and is included here for the unified UI listing only.
  sso: {
    github: {
      enabled: process.env.SSO_GITHUB_ENABLED === 'true',
      clientId: process.env.SSO_GITHUB_CLIENT_ID || '',
      clientSecret: process.env.SSO_GITHUB_CLIENT_SECRET || '',
      callbackUrl: process.env.SSO_GITHUB_CALLBACK_URL || '',
      autoCreateUser: process.env.SSO_GITHUB_AUTO_CREATE_USER !== 'false',
      defaultRole: process.env.SSO_GITHUB_DEFAULT_ROLE || 'pro'
    },
    google: {
      enabled: process.env.SSO_GOOGLE_ENABLED === 'true',
      clientId: process.env.SSO_GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.SSO_GOOGLE_CLIENT_SECRET || '',
      callbackUrl: process.env.SSO_GOOGLE_CALLBACK_URL || '',
      autoCreateUser: process.env.SSO_GOOGLE_AUTO_CREATE_USER !== 'false',
      defaultRole: process.env.SSO_GOOGLE_DEFAULT_ROLE || 'pro'
    },
    wechat: {
      // PC web 扫码 (Open Platform 网页扫码) — open.weixin.qq.com/connect/qrconnect
      enabled: process.env.SSO_WECHAT_ENABLED === 'true',
      appId: process.env.SSO_WECHAT_APP_ID || '',
      appSecret: process.env.SSO_WECHAT_APP_SECRET || '',
      callbackUrl: process.env.SSO_WECHAT_CALLBACK_URL || '',
      autoCreateUser: process.env.SSO_WECHAT_AUTO_CREATE_USER !== 'false',
      defaultRole: process.env.SSO_WECHAT_DEFAULT_ROLE || 'pro'
    },
    alipay: {
      // 支付宝网页授权 — oauth2/publicAppAuthorize.htm (RSA2 signing)
      enabled: process.env.SSO_ALIPAY_ENABLED === 'true',
      appId: process.env.SSO_ALIPAY_APP_ID || '',
      privateKey: process.env.SSO_ALIPAY_PRIVATE_KEY || '',
      alipayPublicKey: process.env.SSO_ALIPAY_PUBLIC_KEY || '',
      callbackUrl: process.env.SSO_ALIPAY_CALLBACK_URL || '',
      autoCreateUser: process.env.SSO_ALIPAY_AUTO_CREATE_USER !== 'false',
      defaultRole: process.env.SSO_ALIPAY_DEFAULT_ROLE || 'pro'
    }
  }
};

/**
 * Check if email is configured
 */
export function isEmailConfigured() {
  return !!(CONFIG.smtp.host && CONFIG.smtp.user && CONFIG.smtp.pass);
}

/**
 * Get user by username — queries database first, falls back to CONFIG.users
 * @param {string} username
 * @returns {object|null} Normalized user object with { username, passwordHash, email, totpSecret, totpEnabled, role, id }
 */
export function getUserByUsername(username) {
  // Query database first (includes migrated, registered, and SSO-only users).
  const dbUser = userDb.getByUsername(username);
  if (dbUser) {
    if (dbUser.deletion_state && dbUser.deletion_state !== 'active') return null;
    return {
      username: dbUser.username,
      passwordHash: dbUser.password_hash || null,
      email: dbUser.email,
      totpSecret: dbUser.totp_secret,
      totpEnabled: !!dbUser.totp_enabled,
      role: dbUser.role === 'admin' ? 'admin' : 'pro',
      id: dbUser.id
    };
  }
  // A finalized deletion remains authoritative after the users row is erased.
  if (userDb.isDeletionTombstoned(username)) return null;
  // Fallback to CONFIG.users only when no authoritative database state exists.
  return CONFIG.users.find(u => u.username === username) || null;
}

/**
 * Update user TOTP settings in SQLite database
 * @param {string} username
 * @param {{totpSecret: string, totpEnabled: boolean}} data
 * @returns {Promise<boolean>}
 */
export async function updateUserTotp(username, data) {
  try {
    userDb.updateTotp(username, data.totpSecret, data.totpEnabled);

    // Update in-memory user data (CONFIG.users) for backward compat
    const user = CONFIG.users.find(u => u.username === username);
    if (user) {
      user.totpSecret = data.totpSecret;
      user.totpEnabled = data.totpEnabled;
    }

    console.log(`TOTP settings saved to database for user: ${username}`);
    return true;
  } catch (err) {
    console.error('Failed to save TOTP settings:', err.message);
    return false;
  }
}

/**
 * Check if TOTP is globally enabled
 * @returns {boolean}
 */
export function isTotpEnabled() {
  return CONFIG.totp?.enabled !== false;
}

/**
 * Validate that required secrets are configured in production mode
 * Throws an error if default secrets are used in production
 */
export function validateProductionConfig() {
  if (CONFIG.skipAuth) {
    // Development mode - skip validation
    return { valid: true };
  }

  const errors = [];
  const warnings = [];

  // Check JWT_SECRET
  if (CONFIG.jwtSecret === DEFAULT_JWT_SECRET) {
    errors.push('JWT_SECRET must be set to a secure value in production mode');
  }

  if (CONFIG.sandbox.enabled && !/^wss?:\/\//.test(CONFIG.sandbox.serverUrl)) {
    errors.push('SANDBOX_SERVER_URL must be the ws:// or wss:// URL that container Agents use to connect');
  }
  if (CONFIG.browserRuntime.enabled) {
    const invalidIceUrl = [...CONFIG.browserRuntime.stunUrls, ...CONFIG.browserRuntime.turnUrls]
      .find(url => !/^(?:stun|stuns|turn|turns):/i.test(url));
    if (invalidIceUrl) errors.push(`Invalid Browser Runtime ICE URL: ${invalidIceUrl}`);
    if (CONFIG.browserRuntime.turnUrls.length > 0 && !CONFIG.browserRuntime.turnSecret) {
      errors.push('BROWSER_TURN_SECRET is required when BROWSER_TURN_URLS is configured');
    }
    if (CONFIG.browserRuntime.iceTransportPolicy === 'relay' && CONFIG.browserRuntime.turnUrls.length === 0) {
      errors.push('BROWSER_TURN_URLS is required when BROWSER_ICE_TRANSPORT_POLICY=relay');
    }
  }

  // Check that at least one user with a password exists (in DB or config)
  // Only warn (don't block startup) — allows first-time setup via create-user.js
  const dbUsers = userDb.getAll();
  const hasUserWithPassword = dbUsers.some(u => u.password_hash) || CONFIG.users.length > 0;
  if (!hasUserWithPassword) {
    warnings.push('No users configured. Create one with: node server/create-user.js <username> <password> [email]');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, warnings: warnings.length > 0 ? warnings : undefined };
}

/**
 * Check if Azure AD SSO is configured
 * @returns {boolean}
 */
export function isAadEnabled() {
  return CONFIG.aad?.enabled && !!CONFIG.aad.clientId && !!CONFIG.aad.tenantId;
}

/**
 * Return the set of enabled SSO providers (excluding Microsoft, which is exposed via aadEnabled).
 * Used by /api/auth/mode to drive the LoginPage button list.
 * @returns {{ github: boolean, google: boolean, wechat: boolean, alipay: boolean }}
 */
export function getEnabledSsoProviders() {
  const sso = CONFIG.sso || {};
  return {
    github: !!(sso.github?.enabled && sso.github.clientId && sso.github.clientSecret && sso.github.callbackUrl),
    google: !!(sso.google?.enabled && sso.google.clientId && sso.google.clientSecret && sso.google.callbackUrl),
    wechat: !!(sso.wechat?.enabled && sso.wechat.appId && sso.wechat.appSecret && sso.wechat.callbackUrl),
    alipay: !!(sso.alipay?.enabled && sso.alipay.appId && sso.alipay.privateKey && sso.alipay.callbackUrl)
  };
}

export default CONFIG;
