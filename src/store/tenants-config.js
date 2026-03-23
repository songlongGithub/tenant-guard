import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/logger.js";

let _cache = null;
let _lastMtime = 0;
let _tenantsPath = null;

const DAILY_MS = 24 * 60 * 60 * 1000;

/**
 * Initialize the tenants config loader.
 * @param {string} dataDir - Path to the plugin data directory
 * @returns {{ load: () => object, getTenantsPath: () => string }}
 */
export function createTenantsConfigLoader(dataDir) {
  _tenantsPath = path.join(dataDir, "tenants.json");

  // Create default if not exists
  if (!fs.existsSync(_tenantsPath)) {
    const defaultConfig = {
      ownerAgents: ["main"],
      ownerPeers: [],
      defaults: {
        quota: { maxTokens: 100000, maxCalls: 50, expiresAt: null, resetInterval: "daily" },
        tools: {
          allow: ["read", "web_search", "web_fetch", "memory_search", "memory_get"],
          deny: ["exec", "session_status"],
        },
        memory: { globalRead: true, globalWrite: false },
        overLimit: { action: "reject", downgradeModel: null },
        language: "auto",
        systemPrompt: null,
      },
      systemPromptTemplate:
        "你是 {name}，一个 AI 助手。\n{language_hint}\n体验额度：{maxTokens} tokens / {maxCalls} 次调用。",
      tenants: {},
    };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(_tenantsPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
    log.info(`Created default tenants.json at ${_tenantsPath}`);
  }

  return { load: loadTenantsSync, getTenantsPath: () => _tenantsPath };
}

/**
 * Load tenants.json synchronously with mtime-based caching.
 * @returns {object} The parsed tenants config
 */
export function loadTenantsSync() {
  if (!_tenantsPath) throw new Error("tenants config not initialized");
  try {
    const stat = fs.statSync(_tenantsPath);
    if (_cache && stat.mtimeMs === _lastMtime) return _cache;
    _cache = JSON.parse(fs.readFileSync(_tenantsPath, "utf-8"));
    _lastMtime = stat.mtimeMs;
    log.debug("tenants.json reloaded");
  } catch (err) {
    if (!_cache) throw err; // first load failure is fatal
    log.warn(`tenants.json reload failed, using cached: ${err.message}`);
  }
  return _cache;
}

/**
 * Check if a context represents an Owner.
 * Supports both agentId-only and peer-level checks.
 * @param {string|{agentId:string, peer?:string}} ctxOrAgentId
 * @returns {boolean}
 */
export function isOwner(ctxOrAgentId) {
  const config = loadTenantsSync();
  const ownerAgents = config.ownerAgents || ["main"];
  const ownerPeers = config.ownerPeers || [];

  const agentId = typeof ctxOrAgentId === "string" ? ctxOrAgentId : ctxOrAgentId.agentId;
  const peer = typeof ctxOrAgentId === "string" ? null : ctxOrAgentId.peer;

  if (!ownerAgents.includes(agentId)) return false;

  // If ownerPeers is configured, also check peer identity
  if (ownerPeers.length > 0 && peer) {
    return ownerPeers.includes(peer);
  }

  // No ownerPeers configured → all users on owner agent are Owners
  return true;
}

/**
 * Get the effective tenant ID for a context.
 * Owner → null (not a tenant).
 * Named agent (non-main) → agentId.
 * Main agent with peer → "peer:<peerId>" (virtual tenant).
 * @param {{ agentId: string, peer?: string }} ctx
 * @returns {string | null}
 */
export function getEffectiveTenantId(ctx) {
  if (isOwner(ctx)) return null;
  // Non-owner on 'main' agent → identify by peer
  if (ctx.agentId === "main" && ctx.peer) {
    return `peer:${ctx.peer}`;
  }
  return ctx.agentId;
}

/**
 * Get resolved tenant config, merging defaults with tenant-specific overrides.
 * Supports both agentId and "peer:xxx" format keys.
 * @param {string} tenantId
 * @returns {{ quota, tools, memory, overLimit, language, systemPrompt, label } | null}
 */
export function getTenantConfig(tenantId) {
  const config = loadTenantsSync();
  const tenant = config.tenants?.[tenantId];

  // For unregistered tenants, apply defaults
  const d = config.defaults || {};
  if (!tenant) {
    return {
      label: tenantId.startsWith("peer:") ? tenantId.slice(5) : tenantId,
      quota: { ...d.quota },
      tools: d.tools || { allow: [], deny: [] },
      memory: { ...d.memory },
      overLimit: { ...d.overLimit },
      language: d.language ?? "auto",
      systemPrompt: d.systemPrompt ?? null,
    };
  }

  return {
    label: tenant.label || tenantId,
    quota: { ...d.quota, ...tenant.quota },
    tools: tenant.tools || d.tools || { allow: [], deny: [] },
    memory: { ...d.memory, ...tenant.memory },
    overLimit: { ...d.overLimit, ...tenant.overLimit },
    language: tenant.language ?? d.language ?? "auto",
    systemPrompt: tenant.systemPrompt ?? d.systemPrompt ?? null,
  };
}

/**
 * Get the reset interval in milliseconds for a tenant.
 * @param {{ resetInterval?: string }} quota
 * @returns {number | null} null means no auto-reset
 */
export function getResetIntervalMs(quota) {
  if (!quota?.resetInterval || quota.resetInterval === "none") return null;
  if (quota.resetInterval === "daily") return DAILY_MS;
  return null;
}

/**
 * Check if a tenant's quota has expired.
 * @param {{ expiresAt?: string | null }} quota
 * @returns {boolean}
 */
export function isExpired(quota) {
  if (!quota?.expiresAt) return false;
  return new Date(quota.expiresAt).getTime() < Date.now();
}

/**
 * Write updates back to tenants.json.
 * @param {object} config - The full tenants config object
 */
export function writeTenantsConfig(config) {
  if (!_tenantsPath) throw new Error("tenants config not initialized");
  fs.writeFileSync(_tenantsPath, JSON.stringify(config, null, 2), "utf-8");
  // Invalidate cache
  _cache = null;
  _lastMtime = 0;
  log.info("tenants.json updated");
}
