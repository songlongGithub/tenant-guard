import { getUsage } from "../store/usage-db.js";
import { getTenantConfig, isOwner } from "../store/tenants-config.js";
import { extractTopics } from "../utils/keywords.js";
import { log } from "../utils/logger.js";

/**
 * before_reset hook — Session profiling.
 * When a tenant session resets, extract topics and update the profile.
 * @param {import("better-sqlite3").Database} db
 */
export function onBeforeReset(db) {
  return (event, ctx) => {
    const agentId = ctx.agentId;
    if (!agentId || isOwner(agentId)) return;

    const tenantConfig = getTenantConfig(agentId);
    if (!tenantConfig) return;

    const messages = event.messages || [];
    if (messages.length === 0) return;

    // Extract topics from conversation
    const topics = extractTopics(messages);
    const topicsStr = topics.map((t) => t.topic).join(", ");

    // Get current usage for session stats
    const usage = getUsage(db, agentId) || { tokens: 0, calls: 0 };

    // Upsert profile
    const now = new Date().toISOString();
    const existing = db
      .prepare("SELECT * FROM profiles WHERE agent_id = ?")
      .get(agentId);

    if (existing) {
      db.prepare(
        `UPDATE profiles SET
          last_seen = ?,
          session_count = session_count + 1,
          total_tokens = total_tokens + ?,
          total_calls = total_calls + ?
        WHERE agent_id = ?`
      ).run(now, usage.tokens, usage.calls, agentId);
    } else {
      db.prepare(
        `INSERT INTO profiles (agent_id, label, channel, first_seen, last_seen, session_count, total_tokens, total_calls)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(
        agentId,
        tenantConfig.label || agentId,
        null, // channel will be filled from binding info
        now,
        now,
        usage.tokens,
        usage.calls
      );
    }

    if (topicsStr) {
      log.info(`Profile ${agentId}: session topics: ${topicsStr}`);
    }
    log.debug(`Profile ${agentId}: session_count ${(existing?.session_count || 0) + 1}`);
  };
}
