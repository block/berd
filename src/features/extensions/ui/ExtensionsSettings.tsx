import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconPlus,
  IconX,
} from "@tabler/icons-react";
import { useSetTopBarActions } from "@/app/contexts/TopBarActionsContext";
import { isCompanyManagedExtension } from "@/features/connections/lib/managedExtensions";
import { useMigrationStore } from "@/features/migration/stores/migrationStore";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { SearchBar } from "@/shared/ui/SearchBar";
import { FilterRow } from "@/shared/ui/page-shell";
import { useExtensionsSettings } from "../hooks/useExtensionsSettings";
import {
  EXTENSION_CATEGORIES,
  filterExtensions,
  getExtensionCategoryCounts,
  splitExtensionsByCategory,
  type ExtensionFilter,
} from "../lib/extensionCategories";
import type { ExtensionEntry } from "../types";
import { ExtensionItem } from "./ExtensionItem";
import { ExtensionModal } from "./ExtensionModal";

type ExtensionsSettingsVariant = "standalone" | "custom" | "gooseCapabilities";

interface ExtensionsSettingsProps {
  variant?: ExtensionsSettingsVariant;
  hideCompanyManagedExtensions?: boolean;
  showAddAction?: boolean;
}

function FilterButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant={active ? "default" : "outline-flat"}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function ExtensionsSettings({
  variant = "standalone",
  hideCompanyManagedExtensions = false,
  showAddAction = variant === "standalone" || variant === "custom",
}: ExtensionsSettingsProps = {}) {
  const { t } = useTranslation("settings");
  const setTopBarActions = useSetTopBarActions();
  const {
    extensions,
    isLoading,
    modalMode,
    editingExtension,
    handleAdd,
    handleConfigure,
    handleSubmit,
    handleDelete,
    handleReset,
    handleModalClose,
  } = useExtensionsSettings();
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    if (!showAddAction) {
      setTopBarActions(null);
      return () => setTopBarActions(null);
    }

    setTopBarActions(
      <Button
        type="button"
        variant="page-header"
        size="xs"
        onClick={handleAdd}
        leftIcon={<IconPlus />}
      >
        {t("extensions.addExtension")}
      </Button>,
    );
    return () => setTopBarActions(null);
  }, [handleAdd, setTopBarActions, showAddAction, t]);
  const [activeFilter, setActiveFilter] = useState<ExtensionFilter>("all");
  const [showGooseCapabilities, setShowGooseCapabilities] = useState(false);
  const disabledExtensions = useMigrationStore(
    (state) => state.disabledExtensions,
  );
  const bannerDismissedAt = useMigrationStore(
    (state) => state.bannerDismissedAt,
  );
  const dismissBanner = useMigrationStore((state) => state.dismissBanner);

  const visibleSourceExtensions = useMemo(
    () =>
      hideCompanyManagedExtensions
        ? extensions.filter(
            (extension) => !isCompanyManagedExtension(extension),
          )
        : extensions,
    [extensions, hideCompanyManagedExtensions],
  );
  const visibleSourceExtensionKeys = useMemo(
    () =>
      new Set(visibleSourceExtensions.map((extension) => extension.config_key)),
    [visibleSourceExtensions],
  );
  const visibleDisabledExtensions = useMemo(
    () =>
      disabledExtensions.filter((extension) =>
        visibleSourceExtensionKeys.has(extension.configKey),
      ),
    [disabledExtensions, visibleSourceExtensionKeys],
  );
  const showDisabledBanner =
    visibleDisabledExtensions.length > 0 && !bannerDismissedAt;

  const effectiveFilter: ExtensionFilter =
    variant === "custom"
      ? "appsServices"
      : variant === "gooseCapabilities"
        ? "gooseCapabilities"
        : activeFilter;

  const filteredExtensions = useMemo(
    () =>
      filterExtensions({
        extensions: visibleSourceExtensions,
        searchTerm,
        activeFilter: effectiveFilter,
        getCategoryLabel: (category) => t(`extensions.categories.${category}`),
      }),
    [effectiveFilter, searchTerm, t, visibleSourceExtensions],
  );

  const { primaryExtensions, gooseCapabilities } = useMemo(
    () => splitExtensionsByCategory(filteredExtensions),
    [filteredExtensions],
  );

  const visibleExtensions =
    effectiveFilter === "gooseCapabilities"
      ? gooseCapabilities
      : variant === "custom"
        ? primaryExtensions
        : [...primaryExtensions, ...gooseCapabilities];
  const hasSearch = searchTerm.trim().length > 0;
  const shouldShowGooseCapabilities =
    effectiveFilter === "gooseCapabilities" ||
    showGooseCapabilities ||
    hasSearch;
  const showGooseCapabilitiesToggle =
    variant === "standalone" &&
    effectiveFilter !== "gooseCapabilities" &&
    !hasSearch &&
    gooseCapabilities.length > 0;

  const categoryCounts = useMemo(
    () => getExtensionCategoryCounts(visibleSourceExtensions),
    [visibleSourceExtensions],
  );

  const emptyMessage =
    variant === "custom"
      ? t("extensions.emptyCustom")
      : variant === "gooseCapabilities"
        ? t("extensions.emptyGooseCapabilities")
        : t("extensions.empty");

  const renderSection = (sectionExtensions: ExtensionEntry[]) => {
    if (sectionExtensions.length === 0) return null;
    return (
      <section>
        <div className="overflow-hidden rounded-md bg-background divide-y divide-border">
          {sectionExtensions.map((ext) => (
            <ExtensionItem
              key={ext.config_key}
              extension={ext}
              onConfigure={handleConfigure}
              onReset={handleReset}
            />
          ))}
        </div>
      </section>
    );
  };

  return (
    <>
      {showDisabledBanner ? (
        <Alert variant="default" className="my-6 pr-10">
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

      <div className="space-y-3">
        <SearchBar
          size="pill"
          className="max-w-lg"
          value={searchTerm}
          onChange={setSearchTerm}
          placeholder={t("extensions.search")}
          aria-label={t("extensions.search")}
        />
        {variant === "standalone" ? (
          <FilterRow>
            <FilterButton
              active={activeFilter === "all"}
              onClick={() => setActiveFilter("all")}
            >
              {t("extensions.filters.all")}
            </FilterButton>
            {EXTENSION_CATEGORIES.map((category) =>
              categoryCounts[category] > 0 ? (
                <FilterButton
                  key={category}
                  active={activeFilter === category}
                  onClick={() => setActiveFilter(category)}
                >
                  {t(`extensions.categories.${category}`)}
                </FilterButton>
              ) : null,
            )}
          </FilterRow>
        ) : null}
      </div>

      <div className="mt-6">
        {isLoading ? (
          <div className="overflow-hidden rounded-md bg-background divide-y divide-border">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="h-20 animate-pulse px-4 py-4">
                <div className="h-4 w-2/5 rounded bg-muted/50" />
                <div className="mt-2 h-3 w-3/5 rounded bg-muted/40" />
              </div>
            ))}
          </div>
        ) : visibleSourceExtensions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        ) : visibleExtensions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("extensions.noResults")}
          </p>
        ) : (
          <div className="space-y-8">
            {effectiveFilter !== "gooseCapabilities"
              ? renderSection(primaryExtensions)
              : null}

            {shouldShowGooseCapabilities
              ? renderSection(gooseCapabilities)
              : null}

            {showGooseCapabilitiesToggle ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowGooseCapabilities((current) => !current)}
                className="w-full text-muted-foreground"
              >
                {showGooseCapabilities
                  ? t("extensions.hideGooseCapabilities")
                  : t("extensions.showGooseCapabilities", {
                      count: gooseCapabilities.length,
                    })}
                {!showGooseCapabilities ? (
                  <IconChevronDown className="size-3" />
                ) : null}
              </Button>
            ) : null}
          </div>
        )}
      </div>

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
    </>
  );
}
