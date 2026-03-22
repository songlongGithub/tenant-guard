#!/usr/bin/env node
/**
 * Self-test for tenant-guard M3: /tenant commands
 * Tests args parsing, validation, list, quota, config, owner subcommands.
 * Note: create/delete require writeConfigFile (OpenClaw runtime), tested in Docker.
 */
import path from "node:path";
import fs from "node:fs";

const testDir = path.join("/tmp", "tg-deps", "test-m3-" + Date.now());
const dataDir = path.join(testDir, "data");
fs.mkdirSync(dataDir, { recursive: true });

console.log(`\n🧪 tenant-guard M3 self-test`);
console.log(`📁 Test dir: ${testDir}\n`);

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.log(`  ❌ ${msg}`); failed++; }
}

// Initialize stores
const { initUsageDb, ensureUsageRow, addUsage } = await import("../src/store/usage-db.js");
const db = initUsageDb(dataDir);

// Write test tenants.json
const testConfig = {
  ownerAgents: ["main"],
  defaults: {
    quota: { maxTokens: 100000, maxCalls: 50, expiresAt: null, resetInterval: "daily" },
    tools: { allow: ["read", "web_search"], deny: ["exec", "write"] },
    memory: { globalRead: true, globalWrite: false },
    overLimit: { action: "reject", downgradeModel: null },
    language: "auto",
    systemPrompt: null,
  },
  tenants: {
    "demo-bot": {
      label: "Demo",
      quota: { maxTokens: 500000, maxCalls: 200, expiresAt: null, resetInterval: "daily" },
      language: "zh",
    },
    "expired-bot": {
      label: "Expired",
      quota: { maxTokens: 100000, maxCalls: 50, expiresAt: "2020-01-01T00:00:00Z", resetInterval: "daily" },
    },
  },
};
fs.writeFileSync(path.join(dataDir, "tenants.json"), JSON.stringify(testConfig, null, 2));

const { createTenantsConfigLoader } = await import("../src/store/tenants-config.js");
createTenantsConfigLoader(dataDir);

// Create usage rows
ensureUsageRow(db, "demo-bot");
addUsage(db, "demo-bot", 400000);
ensureUsageRow(db, "expired-bot");

// Import command handler (we need to mock api for create/delete, but can test others)
const { createTenantCommandHandler } = await import("../src/commands/tenant.js");

// Mock api for commands that don't need writeConfigFile
const mockApi = { runtime: { config: { loadConfig: () => ({ agents: { list: [{ id: "main" }], bindings: [] } }) } } };
const handler = createTenantCommandHandler(mockApi, db);

// ── Test 1: help ──────────────────────────────
console.log("── 1. Help ──");
const helpResult = await handler({ args: "" });
assert(helpResult.text.includes("tenant-guard"), "Help shows header");
assert(helpResult.text.includes("/tenant create"), "Help shows create");

// ── Test 2: list ──────────────────────────────
console.log("\n── 2. List ──");
const listResult = await handler({ args: "list" });
assert(listResult.text.includes("demo-bot"), "List shows demo-bot");
assert(listResult.text.includes("expired-bot"), "List shows expired-bot");
assert(listResult.text.includes("⚠️ 即将超限"), "demo-bot shows warning (80%+)");
assert(listResult.text.includes("⏰ 已过期"), "expired-bot shows expired");

// ── Test 3: quota display ─────────────────────
console.log("\n── 3. Quota display ──");
const quotaResult = await handler({ args: "quota demo-bot" });
assert(quotaResult.text.includes("400000"), "Shows current token usage");
assert(quotaResult.text.includes("500000"), "Shows max tokens");

// ── Test 4: quota reset ──────────────────────
console.log("\n── 4. Quota reset ──");
const resetResult = await handler({ args: "quota demo-bot --reset" });
assert(resetResult.text.includes("✅"), "Reset succeeds");
const { getUsage } = await import("../src/store/usage-db.js");
const postReset = getUsage(db, "demo-bot");
assert(postReset.tokens === 0, "Tokens = 0 after reset");

// ── Test 5: quota update ─────────────────────
console.log("\n── 5. Quota update ──");
const updateResult = await handler({ args: "quota demo-bot --tokens 1000000 --calls 500" });
assert(updateResult.text.includes("✅"), "Quota update succeeds");
const config2 = JSON.parse(fs.readFileSync(path.join(dataDir, "tenants.json"), "utf-8"));
assert(config2.tenants["demo-bot"].quota.maxTokens === 1000000, "maxTokens updated to 1000000");
assert(config2.tenants["demo-bot"].quota.maxCalls === 500, "maxCalls updated to 500");

// ── Test 6: config ────────────────────────────
console.log("\n── 6. Config ──");
const configResult = await handler({ args: "config demo-bot --language en --over-limit downgrade --downgrade-model bailian/qwen3.5-plus" });
assert(configResult.text.includes("✅"), "Config update succeeds");
const config3 = JSON.parse(fs.readFileSync(path.join(dataDir, "tenants.json"), "utf-8"));
assert(config3.tenants["demo-bot"].language === "en", "Language updated to en");
assert(config3.tenants["demo-bot"].overLimit.action === "downgrade", "overLimit action = downgrade");

// ── Test 7: owner ─────────────────────────────
console.log("\n── 7. Owner ──");
const ownerList = await handler({ args: "owner list" });
assert(ownerList.text.includes("main"), "Owner list shows main");

const ownerAdd = await handler({ args: "owner add admin-wx" });
assert(ownerAdd.text.includes("✅"), "Owner add succeeds");
const config4 = JSON.parse(fs.readFileSync(path.join(dataDir, "tenants.json"), "utf-8"));
assert(config4.ownerAgents.includes("admin-wx"), "admin-wx added to ownerAgents");

const ownerRemoveMain = await handler({ args: "owner remove main" });
assert(ownerRemoveMain.text.includes("❌"), "Cannot remove main");

const ownerRemove = await handler({ args: "owner remove admin-wx" });
assert(ownerRemove.text.includes("✅"), "Owner remove succeeds");

// ── Test 8: config error handling ─────────────
console.log("\n── 8. Error handling ──");
const noArgs = await handler({ args: "config" });
assert(noArgs.text.includes("❌"), "Config without ID shows error");

const nonExistent = await handler({ args: "config nonexistent --language zh" });
assert(nonExistent.text.includes("❌"), "Config nonexistent shows error");

const noChange = await handler({ args: "config demo-bot" });
assert(noChange.text.includes("❌"), "Config with no options shows error");

// ── Test 9: create validation (without writeConfigFile) ──
console.log("\n── 9. Create validation ──");
const noChannel = await handler({ args: "create test-bot" });
assert(noChannel.text.includes("❌") && noChannel.text.includes("--channel"), "Create without channel shows error");

// ── Summary ──────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`Results: ${passed} passed, ${failed} failed`);

fs.rmSync(testDir, { recursive: true, force: true });
if (failed > 0) { console.log("❌ FAILED\n"); process.exit(1); }
else { console.log("✅ ALL PASSED\n"); process.exit(0); }
