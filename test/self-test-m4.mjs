#!/usr/bin/env node
/**
 * Self-test for tenant-guard M4: Profile + Keywords
 */
import path from "node:path";
import fs from "node:fs";

const testDir = path.join("/tmp", "tg-deps", "test-m4-" + Date.now());
const dataDir = path.join(testDir, "data");
fs.mkdirSync(dataDir, { recursive: true });

console.log(`\n🧪 tenant-guard M4 self-test\n`);
let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.log(`  ❌ ${msg}`); failed++; }
}

// ── Test 1: Keywords ──────────────────────────
console.log("── 1. Keyword extraction ──");
const { extractTopics } = await import("../src/utils/keywords.js");

const topics = extractTopics([
  { role: "user", content: "帮我查一下深度学习的最新论文" },
  { role: "assistant", content: "好的，查到了..." },
  { role: "user", content: "深度学习和机器学习有什么区别" },
  { role: "user", content: "Python怎么安装TensorFlow" },
]);
assert(topics.length > 0, `Extracted ${topics.length} topics`);
assert(topics[0].count >= 1, `Top topic appears ${topics[0].count}+ times`);
const topicNames = topics.map(t => t.topic);
assert(topicNames.some(t => t.includes("深度") || t.includes("学习")), "Contains '深度/学习'");

const enTopics = extractTopics([
  { role: "user", content: "How to use React hooks in TypeScript" },
  { role: "user", content: "React performance optimization tips" },
  { role: "user", content: "TypeScript generics tutorial" },
]);
assert(enTopics.length > 0, `English: extracted ${enTopics.length} topics`);
const enNames = enTopics.map(t => t.topic);
assert(enNames.includes("react"), "English: contains 'react'");

const emptyTopics = extractTopics([]);
assert(emptyTopics.length === 0, "Empty messages: 0 topics");

// ── Test 2: Profile hook ──────────────────────
console.log("\n── 2. Profile hook ──");

// Setup DB and tenants
const { initUsageDb, ensureUsageRow, addUsage } = await import("../src/store/usage-db.js");
const db = initUsageDb(dataDir);
ensureUsageRow(db, "test-bot");
addUsage(db, "test-bot", 1000);

fs.writeFileSync(path.join(dataDir, "tenants.json"), JSON.stringify({
  ownerAgents: ["main"],
  defaults: { quota: { maxTokens: 100000, maxCalls: 50 }, tools: { allow: [], deny: [] }, memory: {}, overLimit: {}, language: "auto" },
  tenants: { "test-bot": { label: "Test Bot", quota: { maxTokens: 100000, maxCalls: 50 } } },
}));

const { createTenantsConfigLoader } = await import("../src/store/tenants-config.js");
createTenantsConfigLoader(dataDir);

const { onBeforeReset } = await import("../src/hooks/profile.js");
const hook = onBeforeReset(db);

// Simulate session reset
hook(
  { messages: [
    { role: "user", content: "天气怎么样" },
    { role: "assistant", content: "今天晴天" },
    { role: "user", content: "明天天气预报" },
  ] },
  { agentId: "test-bot" }
);

const profile = db.prepare("SELECT * FROM profiles WHERE agent_id = ?").get("test-bot");
assert(profile != null, "Profile created");
assert(profile.session_count === 1, "session_count = 1");
assert(profile.first_seen != null, "first_seen set");
assert(profile.last_seen != null, "last_seen set");
assert(profile.total_tokens === 1000, `total_tokens = 1000 (got ${profile.total_tokens})`);

// Second session
addUsage(db, "test-bot", 500);
hook(
  { messages: [{ role: "user", content: "再查一下" }] },
  { agentId: "test-bot" }
);
const profile2 = db.prepare("SELECT * FROM profiles WHERE agent_id = ?").get("test-bot");
assert(profile2.session_count === 2, "session_count = 2 after second session");
assert(profile2.total_tokens === 2500, `total_tokens = 2500 (got ${profile2.total_tokens})`);

// Owner should be skipped
hook({ messages: [{ role: "user", content: "test" }] }, { agentId: "main" });
const ownerProfile = db.prepare("SELECT * FROM profiles WHERE agent_id = ?").get("main");
assert(ownerProfile == null, "Owner profile NOT created");

// ── Summary ──────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`Results: ${passed} passed, ${failed} failed`);
fs.rmSync(testDir, { recursive: true, force: true });
if (failed > 0) { console.log("❌ FAILED\n"); process.exit(1); }
else { console.log("✅ ALL PASSED\n"); process.exit(0); }
