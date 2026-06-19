import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { toast } from "sonner";
import { IconCheck, IconExternalLink } from "@tabler/icons-react";
import {
  CONNECTIONS_QUERY_KEY,
  type Connection,
  listConnections,
} from "@/features/connections/api/connections";
import {
  OAUTH_PROVIDERS,
  type OAuthProviderEntry,
} from "@/features/connections/catalog";
import {
  CONNECTION_STATUS_PRIORITY,
  type ConnectionStatus,
  resolveConnectionStatus,
} from "@/features/connections/lib/connectionStatus";
import { ExtensionsSettings } from "@/features/extensions/ui/ExtensionsSettings";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";

const CONNECTIONS_REFETCH_INTERVAL_MS = 5_000;

const DEFAULT_G2_BASE_URL = "https://g2.sqprod.co";
const G2_BASE_URL =
  import.meta.env.VITE_GOOSE_INTERNAL_G2_BASE_URL ?? DEFAULT_G2_BASE_URL;
const RETURN_URL = "goose-internal://connect-return";

export type ConnectionsTab = "companyManaged" | "custom" | "gooseCapabilities";

interface ConnectionsSettingsProps {
  activeTab: ConnectionsTab;
  onActiveTabChange: (tab: ConnectionsTab) => void;
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
  const isActive = status.kind === "active";

  return (
    <div className="flex items-start justify-between gap-4 px-4 py-4">
      <div className="flex min-w-0 flex-1 gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
          <entry.Icon className="h-5 w-5" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="text-sm">{entry.displayName}</p>
          <p className="text-xs text-muted-foreground">{entry.description}</p>
          <StatusBadge status={status} />
        </div>
      </div>
      {isActive && (
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center text-success"
          role="img"
          aria-label={t("connections.status.active")}
          title={t("connections.status.active")}
        >
          <IconCheck className="size-4" aria-hidden="true" />
        </div>
      )}
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

export function ConnectionsSettings({
  activeTab,
  onActiveTabChange,
}: ConnectionsSettingsProps) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();

  const { data: connectionsData } = useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: listConnections,
    refetchInterval: CONNECTIONS_REFETCH_INTERVAL_MS,
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onOpenUrl(() => {
      queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
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
    for (const entry of connectionsData?.connections ?? []) {
      map.set(entry.name, entry);
    }
    return map;
  }, [connectionsData?.connections]);

  const nowMs = Date.now();

  const sortedRows = OAUTH_PROVIDERS.filter((entry) => entry.hidden !== true)
    .map((entry) => ({
      entry,
      status: resolveConnectionStatus(
        connectionsByName.get(entry.provider),
        nowMs,
      ),
    }))
    .sort((a, b) => {
      const bucketDiff =
        CONNECTION_STATUS_PRIORITY[a.status.kind] -
        CONNECTION_STATUS_PRIORITY[b.status.kind];
      if (bucketDiff !== 0) return bucketDiff;
      return a.entry.displayName.localeCompare(b.entry.displayName);
    });

  return (
    <SettingsPage contentClassName="space-y-6">
      <Tabs
        value={activeTab}
        onValueChange={(value) => onActiveTabChange(value as ConnectionsTab)}
        className="gap-5"
      >
        <div>
          <h4 className="text-base text-foreground">
            {t("connections.title")}
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("connections.description")}
          </p>
          <TabsList variant="weight" className="mt-4">
            <TabsTrigger value="companyManaged" variant="weight">
              {t("connections.tabs.companyManaged")}
            </TabsTrigger>
            <TabsTrigger value="custom" variant="weight">
              {t("connections.tabs.custom")}
            </TabsTrigger>
            <TabsTrigger value="gooseCapabilities" variant="weight">
              {t("connections.tabs.gooseCapabilities")}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="companyManaged">
          <div className="overflow-hidden rounded-md bg-background divide-y divide-border">
            {sortedRows.map(({ entry, status }) => (
              <ConnectionRow
                key={entry.provider}
                entry={entry}
                status={status}
              />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="custom">
          {activeTab === "custom" ? (
            <ExtensionsSettings
              variant="custom"
              hideCompanyManagedExtensions
              showAddAction
            />
          ) : null}
        </TabsContent>

        <TabsContent value="gooseCapabilities">
          {activeTab === "gooseCapabilities" ? (
            <ExtensionsSettings
              variant="gooseCapabilities"
              showAddAction={false}
            />
          ) : null}
        </TabsContent>
      </Tabs>
    </SettingsPage>
  );
}
