import type { WidgetInstance } from "@/features/home/widgets/types";

export type PinnedHomeNavigationTarget =
  | { kind: "chat"; id: string }
  | { kind: "project"; id: string };

function normalizedStateId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id || null;
}

/**
 * Returns the home pins that also belong in global navigation. The widget
 * order is preserved so projects and chats can share one Pinned section.
 */
export function getPinnedHomeNavigationTargets(
  instances: readonly WidgetInstance[],
): PinnedHomeNavigationTarget[] {
  const targets: PinnedHomeNavigationTarget[] = [];
  const seen = new Set<string>();

  for (const instance of instances) {
    const target =
      instance.type === "chatPin"
        ? ({
            kind: "chat" as const,
            id: normalizedStateId(instance.state?.sessionId),
          } as const)
        : instance.type === "projectArtifactPin"
          ? ({
              kind: "project" as const,
              id: normalizedStateId(instance.state?.projectId),
            } as const)
          : null;
    if (!target?.id) continue;

    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ kind: target.kind, id: target.id });
  }

  return targets;
}

export function getPinnedHomeChatSessionIds(
  instances: readonly WidgetInstance[],
): ReadonlySet<string> {
  return new Set(
    getPinnedHomeNavigationTargets(instances)
      .filter((target) => target.kind === "chat")
      .map((target) => target.id),
  );
}
