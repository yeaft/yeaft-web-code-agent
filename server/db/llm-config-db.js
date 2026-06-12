import { stmts } from './connection.js';

export const llmConfigDb = {
  get(userId) {
    if (!userId) return { providers: [] };
    const row = stmts.getUserLlmConfig.get(userId);
    if (!row?.config_json) return { providers: [] };
    try {
      const parsed = JSON.parse(row.config_json);
      return parsed && typeof parsed === 'object' ? parsed : { providers: [] };
    } catch {
      return { providers: [] };
    }
  },

  set(userId, config) {
    if (!userId) throw new Error('userId is required');
    const now = Date.now();
    stmts.upsertUserLlmConfig.run(userId, JSON.stringify(config || { providers: [] }), now, now);
  },
};
