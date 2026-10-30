import {
  cancelSession,
  deleteSession,
  getSessionInfo,
  newSession,
  setModel,
  prompt,
  setSessionMode,
} from "@/shared/api/acpApi";
import {
  hidePrivateSessionNotifications,
  interceptSessionNotifications,
} from "@/shared/api/acpConnection";

import { getSessionBackend } from "@/shared/api/acpSessionBackends";

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
  let privateSessionId: string | undefined;
  let stopIntercepting: (() => void) | undefined;
  let setupTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanupSession = (sessionId: string) => {
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
    if (privateSessionId) cleanupSession(privateSessionId);
  };
  const lifetimeTimer = setTimeout(dispose, 15_000);
  setupTimer = setTimeout(dispose, 2_000);
  const result = (async () => {
    const source = await getSessionInfo(sourceSessionId);
    if (stopped || !source.providerId?.trim() || !source.modelId?.trim())
      return null;
    // Transcript-only speculation: never copy source history (including hidden
    // context). The final source-session turn retains full history and authority.
    // Hidden must be set at creation, not applied to a visible fork afterward.
    const session = await newSession(workingDir, {
      hidden: true,
      providerId: source.providerId,
      backendId: getSessionBackend(sourceSessionId),
    });
    privateSessionId = session.sessionId;
    hidePrivateSessionNotifications(privateSessionId);
    if (stopped) {
      cleanupSession(privateSessionId);
      return null;
    }
    // Fail closed. Backend chat mode skips ALL tool_requests, including tools
    // that bypass the permission callback. Prompt must never precede this ack.
    await setModel(privateSessionId, source.modelId);
    if (stopped) return null;
    await setSessionMode(privateSessionId, "chat");
    if (stopped) return null;
    clearTimeout(setupTimer);
    const chunks: string[] = [];
    stopIntercepting = interceptSessionNotifications((notification) => {
      if (notification.sessionId !== privateSessionId) return false;
      const { update } = notification;
      if (
        !stopped &&
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      )
        chunks.push(update.content.text);
      return true;
    });
    await prompt(privateSessionId, [{ type: "text", text }]);
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
