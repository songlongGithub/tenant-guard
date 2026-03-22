import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { log } from "../utils/logger.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS usage (
  agent_id    TEXT PRIMARY KEY,
  tokens      INTEGER NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0,
  notified    INTEGER NOT NULL DEFAULT 0,
  last_reset  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quota_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  agent_id        TEXT PRIMARY KEY,
  label           TEXT,
  channel         TEXT,
  account_id      TEXT,
  first_seen      TEXT,
  last_seen       TEXT,
  session_count   INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  total_calls     INTEGER NOT NULL DEFAULT 0
);
`;

let _db = null;

/**
 * Initialize or return the SQLite database.
 * @param {string} dataDir - Path to the plugin data directory
 * @returns {import("better-sqlite3").Database}
 */
export function initUsageDb(dataDir) {
  if (_db) return _db;

  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "usage.sqlite");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.exec(SCHEMA);

  log.info(`SQLite initialized: ${dbPath}`);
  return _db;
}

/**
 * Ensure a usage row exists for the given agent.
 * @param {import("better-sqlite3").Database} db
 * @param {string} agentId
 */
export function ensureUsageRow(db, agentId) {
  db.prepare(
    "INSERT OR IGNORE INTO usage (agent_id, last_reset) VALUES (?, ?)"
  ).run(agentId, Date.now());
}

/**
 * Get usage for a specific agent.
 * @param {import("better-sqlite3").Database} db
 * @param {string} agentId
 * @returns {{ tokens: number, calls: number, notified: number, last_reset: number } | null}
 */
export function getUsage(db, agentId) {
  return db.prepare("SELECT * FROM usage WHERE agent_id = ?").get(agentId) || null;
}

/**
 * Atomically increment token and call counts.
 * @param {import("better-sqlite3").Database} db
 * @param {string} agentId
 * @param {number} tokens
 */
export function addUsage(db, agentId, tokens) {
  ensureUsageRow(db, agentId);
  db.prepare(
    "UPDATE usage SET tokens = tokens + ?, calls = calls + 1 WHERE agent_id = ?"
  ).run(tokens, agentId);
}

/**
 * Check and reset usage if the sliding window has elapsed.
 * Uses a transaction for atomicity.
 * @param {import("better-sqlite3").Database} db
 * @param {string} agentId
 * @param {number} intervalMs - Reset interval in milliseconds (e.g., 86400000 for daily)
 * @returns {boolean} true if reset was performed
 */
export const checkAndReset = (db) =>
  db.transaction((agentId, intervalMs) => {
    const now = Date.now();
    const row = db
      .prepare("SELECT last_reset FROM usage WHERE agent_id = ?")
      .get(agentId);
    if (!row) return false;
    if (now - row.last_reset >= intervalMs) {
      db.prepare(
        "UPDATE usage SET tokens = 0, calls = 0, notified = 0, last_reset = ? WHERE agent_id = ?"
      ).run(now, agentId);
      log.info(`Usage reset for ${agentId}`);
      return true;
    }
    return false;
  });

/**
 * CAS operation to mark notified. Returns true if this call was the one that set it.
 * @param {import("better-sqlite3").Database} db
 * @param {string} agentId
 * @returns {boolean}
 */
export function markNotified(db, agentId) {
  const result = db
    .prepare("UPDATE usage SET notified = 1 WHERE agent_id = ? AND notified = 0")
    .run(agentId);
  return result.changes > 0;
}

/**
 * Delete usage row for an agent.
 * @param {import("better-sqlite3").Database} db
 * @param {string} agentId
 */
export function deleteUsage(db, agentId) {
  db.prepare("DELETE FROM usage WHERE agent_id = ?").run(agentId);
}

/**
 * Record a quota event for auditing.
 * @param {import("better-sqlite3").Database} db
 * @param {string} agentId
 * @param {string} eventType
 * @param {string} [detail]
 */
export function recordQuotaEvent(db, agentId, eventType, detail) {
  db.prepare(
    "INSERT INTO quota_events (agent_id, event_type, detail, created_at) VALUES (?, ?, ?, ?)"
  ).run(agentId, eventType, detail || null, Date.now());
}
