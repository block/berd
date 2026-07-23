import { getPlatform, type Platform } from "@/shared/lib/platform";

type SelectionModifierEvent = {
  ctrlKey: boolean;
  metaKey: boolean;
};

export type SessionAction = (sessionId: string) => unknown | Promise<unknown>;

type SessionActionOutcome = { ok: boolean } | undefined;

export function isMultiSelectModifier(
  event: SelectionModifierEvent,
  platform: Platform = getPlatform(),
) {
  return event.metaKey || (platform !== "mac" && event.ctrlKey);
}

export function areSetsEqual<T>(left: Set<T>, right: Set<T>) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

export function normalizeSelectedSessionIds({
  current,
  activeSessionIds,
  activeSessionId,
  includeActiveSession,
}: {
  current: Set<string>;
  activeSessionIds: Set<string>;
  activeSessionId?: string | null;
  includeActiveSession?: boolean;
}) {
  const next = new Set(
    [...current].filter((sessionId) => activeSessionIds.has(sessionId)),
  );

  if (
    includeActiveSession &&
    next.size > 0 &&
    activeSessionId &&
    activeSessionIds.has(activeSessionId)
  ) {
    next.add(activeSessionId);
  }

  return next;
}

export function toggleSessionSelection({
  current,
  sessionId,
  selected,
  activeSessionId,
  activeSessionIds,
  includeActiveSessionOnStart,
  clearActiveOnlySelection,
}: {
  current: Set<string>;
  sessionId: string;
  selected: boolean;
  activeSessionId?: string | null;
  activeSessionIds?: Set<string>;
  includeActiveSessionOnStart?: boolean;
  clearActiveOnlySelection?: boolean;
}) {
  const next = new Set(current);

  if (
    selected &&
    includeActiveSessionOnStart &&
    next.size === 0 &&
    activeSessionId &&
    activeSessionIds?.has(activeSessionId)
  ) {
    next.add(activeSessionId);
  }

  if (selected) {
    next.add(sessionId);
  } else {
    next.delete(sessionId);
  }

  if (
    !selected &&
    clearActiveOnlySelection &&
    activeSessionId &&
    next.size === 1 &&
    next.has(activeSessionId)
  ) {
    return new Set<string>();
  }

  return next;
}

export async function applySessionActionToIds(
  sessionIds: Iterable<string>,
  action?: SessionAction,
) {
  const ids = [...sessionIds];
  if (!action || ids.length === 0) {
    return;
  }

  // Run sequentially so an archive action that needs dirty-workspace
  // confirmation never races another confirmation dialog.
  const results: PromiseSettledResult<SessionActionOutcome>[] = [];
  for (const sessionId of ids) {
    try {
      const value = (await action(sessionId)) as SessionActionOutcome;
      results.push({ status: "fulfilled", value });
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
  }
  const failedCount = results.filter(
    (result) =>
      result.status === "rejected" ||
      (result.status === "fulfilled" && result.value?.ok === false),
  ).length;
  const rejectedReasons = results.flatMap((result) => {
    if (result.status === "rejected") return [result.reason];
    return result.value?.ok === false ? [result.value] : [];
  });

  return { failedCount, rejectedReasons };
}
