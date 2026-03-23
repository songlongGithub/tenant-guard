#!/usr/bin/env node
/**
 * Self-test for tenant-guard M2: SQLite + tenants-config + quota hooks
 * Run: node test/self-test-m2.mjs
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Create temp dir for test in a writable location
const testDir = path.join("/tmp", "tg-deps", "test-data-" + Date.now());
fs.mkdirSync(testDir, { recursive: true });
const dataDir = path.join(testDir, "data");
fs.mkdirSync(dataDir, { recursive: true });

console.log(`\n🧪 tenant-guard M2 self-test`);
console.log(`📁 Test dir: ${testDir}\n`);

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

// ── Test 1: SQLite usage-db ──────────────────────
console.log("── 1. SQLite usage-db ──");

const { initUsageDb, ensureUsageRow, getUsage, addUsage, checkAndReset, markNotified } = await import("../src/store/usage-db.js");

const db = initUsageDb(dataDir);
assert(db != null, "DB initialized");

ensureUsageRow(db, "test-agent");
const row = getUsage(db, "test-agent");
assert(row != null, "Usage row created");
assert(row.tokens === 0, "Initial tokens = 0");
assert(row.calls === 0, "Initial calls = 0");

addUsage(db, "test-agent", 500);
const row2 = getUsage(db, "test-agent");
assert(row2.tokens === 500, "After addUsage(500): tokens = 500");
assert(row2.calls === 1, "After addUsage(500): calls = 1");

addUsage(db, "test-agent", 300);
const row3 = getUsage(db, "test-agent");
assert(row3.tokens === 800, "After addUsage(300): tokens = 800 (atomic add)");
assert(row3.calls === 2, "After addUsage(300): calls = 2");

// CAS notify
const firstNotify = markNotified(db, "test-agent");
assert(firstNotify === true, "markNotified first call: true");
const secondNotify = markNotified(db, "test-agent");
assert(secondNotify === false, "markNotified second call: false (CAS)");

// Reset - set last_reset to a past time first
db.prepare("UPDATE usage SET last_reset = ? WHERE agent_id = ?")
  .run(Date.now() - 100000, "test-agent"); // 100 seconds ago
const resetFn = checkAndReset(db);
const didReset = resetFn("test-agent", 1000); // 1s interval, last_reset was 100s ago
assert(didReset === true, "checkAndReset with elapsed interval: reset triggered");
const row4 = getUsage(db, "test-agent");
assert(row4.tokens === 0, "After reset: tokens = 0");
assert(row4.calls === 0, "After reset: calls = 0");
assert(row4.notified === 0, "After reset: notified = 0");

// Reset should NOT trigger when interval hasn't elapsed
addUsage(db, "test-agent", 100);
const didResetAgain = resetFn("test-agent", 86400000); // 24h interval, just reset
assert(didResetAgain === false, "checkAndReset with long interval: no reset");

// ── Test 2: tenants-config ──────────────────────
console.log("\n── 2. tenants-config ──");

// Write test tenants.json
const testConfig = {
  ownerAgents: ["main", "admin-wx"],
  defaults: {
    quota: { maxTokens: 100000, maxCalls: 50, expiresAt: null, resetInterval: "daily" },
    tools: { allow: ["read", "web_search"], deny: ["exec", "write"] },
    memory: { globalRead: true, globalWrite: false },
    overLimit: { action: "reject", downgradeModel: null },
    language: "auto",
    systemPrompt: null,
  },
  systemPromptTemplate: "你是 {name}。\n{language_hint}",
  tenants: {
    "test-bot": {
      label: "测试用户",
      quota: { maxTokens: 500000, maxCalls: 200 },
      language: "zh",
      overLimit: { action: "downgrade", downgradeModel: "bailian/qwen3.5-plus" },
    },
    "expired-bot": {
      quota: { expiresAt: "2020-01-01T00:00:00Z" },
    },
  },
};
fs.writeFileSync(path.join(dataDir, "tenants.json"), JSON.stringify(testConfig, null, 2));

const { createTenantsConfigLoader, isOwner, getTenantConfig, isExpired, getResetIntervalMs } = await import("../src/store/tenants-config.js");

const loader = createTenantsConfigLoader(dataDir);
const config = loader.load();
assert(config.ownerAgents.length === 2, "ownerAgents has 2 entries");

assert(isOwner("main") === true, "isOwner('main') = true");
assert(isOwner("admin-wx") === true, "isOwner('admin-wx') = true");
assert(isOwner("test-bot") === false, "isOwner('test-bot') = false");

const tc = getTenantConfig("test-bot");
assert(tc != null, "getTenantConfig('test-bot') returns config");
assert(tc.label === "测试用户", "Tenant label = '测试用户'");
assert(tc.quota.maxTokens === 500000, "Tenant maxTokens = 500000 (override)");
assert(tc.quota.resetInterval === "daily", "Tenant resetInterval = 'daily' (default)");
assert(tc.overLimit.action === "downgrade", "Tenant overLimit.action = 'downgrade'");
assert(tc.language === "zh", "Tenant language = 'zh'");

const unknown = getTenantConfig("nonexistent");
assert(unknown !== null && unknown.quota, "getTenantConfig('nonexistent') returns defaults");

assert(isExpired(testConfig.tenants["expired-bot"].quota) === true, "expired-bot is expired");
assert(isExpired(tc.quota) === false, "test-bot is not expired");

assert(getResetIntervalMs({ resetInterval: "daily" }) === 86400000, "daily = 86400000ms");
assert(getResetIntervalMs({ resetInterval: "none" }) === null, "none = null");

// ── Summary ──────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`Results: ${passed} passed, ${failed} failed`);

// Cleanup
fs.rmSync(testDir, { recursive: true, force: true });

if (failed > 0) {
  console.log("❌ FAILED\n");
  process.exit(1);
} else {
  console.log("✅ ALL PASSED\n");
  process.exit(0);
}
