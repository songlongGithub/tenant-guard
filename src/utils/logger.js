const PREFIX = "[tenant-guard]";

export const log = {
  info: (...args) => console.log(PREFIX, ...args),
  warn: (...args) => console.warn(PREFIX, "⚠️", ...args),
  error: (...args) => console.error(PREFIX, "❌", ...args),
  debug: (...args) => {
    if (process.env.TENANT_GUARD_DEBUG === "1") {
      console.log(PREFIX, "🔍", ...args);
    }
  },
};
