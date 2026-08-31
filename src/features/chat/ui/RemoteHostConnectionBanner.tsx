import { useCallback, useState } from "react";
import { Globe2, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useRemoteHostStore } from "@/features/remoteHosts/stores/remoteHostStore";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

interface RemoteHostConnectionBannerProps {
  host: string;
  /** Session to reload once the tunnel is back, so the transcript resyncs. */
  sessionId: string | null;
}

/**
 * Connection status for the active remote chat, shown above the composer.
 * A host with no status entry yet (fresh app run, rehydrated session) is
 * effectively disconnected: nothing has dialed the tunnel this run.
 * Renders nothing while the host is ready.
 */
export function RemoteHostConnectionBanner({
  host,
  sessionId,
}: RemoteHostConnectionBannerProps) {
  const { t } = useTranslation("chat");
  const status = useRemoteHostStore((store) => store.statusByHost[host]);
  const ensureHostConnected = useRemoteHostStore(
    (store) => store.ensureHostConnected,
  );
  const [reconnectPending, setReconnectPending] = useState(false);

  const handleReconnect = useCallback(async () => {
    setReconnectPending(true);
    try {
      await ensureHostConnected(host);
      if (sessionId) {
        // Replays the remote transcript so anything that happened while the
        // tunnel was down (the daemon keeps running) shows up.
        const { loadSessionMessages } = await import(
          "@/features/chat/lib/sessionActivation"
        );
        await loadSessionMessages(sessionId);
      }
    } catch {
      // ensureHostConnected already recorded the failure in statusByHost;
      // the banner re-renders into the failed state with a retry button.
    } finally {
      setReconnectPending(false);
    }
  }, [ensureHostConnected, host, sessionId]);

  const state = status?.state ?? "disconnected";
  if (state === "ready") return null;

  const busy =
    reconnectPending || state === "connecting" || state === "reconnecting";
  const label = busy
    ? state === "reconnecting"
      ? t("toolbar.remoteHost.banner.reconnecting", { host })
      : t("toolbar.remoteHost.banner.connecting", { host })
    : state === "failed"
      ? t("toolbar.remoteHost.banner.failed", { host })
      : t("toolbar.remoteHost.banner.disconnected", { host });
  const detail = !busy && state === "failed" ? status?.error?.message : null;

  return (
    <div
      data-remote-host-banner
      role="status"
      className={cn(
        "mb-2 flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm",
        state === "failed" ? "border-destructive/30" : "border-border",
      )}
    >
      {busy ? (
        <Loader2
          className="size-4 shrink-0 animate-spin text-muted-foreground"
          aria-hidden="true"
        />
      ) : (
        <Globe2
          className={cn(
            "size-4 shrink-0",
            state === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
          aria-hidden="true"
        />
      )}
      <div className="min-w-0 flex-1">
        <span className="text-foreground">{label}</span>
        {detail ? (
          <span className="ml-2 truncate text-muted-foreground text-xs">
            {detail}
          </span>
        ) : null}
      </div>
      {!busy ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void handleReconnect()}
        >
          {t("toolbar.remoteHost.banner.reconnect")}
        </Button>
      ) : null}
    </div>
  );
}
