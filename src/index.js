import { initUsageDb } from "./store/usage-db.js";
import { createTenantsConfigLoader } from "./store/tenants-config.js";
import { onLlmOutput, onBeforeToolCall, onBeforePromptBuild } from "./hooks/quota.js";
import { onOwnerNotify } from "./hooks/notify.js";
import { onBeforeReset } from "./hooks/profile.js";
import { createTenantCommandHandler } from "./commands/tenant.js";
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
    api.on("llm_output", onLlmOutput(db, dataDir), { priority: -10 });
    api.on("before_tool_call", onBeforeToolCall(db), { priority: -10 });
    api.on("before_prompt_build", onBeforePromptBuild(db, dataDir), { priority: -10 });

    // ── M5: Notification hook ─────────────────────
    api.on("before_prompt_build", onOwnerNotify(dataDir), { priority: -10 });

    // ── M4: Profile hook ──────────────────────
    api.on("before_reset", onBeforeReset(db), { priority: -10 });

    // ── M3: Tenant management command ────────────
    api.registerCommand({
      name: "tenant",
      description: "多租户管理（create/delete/list/quota/config/owner/cleanup）",
      acceptsArgs: true,
      requireAuth: true,
      handler: createTenantCommandHandler(api, db),
    });

    log.info("✅ tenant-guard loaded successfully");
  },
};
