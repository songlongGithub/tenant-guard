import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/logger.js";

/**
 * Append a notification to the JSONL queue.
 * Uses appendFileSync for atomicity within single process.
 * @param {string} dataDir
 * @param {{ agentId: string, type: string, message: string, detail?: string }} entry
 */
export function appendNotification(dataDir, entry) {
  const filePath = path.join(dataDir, "notifications.jsonl");
  const line = JSON.stringify({
    ...entry,
    ts: new Date().toISOString(),
  }) + "\n";
  try {
    fs.appendFileSync(filePath, line, "utf-8");
    log.debug(`Notification queued: ${entry.type} for ${entry.agentId}`);
  } catch (err) {
    log.error(`Failed to write notification: ${err.message}`);
  }
}

/**
 * Drain the notification queue: rename → read → delete.
 * Returns the notifications as an array. If no file exists, returns [].
 * @param {string} dataDir
 * @returns {{ agentId: string, type: string, message: string, ts: string }[]}
 */
export function drainNotifications(dataDir) {
  const filePath = path.join(dataDir, "notifications.jsonl");

  if (!fs.existsSync(filePath)) return [];

  // Check file is non-empty
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch { return []; }
  if (stat.size === 0) return [];

  // Atomic drain: rename → read → delete
  const drainPath = filePath + ".drain." + Date.now();
  try {
    fs.renameSync(filePath, drainPath);
  } catch (err) {
    log.warn(`Drain rename failed: ${err.message}`);
    return [];
  }

  try {
    const raw = fs.readFileSync(drainPath, "utf-8");
    fs.unlinkSync(drainPath);

    const notifications = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean);

    if (notifications.length > 0) {
      log.info(`Drained ${notifications.length} notification(s)`);
    }
    return notifications;
  } catch (err) {
    log.error(`Drain read failed: ${err.message}`);
    return [];
  }
}

/**
 * Format notifications into a human-readable message for Owner injection.
 * @param {{ agentId: string, type: string, message: string, ts: string }[]} notifications
 * @returns {string | null}
 */
export function formatNotifications(notifications) {
  if (!notifications || notifications.length === 0) return null;

  const lines = notifications.map((n) => {
    const icon = n.type === "exceeded" ? "⚠️" : n.type === "expired" ? "⏰" : "📋";
    return `${icon} ${n.agentId}: ${n.message}`;
  });

  return [
    `[租户管理通知 - ${notifications.length} 条]`,
    ...lines,
    `使用 /tenant quota <id> 更新配额。`,
  ].join("\n");
}
