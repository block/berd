import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import {
  IconAlertTriangle,
  IconLink,
  IconPlus,
  IconX,
} from "@tabler/icons-react";
import { useSetTopBarActions } from "@/app/contexts/TopBarActionsContext";
import {
  CONNECTIONS_QUERY_KEY,
  type Connection,
  listConnections,
} from "@/features/connections/api/connections";
import { OAUTH_PROVIDERS } from "@/features/connections/catalog";
import { resolveConnectionStatus } from "@/features/connections/lib/connectionStatus";
import {
  compareGridItems,
  type ConnectionGridItem,
  filterGridItems,
  gridItemKey,
  itemSection,
} from "@/features/connections/lib/connectionGrid";
import { isCompanyManagedExtension } from "@/features/connections/lib/managedExtensions";
import { useExtensionsSettings } from "@/features/extensions/hooks/useExtensionsSettings";
import { isNativeCapabilityExtension } from "@/features/extensions/lib/nativeCapabilities";
import { ExtensionModal } from "@/features/extensions/ui/ExtensionModal";
import { useMigrationStore } from "@/features/migration/stores/migrationStore";
import { useProfileCapability } from "@/shared/profile/capabilities";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { PageHeaderButton } from "@/shared/ui/page-header-button";
import { PageHeader } from "@/shared/ui/page-shell";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";
import { SearchBar } from "@/shared/ui/SearchBar";
import { Skeleton } from "@/shared/ui/skeleton";
import {
  ExtensionConnectionCard,
  isEditableExtension,
  OAuthConnectionCard,
} from "./ConnectionCards";

const CONNECTIONS_REFETCH_INTERVAL_MS = 5_000;

const connectionsGridClass = "divide-y divide-border";

function ConnectionsEmptyState() {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border px-6 py-12 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
        <IconLink className="size-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <div>
        <p className="text-sm text-foreground">
          {t("connections.empty.title")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("connections.empty.description")}
        </p>
      </div>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-md bg-card p-3">
      <Skeleton className="size-4.5 rounded-full" />
      <Skeleton className="h-4 w-32 rounded-sm" />
    </div>
  );
}

/**
 * The Connections settings section: one searchable grid of every MCP the agent
 * can use on the user's behalf.
 *
 * Org-managed OAuth services and user-added custom MCP servers are rows in
 * the same list — whether a connection is provisioned by an enterprise org
 * or linked personally is a property of the data, not a UI division. Native
 * capabilities (built-in tools like web search) are deliberately absent; see
 * `nativeCapabilities.ts`.
 *
 * Renders its content *without* a page wrapper: `SettingsView` renders this
 * into the one shared `SettingsPane` that every settings section uses. Adding
 * a pane here would make the pane a different component type at the same tree
 * position, so React would unmount/remount it and replay the
 * `page-transition` enter animation, flashing the surface underneath
 * (BOT-1272). `ConnectionsSettings.pane.test.tsx` guards this.
 */
export function ConnectionsSettings() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const setTopBarActions = useSetTopBarActions();
  const [searchTerm, setSearchTerm] = useState("");

  // Gates the kgoose-backed OAuth catalog. The capability is named after the
  // backing system (kgoose), not the UI concept — the mismatch is deliberate,
  // don't "fix" it. When off (public tier today), the grid holds only the
  // user's own MCP servers.
  const showOAuthCatalog = useProfileCapability("kgooseConnections");

  const {
    extensions,
    isLoading: isExtensionsLoading,
    modalMode,
    editingExtension,
    handleAdd,
    handleConfigure,
    handleSubmit,
    handleDelete,
    handleReset,
    handleModalClose,
  } = useExtensionsSettings();

  useEffect(() => {
    setTopBarActions(
      <PageHeaderButton
        type="button"
        onClick={handleAdd}
        leftIcon={<IconPlus />}
      >
        {t("extensions.addExtension")}
      </PageHeaderButton>,
    );
    return () => setTopBarActions(null);
  }, [handleAdd, setTopBarActions, t]);

  const { data: connectionsData, isLoading: isOAuthLoading } = useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: listConnections,
    refetchInterval: CONNECTIONS_REFETCH_INTERVAL_MS,
    enabled: showOAuthCatalog,
  });

  useEffect(() => {
    if (!showOAuthCatalog) return;
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
  }, [queryClient, showOAuthCatalog]);

  const connectionsByName = useMemo(() => {
    const map = new Map<string, Connection>();
    for (const entry of connectionsData?.connections ?? []) {
      map.set(entry.name, entry);
    }
    return map;
  }, [connectionsData?.connections]);

  // Custom MCP servers: everything the backend lists minus native
  // capabilities (built-in tools) and extensions already represented by an
  // OAuth catalog card.
  const customExtensions = useMemo(
    () =>
      extensions.filter((extension) => {
        if (isNativeCapabilityExtension(extension)) return false;
        if (showOAuthCatalog && isCompanyManagedExtension(extension)) {
          return false;
        }
        return true;
      }),
    [extensions, showOAuthCatalog],
  );

  const gridItems = useMemo<ConnectionGridItem[]>(() => {
    const nowMs = Date.now();
    const oauthItems: ConnectionGridItem[] = showOAuthCatalog
      ? OAUTH_PROVIDERS.filter((entry) => entry.hidden !== true).map(
          (entry) => ({
            kind: "oauth" as const,
            entry,
            status: resolveConnectionStatus(
              connectionsByName.get(entry.provider),
              nowMs,
            ),
          }),
        )
      : [];
    const extensionItems: ConnectionGridItem[] = customExtensions.map(
      (extension) => ({ kind: "extension" as const, extension }),
    );
    return [...oauthItems, ...extensionItems].sort(compareGridItems);
  }, [connectionsByName, customExtensions, showOAuthCatalog]);

  const visibleItems = useMemo(
    () => filterGridItems(gridItems, searchTerm),
    [gridItems, searchTerm],
  );
  // compareGridItems already orders active-section items before inactive
  // ones, so each partition preserves its internal order.
  const activeItems = useMemo(
    () => visibleItems.filter((item) => itemSection(item) === "active"),
    [visibleItems],
  );
  const inactiveItems = useMemo(
    () => visibleItems.filter((item) => itemSection(item) === "inactive"),
    [visibleItems],
  );

  const disabledExtensions = useMigrationStore(
    (state) => state.disabledExtensions,
  );
  const bannerDismissedAt = useMigrationStore(
    (state) => state.bannerDismissedAt,
  );
  const dismissBanner = useMigrationStore((state) => state.dismissBanner);

  const visibleExtensionKeys = useMemo(
    () => new Set(customExtensions.map((extension) => extension.config_key)),
    [customExtensions],
  );
  const visibleDisabledExtensions = useMemo(
    () =>
      disabledExtensions.filter((extension) =>
        visibleExtensionKeys.has(extension.configKey),
      ),
    [disabledExtensions, visibleExtensionKeys],
  );
  const showDisabledBanner =
    visibleDisabledExtensions.length > 0 && !bannerDismissedAt;

  const isLoading = isExtensionsLoading || (showOAuthCatalog && isOAuthLoading);
  const hasSearch = searchTerm.trim().length > 0;

  const renderGridItem = (item: ConnectionGridItem) =>
    item.kind === "oauth" ? (
      <OAuthConnectionCard
        key={gridItemKey(item)}
        entry={item.entry}
        status={item.status}
      />
    ) : (
      <ExtensionConnectionCard
        key={gridItemKey(item)}
        extension={item.extension}
        onReset={handleReset}
        onSelect={() => {
          if (isEditableExtension(item.extension)) {
            handleConfigure(item.extension);
          }
        }}
      />
    );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("connections.title")}
        description={t("connections.description")}
        variant="default"
        titleClassName="font-medium"
        descriptionClassName="text-xs font-normal text-muted-foreground"
      />

      {showDisabledBanner ? (
        <Alert variant="default" className="pr-10">
          <IconAlertTriangle aria-hidden="true" className="text-warning!" />
          <AlertTitle>{t("extensions.disabledBanner.title")}</AlertTitle>
          <AlertDescription>
            <p>
              {t("extensions.disabledBanner.description", {
                names: visibleDisabledExtensions
                  .map((ext) => ext.name)
                  .join(", "),
              })}
            </p>
          </AlertDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              void dismissBanner();
            }}
            aria-label={t("extensions.disabledBanner.dismiss")}
            className="absolute top-2 right-2"
          >
            <IconX className="size-3.5" />
          </Button>
        </Alert>
      ) : null}

      <SearchBar
        size="pill"
        value={searchTerm}
        onChange={setSearchTerm}
        placeholder={t("connections.search")}
        aria-label={t("connections.search")}
      />

      {isLoading ? (
        <div className={connectionsGridClass}>
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : gridItems.length === 0 ? (
        <ConnectionsEmptyState />
      ) : visibleItems.length === 0 && hasSearch ? (
        <p className="text-sm text-muted-foreground">
          {t("connections.noResults")}
        </p>
      ) : (
        <SettingsSections>
          {activeItems.length > 0 ? (
            <SettingsSection title={t("connections.sections.installed")}>
              {activeItems.map(renderGridItem)}
            </SettingsSection>
          ) : null}
          {inactiveItems.length > 0 ? (
            <SettingsSection title={t("connections.sections.available")}>
              {inactiveItems.map(renderGridItem)}
            </SettingsSection>
          ) : null}
        </SettingsSections>
      )}

      {modalMode === "add" && (
        <ExtensionModal onSubmit={handleSubmit} onClose={handleModalClose} />
      )}

      {modalMode === "edit" && editingExtension && (
        <ExtensionModal
          extension={editingExtension}
          onSubmit={handleSubmit}
          onDelete={handleDelete}
          onClose={handleModalClose}
        />
      )}
    </div>
  );
}
