import {
  IconArrowLeft,
  IconArrowRight,
  IconLayoutSidebar,
  IconLayoutSidebarFilled,
  IconLayoutSidebarRight,
  IconLayoutSidebarRightFilled,
  IconMessageReport,
  IconSearch,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTopBarActions } from "@/app/contexts/TopBarActionsContext";
import { cn } from "@/shared/lib/cn";
import { BreadcrumbTrail } from "@/shared/ui/breadcrumb";
import { Button } from "@/shared/ui/button";
import { GooseIcon } from "@/shared/ui/icons/GooseIcon";

type TopBarLeadingChromeInset = "compact" | "trafficLights";
type TopBarBreadcrumbDisplay = "full" | "compact" | "current";

const TOP_BAR_COMPACT_BREADCRUMB_WIDTH = 1180;
const TOP_BAR_CURRENT_BREADCRUMB_WIDTH = 920;

export interface TopBarChromeInsets {
  leading: TopBarLeadingChromeInset;
}

interface TopBarProps {
  breadcrumbs: TopBarBreadcrumb[];
  canGoBack?: boolean;
  canGoForward?: boolean;
  className?: string;
  contextPanelLabel?: string;
  contextPanelOpen?: boolean;
  chromeInsets?: TopBarChromeInsets;
  showContextPanelToggle?: boolean;
  sidebarCollapsed?: boolean;
  onGoHome?: () => void;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onToggleContextPanel?: () => void;
  onToggleSidebar?: () => void;
  onFeedbackClick: () => void;
  onSearchClick?: () => void;
}

export interface TopBarBreadcrumb {
  id?: string;
  label: string;
  onClick?: () => void;
}

function getTopBarBreadcrumbDisplay(): TopBarBreadcrumbDisplay {
  if (typeof window === "undefined") {
    return "full";
  }

  if (window.innerWidth <= TOP_BAR_CURRENT_BREADCRUMB_WIDTH) {
    return "current";
  }

  if (window.innerWidth <= TOP_BAR_COMPACT_BREADCRUMB_WIDTH) {
    return "compact";
  }

  return "full";
}

function useTopBarBreadcrumbDisplay() {
  const [display, setDisplay] = useState<TopBarBreadcrumbDisplay>(
    getTopBarBreadcrumbDisplay,
  );

  useEffect(() => {
    const handleResize = () => {
      const nextDisplay = getTopBarBreadcrumbDisplay();
      setDisplay((currentDisplay) =>
        currentDisplay === nextDisplay ? currentDisplay : nextDisplay,
      );
    };

    handleResize();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return display;
}

export function TopBar({
  breadcrumbs,
  canGoBack = false,
  canGoForward = false,
  className,
  contextPanelLabel,
  contextPanelOpen = false,
  chromeInsets = { leading: "trafficLights" },
  showContextPanelToggle = false,
  sidebarCollapsed = false,
  onGoHome,
  onGoBack,
  onGoForward,
  onToggleContextPanel,
  onToggleSidebar,
  onFeedbackClick,
  onSearchClick,
}: TopBarProps) {
  const { t } = useTranslation(["sidebar", "feedback"]);
  const viewActions = useTopBarActions();
  const breadcrumbDisplay = useTopBarBreadcrumbDisplay();
  const visibleBreadcrumbs = useMemo(
    () =>
      breadcrumbDisplay === "current" && breadcrumbs.length > 0
        ? [breadcrumbs[breadcrumbs.length - 1]]
        : breadcrumbs,
    [breadcrumbDisplay, breadcrumbs],
  );
  const sidebarLabel = sidebarCollapsed
    ? t("actions.expand")
    : t("actions.collapse");
  const SidebarIcon = sidebarCollapsed
    ? IconLayoutSidebar
    : IconLayoutSidebarFilled;
  const ContextPanelIcon = contextPanelOpen
    ? IconLayoutSidebarRightFilled
    : IconLayoutSidebarRight;
  const leadingSpaceClassName =
    chromeInsets.leading === "trafficLights"
      ? "w-[var(--spacing-app-top-bar-leading)]"
      : "w-4";
  return (
    <header
      className={cn(
        "flex h-[var(--spacing-app-top-bar)] min-w-0 items-center gap-2 pr-4",
        className,
      )}
      data-tauri-drag-region
    >
      <div
        className={cn("h-full shrink-0", leadingSpaceClassName)}
        data-tauri-drag-region
      />
      <div className="flex shrink-0 items-center gap-[var(--spacing-app-top-bar-button-gap)]">
        {onGoHome ? (
          <Button
            type="button"
            variant="top-bar-icon"
            size="icon-top-bar"
            onClick={onGoHome}
            aria-label={t("navigation.gooseHome")}
            title={t("navigation.gooseHome")}
          >
            <GooseIcon className="size-5" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="top-bar-icon"
          size="icon-top-bar"
          onClick={onToggleSidebar}
          aria-label={sidebarLabel}
          title={sidebarLabel}
        >
          <SidebarIcon aria-hidden="true" />
        </Button>
        {onSearchClick ? (
          <Button
            type="button"
            variant="top-bar-icon"
            size="icon-top-bar"
            onClick={onSearchClick}
            aria-label={t("actions.search")}
            title={t("actions.search")}
          >
            <IconSearch aria-hidden="true" />
          </Button>
        ) : null}
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="top-bar-icon"
            size="icon-top-bar"
            onClick={onGoBack}
            disabled={!canGoBack}
            aria-label={t("actions.back")}
            title={t("actions.back")}
          >
            <IconArrowLeft aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="top-bar-icon"
            size="icon-top-bar"
            onClick={onGoForward}
            disabled={!canGoForward}
            aria-label={t("actions.forward")}
            title={t("actions.forward")}
          >
            <IconArrowRight aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div
        className="flex min-w-0 flex-1 items-center self-stretch overflow-x-clip overflow-y-visible"
        data-tauri-drag-region
      >
        <BreadcrumbTrail
          className="min-w-0 max-w-full overflow-x-clip overflow-y-visible"
          items={visibleBreadcrumbs}
          listClassName={cn(
            "min-w-0 max-w-full overflow-x-clip overflow-y-visible",
            breadcrumbDisplay !== "full" &&
              "text-[var(--text-app-top-bar-title-compact)] leading-none",
          )}
          variant="top-bar"
          pageProps={{ "data-tauri-drag-region": true }}
        />
      </div>
      {viewActions ? (
        <div className="flex shrink-0 items-center gap-2">{viewActions}</div>
      ) : null}
      <div className="flex shrink-0 items-center gap-[var(--spacing-app-top-bar-button-gap)]">
        <Button
          type="button"
          variant="top-bar-icon"
          size="icon-top-bar"
          onClick={onFeedbackClick}
          aria-label={t("feedback:title")}
          title={t("feedback:title")}
        >
          <IconMessageReport aria-hidden="true" />
        </Button>
        {showContextPanelToggle && (
          <Button
            type="button"
            variant="top-bar-icon"
            size="icon-top-bar"
            onClick={onToggleContextPanel}
            aria-pressed={contextPanelOpen}
            aria-label={contextPanelLabel}
            title={contextPanelLabel}
            data-context-panel-toggle="true"
          >
            <ContextPanelIcon aria-hidden="true" />
          </Button>
        )}
      </div>
    </header>
  );
}
