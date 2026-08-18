import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconAlertTriangle, IconX } from "@tabler/icons-react";
import {
  listLocalMcpInventory,
  LOCAL_MCP_INVENTORY_QUERY_KEY,
} from "@/features/connections/api/localMcpInventory";
import {
  filterMcpGroups,
  groupMcpServers,
  harnessesWithErrors,
} from "@/features/connections/lib/localMcpInventory";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { useMigrationStore } from "@/features/migration/stores/migrationStore";
import { SettingsSection } from "@/shared/ui/settings-section";
import { Skeleton } from "@/shared/ui/skeleton";
import { LocalMcpConnectionCard } from "./LocalMcpConnectionCard";

export function LocalMcpSection({
  searchTerm,
  workspacePaths,
  onAddConnection,
}: {
  searchTerm: string;
  workspacePaths: string[];
  onAddConnection?: () => void;
}) {
  const { t } = useTranslation("settings");
  const query = useQuery({
    queryKey: [...LOCAL_MCP_INVENTORY_QUERY_KEY, workspacePaths],
    queryFn: () => listLocalMcpInventory(workspacePaths),
    staleTime: 10_000,
  });
  const groups = groupMcpServers(query.data);
  const visibleGroups = filterMcpGroups(groups, searchTerm);
  const failedSources = harnessesWithErrors(query.data);
  const hasFailure = query.isError || failedSources.length > 0;
  const disabledExtensions = useMigrationStore(
    (state) => state.disabledExtensions,
  );
  const bannerDismissedAt = useMigrationStore(
    (state) => state.bannerDismissedAt,
  );
  const dismissBanner = useMigrationStore((state) => state.dismissBanner);
  const visibleGooseKeys = new Set(
    groups.flatMap((group) =>
      group.entries
        .filter((entry) => entry.harness === "goose")
        .map((entry) => entry.configKey),
    ),
  );
  const visibleDisabledExtensions = disabledExtensions.filter((extension) =>
    visibleGooseKeys.has(extension.configKey),
  );
  const showDisabledBanner =
    visibleDisabledExtensions.length > 0 && !bannerDismissedAt;

  if (query.isLoading) {
    return (
      <SettingsSection title={t("connections.sections.local")}>
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

  if (groups.length === 0 && hasFailure) {
    return (
      <SettingsSection title={t("connections.sections.local")}>
        <Alert>
          <AlertTitle>{t("connections.localError.title")}</AlertTitle>
          <AlertDescription>
            <span>{t("connections.localError.description")}</span>
            <Button
              type="button"
              variant="alert"
              size="xs"
              feedbackState={query.isFetching ? "loading" : "idle"}
              loadingLabel={t("connections.localError.retrying")}
              onClick={() => void query.refetch()}
            >
              {t("connections.localError.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      </SettingsSection>
    );
  }

  if (groups.length === 0) {
    return (
      <SettingsSection title={t("connections.sections.local")}>
        <div className="flex flex-col items-start gap-2 p-3">
          <div>
            <p className="text-sm text-foreground">
              {t("connections.empty.title")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("connections.empty.description")}
            </p>
          </div>
          {onAddConnection ? (
            <Button
              type="button"
              variant="subtle"
              size="sm"
              onClick={onAddConnection}
            >
              {t("connections.askAgent")}
            </Button>
          ) : null}
        </div>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={t("connections.sections.local")}>
      {showDisabledBanner ? (
        <Alert variant="default" className="pr-10">
          <IconAlertTriangle aria-hidden="true" className="text-warning!" />
          <AlertTitle>{t("extensions.disabledBanner.title")}</AlertTitle>
          <AlertDescription>
            {t("extensions.disabledBanner.description", {
              names: visibleDisabledExtensions
                .map((extension) => extension.name)
                .join(", "),
            })}
          </AlertDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute top-2 right-2"
            aria-label={t("extensions.disabledBanner.dismiss")}
            onClick={() => void dismissBanner()}
          >
            <IconX className="size-3.5" />
          </Button>
        </Alert>
      ) : null}
      {hasFailure ? (
        <Alert>
          <AlertTitle>{t("connections.localError.partialTitle")}</AlertTitle>
          <AlertDescription>
            <span>{t("connections.localError.partialDescription")}</span>
            <Button
              type="button"
              variant="alert"
              size="xs"
              feedbackState={query.isFetching ? "loading" : "idle"}
              loadingLabel={t("connections.localError.retrying")}
              onClick={() => void query.refetch()}
            >
              {t("connections.localError.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {visibleGroups.length === 0 && searchTerm.trim() ? (
        <p className="p-3 text-sm text-muted-foreground">
          {t("connections.noResults")}
        </p>
      ) : (
        visibleGroups.map((group) => (
          <LocalMcpConnectionCard key={group.id} group={group} />
        ))
      )}
    </SettingsSection>
  );
}
