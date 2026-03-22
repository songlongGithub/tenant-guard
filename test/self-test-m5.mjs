#!/usr/bin/env node
/**
 * Self-test for tenant-guard M5: Notification queue
 * Run: node test/self-test-m5.mjs
 */
import path from "node:path";
import fs from "node:fs";

const testDir = path.join("/tmp", "tg-deps", "test-m5-" + Date.now());
fs.mkdirSync(path.join(testDir, "data"), { recursive: true });
const dataDir = path.join(testDir, "data");

console.log(`\n🧪 tenant-guard M5 self-test`);
console.log(`📁 Test dir: ${testDir}\n`);

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.log(`  ❌ ${msg}`); failed++; }
}

const { appendNotification, drainNotifications, formatNotifications } = await import("../src/store/notifications.js");

// ── Test 1: Basic append + drain ──────────────
console.log("── 1. Append + Drain ──");

appendNotification(dataDir, { agentId: "tenant-a", type: "exceeded", message: "Token 额度用尽（100000/100000）" });
appendNotification(dataDir, { agentId: "tenant-b", type: "expired", message: "授权已过期" });

const filePath = path.join(dataDir, "notifications.jsonl");
assert(fs.existsSync(filePath), "notifications.jsonl created");

const raw = fs.readFileSync(filePath, "utf-8");
const lines = raw.trim().split("\n");
assert(lines.length === 2, `File has 2 lines (got ${lines.length})`);

const entry = JSON.parse(lines[0]);
assert(entry.agentId === "tenant-a", "First entry agentId = tenant-a");
assert(entry.type === "exceeded", "First entry type = exceeded");
assert(entry.ts != null, "Entry has timestamp");

// ── Test 2: Drain operation ──────────────────
console.log("\n── 2. Drain ──");

const notifications = drainNotifications(dataDir);
assert(notifications.length === 2, `Drained 2 notifications (got ${notifications.length})`);
assert(!fs.existsSync(filePath), "notifications.jsonl removed after drain");

// Drain again should return empty
const empty = drainNotifications(dataDir);
assert(empty.length === 0, "Second drain returns empty");

// ── Test 3: Format ────────────────────────────
console.log("\n── 3. Format ──");

const formatted = formatNotifications(notifications);
assert(formatted != null, "formatNotifications returns string");
assert(formatted.includes("租户管理通知"), "Contains header");
assert(formatted.includes("⚠️ tenant-a"), "Contains tenant-a exceeded");
assert(formatted.includes("⏰ tenant-b"), "Contains tenant-b expired");
assert(formatted.includes("/tenant quota"), "Contains action hint");

const emptyFormat = formatNotifications([]);
assert(emptyFormat === null, "Empty array returns null");

// ── Test 4: Concurrent appends ────────────────
console.log("\n── 4. Multiple rapid appends ──");

for (let i = 0; i < 10; i++) {
  appendNotification(dataDir, { agentId: `bot-${i}`, type: "exceeded", message: `test ${i}` });
}
const bulkDrain = drainNotifications(dataDir);
assert(bulkDrain.length === 10, `Drained 10 rapid notifications (got ${bulkDrain.length})`);

// ── Summary ──────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`Results: ${passed} passed, ${failed} failed`);

fs.rmSync(testDir, { recursive: true, force: true });

if (failed > 0) { console.log("❌ FAILED\n"); process.exit(1); }
else { console.log("✅ ALL PASSED\n"); process.exit(0); }
