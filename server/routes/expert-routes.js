import { CONFIG } from '../config.js';
import { expertDb, userDb } from '../database.js';

/**
 * Resolve the effective userId from the request.
 * In skipAuth mode, uses a default user id; otherwise resolves from JWT.
 */
function resolveUserId(req) {
  if (CONFIG.skipAuth) {
    // In skipAuth mode, use a fixed default user ID
    return req.query.userId || 'default-user';
  }
  const user = userDb.getByUsername(req.user.username);
  return user?.id;
}

/**
 * Register custom expert role REST API routes.
 *
 * GET    /api/expert-roles/custom          — list custom roles for current user
 * POST   /api/expert-roles/custom          — create a custom role
 * PUT    /api/expert-roles/custom/:roleId  — update a custom role
 * DELETE /api/expert-roles/custom/:roleId  — delete a custom role
 */
export function registerExpertRoutes(app, { requireAuth }) {
  // GET — list all custom roles for the current user
  app.get('/api/expert-roles/custom', requireAuth, (req, res) => {
    try {
      const userId = resolveUserId(req);
      if (!userId) return res.status(401).json({ error: 'User not found' });

      const roles = expertDb.getCustomRolesByUser(userId);
      res.json({ roles });
    } catch (error) {
      console.error('[ExpertRoutes] GET /api/expert-roles/custom error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST — create a custom role
  app.post('/api/expert-roles/custom', requireAuth, (req, res) => {
    try {
      const userId = resolveUserId(req);
      if (!userId) return res.status(401).json({ error: 'User not found' });

      const roleData = req.body;
      if (!roleData.name || !roleData.title) {
        return res.status(400).json({ error: 'name and title are required' });
      }

      // Check for duplicate role_id if provided
      if (roleData.roleId && expertDb.exists(userId, roleData.roleId)) {
        return res.status(409).json({ error: `Role ${roleData.roleId} already exists` });
      }

      const { rowId, roleId } = expertDb.createCustomRole(userId, roleData);
      const roles = expertDb.getCustomRolesByUser(userId);
      const created = roles.find(r => r.id === roleId);

      res.status(201).json({ role: created });
    } catch (error) {
      console.error('[ExpertRoutes] POST /api/expert-roles/custom error:', error);
      if (error.message?.includes('UNIQUE constraint')) {
        return res.status(409).json({ error: 'Role with this ID already exists' });
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT — update a custom role
  app.put('/api/expert-roles/custom/:roleId', requireAuth, (req, res) => {
    try {
      const userId = resolveUserId(req);
      if (!userId) return res.status(401).json({ error: 'User not found' });

      const { roleId } = req.params;
      const roleData = req.body;

      if (!expertDb.exists(userId, roleId)) {
        return res.status(404).json({ error: `Role ${roleId} not found` });
      }

      if (!roleData.name || !roleData.title) {
        return res.status(400).json({ error: 'name and title are required' });
      }

      expertDb.updateCustomRole(userId, roleId, roleData);
      const roles = expertDb.getCustomRolesByUser(userId);
      const updated = roles.find(r => r.id === roleId);

      res.json({ role: updated });
    } catch (error) {
      console.error('[ExpertRoutes] PUT /api/expert-roles/custom error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE — delete a custom role
  app.delete('/api/expert-roles/custom/:roleId', requireAuth, (req, res) => {
    try {
      const userId = resolveUserId(req);
      if (!userId) return res.status(401).json({ error: 'User not found' });

      const { roleId } = req.params;
      const deleted = expertDb.deleteCustomRole(userId, roleId);

      if (!deleted) {
        return res.status(404).json({ error: `Role ${roleId} not found` });
      }

      res.json({ deleted: true, roleId });
    } catch (error) {
      console.error('[ExpertRoutes] DELETE /api/expert-roles/custom error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
