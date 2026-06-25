import type { WidgetInstance } from "@/features/home/widgets/types";

export function getPinnedHomeChatSessionIds(
  instances: readonly WidgetInstance[],
): ReadonlySet<string> {
  const sessionIds = new Set<string>();

  for (const instance of instances) {
    const sessionId = instance.state?.sessionId;
    if (instance.type === "chatPin" && typeof sessionId === "string") {
      const trimmedSessionId = sessionId.trim();
      if (trimmedSessionId) {
        sessionIds.add(trimmedSessionId);
      }
    }
  }

  return sessionIds;
}
