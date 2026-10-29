import { compositeSessionId, type AcpBackendId } from "./acpBackendId";
import type { deliverSessionPrompt } from "@/features/berdctl/commands/runtime/deliverSessionPrompt";

const PREFIX = "_goose/unstable/session/delegated-tasks/";
type Request = (
  method: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Delivery acceptance and result retrieval are deliberately separate operations. */
export async function drainDelegatedTaskEvents(
  request: Request,
  backend: AcpBackendId,
  parents: string[],
  deliver: typeof deliverSessionPrompt,
): Promise<void> {
  if (!parents.length) return;
  const { events } = await request(`${PREFIX}pending`, {
    parentSessionIds: parents,
  });
  if (!Array.isArray(events)) return;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const { taskId, parentSessionId, description, status } = event;
    if (
      typeof taskId !== "string" ||
      typeof parentSessionId !== "string" ||
      typeof description !== "string" ||
      typeof status !== "string" ||
      !parents.includes(parentSessionId)
    )
      continue;
    const outcome =
      status === "action_limit_reached"
        ? "Worker reached its action limit. Work is incomplete."
        : `Worker ended with status: ${status}.`;
    try {
      await deliver(
        {
          session_id: compositeSessionId(backend, parentSessionId),
          prompt: `${outcome}\nTask: ${taskId}\nDelegated work: ${description}\nUse load(source: ${JSON.stringify(taskId)}) to retrieve the result and any recorded progress. Decide whether to continue the work or surface a blocker. Do not assume the task succeeded.`,
          if_running: "queue",
          from: "Delegated worker",
          delivery_id: `delegated-task:${taskId}`,
        },
        { eventType: "notification" },
      );
      await request(`${PREFIX}acknowledge`, { parentSessionId, taskId });
    } catch {
      // A window handoff, dispatch rejection, or lost acknowledgement leaves
      // the event pending. The next attempt uses the same deduplicated ID.
    }
  }
}

/** One loop per backend connection, never one process or timer per worker. */
export function startDelegatedTaskDelivery(
  request: Request,
  backend: AcpBackendId,
  signal: AbortSignal,
): void {
  void (async () => {
    const [
      { useChatSessionStore },
      { backendIdForSession, splitCompositeSessionId },
      { deliverSessionPrompt },
    ] = await Promise.all([
      import("@/features/chat/stores/chatSessionStore"),
      import("./acpBackendId"),
      import("@/features/berdctl/commands/runtime/deliverSessionPrompt"),
    ]);
    while (!signal.aborted) {
      const parents = useChatSessionStore
        .getState()
        .sessions.filter(
          (session) =>
            backendIdForSession(session) === backend && !session.archivedAt,
        )
        .map(
          (session) =>
            splitCompositeSessionId(session.id)?.wireSessionId ?? session.id,
        );
      try {
        await drainDelegatedTaskEvents(
          request,
          backend,
          parents,
          async (...args) => {
            if (signal.aborted) throw new Error("Completion transport retired");
            return deliverSessionPrompt(...args);
          },
        );
      } catch (error) {
        // Older or other harness backends need not implement this extension.
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === -32601
        )
          return;
      }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 1000);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  })();
}
