import {
  cancelSession,
  deleteSession,
  forkSession,
  prompt,
  setSessionMode,
} from "@/shared/api/acpApi";
import {
  hidePrivateSessionNotifications,
  interceptSessionNotifications,
} from "@/shared/api/acpConnection";

export interface PrivateVoiceDraft {
  take: () => Promise<string | null>;
  dispose: () => void;
}

/** No main-session run, mode, permission or notification state is changed. */
export function startPrivateVoiceDraft(
  sourceSessionId: string,
  workingDir: string,
  text: string,
): PrivateVoiceDraft {
  let stopped = false;
  let forkId: string | undefined;
  let stopIntercepting: (() => void) | undefined;
  let setupTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanupFork = (sessionId: string) => {
    hidePrivateSessionNotifications(sessionId);
    // Neither cancellation nor deletion is trusted to settle. They cannot hold
    // the final queue, and neither ever targets the source session.
    void cancelSession(sessionId).catch(() => undefined);
    void deleteSession(sessionId).catch(() => undefined);
  };
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(setupTimer);
    clearTimeout(lifetimeTimer);
    stopIntercepting?.();
    if (forkId) cleanupFork(forkId);
  };
  const lifetimeTimer = setTimeout(dispose, 15_000);
  setupTimer = setTimeout(dispose, 2_000);
  const result = (async () => {
    const fork = await forkSession(sourceSessionId, workingDir);
    forkId = fork.sessionId;
    hidePrivateSessionNotifications(forkId);
    if (stopped) {
      cleanupFork(forkId);
      return null;
    }
    // Fail closed. Backend chat mode skips ALL tool_requests, including tools
    // that bypass the permission callback. Prompt must never precede this ack.
    await setSessionMode(forkId, "chat");
    if (stopped) return null;
    clearTimeout(setupTimer);
    const chunks: string[] = [];
    stopIntercepting = interceptSessionNotifications((notification) => {
      if (notification.sessionId !== forkId) return false;
      const { update } = notification;
      if (
        !stopped &&
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      )
        chunks.push(update.content.text);
      return true;
    });
    await prompt(forkId, [{ type: "text", text }]);
    return stopped ? null : chunks.join("").trim() || null;
  })()
    .catch(() => null)
    .finally(dispose);
  return {
    dispose,
    async take() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          result,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 750);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        dispose();
      }
    },
  };
}
