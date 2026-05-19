import {
  IconArrowLeft,
  IconArrowRight,
  IconLayoutSidebar,
  IconLayoutSidebarFilled,
  IconLayoutSidebarRight,
  IconLayoutSidebarRightFilled,
  IconMessageReport,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { UpdateIndicator } from "@/features/updates/ui/UpdateIndicator";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

type TopBarLeadingChromeInset = "compact" | "trafficLights";

export interface TopBarChromeInsets {
  leading: TopBarLeadingChromeInset;
}

interface TopBarProps {
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
}

export function TopBar({
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
}: TopBarProps) {
  const { t } = useTranslation(["sidebar", "feedback"]);
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
  const toolbarButtonOffsetClassName = "translate-y-0.5";
  const toolbarIconClassName = "size-[18px]";
  const leadingSpaceClassName =
    chromeInsets.leading === "trafficLights"
      ? "w-[var(--spacing-app-top-bar-leading)]"
      : "w-[var(--spacing-app-top-bar-leading-compact)]";

  return (
    <header
      className={cn(
        "flex h-[var(--spacing-app-top-bar)] items-center bg-background/80 backdrop-blur-sm",
        className,
      )}
    >
      <div
        className={cn(
          "h-full shrink-0 transition-[width] duration-200 ease-out",
          leadingSpaceClassName,
        )}
        data-tauri-drag-region
      />
      <div
        className={cn("flex items-center gap-1", toolbarButtonOffsetClassName)}
      >
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
      </div>
      <div
        className="ml-[6px] min-w-0 flex-1 self-stretch"
        data-tauri-drag-region
      />
      <div className="flex items-center gap-1">
        <UpdateIndicator />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(toolbarButtonClassName, toolbarButtonOffsetClassName)}
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
            className={cn(toolbarButtonClassName, toolbarButtonOffsetClassName)}
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
      <div
        className={cn(
          "h-full shrink-0 transition-[width] duration-200 ease-out",
          "w-[var(--spacing-app-top-bar-trailing)]",
        )}
        data-tauri-drag-region
      />
    </header>
  );
}
