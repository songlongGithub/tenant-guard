import { drainNotifications, formatNotifications } from "../store/notifications.js";
import { isOwner } from "../store/tenants-config.js";

/**
 * before_prompt_build hook for Owner notification injection.
 * When Owner sends a message, drain the notification queue and prepend to context.
 * @param {string} dataDir
 */
export function onOwnerNotify(dataDir) {
  return (event, ctx) => {
    const agentId = ctx.agentId;
    if (!agentId || !isOwner(agentId)) return;

    const notifications = drainNotifications(dataDir);
    const formatted = formatNotifications(notifications);
    if (formatted) {
      return { prependContext: formatted };
    }
  };
}
