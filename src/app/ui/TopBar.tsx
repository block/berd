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
import type { AppView } from "@/app/types/appNavigation";
import { UpdateIndicator } from "@/features/updates/ui/UpdateIndicator";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

type TopBarLeadingChromeInset = "compact" | "trafficLights";

export interface TopBarChromeInsets {
  leading: TopBarLeadingChromeInset;
}

interface TopBarProps {
  activeView?: AppView;
  chatSessionTitle?: string;
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

const PAGE_LABELS: Partial<Record<AppView, string>> = {
  skills: "Skills",
  agents: "Agents",
  automations: "Automations",
  "session-history": "Session History",
  search: "Search",
  settings: "Settings",
  "design-system": "Design System",
  projects: "Projects",
};

export function TopBar({
  activeView,
  chatSessionTitle,
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
  const toolbarButtonClassName = "size-[var(--spacing-app-top-bar-control)]";
  const toolbarIconClassName = "size-[18px]";
  const leadingSpaceClassName =
    chromeInsets.leading === "trafficLights"
      ? "w-[var(--spacing-app-top-bar-leading)]"
      : "w-4";

  const pageLabel =
    activeView === "chat"
      ? chatSessionTitle
      : activeView
        ? PAGE_LABELS[activeView]
        : undefined;

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
      <div className="flex items-center gap-1">
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
          <IconSearch aria-hidden="true" className={toolbarIconClassName} />
        </Button>
      </div>
      <h1
        data-tauri-drag-region
        className="whitespace-nowrap font-sans text-[24px] font-light leading-[0.96] tracking-[-0.04em] text-text-title"
      >
        {/* i18n-check-ignore */}
        Goose
        {pageLabel ? (
          <>
            <span className="text-text-breadcrumb-separator">{" / "}</span>
            <span className="text-text-muted">{pageLabel}</span>
          </>
        ) : null}
      </h1>
      <div className="min-w-0 flex-1 self-stretch" data-tauri-drag-region />
      {viewActions ? (
        <div className="flex items-center gap-2">{viewActions}</div>
      ) : null}
      <div className="flex items-center gap-1">
        <UpdateIndicator />
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
