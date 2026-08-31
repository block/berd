import { useEffect, useRef } from "react";
import { runChatRuntimeStartup } from "@/app/lib/chatRuntimeStartup";
import { REMOTE_SSH_SESSIONS_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";

/** Keep remote-session state aligned with the user-local experiment in every window. */
export function useRemoteSessionExperimentReconciliation(): boolean {
  const enabled =
    useExperiment(REMOTE_SSH_SESSIONS_EXPERIMENT_ID)?.enabled === true;
  const reconciliationRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    reconciliationRef.current = reconciliationRef.current
      .catch(() => undefined)
      .then(async () => {
        await runChatRuntimeStartup();
        if (enabled) {
          // Live host statuses feed the sidebar indicator and the chat
          // disconnected banner, so the subscription must not wait for the
          // settings card to mount.
          const { ensureRemoteHostStoreInitialized } = await import(
            "@/features/remoteHosts/stores/remoteHostStore"
          );
          ensureRemoteHostStoreInitialized();
        }
        const { reconcileRemoteSessionsForExperiment } = await import(
          "@/features/chat/stores/remoteSessionPersistence"
        );
        await reconcileRemoteSessionsForExperiment(enabled);
      })
      .catch((error) => {
        console.error("Failed to reconcile remote-session experiment:", error);
      });
  }, [enabled]);

  return enabled;
}
