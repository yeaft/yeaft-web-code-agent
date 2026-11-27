import { CONFIG } from '../config.js';
import { hashPassword } from '../auth.js';
import { userDb, userPreferencesDb, sessionDb } from '../database.js';
import {
  activeSessions, pendingVerifications, pendingTotpVerifications, pendingTotpSetup,
  revokedTokens
} from '../auth/session-store.js';
import { clearSessionCookie } from '../auth/request-auth.js';
import { agents, webClients, userStatsDeltas } from '../context.js';
import { containerAgentService } from '../container-agent-service.js';

// 过滤用户敏感字段
function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    email: user.email,
    role: user.role,
    created_at: user.created_at,
    last_login_at: user.last_login_at
  };
}

// 转换数据库会话记录为前端期望的格式
function transformSession(session) {
  return {
    id: session.id,
    agentId: session.agent_id,
    agentName: session.agent_name,
    claudeSessionId: session.claude_session_id,
    workDir: session.work_dir,
    title: session.title,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    isActive: !!session.is_active,
    userId: session.user_id
  };
}

function loadCurrentUser(req) {
  let user = userDb.getByUsername(req.user.username);
  if (!user && CONFIG.skipAuth) {
    user = userDb.getOrCreate(req.user.username, req.user.username);
  }
  return user;
}

function ensureAgentSecret(user) {
  if (user?.agent_secret) return user.agent_secret;
  return userDb.resetAgentSecret(user.id);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const preferenceFields = new Set([
  'sidebarProjectsRatio', 'sidebarActionsCompact', 'sidebarCollapsedProjects', 'sidebarCollapsedSections', 'cosmosConfig',
]);
const unsafeMapKeys = new Set(['__proto__', 'constructor', 'prototype']);
const cosmosConfigFields = new Set(['constants', 'planetBindings', 'drawerWidth', 'uiMode']);
const cosmosPlanetIds = new Set(['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);
const cosmosLivePreviewModes = new Set(['2', '3', 'collapsed']);
const cosmosRenderQualities = new Set(['auto', 'high', 'lite']);
const cosmosUiModes = new Set(['cosmos', 'classic']);
const cosmosNumericBounds = {
  orbitSpeed: [0, 2.5],
  spinSpeed: [0, 2.5],
  planetScale: [0.65, 1.5],
  eventScale: [0.5, 1.8],
  starDensity: [0.35, 2.0],
  skyBright: [0.35, 1.8],
  orbitLines: [0, 1.2],
};
const cosmosBooleanFields = new Set(['activeFlash', 'showEventsCountdown', 'eventsAutoEnabled', 'eventsAutoZoom']);

function isCollapseMap(value, sections = false) {
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return (sections || entries.length <= 1000) && entries.every(([key, collapsed]) => (
    typeof collapsed === 'boolean' && !unsafeMapKeys.has(key)
    && (sections ? key === 'projects' || key === 'recents' : key.length > 0 && key.length <= 200)
  ));
}

function isValidCosmosConstantsPatch(value) {
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0) return false;
  return entries.every(([key, val]) => {
    if (unsafeMapKeys.has(key)) return false;
    if (Object.hasOwn(cosmosNumericBounds, key)) {
      const [min, max] = cosmosNumericBounds[key];
      return typeof val === 'number' && Number.isFinite(val) && val >= min && val <= max;
    }
    if (cosmosBooleanFields.has(key)) return typeof val === 'boolean';
    if (key === 'livePreviewMode') return typeof val === 'string' && cosmosLivePreviewModes.has(val);
    if (key === 'renderQuality') return typeof val === 'string' && cosmosRenderQualities.has(val);
    return false;
  });
}

function isValidCosmosPlanetBindings(value) {
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 128) return false;
  return entries.every(([agentId, planetId]) => (
    typeof agentId === 'string' && agentId.length > 0 && agentId.length <= 200
    && !unsafeMapKeys.has(agentId)
    && typeof planetId === 'string' && cosmosPlanetIds.has(planetId)
  ));
}

function isValidCosmosConfigPatch(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some(key => !cosmosConfigFields.has(key))) return false;
  if (Object.hasOwn(value, 'constants') && !isValidCosmosConstantsPatch(value.constants)) return false;
  if (Object.hasOwn(value, 'planetBindings') && !isValidCosmosPlanetBindings(value.planetBindings)) return false;
  if (Object.hasOwn(value, 'drawerWidth') && value.drawerWidth !== null && !(
    typeof value.drawerWidth === 'number' && Number.isInteger(value.drawerWidth)
    && value.drawerWidth >= 340 && value.drawerWidth <= 1280
  )) return false;
  if (Object.hasOwn(value, 'uiMode') && (typeof value.uiMode !== 'string' || !cosmosUiModes.has(value.uiMode))) return false;
  return true;
}

/**
 * Register user profile, agent secret, and admin user management routes.
 */
export function registerUserRoutes(app, {
  requireAuth,
  requireAdmin,
  containerService = containerAgentService,
}) {
  // Get my profile
  app.get('/api/user/profile', requireAuth, (req, res) => {
    try {
      const user = loadCurrentUser(req);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({
        userId: user.id,
        username: user.username,
        displayName: user.display_name,
        email: user.email,
        role: user.role === 'admin' ? 'admin' : 'pro',
        createdAt: user.created_at,
        // hasPassword lets the UI distinguish "change password" (current pwd
        // required) from "set password for the first time" (SSO-only users).
        hasPassword: !!user.password_hash
      });
    } catch (err) {
      console.error('Get profile error:', err);
      res.status(500).json({ error: 'Failed to get profile' });
    }
  });

  app.get('/api/user/preferences', requireAuth, (req, res) => {
    try {
      const user = loadCurrentUser(req);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.set('Cache-Control', 'private, no-store').json(userPreferencesDb.get(user.id));
    } catch (err) {
      console.error('Get preferences error:', err);
      res.status(500).json({ error: 'Failed to get preferences' });
    }
  });

  app.patch('/api/user/preferences', requireAuth, (req, res) => {
    try {
      const user = loadCurrentUser(req);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const body = req.body;
      if (!isPlainObject(body)
        || Object.keys(body).length === 0
        || Object.keys(body).some(key => !preferenceFields.has(key))
        || (Object.hasOwn(body, 'sidebarProjectsRatio') && (
          typeof body.sidebarProjectsRatio !== 'number'
          || !Number.isFinite(body.sidebarProjectsRatio)
          || body.sidebarProjectsRatio < 0.15 || body.sidebarProjectsRatio > 0.85
        ))
        || (Object.hasOwn(body, 'sidebarActionsCompact') && typeof body.sidebarActionsCompact !== 'boolean')
        || (Object.hasOwn(body, 'sidebarCollapsedProjects') && !isCollapseMap(body.sidebarCollapsedProjects))
        || (Object.hasOwn(body, 'sidebarCollapsedSections') && !isCollapseMap(body.sidebarCollapsedSections, true))
        || (Object.hasOwn(body, 'cosmosConfig') && !isValidCosmosConfigPatch(body.cosmosConfig))) {
        return res.status(400).json({
          error: 'Expected a nonempty patch with only sidebarProjectsRatio (finite number between 0.15 and 0.85), '
            + 'sidebarActionsCompact (boolean), sidebarCollapsedProjects (boolean map, up to 1000 nonempty project IDs '
            + 'of at most 200 characters, excluding __proto__/constructor/prototype), '
            + 'sidebarCollapsedSections (boolean map with only projects/recents), and/or '
            + 'cosmosConfig (validated constants, planetBindings, drawerWidth, uiMode)',
        });
      }

      res.set('Cache-Control', 'private, no-store').json(userPreferencesDb.update(user.id, body));
    } catch (err) {
      console.error('Update preferences error:', err);
      res.status(500).json({ error: 'Failed to update preferences' });
    }
  });

  // Update my profile (password and/or email)
  app.put('/api/user/profile', requireAuth, async (req, res) => {
    try {
      const user = userDb.getByUsername(req.user.username);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const { currentPassword, newPassword, email } = req.body;

      // Two cases:
      //   (a) User already has a password → must verify currentPassword.
      //   (b) User has no password (e.g. SSO-only) and is setting one for the
      //       first time → currentPassword is not required, but they must
      //       supply newPassword. This unblocks logout-then-username-login
      //       for SSO users.
      const isSettingFirstPassword = !user.password_hash && !!newPassword;

      if (!isSettingFirstPassword) {
        if (!currentPassword) {
          return res.status(400).json({ error: 'Current password is required' });
        }
        if (!user.password_hash) {
          // No password yet, and no newPassword in this request → nothing valid to do.
          return res.status(400).json({ error: 'No password is set; supply newPassword to set one.' });
        }
        const bcryptModule = await import('bcrypt');
        const passwordValid = await bcryptModule.default.compare(currentPassword, user.password_hash);
        if (!passwordValid) {
          return res.status(403).json({ error: 'Current password is incorrect' });
        }
      }

      if (newPassword) {
        if (newPassword.length < 6) {
          return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }
        const newHash = await hashPassword(newPassword);
        userDb.updatePassword(user.id, newHash);
      }

      if (email !== undefined) {
        userDb.updateEmail(user.id, email || null);
      }

      res.json({ success: true });
    } catch (err) {
      console.error('Update profile error:', err);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  });

  // Permanently delete my account.
  // Requires either currentPassword (for password users) OR confirms !hasPassword
  // for SSO-only users (in which case the body must include `confirm: 'DELETE'`).
  app.delete('/api/user/me', requireAuth, async (req, res) => {
    try {
      const user = userDb.getByUsername(req.user.username);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const { currentPassword, confirm } = req.body || {};

      if (user.password_hash) {
        if (!currentPassword) {
          return res.status(400).json({ error: 'Current password is required' });
        }
        const bcryptModule = await import('bcrypt');
        const ok = await bcryptModule.default.compare(currentPassword, user.password_hash);
        if (!ok) return res.status(403).json({ error: 'Current password is incorrect' });
      } else {
        // SSO-only: require explicit confirmation string to prevent accidental deletion.
        if (confirm !== 'DELETE') {
          return res.status(400).json({ error: 'Confirmation required (confirm: "DELETE")' });
        }
      }

      // Keep managed cleanup and the durable active -> pending transition inside
      // one owner lifecycle fence so an admitted create cannot outlive deletion.
      const deletion = await containerService.prepareOwnerDeletion(
        user.id,
        () => userDb.beginDeletion(user.id),
      );
      if (!deletion) return res.status(404).json({ error: 'User not found or already deleted' });

      // Durable eligibility is enforced from the user row. These sweeps close
      // already-open channels immediately rather than waiting for their next use.
      for (const [token, info] of activeSessions.entries()) {
        if (info?.username === user.username) {
          activeSessions.delete(token);
          revokedTokens.add(token);
        }
      }
      for (const pending of [pendingVerifications, pendingTotpVerifications, pendingTotpSetup]) {
        for (const [token, info] of pending) {
          if (info?.username === user.username) pending.delete(token);
        }
      }
      for (const [, client] of webClients) {
        if (client.userId === user.id) client.ws.close(1008, 'Account disabled');
      }
      for (const [, agent] of agents) {
        if (agent.ownerId === user.id) agent.ws.close(1008, 'Account disabled');
      }
      userStatsDeltas.delete(user.id);
      clearSessionCookie(req, res);
      res.status(202).json(deletion);
    } catch (err) {
      console.error('Delete user error:', err);
      res.status(500).json({ error: 'Failed to delete account' });
    }
  });

  // Get my agent secret
  app.get('/api/user/agent-secret', requireAuth, (req, res) => {
    try {
      const user = loadCurrentUser(req);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const agentSecret = ensureAgentSecret(user);
      res.json({ agentSecret });
    } catch (err) {
      console.error('Get agent secret error:', err);
      res.status(500).json({ error: 'Failed to get agent secret' });
    }
  });

  // Reset my agent secret
  app.post('/api/user/agent-secret/reset', requireAuth, (req, res) => {
    try {
      const user = loadCurrentUser(req);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const newSecret = userDb.resetAgentSecret(user.id);
      res.json({ agentSecret: newSecret });
    } catch (err) {
      console.error('Reset agent secret error:', err);
      res.status(500).json({ error: 'Failed to reset agent secret' });
    }
  });

  // Admin: list all users
  app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
    try {
      const users = userDb.getAll().map(sanitizeUser);
      res.json({ users });
    } catch (e) {
      console.error('Failed to get users:', e.message);
      res.status(500).json({ error: 'Failed to get users' });
    }
  });

  // Admin: get user by id
  app.get('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
    try {
      const user = userDb.get(req.params.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({ user: sanitizeUser(user) });
    } catch (e) {
      console.error('Failed to get user:', e.message);
      res.status(500).json({ error: 'Failed to get user' });
    }
  });

  // Admin: get user's sessions
  app.get('/api/users/:id/sessions', requireAuth, requireAdmin, (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 50;
    const agentId = req.query.agentId;
    try {
      const sessions = agentId
        ? sessionDb.getByUserAndAgent(req.params.id, agentId, limit)
        : sessionDb.getByUser(req.params.id, limit);
      res.json({ sessions: sessions.map(transformSession) });
    } catch (e) {
      console.error('Failed to get user sessions:', e.message);
      res.status(500).json({ error: 'Failed to get user sessions' });
    }
  });
}
