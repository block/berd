import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { IconPlus } from "@tabler/icons-react";
import {
  CONNECTIONS_QUERY_KEY,
  type Connection,
  listConnections,
} from "@/features/connections/api/connections";
import { OAUTH_PROVIDERS } from "@/features/connections/catalog";
import { resolveConnectionStatus } from "@/features/connections/lib/connectionStatus";
import {
  compareGridItems,
  filterGridItems,
  type ConnectionGridItem,
} from "@/features/connections/lib/connectionGrid";
import type { SetupChatRequest } from "@/features/chat/lib/setupChatRequest";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { useProfileCapability } from "@/shared/profile/capabilities";
import { Button } from "@/shared/ui/button";
import { PageHeader } from "@/shared/ui/page-shell";
import {
  SettingsSections,
  SettingsSection,
} from "@/shared/ui/settings-section";
import { SearchBar } from "@/shared/ui/SearchBar";
import { Skeleton } from "@/shared/ui/skeleton";
import { RemoteHostsSettings } from "@/features/remoteHosts/ui/RemoteHostsSettings";
import { OAuthConnectionCard } from "./ConnectionCards";
import { LocalMcpSection } from "./LocalMcpSection";

const CONNECTIONS_REFETCH_INTERVAL_MS = 5_000;

function SectionSkeleton({ title }: { title: string }) {
  return (
    <SettingsSection title={title}>
      {[1, 2, 3].map((item) => (
        <div
          key={item}
          className="flex items-center gap-3 rounded-md bg-card p-3"
        >
          <Skeleton className="size-4.5 rounded-full" />
          <Skeleton className="h-4 w-32 rounded-sm" />
        </div>
      ))}
    </SettingsSection>
  );
}

/**
 * One searchable inventory organized by ownership: enterprise-managed
 * connections first when the distribution enables them, followed by MCPs
 * configured locally for Goose, Claude Code, and Codex.
 */
export interface ConnectionsSettingsProps {
  onAskAgentToAddMcp?: (request: SetupChatRequest) => void;
}

export function ConnectionsSettings({
  onAskAgentToAddMcp,
}: ConnectionsSettingsProps) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState("");
  const showManagedConnections = useProfileCapability("managedConnections");
  const activeProject = useProjectStore((state) =>
    state.projects.find((project) => project.id === state.activeProjectId),
  );
  const workspacePaths = activeProject?.workingDirs ?? [];

  const managedQuery = useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: listConnections,
    refetchInterval: CONNECTIONS_REFETCH_INTERVAL_MS,
    enabled: showManagedConnections,
  });

  useEffect(() => {
    if (!showManagedConnections) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onOpenUrl(() => {
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
    }).then((listener) => {
      if (cancelled) listener();
      else unlisten = listener;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient, showManagedConnections]);

  const connectionsByName = useMemo(() => {
    const map = new Map<string, Connection>();
    for (const connection of managedQuery.data?.connections ?? []) {
      map.set(connection.name, connection);
    }
    return map;
  }, [managedQuery.data?.connections]);

  const managedItems = useMemo<ConnectionGridItem[]>(
    () =>
      showManagedConnections
        ? OAUTH_PROVIDERS.filter((entry) => entry.hidden !== true)
            .map((entry) => ({
              kind: "oauth" as const,
              entry,
              status: resolveConnectionStatus(
                connectionsByName.get(entry.provider),
              ),
            }))
            .sort(compareGridItems)
        : [],
    [connectionsByName, showManagedConnections],
  );
  const visibleManagedItems = useMemo(
    () => filterGridItems(managedItems, searchTerm),
    [managedItems, searchTerm],
  );
  const askAgentToAddConnection = () => {
    onAskAgentToAddMcp?.({
      title: t("connections.askAgentTitle"),
      prompt: t("connections.askAgentPrompt"),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("connections.title")}
        description={t("connections.description")}
        variant="default"
        titleClassName="font-medium"
        descriptionClassName="text-xs font-normal text-muted-foreground"
        actions={
          onAskAgentToAddMcp ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={askAgentToAddConnection}
            >
              <IconPlus className="size-3.5" />
              {t("connections.askAgent")}
            </Button>
          ) : null
        }
      />

      <SearchBar
        size="pill"
        value={searchTerm}
        onChange={setSearchTerm}
        placeholder={t("connections.search")}
        aria-label={t("connections.search")}
      />

      <SettingsSections>
        {showManagedConnections ? (
          managedQuery.isLoading ? (
            <SectionSkeleton title={t("connections.sections.managed")} />
          ) : managedItems.length > 0 ? (
            <SettingsSection title={t("connections.sections.managed")}>
              {visibleManagedItems.length === 0 && searchTerm.trim() ? (
                <p className="p-3 text-sm text-muted-foreground">
                  {t("connections.noResults")}
                </p>
              ) : (
                visibleManagedItems.map((item) =>
                  item.kind === "oauth" ? (
                    <OAuthConnectionCard
                      key={item.entry.provider}
                      entry={item.entry}
                      status={item.status}
                    />
                  ) : null,
                )
              )}
            </SettingsSection>
          ) : null
        ) : null}

        <LocalMcpSection
          searchTerm={searchTerm}
          workspacePaths={workspacePaths}
          onAddConnection={
            onAskAgentToAddMcp ? askAgentToAddConnection : undefined
          }
        />

        {/* Renders nothing unless the remote-ssh-sessions experiment is on. */}
        <RemoteHostsSettings />
      </SettingsSections>
    </div>
  );
}
