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
import { TopBarIconButton } from "@/shared/ui/top-bar-icon-button";

type TopBarLeadingChromeInset = "compact" | "trafficLights";
export interface TopBarChromeInsets {
  leading: TopBarLeadingChromeInset;
}

interface TopBarProps {
  breadcrumbs: TopBarBreadcrumb[];
  canGoBack?: boolean;
  canGoForward?: boolean;
  className?: string;
  rightRailLabel?: string;
  rightRailOpen?: boolean;
  chromeInsets?: TopBarChromeInsets;
  showRightRailToggle?: boolean;
  sidebarCollapsed?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onToggleRightRail?: () => void;
  onToggleSidebar?: () => void;
  onFeedbackClick?: () => void;
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
  rightRailLabel,
  rightRailOpen = false,
  chromeInsets = { leading: "trafficLights" },
  showRightRailToggle = false,
  sidebarCollapsed = false,
  onGoBack,
  onGoForward,
  onToggleRightRail,
  onToggleSidebar,
  onFeedbackClick,
  onSearchClick,
}: TopBarProps) {
  const { t } = useTranslation(["sidebar", "feedback"]);
  const viewActions = useTopBarActions();
  const chatTitle =
    breadcrumbs.find((breadcrumb) => breadcrumb.id === "chat-session")?.label ??
    null;
  const sidebarLabel = sidebarCollapsed
    ? t("actions.expand")
    : t("actions.collapse");
  const SidebarIcon = sidebarCollapsed
    ? IconLayoutSidebar
    : IconLayoutSidebarFilled;
  const RightRailIcon = rightRailOpen
    ? IconLayoutSidebarRightFilled
    : IconLayoutSidebarRight;
  const leadingSpaceClassName =
    chromeInsets.leading === "trafficLights"
      ? "w-[var(--spacing-app-top-bar-leading)]"
      : "w-4";
  return (
    // The whole top bar is a window drag surface (`deep`). Tauri's drag
    // script exempts semantic controls (buttons, links, roles) automatically,
    // so any interactive content rendered here — including `viewActions` —
    // must use semantic elements, or it will start window drags on click.
    <header
      className={cn(
        "relative grid h-[var(--spacing-app-top-bar)] min-w-0 select-none grid-cols-[calc(var(--app-sidebar-outer-width)+var(--spacing-app-panel-gutter-inline))_minmax(0,1fr)_auto] items-center gap-2 pr-4",
        className,
      )}
      data-tauri-drag-region="deep"
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className={cn("h-full shrink-0", leadingSpaceClassName)} />
        <div className="flex shrink-0 items-center gap-[var(--spacing-app-top-bar-button-gap)]">
          <TopBarIconButton
            type="button"
            size="icon-top-bar"
            onClick={onToggleSidebar}
            aria-label={sidebarLabel}
            title={sidebarLabel}
          >
            <SidebarIcon aria-hidden="true" />
          </TopBarIconButton>
          <div className="flex items-center gap-0.5">
            <TopBarIconButton
              type="button"
              size="icon-top-bar"
              onClick={onGoBack}
              disabled={!canGoBack}
              aria-label={t("actions.back")}
              title={t("actions.back")}
            >
              <IconArrowLeft aria-hidden="true" />
            </TopBarIconButton>
            <TopBarIconButton
              type="button"
              size="icon-top-bar"
              onClick={onGoForward}
              disabled={!canGoForward}
              aria-label={t("actions.forward")}
              title={t("actions.forward")}
            >
              <IconArrowRight aria-hidden="true" />
            </TopBarIconButton>
          </div>
        </div>
      </div>
      <div className="flex min-w-0 items-center self-stretch">
        {chatTitle ? (
          <span className="truncate text-[length:var(--text-app-top-bar-title)] font-normal text-foreground">
            {chatTitle}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-app-top-bar-control-fg [&_svg]:size-[length:var(--text-app-top-bar-icon)]">
        {viewActions}

        {onSearchClick ? (
          <TopBarIconButton
            type="button"
            size="icon-top-bar"
            onClick={onSearchClick}
            aria-label={t("actions.search")}
            title={t("actions.search")}
          >
            <IconSearch aria-hidden="true" />
          </TopBarIconButton>
        ) : null}
        {onFeedbackClick ? (
          <TopBarIconButton
            type="button"
            size="icon-top-bar"
            onClick={onFeedbackClick}
            aria-label={t("feedback:title")}
            title={t("feedback:title")}
          >
            <IconMessageReport aria-hidden="true" />
          </TopBarIconButton>
        ) : null}
        {showRightRailToggle && (
          <TopBarIconButton
            type="button"
            size="icon-top-bar"
            onClick={onToggleRightRail}
            aria-pressed={rightRailOpen}
            aria-label={rightRailLabel}
            title={rightRailLabel}
            data-right-rail-toggle="true"
          >
            <RightRailIcon aria-hidden="true" />
          </TopBarIconButton>
        )}
      </div>
    </header>
  );
}
