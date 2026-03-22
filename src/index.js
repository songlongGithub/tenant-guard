import { initUsageDb } from "./store/usage-db.js";
import { createTenantsConfigLoader } from "./store/tenants-config.js";
import { onLlmOutput, onBeforeToolCall, onBeforePromptBuild } from "./hooks/quota.js";
import { log } from "./utils/logger.js";

export default {
  id: "tenant-guard",
  name: "Tenant Guard",
  description: "Multi-tenant authorization, quota, memory isolation, and profiling",
  version: "1.0.0",

  async register(api) {
    const dataDir = api.resolvePath("data");
    const db = initUsageDb(dataDir);
    const config = createTenantsConfigLoader(dataDir);

    log.info("Registering hooks...");

    // ── M2: Quota hooks ──────────────────────────
    api.on("llm_output", onLlmOutput(db), { priority: -10 });
    api.on("before_tool_call", onBeforeToolCall(db), { priority: -10 });
    api.on("before_prompt_build", onBeforePromptBuild(db), { priority: -10 });

    // ── M5: Notification hooks (added later) ─────

    // ── M4: Profile hooks (added later) ──────────

    // ── M3: Commands (added later) ───────────────

    log.info("✅ tenant-guard loaded successfully");
  },
};
