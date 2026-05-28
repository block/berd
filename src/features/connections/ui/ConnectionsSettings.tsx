import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { toast } from "sonner";
import { IconExternalLink } from "@tabler/icons-react";
import {
  type Connection,
  listConnections,
} from "@/features/connections/api/connections";
import {
  OAUTH_PROVIDERS,
  type OAuthProviderEntry,
} from "@/features/connections/catalog";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { SettingsPage } from "@/shared/ui/SettingsPage";

const CONNECTIONS_REFETCH_INTERVAL_MS = 5_000;
const SECONDS_IN_DAY = 86_400;
const EXPIRY_WARNING_WINDOW_MS = 7 * SECONDS_IN_DAY * 1000;

const DEFAULT_G2_BASE_URL = "https://g2.sqprod.co";
const G2_BASE_URL =
  import.meta.env.VITE_GOOSE_INTERNAL_G2_BASE_URL ?? DEFAULT_G2_BASE_URL;
const RETURN_URL = "goose-internal://connect-return";

type ConnectionStatus =
  | { kind: "active" }
  | { kind: "expiring"; daysUntilExpiry: number }
  | { kind: "expired" }
  | { kind: "disconnected" };

const STATUS_PRIORITY: Record<ConnectionStatus["kind"], number> = {
  expired: 0,
  expiring: 1,
  active: 2,
  disconnected: 3,
};

function resolveStatus(
  connection: Connection | undefined,
  nowMs: number,
): ConnectionStatus {
  if (!connection) return { kind: "disconnected" };
  const expiresAtEpochS = connection.expiresAtEpochS;
  const expiresAtMs =
    expiresAtEpochS !== undefined ? expiresAtEpochS * 1000 : undefined;
  if (
    connection.previouslyConnected === true &&
    (expiresAtMs === undefined || expiresAtMs <= nowMs)
  ) {
    return { kind: "expired" };
  }
  if (expiresAtEpochS === undefined || expiresAtMs === undefined) {
    return { kind: "active" };
  }
  if (expiresAtMs <= nowMs) return { kind: "expired" };
  if (expiresAtMs - nowMs <= EXPIRY_WARNING_WINDOW_MS) {
    const nowSeconds = Math.floor(nowMs / 1000);
    const daysUntilExpiry = Math.floor(
      (expiresAtEpochS - nowSeconds) / SECONDS_IN_DAY,
    );
    return { kind: "expiring", daysUntilExpiry };
  }
  return { kind: "active" };
}

function buildConnectUrl(extensionName: string): string {
  const params = new URLSearchParams({
    extension: extensionName,
    return: RETURN_URL,
  });
  return `${G2_BASE_URL}/connections/start?${params.toString()}`;
}

function StatusBadge({ status }: { status: ConnectionStatus }) {
  const { t } = useTranslation("settings");
  if (status.kind === "active" || status.kind === "disconnected") return null;
  const label =
    status.kind === "expired"
      ? t("connections.status.expired")
      : status.daysUntilExpiry === 0
        ? t("connections.expiresToday")
        : status.daysUntilExpiry === 1
          ? t("connections.expiresTomorrow")
          : t("connections.expiresInDays", { count: status.daysUntilExpiry });
  return (
    <div className="mt-2">
      <Badge variant="destructive">{label}</Badge>
    </div>
  );
}

function ConnectionRow({
  entry,
  status,
}: {
  entry: OAuthProviderEntry;
  status: ConnectionStatus;
}) {
  const { t } = useTranslation("settings");

  async function handleConnect() {
    try {
      await invoke("open_in_chrome", { url: buildConnectUrl(entry.provider) });
    } catch (error) {
      console.warn("Failed to launch connect flow:", error);
      toast.error(t("connections.connectError"));
    }
  }

  const buttonLabel =
    status.kind === "disconnected"
      ? t("connections.connect")
      : status.kind === "expiring"
        ? t("connections.extendAccess")
        : status.kind === "expired"
          ? t("connections.reconnect")
          : null;

  return (
    <div className="flex items-start justify-between gap-4 px-4 py-4">
      <div className="flex min-w-0 flex-1 gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
          <entry.Icon className="h-5 w-5" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="text-sm font-medium">{entry.displayName}</p>
          <p className="text-xs text-muted-foreground">{entry.description}</p>
          <StatusBadge status={status} />
        </div>
      </div>
      {buttonLabel !== null && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleConnect}
          rightIcon={<IconExternalLink />}
        >
          {buttonLabel}
        </Button>
      )}
    </div>
  );
}

export function ConnectionsSettings() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();

  const connectionsQuery = useQuery({
    queryKey: ["connections"],
    queryFn: listConnections,
    refetchInterval: CONNECTIONS_REFETCH_INTERVAL_MS,
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onOpenUrl(() => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);

  const connectionsByName = useMemo(() => {
    const map = new Map<string, Connection>();
    for (const entry of connectionsQuery.data?.connections ?? []) {
      map.set(entry.name, entry);
    }
    return map;
  }, [connectionsQuery.data?.connections]);

  const nowMs = Date.now();

  const sortedRows = OAUTH_PROVIDERS.filter((entry) => entry.hidden !== true)
    .map((entry) => ({
      entry,
      status: resolveStatus(connectionsByName.get(entry.provider), nowMs),
    }))
    .sort((a, b) => {
      const bucketDiff =
        STATUS_PRIORITY[a.status.kind] - STATUS_PRIORITY[b.status.kind];
      if (bucketDiff !== 0) return bucketDiff;
      return a.entry.displayName.localeCompare(b.entry.displayName);
    });

  return (
    <SettingsPage contentClassName="space-y-8">
      <section className="space-y-3">
        <div>
          <h4 className="text-sm font-semibold">{t("connections.title")}</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("connections.description")}
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-background divide-y divide-border">
          {sortedRows.map(({ entry, status }) => (
            <ConnectionRow key={entry.provider} entry={entry} status={status} />
          ))}
        </div>
      </section>
    </SettingsPage>
  );
}
