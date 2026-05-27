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
import { useTranslation } from "react-i18next";
import { useTopBarActions } from "@/app/contexts/TopBarActionsContext";
import { cn } from "@/shared/lib/cn";
import { BreadcrumbTrail } from "@/shared/ui/breadcrumb";
import { Button } from "@/shared/ui/button";

type TopBarLeadingChromeInset = "compact" | "trafficLights";

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
  onGoBack,
  onGoForward,
  onToggleContextPanel,
  onToggleSidebar,
  onFeedbackClick,
  onSearchClick,
}: TopBarProps) {
  const { t } = useTranslation(["sidebar", "feedback"]);
  const viewActions = useTopBarActions();
  const sidebarLabel = sidebarCollapsed
    ? t("actions.expand")
    : t("actions.collapse");
  const SidebarIcon = sidebarCollapsed
    ? IconLayoutSidebar
    : IconLayoutSidebarFilled;
  const ContextPanelIcon = contextPanelOpen
    ? IconLayoutSidebarRightFilled
    : IconLayoutSidebarRight;
  const toolbarButtonClassName = cn(
    "size-[var(--spacing-app-top-bar-control)]",
    "text-muted-foreground hover:text-foreground active:text-foreground focus-visible:text-foreground",
  );
  const toolbarIconClassName = "size-[18px]";
  const leadingSpaceClassName =
    chromeInsets.leading === "trafficLights"
      ? "w-[var(--spacing-app-top-bar-leading)]"
      : "w-4";

  return (
    <header
      className={cn(
        "flex h-[var(--spacing-app-top-bar)] items-center gap-3 pr-4",
        className,
      )}
      data-tauri-drag-region
    >
      <div
        className={cn("h-full shrink-0", leadingSpaceClassName)}
        data-tauri-drag-region
      />
      <div className="flex items-center gap-[var(--spacing-app-top-bar-button-gap)]">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={toolbarButtonClassName}
          onClick={onToggleSidebar}
          aria-label={sidebarLabel}
          title={sidebarLabel}
        >
          <SidebarIcon aria-hidden="true" className={toolbarIconClassName} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={toolbarButtonClassName}
          onClick={onGoBack}
          disabled={!canGoBack}
          aria-label={t("actions.back")}
          title={t("actions.back")}
        >
          <IconArrowLeft aria-hidden="true" className={toolbarIconClassName} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={toolbarButtonClassName}
          onClick={onGoForward}
          disabled={!canGoForward}
          aria-label={t("actions.forward")}
          title={t("actions.forward")}
        >
          <IconArrowRight aria-hidden="true" className={toolbarIconClassName} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={toolbarButtonClassName}
          onClick={onSearchClick}
          aria-label={t("actions.search")}
          title={t("actions.search")}
        >
          {/* IconSearch's SVG centerpoint sits ~1px above the other Tabler
              icons in this row; the per-icon nudge realigns just this one
              rather than shifting the whole shared icon class. */}
          <IconSearch
            aria-hidden="true"
            className={cn(toolbarIconClassName, "translate-y-px")}
          />
        </Button>
      </div>
      <BreadcrumbTrail
        items={breadcrumbs}
        variant="top-bar"
        pageProps={{ "data-tauri-drag-region": true }}
      />
      <div className="min-w-0 flex-1 self-stretch" data-tauri-drag-region />
      {viewActions ? (
        <div className="flex items-center gap-2">{viewActions}</div>
      ) : null}
      <div className="flex items-center gap-[var(--spacing-app-top-bar-button-gap)]">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={toolbarButtonClassName}
          onClick={onFeedbackClick}
          aria-label={t("feedback:title")}
          title={t("feedback:title")}
        >
          <IconMessageReport
            aria-hidden="true"
            className={toolbarIconClassName}
          />
        </Button>
        {showContextPanelToggle && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={toolbarButtonClassName}
            onClick={onToggleContextPanel}
            aria-label={contextPanelLabel}
            title={contextPanelLabel}
          >
            <ContextPanelIcon
              aria-hidden="true"
              className={toolbarIconClassName}
            />
          </Button>
        )}
      </div>
    </header>
  );
}
